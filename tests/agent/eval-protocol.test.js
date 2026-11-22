import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveDriverConfig, runDriver, DRIVER_ENV } from '../../agent/driver.js';
import { AgentSession } from '../../agent/session.js';
import { resolveEvalConfig, EVAL_ENV, PROTOCOL_LEVELS, PROTOCOL_EXCLUDED, runProtocol, renderReport, renderSummary } from '../../agent/eval.js';
import { startStubServer, makeWinPolicy, makeLevelSelectivePolicy } from '../helpers/stub-provider.js';

/**
 * Phase-2 exit eval (ticket #50): the RE-RUNNABLE measurement. The protocol
 * runs the real LLM driver over a fixed level set (level-01 gated to solve
 * EVERY run; level-02/03 attempted and diagnosis-obligated) across the
 * configured seeds, then renders a compact per-level report. Provider
 * independence comes from the shared stub provider seam: the protocol runs
 * against the same OpenAI-compatible fake endpoint the driver tests use,
 * so these tests exercise the REAL driver loop, REAL sessions and REAL
 * level data - only the LLM is a stub.
 *
 * Report contract pinned here: per-level shape, the level-01 gate, the
 * stuck-point diagnosis for unsolved runs, the determinism-caveats and
 * level-04 exclusion notes, and the two-invocation diffability pin (same
 * inputs -> identical report bytes except the marked VOLATILE block).
 */

describe('resolveEvalConfig - the eval CLI/env contract', () => {
    it('exposes the knobs as constants, on top of the driver env contract', () => {
        expect(EVAL_ENV.MODEL).toBe('TIM_AGENT_MODEL');
        expect(EVAL_ENV.BASE_URL).toBe('TIM_AGENT_BASE_URL');
        expect(EVAL_ENV.MAX_TURNS).toBe('TIM_AGENT_MAX_TURNS');
        expect(EVAL_ENV.REPORT).toBe('TIM_EVAL_REPORT');
        expect(EVAL_ENV.SEEDS).toBe('TIM_EVAL_SEEDS');
        expect(EVAL_ENV.TRANSCRIPTS).toBe('TIM_EVAL_TRANSCRIPTS');
        expect(EVAL_ENV.TURN_BASE_URL).toBe(DRIVER_ENV.TURN_BASE_URL);
    });

    it('defaults: protocol levels fixed, seeds [1,2,3], gitignored report + transcript paths, cap 20', () => {
        const { errors, config } = resolveEvalConfig({
            argv: [],
            env: { [EVAL_ENV.MODEL]: 'm', [EVAL_ENV.BASE_URL]: 'http://127.0.0.1:1/v1' },
        });
        expect(errors).toEqual([]);
        expect(config.seeds).toEqual([1, 2, 3]);
        expect(PROTOCOL_LEVELS).toEqual(['level-01', 'level-02', 'level-03']);
        expect(PROTOCOL_EXCLUDED.level).toBe('level-04');
        expect(config.reportPath).toBe('.agent-transcripts/eval-report.txt');
        expect(config.transcriptsDir).toBe('.agent-transcripts/eval');
        expect(config.maxTurns).toBe(20);
    });

    it('env overrides report/seeds/transcripts; CLI flags win over env', () => {
        const { errors, config: fromEnv } = resolveEvalConfig({
            argv: [],
            env: {
                [EVAL_ENV.MODEL]: 'm',
                [EVAL_ENV.SEEDS]: '7,8',
                [EVAL_ENV.REPORT]: 'out/r.txt',
                [EVAL_ENV.TRANSCRIPTS]: 'out/t',
            },
        });
        expect(fromEnv.seeds).toEqual([7, 8]);
        expect(fromEnv.reportPath).toBe('out/r.txt');
        expect(fromEnv.transcriptsDir).toBe('out/t');

        const { errors: errors2, config: fromCli } = resolveEvalConfig({
            argv: ['--model', 'cli', '--seeds', '11,12,13', '--report', 'cli.txt', '--transcripts-dir', 'cli-t'],
            env: {
                [EVAL_ENV.MODEL]: 'env',
                [EVAL_ENV.SEEDS]: '7,8',
                [EVAL_ENV.REPORT]: 'env.txt',
                [EVAL_ENV.TRANSCRIPTS]: 'env-t',
            },
        });
        expect(fromCli.seeds).toEqual([11, 12, 13]);
        expect(fromCli.reportPath).toBe('cli.txt');
        expect(fromCli.transcriptsDir).toBe('cli-t');
    });

    it('TIM_AGENT_MAX_TURNS flows through as the cap', () => {
        const { errors, config } = resolveEvalConfig({
            argv: [],
            env: { [EVAL_ENV.MODEL]: 'm', [EVAL_ENV.MAX_TURNS]: '7' },
        });
        expect(errors).toEqual([]);
        expect(config.maxTurns).toBe(7);
    });

    it('errors: no model; bad seeds (non-numeric, empty, >12, negative); invalid cap', () => {
        const noModel = resolveEvalConfig({ argv: [], env: {} });
        expect(noModel.config).toBeNull();
        expect(noModel.errors.join(' ')).toContain(EVAL_ENV.MODEL);

        const badSeeds = resolveEvalConfig({
            argv: ['--model', 'm', '--seeds', '7,banana,-3'],
            env: {},
        });
        expect(badSeeds.config).toBeNull();
        expect(badSeeds.errors.join(' ')).toMatch(/seed/i);

        const tooMany = resolveEvalConfig({
            argv: ['--model', 'm', '--seeds', '1,2,3,4,5,6,7,8,9,10,11,12,13'],
            env: {},
        });
        expect(tooMany.config).toBeNull();

        const badCap = resolveEvalConfig({
            argv: ['--model', 'm', '--max-turns', 'zero'],
            env: {},
        });
        expect(badCap.config).toBeNull();
    });

    it('the protocol is host-mode only: a configured turn service is a config error (that is e2e-demo.mjs)', () => {
        const { errors, config } = resolveEvalConfig({
            argv: [],
            env: { [EVAL_ENV.MODEL]: 'm', [EVAL_ENV.TURN_BASE_URL]: 'http://127.0.0.1:8787' },
        });
        expect(config).toBeNull();
        expect(errors.join(' ')).toContain(EVAL_ENV.TURN_BASE_URL);
    });
});

/** @type {Array<{ port: number, requests: object[], close(): Promise<void> }>} stubs opened by the current test */
const stubs = [];
/** @type {string|null} temp dir for this test's transcripts */
let dir = null;

afterEach(async () => {
    dir = null;
    for (const s of stubs.splice(0)) await s.close();
});

/** Resolve an eval config through the PUBLIC env contract against a stub endpoint. */
async function evalConfig(policy, { seeds = '1,4' } = {}) {
    dir = await mkdtemp(join(tmpdir(), 'tim-eval-'));
    const stub = await startStubServer(policy);
    stubs.push(stub);
    const { errors, config } = resolveEvalConfig({
        argv: [],
        env: {
            [EVAL_ENV.MODEL]: 'stub-model',
            [EVAL_ENV.BASE_URL]: `http://127.0.0.1:${stub.port}/v1`,
            [EVAL_ENV.SEEDS]: seeds,
            [EVAL_ENV.TRANSCRIPTS]: join(dir, 't'),
            [EVAL_ENV.REPORT]: join(dir, 'r.txt'),
        },
    });
    return { stub, errors, config };
}

describe('runProtocol - the measurement over the stub provider', () => {
    it(
        'the solved/unsolved mix: level-01 and level-03 reach, the ramp-only level-02 hits the cap; transcripts land at the deterministic paths',
        { timeout: 60000 },
        async () => {
            const { errors, config } = await evalConfig(makeLevelSelectivePolicy(['level-01', 'level-03']));
            expect(errors).toEqual([]);

            const result = await runProtocol(config);

            expect(result.protocol).toEqual({ id: 'p2-exit-eval', version: 1 });
            expect(result.gate.passed).toBe(true);
            expect(result.verdict).toBe('gate passed');
            expect(result.levels.map((l) => l.level)).toEqual(['level-01', 'level-02', 'level-03']);
            expect(result.levels.map((l) => l.gate)).toEqual(['must-solve-every-run', 'attempt-and-diagnose', 'attempt-and-diagnose']);

            const byLevel = Object.fromEntries(result.levels.map((l) => [l.level, l]));
            expect(byLevel['level-01'].solved).toBe(2);
            expect(byLevel['level-03'].solved).toBe(2);
            // level-02 has no player-placeable ball: the generic ball-drop
            // policy cannot win it, so its runs end at the turn cap.
            expect(byLevel['level-02'].solved).toBe(0);

            for (const level of result.levels) {
                expect(level.runs).toHaveLength(2);
                for (const run of level.runs) {
                    expect(run.outcome).toBe(level.level === 'level-02' ? 'turn-cap' : 'goal-reached');
                    expect(run.turns).toBeGreaterThanOrEqual(2);
                    expect(run.durationMs).toBeGreaterThanOrEqual(0);
                }
                expect(level.name).toBeTruthy();
            }

            // deterministic transcript refs (no wall-clock stamps; slash-joined under the configured dir)
            const expected = [
                join(dir, 't').replace(/\\/g, '/') + '/level-01-seed1.txt',
                join(dir, 't').replace(/\\/g, '/') + '/level-01-seed4.txt',
                join(dir, 't').replace(/\\/g, '/') + '/level-02-seed1.txt',
                join(dir, 't').replace(/\\/g, '/') + '/level-02-seed4.txt',
                join(dir, 't').replace(/\\/g, '/') + '/level-03-seed1.txt',
                join(dir, 't').replace(/\\/g, '/') + '/level-03-seed4.txt',
            ];
            expect(result.levels.flatMap((l) => l.runs.map((r) => r.transcriptRef))).toEqual(expected);
            // the transcripts exist and name their outcome
            for (const ref of expected) {
                const onDisk = await readFile(ref, 'utf8');
                expect(onDisk).toContain(ref.includes('level-02') ? 'outcome: turn-cap' : 'outcome: goal-reached');
            }
        },
    );
});

describe('runProtocol - the gate and the stuck-point diagnosis', () => {
    it(
        'gates on level-01: a model that jams EVERYWHERE fails the verdict, unsolved gate runs get diagnosed',
        { timeout: 60000 },
        async () => {
            const { config } = await evalConfig(makeLevelSelectivePolicy([]), { seeds: '5' });

            const result = await runProtocol(config);

            expect(result.gate.passed).toBe(false);
            expect(result.verdict).toBe('gate failed');
            expect(result.gate.solvedOf).toBe(0);
            expect(result.gate.runs).toBe(1);
            // even the gate level carries a diagnosis when unsolved (repetition: observe-only)
            const joined = result.levels[0].runs[0].diagnosis.join('\n');
            expect(joined).toMatch(/repetition:/i);
            expect(result.levels[0].solved).toBe(0);
        },
    );

    it(
        'level-01 solved but level-02/03 stuck: gate passes, every unsolved run is diagnosed with gaps named',
        { timeout: 60000 },
        async () => {
            const { config } = await evalConfig(makeLevelSelectivePolicy(['level-01']), { seeds: '2,9' });

            const result = await runProtocol(config);

            expect(result.gate.passed).toBe(true);
            expect(result.verdict).toBe('gate passed');
            const l02 = result.levels.find((l) => l.level === 'level-02');
            const l03 = result.levels.find((l) => l.level === 'level-03');
            expect(l02.solved).toBe(0);
            expect(l03.solved).toBe(0);
            expect(l02.runs).toHaveLength(2);
            for (const run of l02.runs) {
                expect(run.outcome).toBe('turn-cap');
                expect(run.diagnosis).toBeTruthy();
                const joined = run.diagnosis.join('\n');
                // the OBSERVATION gap: the shipped hint the model never sees...
                expect(joined).toMatch(/observation gap: the level ships a hint the observation never shows/);
                expect(joined).toContain('The ⚓ bowling ball is anchored');
                // ...and the ACTION gap: observe-forever repetition (never building)
                expect(joined).toMatch(/repetition: observe \{\} x/i);
                // unused budget: what was never even attempted
                expect(joined).toMatch(/budget left unused: ramp 3/);
            }
            // level-03's diagnosis names its own hint
            expect(l03.runs[0].diagnosis.join('\n')).toContain('Line up the dominoes on the ramp');
            // solved gate runs diagnose nothing stuck
            expect(result.levels[0].runs[0].diagnosis[0]).toMatch(/not stuck \(solved after \d+ turns\)/);
        },
    );
});

describe('renderReport + renderSummary - the compact per-level report', () => {
    it(
        'renders the per-level sections, gate/aggregate lines, caveats and the marked VOLATILE block',
        { timeout: 60000 },
        async () => {
            const { stub, config } = await evalConfig(makeLevelSelectivePolicy(['level-01']), { seeds: '1,4' });
            const result = await runProtocol(config);
            await stub.close(); stubs.pop(); // this test owns its stub fully; afterEach sees stubs[] empty

            const report = renderReport(result);

            // HEADER: identity + configuration echo
            expect(report).toContain('TIM agent phase-2 exit eval - protocol report');
            expect(report).toContain('protocol: p2-exit-eval v1');
            expect(report).toContain(`model: ${result.configEcho.model}`);
            expect(report).toContain('turn transport: host mode (in-process runTurn; the game lives in this process)');
            expect(report).toContain('turn cap: 20');
            expect(report).toContain('seeds (world construction only): 1, 4');
            expect(report).toContain(
                'protocol levels: level-01 - must-solve-every-run; level-02 - attempt-and-diagnose; level-03 - attempt-and-diagnose',
            );
            expect(report).toMatch(/excluded by design: level-04 \(Lighter Than Air\) - known-broken rope-attach\/balloon mechanics/);

            // VOLATILE block: wall-clock only, clearly fenced
            const begin = report.indexOf('# BEGIN VOLATILE');
            const end = report.indexOf('# END VOLATILE');
            expect(begin).toBeGreaterThan(-1);
            expect(end).toBeGreaterThan(begin);
            const volatileBlock = report.slice(begin, end);
            expect(volatileBlock).toContain('started: ');
            expect(volatileBlock).toContain('ended: ');
            expect(volatileBlock).toContain('wall seconds total: ');
            expect(volatileBlock).toContain('wall seconds per run: ');
            // wall-clock does NOT leak into the stable sections
            expect(report.slice(0, begin)).not.toMatch(/started:|ended:|wall seconds/);
            expect(report.slice(end)).not.toMatch(/started:|ended:|wall seconds/);

            // GATE + aggregate
            expect(report).toContain('gate: PASS - level-01 solved in every run (2 of 2)');
            expect(report).toContain('aggregate: level-01 solved 2/2; level-02 solved 0/2 (2 unsolved runs diagnosed); level-03 solved 0/2 (2 unsolved runs diagnosed)');

            // PER-LEVEL sections
            expect(report).toContain('[level-01 - First Steps] gate: must-solve-every-run');
            expect(report).toContain('[level-02 - Across the Gap] gate: attempt-and-diagnose');
            expect(report).toContain('[level-03 - Chain Reaction] gate: attempt-and-diagnose');
            expect(report).toContain('goal: (object_in_zone, target ball, zone bucket-goal)');
            expect(report).toMatch(/run 1\/2: seed 1 -> goal-reached after \d+ turns; transcript .*\/level-01-seed1\.txt/);
            expect(report).toMatch(/run 2\/2: seed 4 -> goal-reached after \d+ turns; transcript .*\/level-01-seed4\.txt/);
            // notable events ride with solved runs; no diagnosis block for them
            expect(report).toMatch(/events: .*caught by bucket-goal/);
            const l01Section = report.slice(report.indexOf('[level-01 - '), report.indexOf('[level-02 - '));
            expect(l01Section).not.toContain('diagnosis');
            // unsolved runs: outcomes + diagnosis blocks
            expect(report).toMatch(/run 1\/2: seed 1 -> turn-cap after \d+ turns; transcript .*\/level-02-seed1\.txt/);
            expect(report).toContain('run 1 diagnosis (unsolved):');
            expect(report).toContain('observation gap: the level ships a hint the observation never shows');

            // DETERMINISM CAVEATS: what seeding covers, what it cannot, the diffability contract
            expect(report).toContain('determinism caveats:');
            expect(report).toMatch(/pins WORLD construction randomness only/);
            expect(report).toMatch(/provider sampling \(the driver sets no temperature/);
            expect(report).toMatch(/provider-side drift/);
            expect(report).toMatch(/identical seeds AND identical provider behavior yield byte-identical report/);

            const summary = renderSummary(result);
            expect(summary).toMatch(/^\[eval\] p2-exit-eval v1: model=stub-model seeds=1,4 cap=20$/m);
            expect(summary).toMatch(/^\[eval\] level-01 First Steps: gate must-solve-every-run -> solved 2\/2 \(PASS\)$/m);
            expect(summary).toMatch(/^\[eval\] level-02 Across the Gap: gate attempt-and-diagnose -> solved 0\/2, 2 unsolved runs diagnosed$/m);
            expect(summary).toMatch(/^\[eval\] verdict: gate passed$/m);
            expect(summary).toMatch(/^\[eval\] report: /m);
        },
    );

    it(
        'renders the gate failing honestly when level-01 is unsolved',
        { timeout: 60000 },
        async () => {
            const { stub, config } = await evalConfig(makeLevelSelectivePolicy([]), { seeds: '5' });
            const failResult = await runProtocol(config);
            await stub.close(); stubs.pop();

            const report = renderReport(failResult);

            expect(report).toContain('gate: FAIL - level-01 solved in 0 of 1 runs (must-solve-every-run)');
            expect(report).toContain('level-02/03 unsolved-with-diagnosis is acceptable by design');
            expect(renderSummary(failResult)).toMatch(/^\[eval\] verdict: gate failed$/m);
            expect(renderSummary(failResult)).toMatch(/^\[eval\] level-01 First Steps: gate must-solve-every-run -> solved 0\/1 \(FAIL - must solve every run\)$/m);
        },
    );
});

describe('renderReport - the diffability pin (two consecutive seeded invocations)', () => {
    it(
        'two consecutive protocol runs with the same seeds render byte-identical reports except the fenced VOLATILE block; the stdout summary diffs byte-identical outright',
        { timeout: 120000 },
        async () => {
            const { config } = await evalConfig(makeLevelSelectivePolicy(['level-01']), { seeds: '1,4' });

            const first = await runProtocol(config);
            const second = await runProtocol(config);

            const report1 = renderReport(first);
            const report2 = renderReport(second);
            // The fence actually carries the volatile bytes: the full renders differ...
            expect(report2).not.toBe(report1);
            // ...but everything outside the fence is byte-identical (acceptance: comparable, diffable reports).
            const stripVolatile = (r) =>
                r.slice(0, r.indexOf('# BEGIN VOLATILE')) +
                '# BEGIN VOLATILE\n# END VOLATILE\n' +
                r.slice(r.indexOf('# END VOLATILE') + '# END VOLATILE\n'.length);
            expect(stripVolatile(report2)).toBe(stripVolatile(report1));
            // The stdout summary is volatile-free: byte-identical across invocations with no strip needed.
            expect(renderSummary(second)).toBe(renderSummary(first));
            // Both invocations reference the same deterministic transcript paths.
            expect(first.levels.flatMap((l) => l.runs.map((r) => r.transcriptRef)))
                .toEqual(second.levels.flatMap((l) => l.runs.map((r) => r.transcriptRef)));
        },
    );

    it(
        'the per-level section shape: header, goal, per-run lines (outcome vocabulary), events, diagnosis ONLY for unsolved runs, blank-line close',
        { timeout: 120000 },
        async () => {
            const { config } = await evalConfig(makeLevelSelectivePolicy(['level-01']), { seeds: '2,9' });
            const report = renderReport(await runProtocol(config));

            const RUN_LINE = /^run (\d+)\/(\d+): seed (\d+) -> (goal-reached|goal-failed|turn-cap) after (\d+) turns; transcript (\S+)$/;
            const nextMarker = { 'level-01': '[level-02 - ', 'level-02': '[level-03 - ', 'level-03': 'determinism caveats:' };
            for (const level of ['level-01', 'level-02', 'level-03']) {
                const section = report.slice(
                    report.indexOf(`[${level} - `),
                    report.indexOf(nextMarker[level]),
                );
                const lines = section.split('\n');
                // header + goal
                expect(lines[0]).toMatch(new RegExp(`^\\[${level} - .+\\] gate: (must-solve-every-run|attempt-and-diagnose)$`));
                expect(lines[1]).toMatch(/^goal: \(.+\)$/);
                // per-run lines carry the full outcome vocabulary; two runs (the two seeds)
                const runLines = lines.filter((l) => /^run \d+\/\d+: seed \d+ -> /.test(l));
                expect(runLines).toHaveLength(2);
                for (const l of runLines) expect(l).toMatch(RUN_LINE);
                // events: one notable-events line per run, right after its run line
                expect(lines.filter((l) => /^  events: /.test(l))).toHaveLength(2);
                // diagnosis blocks appear ONLY for unsolved runs; each carries indented diagnosis lines
                const unsolvedRuns = runLines.filter((l) => !l.includes('-> goal-reached')).length;
                expect(unsolvedRuns).toBe(level === 'level-01' ? 0 : 2); // win policy solves level-01, jams 02/03
                const diagnosisHeaders = lines.filter((l) => /^  run \d+ diagnosis \(unsolved\):$/.test(l));
                expect(diagnosisHeaders).toHaveLength(unsolvedRuns);
                for (const header of diagnosisHeaders) {
                    const after = lines.slice(lines.indexOf(header) + 1);
                    expect(after.filter((l) => /^    \S/.test(l)).length).toBeGreaterThan(0);
                }
                // the section closes on a blank line before the next level's section
                expect(lines[lines.length - 1]).toBe('');
            }
        },
    );
});
describe('scripts/eval-protocol.mjs - the ONE COMMAND (executable doc; acceptance: one command runs the protocol)', () => {
    const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

    /**
     * Spawn the script against a stub provider with this test's own env
     * overrides (flags/env contract tested above). ASYNC spawn on purpose:
     * the stub server lives in this worker's event loop - a blocking
     * spawnSync here would deadlock it against the child's provider requests.
     * @private
     */
    function runScript(envOverrides, timeoutMs = 110000) {
        return new Promise((resolve, reject) => {
            const child = spawn('node', ['scripts/eval-protocol.mjs'], {
                cwd: REPO_ROOT,
                env: { ...process.env, ...envOverrides },
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            child.stdout.setEncoding('utf8');
            child.stderr.setEncoding('utf8');
            let out = '';
            let err = '';
            child.stdout.on('data', (d) => { out += d; });
            child.stderr.on('data', (d) => { err += d; });
            const timer = setTimeout(() => {
                child.kill();
                reject(new Error(`eval-protocol.mjs did not finish within ${timeoutMs}ms`));
            }, timeoutMs);
            child.on('error', (e) => { clearTimeout(timer); reject(e); });
            child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout: out, stderr: err }); });
        });
    }

    it(
        'writes the per-level report at the configured path, prints the summary to stdout, exits 0 on gate pass',
        { timeout: 120000 },
        async () => {
            dir = await mkdtemp(join(tmpdir(), 'tim-eval-cli-'));
            const stub = await startStubServer(makeLevelSelectivePolicy(['level-01']));
            stubs.push(stub);
            const report = join(dir, 'out', 'report.txt');
            const transcripts = join(dir, 'out', 't');

            const r = await runScript({
                [EVAL_ENV.MODEL]: 'stub-model',
                [EVAL_ENV.BASE_URL]: `http://127.0.0.1:${stub.port}/v1`,
                [EVAL_ENV.SEEDS]: '1,4',
                [EVAL_ENV.REPORT]: report,
                [EVAL_ENV.TRANSCRIPTS]: transcripts,
            });

            expect(r.error).toBeUndefined();
            expect(r.status).toBe(0);
            // stdout = the volatile-free summary, and it names the report it wrote
            expect(r.stdout).toContain('[eval] p2-exit-eval v1: model=stub-model seeds=1,4 cap=20');
            expect(r.stdout).toContain(`[eval] report: ${report}`);
            // the report exists on disk with the full report shape
            const reportText = await readFile(report, 'utf8');
            expect(reportText).toContain('TIM agent phase-2 exit eval - protocol report');
            expect(reportText).toContain('gate: PASS - level-01 solved in every run (2 of 2)');
            expect(reportText).toContain('# BEGIN VOLATILE');
            expect(reportText).toContain('determinism caveats:');
            expect(reportText).toContain('excluded by design: level-04 (Lighter Than Air)');
            // every transcript the report references actually landed in the configured dir
            const refs = reportText
                .split('\n')
                .filter((l) => l.startsWith('run ') && l.includes('transcript '))
                .map((l) => /transcript (\S+)$/.exec(l)[1]);
            expect(refs).toHaveLength(6);
            for (const ref of refs) expect(await readFile(ref, 'utf8')).toContain('outcome:');
        },
    );

    it(
        'exits 2 on config error before any run (stderr names the missing model); exits 1 on gate failure with the report written anyway',
        { timeout: 120000 },
        async () => {
            const noModel = await runScript({ [EVAL_ENV.MODEL]: '' });
            expect(noModel.status).toBe(2);
            expect(noModel.stderr).toContain(EVAL_ENV.MODEL);

            dir = await mkdtemp(join(tmpdir(), 'tim-eval-cli-fail-'));
            const stub = await startStubServer(makeLevelSelectivePolicy([]));
            stubs.push(stub);
            const report = join(dir, 'r.txt');

            const r = await runScript({
                [EVAL_ENV.MODEL]: 'stub-model',
                [EVAL_ENV.BASE_URL]: `http://127.0.0.1:${stub.port}/v1`,
                [EVAL_ENV.SEEDS]: '7',
                [EVAL_ENV.REPORT]: report,
            });

            expect(r.status).toBe(1);
            expect(r.stdout).toContain('[eval] verdict: gate failed');
            expect(r.stdout).toContain('[eval] report:');
            // the report is written anyway - the measurement, not the verdict, is the product
            expect(await readFile(report, 'utf8')).toContain('gate: FAIL - level-01 solved in 0 of 1 runs (must-solve-every-run)');
        },
    );
});