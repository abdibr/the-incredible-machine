/**
 * eval - the phase-2 EXIT EVAL protocol (ticket #50): a RE-RUNNABLE
 * measurement, not a one-off demo. runProtocol() drives the real LLM
 * driver (agent/driver.js) over a fixed level set and seeds, then
 * renderReport() writes a compact per-level report whose bytes are
 * diffable across invocations.
 *
 * THE PROTOCOL (fixed by design):
 *   level-01  must be SOLVED in every run - the gate. Any unsolved run
 *             fails the verdict (the measurement, not the model, ends
 *             the protocol).
 *   level-02  attempted; unsolved is acceptable IF diagnosed. The
 *             stuck-point diagnosis names what the run data shows:
 *             observation gaps, rejected actions (with their structured
 *             failure reasons), repetition/dead-end loops, silent
 *             trials, closest approach to the goal zone, unused budget.
 *   level-03  same gate as level-02.
 *   level-04  EXCLUDED BY DESIGN - its rope-attach/balloon mechanics are
 *             the known-broken clean-failure test; the solver already
 *             documents that failure (parent.md design rule). This eval
 *             does not measure it; the report says so.
 *
 * SEEDING (ticket #46): each run gets its seed via the AgentSession seed
 * option (the TIM_AGENT_SEED seam), making WORLD construction - every
 * Math.random draw - reproducible. Seeding does NOT pin the model:
 * provider sampling and provider-side drift are outside its reach. The
 * report carries this as an explicit determinism-caveats section.
 *
 * MODE: host only. The game lives in this process and the driver runs
 * its in-process runTurn transport; a configured TIM_AGENT_TURN_BASE_URL
 * is a config error (driving a container service is scripts/e2e-demo.mjs,
 * ticket #49). One session lives at a time - the shared eventBus is a
 * process-wide singleton (boundary fact), so protocol runs are strictly
 * sequential.
 *
 * USAGE (the script is the executable doc):
 *   node scripts/eval-protocol.mjs
 * Env/flags: TIM_AGENT_MODEL (required), TIM_AGENT_BASE_URL (the
 * provider), TIM_AGENT_MAX_TURNS via EVAL_ENV below, plus the eval
 * knobs TIM_EVAL_REPORT / TIM_EVAL_SEEDS / TIM_EVAL_TRANSCRIPTS.
 * Exit codes: 0 gate passed; 1 gate failed (report written anyway);
 * 2 configuration error.
 */

import { DRIVER_ENV, resolveDriverConfig, runDriver } from './driver.js';
import { parseFlags } from './cli-flags.js';
import { AgentSession } from './session.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Protocol identity - the report names it. */
export const PROTOCOL = Object.freeze({ id: 'p2-exit-eval', version: 1 });

/** The fixed level set: gate level first, then the diagnosis levels. */
export const PROTOCOL_LEVELS = Object.freeze(['level-01', 'level-02', 'level-03']);

/** level-04 stays out by design; the report states this. */
export const PROTOCOL_EXCLUDED = Object.freeze({
    level: 'level-04',
    name: 'Lighter Than Air',
    reason:
        'known-broken rope-attach/balloon mechanics are the deliberate clean-failure test; ' +
        'the solver documents that failure - parent.md design rule, not measured here',
});

/** Per-level gate kinds - must-solve-every-run vs attempt-and-diagnose. */
export const LEVEL_GATES = Object.freeze({
    'level-01': 'must-solve-every-run',
    'level-02': 'attempt-and-diagnose',
    'level-03': 'attempt-and-diagnose',
});

/** Env/flag contract of the eval: driver names reused, eval knobs added. */
export const EVAL_ENV = Object.freeze({
    MODEL: DRIVER_ENV.MODEL, // required
    BASE_URL: DRIVER_ENV.BASE_URL, // the provider (OpenAI-compatible)
    MAX_TURNS: DRIVER_ENV.MAX_TURNS,
    TURN_BASE_URL: DRIVER_ENV.TURN_BASE_URL, // must stay UNSET (host-mode protocol)
    API_KEY: DRIVER_ENV.API_KEY, // flows to the driver only; never printed
    REPORT: 'TIM_EVAL_REPORT',
    SEEDS: 'TIM_EVAL_SEEDS',
    TRANSCRIPTS: 'TIM_EVAL_TRANSCRIPTS',
});

/** Default protocol size: three seeds = three runs per level. */
export const DEFAULT_SEEDS = Object.freeze([1, 2, 3]);

const MAX_SEEDS = 12;
const REPORT_PATH_DEFAULT = '.agent-transcripts/eval-report.txt';
const TRANSCRIPTS_DIR_DEFAULT = '.agent-transcripts/eval';

/** Parse the seeds spec (csv of uint32s) or null for unset. @private */
function parseSeeds(raw, errors) {
    if (raw === undefined) return null; // caller applies DEFAULT_SEEDS
    const parts = String(raw)
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '');
    if (parts.length === 0) {
        errors.push(`invalid seeds: "${raw}" - a comma-separated list of at least one non-negative integer`);
        return null;
    }
    if (parts.length > MAX_SEEDS) {
        errors.push(`too many seeds: ${parts.length} (max ${MAX_SEEDS}) - the protocol is a small measurement`);
        return null;
    }
    const seeds = [];
    for (const part of parts) {
        const n = Number(part);
        if (!(Number.isInteger(n) && n >= 0 && n <= 4294967295)) {
            errors.push(`invalid seed: "${part}" - seeds are non-negative integers 0..4294967295`);
            return null;
        }
        seeds.push(n);
    }
    return seeds;
}

/**
 * Resolve the eval configuration from CLI flags + env (CLI wins; env is
 * the documented contract). Pure: pass argv/env explicitly to test it.
 * Host-mode protocol: a configured turn service is an ERROR - measuring
 * through the container transport is scripts/e2e-demo.mjs (ticket #49).
 *
 * @param {{ argv?: string[], env?: object }} [opts]
 * @returns {{ errors: string[], config: null | { model: string, baseUrl?: string,
 *   apiKey?: string, maxTurns: number, seeds: number[], reportPath: string,
 *   transcriptsDir: string } }}
 */
export function resolveEvalConfig({ argv = [], env = {} } = {}) {
    const flags = parseFlags(argv);
    const errors = [];

    // Shared provider/cap parsing with the driver's own contract (same
    // env names, same validation, same error wording).
    const driverResolution = resolveDriverConfig({ argv, env });
    errors.push(...driverResolution.errors);
    const driver = driverResolution.config;

    if (env[EVAL_ENV.TURN_BASE_URL] !== undefined || flags['turn-base-url'] !== undefined) {
        errors.push(
            `${EVAL_ENV.TURN_BASE_URL} / --turn-base-url is configured - the eval protocol measures the ` +
            'HOST-mode game only; unset it (driving a container turn service is scripts/e2e-demo.mjs)',
        );
    }

    const seeds = parseSeeds(flags.seeds ?? env[EVAL_ENV.SEEDS], errors) ?? DEFAULT_SEEDS;
    const reportPath = flags.report ?? env[EVAL_ENV.REPORT] ?? REPORT_PATH_DEFAULT;
    const transcriptsDir = flags['transcripts-dir'] ?? env[EVAL_ENV.TRANSCRIPTS] ?? TRANSCRIPTS_DIR_DEFAULT;

    if (errors.length || !driver) return { errors, config: null };

    return {
        errors: [],
        config: Object.freeze({
            model: driver.model,
            baseUrl: driver.baseUrl,
            apiKey: driver.apiKey,
            maxTurns: driver.maxTurns,
            seeds,
            reportPath,
            transcriptsDir,
        }),
    };
}

/** Slash-joined transcript ref under the transcripts dir: stable across invocations and platforms. @private */
function transcriptRef(dir, levelId, seed) {
    return `${String(dir ?? '').replace(/[\\/]+$/, '').replace(/\\/g, '/')}/${levelId}-seed${seed}.txt`;
}

/** Goal header text, the same shape the observation's first line shows. @private */
function goalText(levelData) {
    const g = levelData?.goal;
    return g ? `(${g.type}, target ${g.targetType}, zone ${g.zoneId})` : '(no goal)';
}

/** 0-based slot of this placement among same-type placements (the remove/rotate addressing). @private */
function withSlots(placements) {
    const seen = new Map();
    return placements.map((p) => {
        const slot = seen.get(p.type) ?? 0;
        seen.set(p.type, slot + 1);
        return { type: p.type, x: p.x, y: p.y, angle: p.angle, slot };
    });
}

/**
 * Run the protocol: every level x seed, STRICTLY SEQUENTIALLY - the
 * eventBus singleton means one session lives at a time (boundary fact).
 * Each run is one real driver run over the real level data at the real
 * turn boundary; per-run world state is captured before the session is
 * disposed, so the diagnosis sees the run's final machine.
 *
 * @param {{ model: string, baseUrl?: string, apiKey?: string, maxTurns: number,
 *           seeds: number[], transcriptsDir: string }} config from resolveEvalConfig()
 * @returns {Promise<object>} the protocol result (levels/runs/gate/durations; the
 *   report is rendered separately by renderReport, written by the script)
 */
export async function runProtocol(config) {
    if (!config?.model) {
        throw new TypeError('runProtocol(config): config needs a model - use resolveEvalConfig() first');
    }
    const startedAt = Date.now();
    const levels = [];
    const perRunDurations = [];
    for (const levelId of PROTOCOL_LEVELS) {
        const runs = [];
        let levelName = levelId;
        let levelGoalLine = '(no goal)';
        for (const seed of config.seeds) {
            const runStart = Date.now();
            const session = new AgentSession({ seed });
            const ref = transcriptRef(config.transcriptsDir, levelId, seed);
            const driverConfig = Object.freeze({
                level: levelId,
                model: config.model,
                baseUrl: config.baseUrl,
                apiKey: config.apiKey,
                maxTurns: config.maxTurns,
                transcriptPath: ref,
            });
            await session.loadLevel(levelId);
            levelName = session.levelData?.name ?? levelId;
            levelGoalLine = goalText(session.levelData);
            const run = await runDriver(driverConfig, session);
            const durationMs = Date.now() - runStart;
            const record = {
                level: levelId,
                seed,
                index: runs.length + 1,
                outcome: run.outcome,
                turns: run.turns,
                transcriptRef: ref,
                durationMs,
                turnLog: run.turnLog ?? [],
                endBudget: session.budget(),
                placements: withSlots(session.placements),
            };
            record.diagnosis = analyzeRun(record, { hints: session.levelData?.hints });
            runs.push(record);
            perRunDurations.push(`${levelId}/seed${seed}=${(durationMs / 1000).toFixed(1)}s`);
            session.dispose();
        }
        levels.push({
            level: levelId,
            gate: LEVEL_GATES[levelId],
            name: levelName,
            goalLine: levelGoalLine,
            runs,
            solved: runs.filter((r) => r.outcome === 'goal-reached').length,
        });
    }
    // THE GATE: level-01 must be solved in EVERY run.
    const gateLevel = levels[0];
    const gateRuns = gateLevel.runs;
    const unsolvedGateRuns = gateRuns.filter((r) => r.outcome !== 'goal-reached');
    const gate = Object.freeze({
        level: gateLevel.level,
        passed: unsolvedGateRuns.length === 0,
        solvedOf: gateRuns.length - unsolvedGateRuns.length,
        runs: gateRuns.length,
    });
    return {
        protocol: PROTOCOL,
        configEcho: Object.freeze({
            model: config.model,
            baseUrl: configuredBaseUrlEcho(config.baseUrl),
            maxTurns: config.maxTurns,
            seeds: [...config.seeds],
            levels: [...PROTOCOL_LEVELS],
            excluded: PROTOCOL_EXCLUDED.level,
            reportPath: config.reportPath ?? REPORT_PATH_DEFAULT,
        }),
        startedAtMs: startedAt,
        endedAtMs: Date.now(),
        durationMs: Date.now() - startedAt,
        perRunDurations,
        levels,
        gate,
        verdict: gate.passed ? 'gate passed' : 'gate failed',
    };
}

/** Echo the provider base URL without secrets (there are none in a URL, but keep the shape stable). @private */
function configuredBaseUrlEcho(baseUrl) {
    return baseUrl ?? '(sdk default - OpenAI; requires OPENAI_API_KEY)';
}

/** JSON with sorted keys - the stable representation for repetition keys and diagnosis echo. @private */
function stableJson(value) {
    if (Array.isArray(value)) return `[${value.map((v) => stableJson(v)).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value)
            .filter((k) => value[k] !== undefined)
            .sort()
            .map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`)
            .join(',')}}`;
    }
    return String(JSON.stringify(value) ?? 'null');
}

/** Keep echoed argument blobs bounded. @private */
function bounded(text, max = 160) {
    return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

/**
 * Stuck-point analysis of ONE run record (the diagnosis obligation for
 * unsolved runs, useful context for solved ones). Pure: derives ONLY from
 * the recorded data (turn log, budgets, placements) plus the level hints -
 * the observation/action gaps the acceptance criterion asks to be named:
 *   - observation gap: the shipped hint the observation never shows
 *   - rejected actions with their structured failure reasons
 *   - repetition/dead-end loops in the model's tool-call stream
 *   - silent trials (no causal feedback) + closest approach + unused budget
 * Deterministic: same record -> same lines.
 *
 * @param {{ outcome: string, turns: number, turnLog: object[], endBudget: object,
 *           placements: object[] }} record one runProtocol run record
 * @param {{ hints?: string[], description?: string }} [levelData] the level document
 * @returns {string[]} diagnosis lines
 */
export function analyzeRun(record, levelData = {}) {
    if (record.outcome === 'goal-reached') {
        return [`not stuck (solved after ${record.turns} turns)`];
    }
    const lines = [];
    const calls = [];
    const outputs = [];
    for (const entry of record.turnLog ?? []) {
        if (entry.note) lines.push(`turn ${entry.turn} note: ${entry.note}`);
        for (const c of entry.calls ?? []) calls.push(c);
        for (const o of entry.outputs ?? []) outputs.push(o);
    }

    // closest approach: the best any trial brought the target to the zone
    const distances = outputs
        .map((o) => o?.result?.distance)
        .filter((d) => typeof d === 'number' && Number.isFinite(d));
    const trialCount = calls.filter((c) => c.name === 'trial').length;
    if (trialCount > 0) {
        lines.push(
            distances.length === 0
                ? 'closest approach to the goal zone: none recorded (the target was never in any trial world)'
                : `closest approach to the goal zone: ${Math.min(...distances).toFixed(1)} game units`,
        );
    }

    // rejected actions: structured never-throw failures the model received back
    const rejected = outputs.filter((o) => o?.result?.ok === false);
    if (rejected.length > 0) {
        lines.push(`rejected actions (${rejected.length}):`);
        for (const r of rejected.slice(0, 8)) {
            lines.push(`  - ${r.action ?? '(unknown action)'} -> ${bounded(String(r.result?.error ?? 'unknown error'))}`);
        }
        if (rejected.length > 8) lines.push(`  (+ ${rejected.length - 8} more rejections - see the transcript)`);
    }

    // the goal-failed reason, when the trial engine said why
    const failureReasons = outputs.map((o) => o?.result?.failureReason).filter((v) => typeof v === 'string' && v);
    if (failureReasons.length > 0) lines.push(`goal-failure reason (from the trial engine): ${failureReasons[0]}`);

    // repetition: identical calls (same verb, same stabilized arguments) coming back >= 3 times
    const counts = new Map();
    for (const c of calls) {
        const key = `${c.name} ${stableJson(c.args ?? {})}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const repeats = [...counts.entries()].filter(([, n]) => n >= 3);
    if (repeats.length > 0) {
        const shown = repeats.slice(0, 3).map(([key, n]) => `${bounded(key)} x${n}`);
        lines.push(`repetition: ${shown.join('; ')}${repeats.length > 3 ? ` (+ ${repeats.length - 3} more repeated patterns)` : ''}`);
    }

    // trial-only streak: simulations without any placement change between them
    const MUTATING = new Set(['place', 'remove', 'rotate', 'nudge', 'reset']);
    let streak = 0;
    let maxStreak = 0;
    for (const c of calls) {
        if (MUTATING.has(c.name)) streak = 0;
        else if (c.name === 'trial') maxStreak = Math.max(maxStreak, ++streak);
    }
    if (maxStreak >= 3) lines.push(`longest trial-only streak: ${maxStreak} trials without a placement change`);

    // silent trials: simulations that recorded ZERO events - no causal feedback at all
    const trialOutputs = outputs.filter((o) => o?.action === 'trial' && o?.result?.outcome !== undefined);
    const silent = trialOutputs.filter((o) => !Array.isArray(o.result.events) || o.result.events.length === 0).length;
    if (trialCount > 0 && silent > 0) {
        lines.push(`silent trials: ${silent} of ${trialCount} trials produced zero events (no causal feedback between placements)`);
    }

    // unused budget: what was never even attempted
    const unused = Object.entries(record.endBudget ?? {}).filter(([, n]) => n > 0);
    if (unused.length > 0) {
        lines.push(`budget left unused: ${unused.map(([type, n]) => `${type} ${n}`).join(', ')}`);
    }

    // observation gap: the level ships a hint (and a description) the observation never shows
    const hints = Array.isArray(levelData?.hints) ? levelData.hints : [];
    if (hints.length > 0) {
        lines.push(
            `observation gap: the level ships a hint the observation never shows (describeWorld renders no hint ` +
            `section) - ${JSON.stringify(hints[0])}`,
        );
    }

    if (lines.length === 0) {
        lines.push(`no observable stuck pattern (run ended as ${record.outcome} after ${record.turns} turns)`);
    }
    return lines;
}

/** One run's notable events, capped - landmark sentences carry the story. @private */
function eventsNote(run) {
    const rows = [];
    for (const entry of run.turnLog ?? []) {
        for (const o of entry.outputs ?? []) {
            for (const row of o?.result?.events ?? []) rows.push(row);
        }
    }
    if (rows.length === 0) return '(none)';
    const shown = rows.slice(0, 4).map((row) => `${row.text} @${row.t}s`);
    return rows.length > 4 ? `${shown.join('; ')} (+ ${rows.length - 4} more)` : shown.join('; ');
}

/** The gate sentence - the one line the whole measurement turns on. @private */
function gateLine(result) {
    const g = result.gate;
    return g.passed
        ? `gate: PASS - ${g.level} solved in every run (${g.solvedOf} of ${g.runs})`
        : `gate: FAIL - ${g.level} solved in ${g.solvedOf} of ${g.runs} runs (must-solve-every-run); ` +
          'level-02/03 unsolved-with-diagnosis is acceptable by design';
}

/** The level aggregate - counts plus the diagnosis obligation status. @private */
function levelAggregate(level) {
    const runs = level.runs.length;
    const unsolved = runs - level.solved;
    return unsolved === 0
        ? `${level.level} solved ${level.solved}/${runs}`
        : `${level.level} solved ${level.solved}/${runs} (${unsolved} unsolved runs diagnosed)`;
}

/**
 * Render the REPORT: compact, per-level, byte-diffable. Everything outside
 * the fenced VOLATILE block is deterministic for a given protocol result -
 * and identical across two invocations with the same seeds and the same
 * provider behavior (see the caveats section text inside).
 *
 * @param {object} result from runProtocol()
 * @returns {string} the report text (LF line endings, trailing newline)
 */
export function renderReport(result) {
    const e = result.configEcho;
    const lines = [
        'TIM agent phase-2 exit eval - protocol report',
        `protocol: ${result.protocol.id} v${result.protocol.version}`,
        `model: ${e.model}`,
        `provider base URL: ${e.baseUrl}`,
        'turn transport: host mode (in-process runTurn; the game lives in this process)',
        `turn cap: ${e.maxTurns}`,
        `seeds (world construction only): ${e.seeds.join(', ')}`,
        `protocol levels: ${result.levels.map((l) => `${l.level} - ${l.gate}`).join('; ')}`,
        `excluded by design: ${PROTOCOL_EXCLUDED.level} (${PROTOCOL_EXCLUDED.name}) - ${PROTOCOL_EXCLUDED.reason}`,
        '',
        '# BEGIN VOLATILE (wall-clock only - never comparable across invocations)',
        `started: ${new Date(result.startedAtMs).toISOString()}`,
        `ended: ${new Date(result.endedAtMs).toISOString()}`,
        `wall seconds total: ${(result.durationMs / 1000).toFixed(1)}`,
        `wall seconds per run: ${result.perRunDurations.join('; ')}`,
        '# END VOLATILE',
        '',
        gateLine(result),
        `aggregate: ${result.levels.map(levelAggregate).join('; ')}`,
        '',
    ];
    for (const level of result.levels) {
        lines.push(`[${level.level} - ${level.name}] gate: ${level.gate}`);
        lines.push(`goal: ${level.goalLine}`);
        const runs = level.runs.length;
        for (const run of level.runs) {
            lines.push(`run ${run.index}/${runs}: seed ${run.seed} -> ${run.outcome} after ${run.turns} turns; transcript ${run.transcriptRef}`);
            lines.push(`  events: ${eventsNote(run)}`);
            if (run.outcome !== 'goal-reached') {
                lines.push(`  run ${run.index} diagnosis (unsolved):`);
                for (const line of run.diagnosis ?? []) lines.push(`    ${line}`);
            }
        }
        lines.push('');
    }
    lines.push(
        'determinism caveats:',
        '- Seeding (protocol seeds; the TIM_AGENT_SEED seam, ticket #46) pins WORLD construction randomness only:' +
            ' every Math.random draw at object-build time (balloon bob phase, candle flicker phase).' +
            ' Same seed + same placements => byte-identical trials.',
        '- Seeding does NOT pin the MODEL: provider sampling (the driver sets no temperature/top-p;' +
            ' provider defaults apply), provider-side drift (model updates, routing) and wall-clock are' +
            " outside the seed's reach.",
        '- Diffability contract: identical seeds AND identical provider behavior yield byte-identical report' +
            ' bytes except the VOLATILE block. A stable-section difference between two seeded runs is provider' +
            ' drift - or a protocol bug (check the transcripts).',
        `- The provider answers for "${e.model}"; no provider-side version/digest is observable from here.`,
        '',
    );
    return lines.join('\n');
}

/**
 * Render the stdout SUMMARY (deterministic on purpose - it is the quick
 * eyeball line a human diffs across runs; the report file carries the rest).
 * @param {object} result from runProtocol()
 * @returns {string}
 */
export function renderSummary(result) {
    const e = result.configEcho;
    const lines = [
        `[eval] ${result.protocol.id} v${result.protocol.version}: model=${e.model} seeds=${e.seeds.join(',')} cap=${e.maxTurns}`,
    ];
    for (const level of result.levels) {
        const runs = level.runs.length;
        const unsolved = runs - level.solved;
        if (level.gate === 'must-solve-every-run') {
            const mark = unsolved === 0
                ? `solved ${level.solved}/${runs} (PASS)`
                : `solved ${level.solved}/${runs} (FAIL - must solve every run)`;
            lines.push(`[eval] ${level.level} ${level.name}: gate ${level.gate} -> ${mark}`);
        } else {
            lines.push(
                `[eval] ${level.level} ${level.name}: gate ${level.gate} -> solved ${level.solved}/${runs}, ` +
                `${unsolved} unsolved runs diagnosed`,
            );
        }
    }
    lines.push(`[eval] verdict: ${result.verdict}`);
    lines.push(`[eval] report: ${e.reportPath ?? '(not configured)'}`);
    return lines.join('\n');
}
