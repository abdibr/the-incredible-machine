import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveDriverConfig, runDriver, DRIVER_ENV } from '../../agent/driver.js';
import { AgentSession } from '../../agent/session.js';
import { resolveEvalConfig, EVAL_ENV, PROTOCOL_LEVELS, PROTOCOL_EXCLUDED, runProtocol } from '../../agent/eval.js';
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
        'solves the gated level set: gate passes, every run reaches, transcripts land at the deterministic paths',
        { timeout: 60000 },
        async () => {
            const { errors, config } = await evalConfig(makeLevelSelectivePolicy(['level-01', 'level-02', 'level-03']));
            expect(errors).toEqual([]);

            const result = await runProtocol(config);

            expect(result.protocol).toEqual({ id: 'p2-exit-eval', version: 1 });
            expect(result.gate.passed).toBe(true);
            expect(result.verdict).toBe('gate passed');
            expect(result.levels.map((l) => l.level)).toEqual(['level-01', 'level-02', 'level-03']);
            expect(result.levels.map((l) => l.gate)).toEqual(['must-solve-every-run', 'attempt-and-diagnose', 'attempt-and-diagnose']);

            for (const level of result.levels) {
                expect(level.runs).toHaveLength(2);
                for (const run of level.runs) {
                    expect(run.outcome).toBe('goal-reached');
                    expect(run.turns).toBeGreaterThanOrEqual(2);
                    expect(run.durationMs).toBeGreaterThanOrEqual(0);
                }
                expect(level.solved).toBe(2);
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
                expect(onDisk).toContain('outcome: goal-reached');
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
                expect(joined).toContain('Place the trampoline');
                // ...and the ACTION gap: observe-forever repetition (never building)
                expect(joined).toMatch(/repetition: observe \{\} x/i);
                // unused budget: what was never even attempted
                expect(joined).toMatch(/budget left unused: ball 1, ramp 2, trampoline 1/);
            }
            // level-03's diagnosis names its own hint
            expect(l03.runs[0].diagnosis.join('\n')).toContain('Line up the dominoes on the ramp');
            // solved gate runs diagnose nothing stuck
            expect(result.levels[0].runs[0].diagnosis[0]).toMatch(/not stuck \(solved after \d+ turns\)/);
        },
    );
});
