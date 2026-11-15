/**
 * runTurn - THE turn boundary of the agent layer.
 *
 * One named seam: observation in, action JSON in, { observation, result }
 * out. Pure composition of the phase-1 modules - agent/actions.js applies
 * the action (never throws, structured failure results), describeWorld()
 * renders the post-action observation. Nothing here knows about LLMs,
 * containers or HTTP; agent/server.js and the later driver wrap THIS seam.
 *
 * @param {object|null} actionJson e.g. { action: 'place', type: 'ball', x: 700, y: 100 }
 *   - optional observation options ride along: { cell, grid, key, state, graph }
 * @param {import('./session.js').AgentSession|null} session the world owner
 * @returns {{ observation: string, result: object }} the action result +
 *          post-action observation, ALWAYS both keys - rejected and
 *          malformed turns included (never throws)
 */

import { place, remove, rotate, nudge, reset, trial } from './actions.js';
import { describeWorld } from './observe/describe.js';

/** The action verbs runTurn dispatches on - the known set, ever. */
export const KNOWN_ACTIONS = ['place', 'remove', 'rotate', 'nudge', 'reset', 'trial', 'observe'];

/**
 * THE trial clamps - the single source of truth shared by agent/server.js
 * (the structured 400 refusal BEFORE runTurn) and agent/driver.js (the
 * trial tool's pre-validation): phase-1 trial() is a sync loop, so absurd
 * seconds/dt must be refused at the turn boundary, never reach the loop.
 */
export const MAX_TRIAL_SECONDS = 120;
export const MAX_TRIAL_DT = 1000;

/**
 * The trial clamp guard: a refusal STRING for out-of-range trial knobs, or
 * null when the trial request is sane. One wording everywhere - the
 * "one contract in both modes" rule (server 400 == driver tool result).
 * @param {{ seconds?: unknown, dt?: unknown }} args
 * @returns {string|null}
 */
export function trialGuardError(args) {
    if (args?.seconds !== undefined) {
        const n = Number(args.seconds);
        if (!(Number.isFinite(n) && n > 0 && n <= MAX_TRIAL_SECONDS)) {
            return `trial seconds must be a number between 0 and ${MAX_TRIAL_SECONDS} (got ${JSON.stringify(args.seconds)})`;
        }
    }
    if (args?.dt !== undefined) {
        const n = Number(args.dt);
        if (!(Number.isFinite(n) && n >= 1 && n <= MAX_TRIAL_DT)) {
            return `trial dt must be a number between 1 and ${MAX_TRIAL_DT} ms (got ${JSON.stringify(args.dt)})`;
        }
    }
    return null;
}

/** One stable wording for a turn payload that is not a usable action object. */
const MALFORMED_ERROR = 'malformed request: an action turn must be a JSON object with an "action" field';

/**
 * @private
 * @param {*} actionJson
 * @returns {boolean} whether the payload names a dispatchable action
 */
function isActionJson(actionJson) {
    return (
        !!actionJson &&
        typeof actionJson === 'object' &&
        !Array.isArray(actionJson) &&
        typeof actionJson.action === 'string' &&
        actionJson.action.trim() !== ''
    );
}

/** Pull the observation options out of the action JSON (undefined = describeWorld defaults). @private */
function observationOptions(actionJson) {
    const o = actionJson ?? {};
    return {
        cell: o.cell,
        grid: o.grid,
        key: o.key,
        state: o.state,
        graph: o.graph,
    };
}

/** Format an events narrative for the observation - null when there are no rows. @private */
function eventsSection(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return null;
    return ['events:', ...rows.map((r) => `- t=${r.t}s  ${r.text}`)].join('\n');
}

/**
 * Run ONE turn against the session: apply the action, observe the world.
 * Synchronous - placements are cheap bookkeeping, trial steps are bounded.
 *
 * @param {object|null} actionJson
 * @param {import('./session.js').AgentSession|null} session
 * @returns {{ observation: string, result: object }}
 */
export function runTurn(actionJson, session) {
    if (!session) {
        return {
            observation: '(no session)',
            result: { ok: false, error: 'no session: runTurn(actionJson, session) needs a loaded AgentSession' },
        };
    }

    if (!isActionJson(actionJson)) {
        return { observation: describeWorld(session, observationOptions(actionJson)), result: { ok: false, error: MALFORMED_ERROR } };
    }

    let result;
    switch (actionJson.action) {
        case 'place':
            result = place(session, actionJson.type, actionJson.x, actionJson.y, { angle: actionJson.angle });
            break;
        case 'remove':
            result = remove(session, actionJson.type, actionJson.slot);
            break;
        case 'rotate':
            result = rotate(session, actionJson.type, actionJson.slot, actionJson.radians);
            break;
        case 'nudge':
            result = nudge(session, actionJson.type, actionJson.dx, actionJson.dy, actionJson.slot);
            break;
        case 'reset':
            result = reset(session);
            break;
        case 'trial':
            result = trial(session, { seconds: actionJson.seconds, dt: actionJson.dt });
            break;
        case 'observe':
            result = { ok: true, action: 'observe' };
            break;
        default:
            return {
                observation: describeWorld(session, observationOptions(actionJson)),
                result: {
                    ok: false,
                    error: `unknown action: "${actionJson.action}" (expected one of: ${KNOWN_ACTIONS.join(', ')})`,
                },
            };
    }
    // Trial turns narrate their fresh event stream; observe replays the last
    // trial's narrative. Mutating turns append nothing - stale events lie.
    const events = actionJson.action === 'trial' ? result?.events : (actionJson.action === 'observe' ? session.lastEventSentences : null);
    const sections = [describeWorld(session, observationOptions(actionJson)), eventsSection(events)].filter(Boolean);
    return { observation: sections.join('\n\n'), result };
}
