/**
 * driver-protocol - THE model-facing protocol of the phase-2 agent
 * (tickets #48/#49/#94), extracted verbatim from agent/driver.js so the
 * BROWSER driver (issue #65, the watch sidecar per ADR 0010) speaks the
 * very same contract the Node driver speaks:
 *
 * - INSTRUCTIONS: the observation contract + tool rules, taught once.
 * - OPENING_DIRECTIVE: the opening brief's tail sentence.
 * - STALL_NUDGE: the text-only-turn nudge.
 * - ACTION_TOOLS: verb -> { verb, description, parameters, build, guard? } -
 *   the one small table tools are built from in BOTH hosts (ticket #94);
 *   row order is phase-1 order, which is also the advertised wire order.
 * - asArgs / toolOutput: the never-trust argument parse and the uniform
 *   { action, result, observation } tool-result line.
 * - createHttpTurnTransport: the transport that POSTs { action, ..., level }
 *   to the headless turn service (agent/server.js) and answers the SAME
 *   { observation, result } envelope runTurn() answers in host mode - never
 *   throws (a refused connection, a timeout, a non-JSON envelope all come
 *   back as structured data).
 *
 * This module is a LEAF: it imports agent/turn.js only (the turn boundary +
 * the trial clamps) - no SDK, no fs, no process - so it is bundle-safe for
 * the watch sidecar (ADR 0010) and Node-safe for driver.js. Nothing in the
 * game bundle reads it: the grant covers the watch sidecar only.
 */

import { MAX_TRIAL_SECONDS, MAX_TRIAL_DT, trialGuardError } from './turn.js';

/** Container-mode POST /turn cap per request (the service trial guard is 120 s; a
 *  turn request may not out-wait it) - past it the turn answers with structured
 *  unreachable data, never a hang. */
const TURN_HTTP_TIMEOUT_MS = 120_000;

const STALL_NUDGE =
    'No tool call happened. Respond with exactly ONE tool call (observe, place, rotate, nudge, remove, reset, ' +
    'trial). Only tool calls advance the game.';

/** The opening brief's tail sentence: one tool call per turn, in both hosts. */
const OPENING_DIRECTIVE =
    'Choose exactly one tool call now (observe to re-read, place to start building, trial to test).';

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
 * Coerce model-supplied tool arguments into an object (never trust, never throw). @private
 */
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

/**
 * The observation entry point's descriptor - NOT a row of the action table
 * (every verb reads the world back through it), but the model must see it
 * advertised: chat-completions requests carry it FIRST (the driver's SDK
 * tools wrap the same wording).
 */
const OBSERVE_TOOL = {
    name: 'observe',
    description: "Read the world fresh: grid, legend, state table, relations. Cell 'auto' by default, 'full' for the precise 8px map.",
    parameters: {
        type: 'object',
        properties: { cell: { type: 'string', description: "'auto' (default) or 'full'" } },
        required: [],
        additionalProperties: true,
    },
};

/**
 * THE ACTION TOOLS AS ONE SMALL TABLE (ticket #94): verb -> argument schema +
 * handler. The phase-1 verbs place / remove / rotate / nudge / reset / trial
 * are six ROWS of data instead of six copied definition/execute chunks - a
 * new tool is a new row, never a re-copied block. Row order is phase-1 order,
 * which is also the advertised order on the wire (the tests pin it).
 *   verb        the tool name: the phase-1 action verb
 *   description the model-facing description, verbatim as the model sees it
 *   parameters  the argument schema (plain JSON schema; strict:false below) -
 *               arguments are parsed but NOT pre-validated here: agent/
 *               actions.js owns validation and answers with its structured
 *               never-throw results, which is the contract the model is
 *               taught (and the tests pin). THE one exception is the trial
 *               row's guard below.
 *   build(args) the EXACT action JSON this verb drives the turn boundary with
 *   guard?      (trial only) pre-validates its clamp knobs through the shared
 *               trialGuardError - out-of-range seconds/dt are refused BEFORE
 *               they can wedge the phase-1 sync trial loop, byte-identically
 *               in both modes (agent/turn.js owns the wording).
 */
const ACTION_TOOLS = Object.freeze([
    {
        verb: 'place',
        description: 'Place a budgeted part at game coordinates (x left-to-right from 0, y grows downward). Types: the state-table vocabulary (ball, ramp, trampoline, domino, fan, balloon, spring, ...).',
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
        build: (args) => ({ action: 'place', type: args.type, x: args.x, y: args.y, angle: args.angle }),
    },
    {
        verb: 'remove',
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
        build: (args) => ({ action: 'remove', type: args.type, slot: args.slot }),
    },
    {
        verb: 'rotate',
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
        build: (args) => ({ action: 'rotate', type: args.type, radians: args.radians, slot: args.slot }),
    },
    {
        verb: 'nudge',
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
        build: (args) => ({ action: 'nudge', type: args.type, dx: args.dx, dy: args.dy, slot: args.slot }),
    },
    {
        verb: 'reset',
        description: 'Wipe all YOUR placements back to the bare level (fixed objects stay).',
        parameters: { type: 'object', properties: {}, required: [], additionalProperties: true },
        build: () => ({ action: 'reset' }),
    },
    {
        verb: 'trial',
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
        guard: trialGuardError,
        build: (args) => ({ action: 'trial', seconds: args.seconds, dt: args.dt }),
    },
]);

/**
 * Container-mode turn transport (ticket #49): every tool turn POSTs the
 * action JSON to the turn service's /turn endpoint - the exact service the
 * Docker image runs, and in issue #65 the exact service the WATCH page
 * drives (the URL is the page's configurable seam). The service answers the
 * SAME { observation, result } envelope runTurn() answers in host mode, so
 * the model sees one contract in every host. config.level stamps EVERY
 * payload (the service scopes its session per request) - that is how the
 * level is selected against the service purely by configuration.
 *
 * NEVER THROWS: a refused connection, a timeout, a non-JSON envelope all
 * come back as the structured { observation, result } data the model is
 * taught to read (parent design rule: HTTP error cases follow the same
 * shape as the never-throw actions).
 * @param {string} turnBaseUrl from TIM_AGENT_TURN_BASE_URL / --turn-base-url / the page's config
 * @param {string} level the driver's configured level id
 */
function createHttpTurnTransport(turnBaseUrl, level) {
    const endpoint = `${turnBaseUrl.replace(/\/+$/, '')}/turn`;
    return {
        async turn(actionJson) {
            const payload = { ...actionJson, level };
            try {
                const res = await fetch(endpoint, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(payload),
                    signal: AbortSignal.timeout(TURN_HTTP_TIMEOUT_MS),
                });
                let body = null;
                try { body = await res.json(); } catch { /* non-JSON -> structured data below */ }
                if (!body || typeof body !== 'object' || body.result === undefined) {
                    return {
                        observation: '(no observation: the turn service answered outside the turn envelope)',
                        result: {
                            ok: false,
                            error: `turn service envelope unreadable (HTTP ${res.status}) at ${endpoint}`,
                        },
                    };
                }
                return {
                    observation: String(body.observation ?? '(no observation in the turn service response)'),
                    result: body.result,
                };
            } catch (err) {
                const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
                const detail = err?.cause?.code ?? err?.cause?.message ?? err?.message ?? String(err);
                return {
                    observation: '(no observation: the turn service is unreachable)',
                    result: {
                        ok: false,
                        error: `turn service unreachable at ${endpoint}: ` +
                            (timedOut ? `no answer within ${TURN_HTTP_TIMEOUT_MS} ms (${detail})` : detail),
                    },
                };
            }
        },
    };
}

export {
    OBSERVE_TOOL,
    INSTRUCTIONS,
    OPENING_DIRECTIVE,
    STALL_NUDGE,
    ACTION_TOOLS,
    asArgs,
    toolOutput,
    createHttpTurnTransport,
};



