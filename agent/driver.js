/**
 * driver - the phase-2 LLM driver (ticket #48): an LLM plays the game on
 * the host THROUGH the turn boundary. One module, one deep seam:
 * resolveDriverConfig() -> runDriver() against an AgentSession.
 *
 * THE AGENT (OpenAI Agents SDK):
 *   Agent({ name: 'tim-driver', instructions, tools }) where instructions
 *   teach the observation contract (grid / legend / state table / relations
 *   / trial events) and tools map ONE-TO-ONE onto the phase-1 actions
 *   (place / remove / rotate / nudge / reset / trial) PLUS the observation
 *   entry point (observe). Every tool internally calls runTurn(actionJson,
 *   session) - the model never touches engine internals, driver.js never
 *   imports js/ modules (pinned by tests/agent/driver.test.js).
 *
 * THE LOOP (hard cap, deterministic):
 *   Each driver turn is one SDK run with maxTurns: 1 - exactly one model
 *   response (tool calls execute through the tools above, then the run
 *   resolves via the SDK's maxTurns error handler with the tool results
 *   already in history). After each turn the driver scans the tool results
 *   for a trial verdict and stops:
 *     - outcome "reached"  -> goal-reached   (exit 0)
 *     - outcome "failed"   -> goal-failed    (exit 1)
 *     - turn cap exhausted -> turn-cap       (exit 1)
 *   The model CANNOT run forever: the cap is the driver's, not the model's.
 *   A text-only model turn is a stall, counted against the same cap.
 *   Config errors exit 2 before any model call.
 *
 * PROVIDER CONFIGURATION (env; CLI overrides for the local knobs only -
 * API keys never ride argv and are never printed):
 *   TIM_AGENT_MODEL     model name as the provider knows it (REQUIRED).
 *   TIM_AGENT_BASE_URL  optional. Pointing this at ANY OpenAI-compatible
 *                       endpoint is the SUPPORTED alternative-provider path
 *                       (the SDK client is built with this base URL and
 *                       runs in chat-completions mode, the lowest common
 *                       denominator every compatible server implements).
 *                       Example Ollama live use:
 *                         TIM_AGENT_BASE_URL=http://127.0.0.1:11434/v1
 *   OPENAI_API_KEY      optional. The SDK-native key var (no alias). Not
 *                       required when TIM_AGENT_BASE_URL points at a local
 *                       provider; a non-secret placeholder is injected then.
 *   TIM_AGENT_MAX_TURNS hard driver-turn cap, default 20 (--max-turns).
 *   TIM_AGENT_TRANSCRIPT transcript file path (--transcript); default
 *                       .agent-transcripts/<level>-<timestamp>.txt, a
 *                       gitignored directory (see .gitignore) - transcripts
 *                       are session artifacts and are never committed.
 *   TIM_AGENT_SEED      flows through to AgentSession (ticket #46) untouched.
 *
 * TRANSCRIPT (printed in full to stdout AND written to the file): header
 * (level/model/base-URL/key-presence/cap/outcome/turns), then per turn the
 * observation excerpt the model decided on -> the exact tool call (JSON)
 * -> the structured result it got back, including the trial verdict row.
 *
 * USAGE:
 *   node agent/driver.js --level level-01 --model <model> [--base-url <u>]
 *                        [--max-turns 20] [--transcript <path>]
 * All of the above also via the TIM_AGENT_* env vars (CLI wins).
 *
 * No markdown docs (the branch is markdown-free): THIS header is the doc,
 * and the stub-based integration tests are the executable spec.
 */

import {
    Agent,
    tool,
    OpenAIProvider,
    Runner,
    setTracingDisabled,
    setOpenAIAPI,
    setDefaultOpenAIKey,
} from '@openai/agents';
// The openai client is @openai/agents' own runtime dependency (it is what
// setDefaultOpenAIClient must be handed); it ships inside node_modules.
import { OpenAI } from 'openai';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runTurn } from './turn.js';
import { AgentSession } from './session.js';

/** The provider/env configuration contract (resolved by resolveDriverConfig). */
export const DRIVER_ENV = Object.freeze({
    MODEL: 'TIM_AGENT_MODEL',
    BASE_URL: 'TIM_AGENT_BASE_URL',
    MAX_TURNS: 'TIM_AGENT_MAX_TURNS',
    TRANSCRIPT: 'TIM_AGENT_TRANSCRIPT',
    TURN_BASE_URL: 'TIM_AGENT_TURN_BASE_URL',
    API_KEY: 'OPENAI_API_KEY',
});

/** Server-parity trial clamps (agent/server.js MAX_TRIAL_SECONDS / MAX_TRIAL_DT). */
const MAX_TRIAL_SECONDS = 120;
const MAX_TRIAL_DT = 1000;
const DEFAULT_MAX_TURNS = 20;
const DEFAULT_LEVEL = 'level-01';
const EXCERPT_HEAD_LINES = 12;
const EXCERPT_EVENT_LINES = 8;

const STALL_NUDGE =
    'No tool call happened. Respond with exactly ONE tool call (observe, place, rotate, nudge, remove, reset, ' +
    'trial). Only tool calls advance the game.';

const RUN_TURN_OPTIONS = {
    maxTurns: 1,
    errorHandlers: {
        maxTurns: () => ({ finalOutput: '', includeInHistory: false }),
    },
};

/** The observation contract, taught once to the agent. */
const INSTRUCTIONS =
    [
        'You drive a headless physics puzzle machine (The Incredible Machine style).',
        '',
        'THE OBSERVATION - your only window into the world. Every tool returns JSON:',
        '{ "action": <verb>, "result": {...}, "observation": "..." }. Results NEVER throw:',
        'rejections come back as {"ok":false,"error":"..."} and are data, not errors.',
        'The observation block reads, top to bottom:',
        '- header line: "<level id> - <level name> (<goal type>, target <type>, zone <zone id>)" - the goal',
        '- a monospaced grid of the playfield; glyph legend follows; a 10-column ruler lets you count columns',
        '- legend: glyph -> object-type mapping',
        '- state: a table (id, type, pos "x,y" in game units, angle, size, flags, motion, extra). extra carries',
        '  readiness facts (goal-zone, caught:n, target-type). x starts at 0 on the left, y grows DOWNWARD.',
        '- relations: goal / touch / fired edges between object ids; trial turns append "events:" lines',
        '- trial result outcome: "reached" wins, "failed" means the target fell off the playfield,',
        '  "timeout" means the machine settled without reaching (or missing) the zone.',
        '',
        'YOUR TOOLS - one per game action; each executes through the game turn boundary:',
        '- observe {} - read the world fresh (a full observation also rides back after every action).',
        '- place {type, x, y, angle?} - place a budgeted part (types = state-table vocabulary).',
        '- remove {type, slot?} - remove YOUR placed copy (slot is 0-based per type; fixed objects immutable).',
        '- rotate {type, radians, slot?} - set an absolute angle on a placed part.',
        '- nudge {type, dx, dy, slot?} - move a placed part by an offset.',
        '- reset {} - wipe all YOUR placements (fixed objects stay).',
        '- trial {seconds?, dt?} - rebuild the world with current placements and simulate',
        '  (seconds 0-120, dt 1-1000 ms; out-of-range values answer with a structured error).',
        '',
        'HOW TO PLAY:',
        '- Each turn, choose exactly ONE tool call, then read the observation you get back and choose again.',
        '- Win = the TARGET object (header line) caught in the goal zone bucket: trial outcome "reached".',
        '- Dead-center drops straight into the goal bucket typically catch. Parts are gravity-fed; think ramps.',
        '- Known-broken mechanics (rope attach, gear meshing, candle, conveyor) return clean failure data.',
        '- Budget is per part type; overspend is rejected with the remaining budget in the error.',
    ].join('\n');

/**
 * Tiny argv parser (no deps, cli.js style): `--key value` pairs only.
 * @param {string[]} argv
 */
function parseFlags(argv) {
    const flags = {};
    for (let i = 0; i < argv.length; i++) {
        if (argv[i].startsWith('--') && i + 1 < argv.length) {
            flags[argv[i].slice(2)] = argv[++i];
        }
    }
    return flags;
}

/** Timestamped default transcript name under the gitignored artifacts dir. @private */
function defaultTranscriptPath(level) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return `.agent-transcripts/${level}-${stamp}.txt`;
}

/**
 * Resolve the driver configuration from CLI flags + env (CLI wins; env is
 * the documented contract). Pure: pass argv/env explicitly to test it.
 *
 * @param {{ argv?: string[], env?: object }} [opts] { argv: process.argv.slice(2), env: process.env }
 * @returns {{ errors: string[], config: null | { level: string, model: string,
 *   baseUrl?: string, apiKey?: string, maxTurns: number, transcriptPath: string,
 *   turnBaseUrl?: string }}}
 */
export function resolveDriverConfig({ argv = [], env = {} } = {}) {
    const flags = parseFlags(argv);
    const errors = [];

    const model = flags.model ?? env[DRIVER_ENV.MODEL];
    if (!model) {
        errors.push(`no model configured: set ${DRIVER_ENV.MODEL} or pass --model <name>`);
    }

    const baseUrl = flags['base-url'] ?? env[DRIVER_ENV.BASE_URL];
    const apiKey = env[DRIVER_ENV.API_KEY];
    // No baseUrl and no key is a soft state, not a config error: with the SDK
    // default client the key is read from env at request time and the SDK
    // reports a missing one itself, with its own clear error.

    const level = flags.level ?? DEFAULT_LEVEL;

    // The turn-boundary transport switch (ticket #49): when set, the driver's
    // tools POST /turn to the turn service (agent/server.js - what the Docker
    // container runs) instead of calling in-process runTurn. Unset = host
    // mode, byte-for-byte today's behavior.
    const turnBaseUrl = flags['turn-base-url'] ?? env[DRIVER_ENV.TURN_BASE_URL];
    if (turnBaseUrl !== undefined && !/^https?:\/\//i.test(turnBaseUrl)) {
        errors.push(
            `invalid turn base URL: "${turnBaseUrl}" - an http(s):// URL is required ` +
            `(set ${DRIVER_ENV.TURN_BASE_URL} or pass --turn-base-url <url>)`,
        );
    }

    const maxTurnsRaw = flags['max-turns'] ?? env[DRIVER_ENV.MAX_TURNS];
    let maxTurns = DEFAULT_MAX_TURNS;
    if (maxTurnsRaw !== undefined) {
        maxTurns = Number(maxTurnsRaw);
        if (!(Number.isFinite(maxTurns) && maxTurns >= 1)) {
            errors.push(`invalid max turns: "${maxTurnsRaw}" - a number >= 1 is required`);
        }
    }

    const transcriptPath = flags.transcript ?? env[DRIVER_ENV.TRANSCRIPT] ?? defaultTranscriptPath(level);

    return {
        errors,
        config: errors.length ? null : Object.freeze({ level, model, baseUrl, apiKey, maxTurns, transcriptPath, turnBaseUrl }),
    };
}

/**
 * Build the per-run model provider: chat-completions mode (the common
 * denominator that also makes non-OpenAI servers reachable) over a client
 * pointed at the configured base URL. The SDK's own run() wraps a lazy
 * global provider that caches its client on first use - so the driver owns
 * its provider Runner instead (fresh per run, no stale endpoint ever
 * pinned - e.g. a closed test stub or a restarted Ollama port). Key values
 * never leak: they go into the client only.
 * @param {{ baseUrl?: string, apiKey?: string, model: string }} config
 */
function buildModelProvider(config) {
    if (config.baseUrl) {
        const apiKey = config.apiKey || 'tim-agent-local-no-key';
        const client = new OpenAI({ baseURL: config.baseUrl, apiKey });
        return new OpenAIProvider({ openAIClient: client, useResponses: false });
    }
    if (config.apiKey) {
        return new OpenAIProvider({ apiKey: config.apiKey, useResponses: false });
    }
    return new OpenAIProvider({ useResponses: false }); // OPENAI_API_KEY from env, if any
}

/** Coerce model-supplied tool arguments into an object (never trust, never throw). @private */
function asArgs(input) {
    if (input && typeof input === 'object' && !Array.isArray(input)) return input;
    if (typeof input === 'string' && input.trim()) {
        try {
            const parsed = JSON.parse(input);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
        } catch { /* structured failure flows back through the result */ }
    }
    return {};
}

/** Uniform tool output: { action, result, observation } as one JSON line. @private */
function toolOutput(actionJson, turn) {
    return JSON.stringify({ action: actionJson.action, result: turn.result, observation: turn.observation });
}

/** Server-parity clamp for trial knobs; returns an error string or null. @private */
function trialGuardError(args) {
    if (args.seconds !== undefined) {
        const n = Number(args.seconds);
        if (!(Number.isFinite(n) && n > 0 && n <= MAX_TRIAL_SECONDS)) {
            return `trial seconds must be a number between 0 and ${MAX_TRIAL_SECONDS} (got ${JSON.stringify(args.seconds)})`;
        }
    }
    if (args.dt !== undefined) {
        const n = Number(args.dt);
        if (!(Number.isFinite(n) && n >= 1 && n <= MAX_TRIAL_DT)) {
            return `trial dt must be a number between 1 and ${MAX_TRIAL_DT} ms (got ${JSON.stringify(args.dt)})`;
        }
    }
    return null;
}

/**
 * The seven tools: one per phase-1 action + the observation entry point,
 * each calling runTurn() - THE only path from the model into the game.
 * Plain JSON-schema parameters (strict:false): arguments are parsed but
 * NOT pre-validated here - agent/actions.js owns validation and answers
 * with its structured never-throw results, which is the contract the model
 * is taught (and the tests pin).
 * @param {import('./session.js').AgentSession} session
 */
function createDriverTools(session) {
    const observe = { action: 'observe' };
    return [
        tool({
            name: 'observe',
            description: "Read the world fresh: grid, legend, state table, relations. Cell 'auto' by default, 'full' for the precise 8px map.",
            parameters: {
                type: 'object',
                properties: { cell: { type: 'string', description: "'auto' (default) or 'full'" } },
                required: [],
                additionalProperties: true,
            },
            strict: false,
            execute: (input) => {
                const args = asArgs(input);
                return toolOutput(observe, runTurn({ ...observe, cell: args.cell }, session));
            },
        }),
        tool({
            name: 'place',
            description: "Place a budgeted part at game coordinates (x left-to-right from 0, y grows downward). Types: the state-table vocabulary (ball, ramp, trampoline, domino, fan, balloon, spring, ...).",
            parameters: {
                type: 'object',
                properties: {
                    type: { type: 'string', description: 'part type' },
                    x: { type: 'number', description: 'game x' },
                    y: { type: 'number', description: 'game y' },
                    angle: { type: 'number', description: 'optional initial angle, radians' },
                },
                required: ['type', 'x', 'y'],
                additionalProperties: true,
            },
            strict: false,
            execute: (input) => {
                const args = asArgs(input);
                const actionJson = { action: 'place', type: args.type, x: args.x, y: args.y, angle: args.angle };
                return toolOutput(actionJson, runTurn(actionJson, session));
            },
        }),
        tool({
            name: 'remove',
            description: 'Remove one of YOUR placed parts by type + 0-based slot (level fixed objects are immutable).',
            parameters: {
                type: 'object',
                properties: {
                    type: { type: 'string', description: 'part type to remove' },
                    slot: { type: 'number', description: '0-based slot among your placements of that type (default 0)' },
                },
                required: ['type'],
                additionalProperties: true,
            },
            strict: false,
            execute: (input) => {
                const args = asArgs(input);
                const actionJson = { action: 'remove', type: args.type, slot: args.slot };
                return toolOutput(actionJson, runTurn(actionJson, session));
            },
        }),
        tool({
            name: 'rotate',
            description: 'Rotate one of YOUR placed parts to an absolute angle (radians).',
            parameters: {
                type: 'object',
                properties: {
                    type: { type: 'string', description: 'part type' },
                    radians: { type: 'number', description: 'absolute angle in radians' },
                    slot: { type: 'number', description: '0-based slot (default 0)' },
                },
                required: ['type', 'radians'],
                additionalProperties: true,
            },
            strict: false,
            execute: (input) => {
                const args = asArgs(input);
                const actionJson = { action: 'rotate', type: args.type, radians: args.radians, slot: args.slot };
                return toolOutput(actionJson, runTurn(actionJson, session));
            },
        }),
        tool({
            name: 'nudge',
            description: 'Move one of YOUR placed parts by an (dx, dy) offset.',
            parameters: {
                type: 'object',
                properties: {
                    type: { type: 'string', description: 'part type' },
                    dx: { type: 'number', description: 'x offset' },
                    dy: { type: 'number', description: 'y offset' },
                    slot: { type: 'number', description: '0-based slot (default 0)' },
                },
                required: ['type', 'dx', 'dy'],
                additionalProperties: true,
            },
            strict: false,
            execute: (input) => {
                const args = asArgs(input);
                const actionJson = { action: 'nudge', type: args.type, dx: args.dx, dy: args.dy, slot: args.slot };
                return toolOutput(actionJson, runTurn(actionJson, session));
            },
        }),
        tool({
            name: 'reset',
            description: 'Wipe all YOUR placements back to the bare level (fixed objects stay).',
            parameters: { type: 'object', properties: {}, required: [], additionalProperties: true },
            strict: false,
            execute: () => toolOutput({ action: 'reset' }, runTurn({ action: 'reset' }, session)),
        }),
        tool({
            name: 'trial',
            description: 'Simulate the current world: rebuild with your placements and step the physics for seconds. The tool result outcome tells "reached" (win), "failed" (target left the playfield) or "timeout".',
            parameters: {
                type: 'object',
                properties: {
                    seconds: { type: 'number', description: `sim seconds, 0 < s <= ${MAX_TRIAL_SECONDS} (default 5)` },
                    dt: { type: 'number', description: `physics step dt in ms, 1 <= dt <= ${MAX_TRIAL_DT} (default ~16.67)` },
                },
                required: [],
                additionalProperties: true,
            },
            strict: false,
            execute: (input) => {
                const args = asArgs(input);
                const guard = trialGuardError(args);
                if (guard) {
                    const readBack = runTurn({ ...observe }, session);
                    return JSON.stringify({ action: 'trial', result: { ok: false, error: guard }, observation: readBack.observation });
                }
                const actionJson = { action: 'trial', seconds: args.seconds, dt: args.dt };
                return toolOutput(actionJson, runTurn(actionJson, session));
            },
        }),
    ];
}

/**
 * One transcript row: what the model saw (excerpt) -> what it chose (exact
 * tool call + arguments) -> what it got back (the structured result).
 * @private
 */
function excerptObservation(observation) {
    const lines = String(observation ?? '').split('\n');
    if (lines.length === 0 || String(observation ?? '').trim() === '') return '| (empty observation)';
    const eventsIdx = lines.findIndex((l) => l.startsWith('events:'));
    const head = lines.slice(0, Math.min(EXCERPT_HEAD_LINES, lines.length));
    const tail = eventsIdx >= EXCERPT_HEAD_LINES ? lines.slice(eventsIdx, eventsIdx + EXCERPT_EVENT_LINES) : [];
    return [...head, ...tail].map((l) => `| ${l}`).join('\n');
}

function renderRow(turn, observation, calls, outputs, note = null) {
    const lines = [`=== turn ${turn} ===`, 'observation (excerpt):', excerptObservation(observation)];
    if (note) {
        lines.push('action:', `  (none: ${note})`, 'result:', '  (none)');
        return lines.join('\n');
    }
    lines.push('action:');
    for (const c of calls) lines.push(`  ${c.name} ${c.arguments ?? '{}'}`);
    lines.push('result:');
    for (const o of outputs) lines.push(`  ${JSON.stringify(o?.result ?? {})}`);
    return lines.join('\n');
}

/** Normalizes a run item (RunItem wrapper or raw protocol item) to its raw shape. @private */
function rawItemOf(item) {
    return item?.rawItem ?? (item && typeof item === 'object' ? item : null);
}

/** Pull the model's tool call choices out of this turn's new run items. @private */
function toolCallsFromItems(items) {
    const calls = [];
    for (const item of items) {
        const raw = rawItemOf(item);
        if (raw?.type === 'function_call') {
            calls.push({ name: raw.name, arguments: raw.arguments });
        }
    }
    return calls;
}

/** Pull (and parse) this turn's tool outputs: { action, result, observation } triples. @private */
function toolOutputsFromItems(items) {
    const outputs = [];
    for (const item of items) {
        const raw = rawItemOf(item);
        if (raw?.type === 'function_call_result') {
            let text = raw.output?.text;
            if (typeof text !== 'string') text = typeof raw.output === 'string' ? raw.output : '';
            let parsed = null;
            try { parsed = JSON.parse(text); } catch { parsed = { action: null, result: { ok: false, error: String(text) }, observation: null }; }
            outputs.push(parsed);
        }
    }
    return outputs;
}

/**
 * Configure the SDK agent for THIS session and run the turn loop.
 *
 * @param {{ level: string, model: string, baseUrl?: string, apiKey?: string,
 *           maxTurns: number, transcriptPath: string }} config from resolveDriverConfig()
 * @param {import('./session.js').AgentSession} session with a level loaded
 * @returns {Promise<{ outcome: 'goal-reached'|'goal-failed'|'turn-cap'|'driver-error',
 *           turns: number, transcript: string, transcriptPath: string }>}
 */
export async function runDriver(config, session) {
    if (!config?.model) {
        throw new TypeError('runDriver(config, session): config needs a model - use resolveDriverConfig() first');
    }
    if (!session?.levelData) {
        throw new TypeError('runDriver(config, session): an AgentSession with a loaded level is required');
    }

    setTracingDisabled(true);
    const provider = buildModelProvider(config);
    const runner = new Runner({ modelProvider: provider });
    const agent = new Agent({
        name: 'tim-driver',
        instructions: INSTRUCTIONS,
        tools: createDriverTools(session),
        model: config.model,
    });

    // Observation #0 also goes through the turn boundary - same as the tools.
    const opening = runTurn({ action: 'observe' }, session);
    const goalLine = String(opening.observation ?? '').split('\n')[0];
    let currentObservation = opening.observation;
    let history = [
        {
            role: 'user',
            content: `${goalLine}\n\nInitial observation:\n${currentObservation}\n\n` +
                'Choose exactly one tool call now (observe to re-read, place to start building, trial to test).',
        },
    ];

    const rows = [];
    let outcome = null;
    let turnsUsed = 0;
    try {
        for (let turn = 1; turn <= config.maxTurns; turn++) {
            turnsUsed = turn;
            // One driver turn = exactly one model response (maxTurns: 1); the
            // SDK's maxTurns handler folds the boundary into a clean resolve
            // with the executed tool results already in history.
            const result = await runner.run(agent, history, RUN_TURN_OPTIONS);
            history = result.history;
            const newItems = result.newItems ?? [];

            const calls = toolCallsFromItems(newItems);
            const outputs = toolOutputsFromItems(newItems);

            if (calls.length === 0) {
                rows.push(renderRow(turn, currentObservation, [], [], 'stall: no tool call'));
                history = [...history, { role: 'user', content: STALL_NUDGE }];
                continue;
            }

            let verdict = null;
            for (const out of outputs) {
                const o = out?.result?.outcome;
                if (o === 'reached' || o === 'failed') verdict = o;
            }
            rows.push(renderRow(turn, currentObservation, calls, outputs));

            const last = outputs[outputs.length - 1];
            if (last?.observation) currentObservation = last.observation;
            if (verdict) {
                outcome = verdict === 'reached' ? 'goal-reached' : 'goal-failed';
                break;
            }
        }
        if (!outcome) outcome = 'turn-cap';
    } catch (err) {
        outcome = 'driver-error';
        rows.push(`=== driver error ===\n| ${String(err?.stack ?? err).replace(/\r?\n/g, '\n| ')}`);
    }

    const lines = [
        '# tim agent driver transcript',
        `level: ${config.level}`,
        `model: ${config.model}`,
        `provider base URL: ${config.baseUrl ?? '(SDK default - OpenAI; requires OPENAI_API_KEY)'}`,
        `api key: ${config.apiKey ? 'set (value withheld)' : 'unset - fine for local/alternative providers'}`,
        `turn cap: ${config.maxTurns}`,
        `outcome: ${outcome}`,
        `turns: ${turnsUsed}`,
        '',
        ...rows,
    ];
    const transcript = lines.join('\n') + '\n';
    const dir = dirname(config.transcriptPath);
    await mkdir(dir, { recursive: true });
    await writeFile(config.transcriptPath, transcript, 'utf8');
    return { outcome, turns: turnsUsed, transcript, transcriptPath: config.transcriptPath };
}

/**
 * Entry point. Usage:
 *   node agent/driver.js --level level-01 --model <model> [--base-url <url>]
 *                        [--max-turns 20] [--transcript <path>]
 * Exit codes: 0 goal reached; 1 goal failed / turn cap / driver error;
 * 2 configuration error. The transcript prints in full and lands on the
 * transcript file (default under gitignored .agent-transcripts/).
 */
export async function main(argv = process.argv.slice(2)) {
    const { errors, config } = resolveDriverConfig({ argv, env: process.env });
    if (!config) {
        for (const error of errors) console.error('[driver] config error: ' + error);
        process.exitCode = 2;
        return;
    }
    const session = new AgentSession();
    try {
        await session.loadLevel(config.level);
        const res = await runDriver(config, session);
        console.log(res.transcript);
        process.exitCode = res.outcome === 'goal-reached' ? 0 : 1;
    } finally {
        session.dispose();
    }
}

const invokedDirectly =
    process.argv[1] && process.argv[1].length > 0 && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
    main().catch((e) => {
        console.error('[driver] fatal:', e);
        process.exitCode = 1;
    });
}






