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

/** Tiny argv parser - same `--key value` semantics as agent/driver.js. @private */
function parseFlags(argv) {
    const flags = {};
    for (let i = 0; i < argv.length; i++) {
        if (argv[i].startsWith('--') && i + 1 < argv.length) {
            flags[argv[i].slice(2)] = argv[++i];
        }
    }
    return flags;
}

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
            runs.push({
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
                note: null,
            });
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
