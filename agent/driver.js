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
 *   entry point (observe). Every tool reaches the game ONLY through the
 *   turn-boundary transport: in-process runTurn(actionJson, session), or -
 *   when TIM_AGENT_TURN_BASE_URL is configured - one POST /turn per tool
 *   call to the turn service (ticket #49). The model never touches engine
 *   internals, driver.js never imports js/ modules (pinned by
 *   tests/agent/driver.test.js).
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
 *   TIM_AGENT_SEED      flows through to AgentSession (ticket #46) untouched
 *                       in host mode; in container mode the game lives in
 *                       the container, so the seed rides the CONTAINER env
 *                       (docker run -e TIM_AGENT_SEED=<seed>).
 *   TIM_AGENT_TURN_BASE_URL  optional. THE host<->container switch (ticket
 *                       #49) - distinct from TIM_AGENT_BASE_URL, which
 *                       points at the MODEL provider; this one points at
 *                       the GAME. Set = container mode: every tool turn
 *                       POSTs { action, ..., level } to <base>/turn (the
 *                       service scopes its session per request, which is
 *                       how the level is selected against the service by
 *                       config) and the driver needs no host session.
 *                       Unset = host mode, byte-for-byte today's
 *                       in-process runTurn. Never throws: network errors
 *                       come back as structured turn results.
 *
 * TRANSCRIPT (printed in full to stdout AND written to the file): header
 * (level/model/provider base URL/key presence/turn service mode/cap/outcome/turns), then per turn the
 * observation excerpt the model decided on (goal header + state table +
 * relations IN FULL; only grid/legend rows elided behind named markers) ->
 * the exact tool call (JSON)
 * -> the structured result it got back, including the trial verdict row.
 *
 * USAGE - HOST MODE (the world lives in this process; the default):
 *   node agent/driver.js --level level-01 --model <model> [--base-url <u>]
 *                        [--max-turns 20] [--transcript <path>]
 * USAGE - CONTAINER MODE (the world lives behind the turn service; the
 *         clean-state orchestration is scripts/e2e-demo.mjs):
 *   node agent/driver.js --turn-base-url http://127.0.0.1:8787 \
 *        --level level-01 --model <model> [--base-url <u>]
 * All of the above also via the TIM_AGENT_* env vars (CLI wins). The two
 * modes are one code path: TIM_AGENT_TURN_BASE_URL is the only switch.
 *
 * THE MODEL-FACING PROTOCOL (instructions / opening directive / stall
 * nudge / action-tool table / the HTTP turn transport) lives in
 * agent/driver-protocol.js (issue #65) - one leaf both drivers import and
 * the suite pins the equality; this module re-exports the bindings and
 * owns only the SDK loop.
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
import { parseFlags } from './cli-flags.js';
import { AgentSession } from './session.js';

// THE MODEL-FACING PROTOCOL lives in agent/driver-protocol.js (issue #65):
// the instructions, the opening directive, the stall nudge, the action-tool
// table and the HTTP turn transport - imported verbatim, never re-typed.
// The browser driver (js/watch/liveFlow.js) imports the same bindings and the
// suite pins the equality - one contract, two hosts, no drift.
import {
    INSTRUCTIONS,
    OPENING_DIRECTIVE,
    STALL_NUDGE,
    ACTION_TOOLS,
    asArgs,
    createHttpTurnTransport,
    toolOutput,
} from './driver-protocol.js';
export { INSTRUCTIONS, OPENING_DIRECTIVE, STALL_NUDGE, ACTION_TOOLS, createHttpTurnTransport } from './driver-protocol.js';

/** The provider/env configuration contract (resolved by resolveDriverConfig). */
export const DRIVER_ENV = Object.freeze({
    MODEL: 'TIM_AGENT_MODEL',
    BASE_URL: 'TIM_AGENT_BASE_URL',
    MAX_TURNS: 'TIM_AGENT_MAX_TURNS',
    TRANSCRIPT: 'TIM_AGENT_TRANSCRIPT',
    TURN_BASE_URL: 'TIM_AGENT_TURN_BASE_URL',
    API_KEY: 'OPENAI_API_KEY',
});

const DEFAULT_MAX_TURNS = 20;
const DEFAULT_LEVEL = 'level-01';
const EXCERPT_GRID_LINES = 4;
const EXCERPT_EVENT_LINES = 8;
const EXCERPT_FULL_LINES = 40; // at/below this an observation is small: render it in full

const RUN_TURN_OPTIONS = {
    maxTurns: 1,
    errorHandlers: {
        maxTurns: () => ({ finalOutput: '', includeInHistory: false }),
    },
};

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

/**
 * The transport seam behind TIM_AGENT_TURN_BASE_URL: unset -> in-process
 * runTurn (host mode, byte-for-byte today's behavior); set -> HTTP turns
 * against the service (container mode). The tools never know which one
 * they are on.
 * @param {{ turnBaseUrl?: string }} config
 * @param {import('./session.js').AgentSession|null} session host-mode world owner (ignored in container mode)
 * @returns {{ turn(actionJson: object): Promise<{ observation: string, result: object }> }}
 */
function createTurnTransport(config, session) {
    if (config.turnBaseUrl) return createHttpTurnTransport(config.turnBaseUrl, config.level);
    return {
        turn: (actionJson) => runTurn(actionJson, session),
    };
}

/**
 * The seven tools: the observation entry point + one tool per ACTION_TOOLS
 * row, each of them the ONLY path from the model into the game.
 *
 * ONE execute path serves every row (ticket #94): parse the model's JSON
 * arguments (asArgs), let the row's guard speak (only trial has one; the
 * refusal reads the world back through an observe turn so the observation
 * still rides along), then build the row's exact action JSON and drive the
 * transport turn. Uniform output: { action, result, observation } as one
 * JSON line, never a throw.
 * @param {{ turn(actionJson: object): Promise<{ observation: string, result: object }> }} transport
 */
function createDriverTools(transport) {
    const observe = { action: 'observe' };
    // The observation entry point is NOT a row of the table: every row reads
    // the world back through it when a turn is refused (see the guard above) -
    // one tool, the door the rows go through.
    const observeTool = tool({
        name: 'observe',
        description: "Read the world fresh: grid, legend, state table, relations. Cell 'auto' by default, 'full' for the precise 8px map.",
        parameters: {
            type: 'object',
            properties: { cell: { type: 'string', description: "'auto' (default) or 'full'" } },
            required: [],
            additionalProperties: true,
        },
        strict: false,
        execute: async (input) => {
            const args = asArgs(input);
            return toolOutput(observe, await transport.turn({ ...observe, cell: args.cell }));
        },
    });
    // The one execute path every table row is served by.
    const actionTool = (row) => tool({
        name: row.verb,
        description: row.description,
        parameters: row.parameters,
        strict: false,
        execute: async (input) => {
            const args = asArgs(input);
            const guard = row.guard ? row.guard(args) : null;
            if (guard) {
                const readBack = await transport.turn({ ...observe });
                return JSON.stringify({ action: row.verb, result: { ok: false, error: guard }, observation: readBack.observation });
            }
            const actionJson = row.build(args);
            return toolOutput(actionJson, await transport.turn(actionJson));
        },
    });
    return [observeTool, ...ACTION_TOOLS.map((row) => actionTool(row))];
}

/**
 * One transcript row: what the model saw (excerpt) -> what it chose (exact
 * tool call + arguments) -> what it got back (the structured result).
 *
 * The excerpt keeps the DECISION-RELEVANT observation content in EVERY row
 * (ticket #48: the transcript must show the observation the model decided
 * from): the goal header, the state table and the relations graph render
 * IN FULL, trial events stay bounded-visible (8 lines, the cut is named);
 * only the bulky grid/legend block is elided behind honest
 * "( ... elided: N lines ... )" markers - the label stays truthful.
 * Small observations (placeholders, error text) render in full.
 * @private
 */
function excerptObservation(observation) {
    const text = String(observation ?? '');
    if (text.trim() === '') return '| (empty observation)';
    const lines = text.split('\n');
    const full = () => lines.map((l) => `|` + ' ' + l).join('\n');
    if (lines.length <= EXCERPT_FULL_LINES) return full();
    const find = (label) => lines.findIndex((l) => l.startsWith(label));
    const worldIdx = find('world ');
    if (worldIdx < 0) return full();
    const legendIdx = find('legend:');
    const stateIdx = find('state:');
    const eventsIdx = find('events:');
    const out = [];
    // The grid block runs from the "world WxH, cell ..." dims line to the next
    // labelled section (legend, or the state table): keep its first rows here,
    // name the elided rest - the frame bottom + ruler + rows below them.
    const nextIdx = legendIdx > worldIdx ? legendIdx : (stateIdx > worldIdx ? stateIdx : lines.length);
    const gridKeep = Math.min(worldIdx + 1 + EXCERPT_GRID_LINES, nextIdx);
    out.push(...lines.slice(0, gridKeep));
    const gridElided = nextIdx - gridKeep;
    if (gridElided > 0) out.push(`( ... grid + ruler elided: ${gridElided} lines ... )`);
    if (legendIdx >= 0 && stateIdx > legendIdx) {
        out.push(`( ... legend elided: ${stateIdx - legendIdx} lines ... )`);
    }
    // The state table + relations render IN FULL - the decision-relevant core.
    if (stateIdx >= 0) {
        const relationsEnd = eventsIdx > stateIdx ? eventsIdx : lines.length;
        out.push(...lines.slice(stateIdx, relationsEnd));
    } else {
        out.push('( ... this observation carries no state table ... )');
    }
    if (eventsIdx >= 0) {
        out.push(...lines.slice(eventsIdx, eventsIdx + EXCERPT_EVENT_LINES));
        const eventsElided = lines.length - (eventsIdx + EXCERPT_EVENT_LINES);
        if (eventsElided > 0) out.push(`( ... events elided: ${eventsElided} more lines ... )`);
    }
    return out.map((l) => `|` + ' ' + l).join('\n');
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
 *           turns: number, transcript: string, transcriptPath: string,
 *           turnLog: Array<{ turn: number, note: string|null,
 *             calls: Array<{ name: string, args: object }>,
 *             outputs: Array<{ action: string, result: object, observation: string }> }>}>
 *   turnLog mirrors the transcript rows as data: what the model chose
 *   (calls) and what the turn boundary answered (outputs). Eval seam.
 */
export async function runDriver(config, session) {
    if (!config?.model) {
        throw new TypeError('runDriver(config, session): config needs a model - use resolveDriverConfig() first');
    }
    if (!config.turnBaseUrl && !session?.levelData) {
        throw new TypeError(
            'runDriver(config, session): an AgentSession with a loaded level is required ' +
            `(in host mode, i.e. ${DRIVER_ENV.TURN_BASE_URL} unset - set it to drive a turn service instead)`,
        );
    }

    setTracingDisabled(true);
    const transport = createTurnTransport(config, session);
    const provider = buildModelProvider(config);
    const runner = new Runner({ modelProvider: provider });
    const agent = new Agent({
        name: 'tim-driver',
        instructions: INSTRUCTIONS,
        tools: createDriverTools(transport),
        model: config.model,
    });

    // Observation #0 also goes through the turn boundary - same as the tools.
    const opening = await transport.turn({ action: 'observe' });
    const goalLine = String(opening.observation ?? '').split('\n')[0];
    let currentObservation = opening.observation;
    let history = [
        {
            role: 'user',
            content: `${goalLine}\n\nInitial observation:\n${currentObservation}\n\n` +
                OPENING_DIRECTIVE,
        },
    ];

    const rows = [];
    // Structured per-turn log - the machine-readable twin of the transcript rows
    // (ticket #50 eval feeds on this): the same data the transcript renders, as data.
    const turnLog = [];
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
                turnLog.push({ turn, calls: [], outputs: [], note: 'stall: no tool call' });
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
            turnLog.push({
                turn,
                calls: calls.map((c) => ({ name: c.name, args: asArgs(c.arguments) })),
                outputs,
                note: null,
            });

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
        turnLog.push({ turn: turnsUsed, calls: [], outputs: [], note: `driver error: ${err?.message ?? String(err)}` });
        rows.push(`=== driver error ===\n| ${String(err?.stack ?? err).replace(/\r?\n/g, '\n| ')}`);
    }

    const lines = [
        '# tim agent driver transcript',
        `level: ${config.level}`,
        `model: ${config.model}`,
        `provider base URL: ${config.baseUrl ?? '(SDK default - OpenAI; requires OPENAI_API_KEY)'}`,
        `turn service: ${config.turnBaseUrl ?? '(host mode - in-process runTurn)'}`,
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
    return { outcome, turns: turnsUsed, transcript, transcriptPath: config.transcriptPath, turnLog };
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
    // Container mode (TIM_AGENT_TURN_BASE_URL set) needs no host world: the
    // turn service owns the level - selected by config on every turn POST.
    const session = config.turnBaseUrl ? null : new AgentSession();
    try {
        if (session) await session.loadLevel(config.level);
        const res = await runDriver(config, session);
        console.log(res.transcript);
        process.exitCode = res.outcome === 'goal-reached' ? 0 : 1;
    } finally {
        session?.dispose();
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






