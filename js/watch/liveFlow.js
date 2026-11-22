/**
 * liveFlow - the live LLM turn source in the watch page (issue #65).
 *
 * The page's driver becomes the real phase-2 agent: a browser driver loop
 * that speaks the SAME protocol agent/driver.js speaks (one shared leaf,
 * agent/driver-protocol.js - ADR 0010 grants the watch sidecar its agent
 * imports) and drives the game through the turn boundary:
 *
 * - the MODEL seam: an OpenAI-compatible chat-completions endpoint
 *   (configurable base URL + model name, exactly the provider contract the
 *   driver documents). One tool call expected per model turn - the loop
 *   executes it, appends the structured tool result, and asks again;
 * - the GAME seam: the headless turn service's /turn envelope at a
 *   configurable URL (createHttpTurnTransport, the same transport the
 *   container-mode driver POSTs through) - or, with no service configured,
 *   the IN-PAGE posture (createLocalTurnTransport: the page's own session
 *   through runTurn, byte-for-byte host mode);
 * - the WATCH: every returned action JSON is applied live through the
 *   never-throw action API on the page's own session - the watched world
 *   the #62/#64 postures own - and the observation text the model received
 *   renders in the page's panel next to the board. Trials play over the
 *   #61 steppable seam in small advance batches on the page's cadence.
 *
 * Connection trouble degrades gracefully (never a frozen watch): a
 * transport failure is structured data, the model provider's error status
 * is structured data, and the loop ends with clear error payloads while
 * the scripted sources (WatchFlow, SandboxFlow) stay usable.
 *
 * The configuration contract (resolveLiveDriverConfig) mirrors the driver
 * resolver's shape: { errors, config | null } - model + model endpoint are
 * required, the turn service URL and maxTurns/level/apiKey are knobs.
 */

import { ACTION_TOOLS, OBSERVE_TOOL, asArgs, createHttpTurnTransport } from '../../agent/driver-protocol.js';
import { runTurn } from '../../agent/turn.js';
import { DEFAULT_LEVEL_ID } from './watchFlow.js';

/** The default driver-turn cap - the same number the Node driver enforces. */
const DEFAULT_MAX_TURNS = 20;

/** The default level the live source drives (the page's subject). */
export const LIVE_DEFAULT_LEVEL = DEFAULT_LEVEL_ID;

const HTTP_URL_RE = /^https?:\/\//i;

/**
 * Resolve + validate the browser driver's configuration. Pure - the page
 * passes its inputs; nothing here reads process/env (a browser page has
 * none, ADR 0010's posture).
 * @param {{ model?: string, modelBaseUrl?: string, turnBaseUrl?: string,
 *           apiKey?: string, maxTurns?: number|string, level?: string }} options
 * @returns {{ errors: string[], config: null | {
 *   model: string, modelBaseUrl: string, turnBaseUrl?: string, apiKey?: string,
 *   maxTurns: number, level: string }}}
 */
export function resolveLiveDriverConfig({ model, modelBaseUrl, turnBaseUrl, apiKey, maxTurns, level = DEFAULT_LEVEL_ID } = {}) {
    const errors = [];

    if (!model) {
        errors.push('no model configured: set model (the live source needs a model name as the provider knows it)');
    }
    if (!modelBaseUrl) {
        errors.push('no model base URL: set modelBaseUrl (the OpenAI-compatible chat-completions endpoint)');
    }
    if (modelBaseUrl !== undefined && !HTTP_URL_RE.test(modelBaseUrl)) {
        errors.push(`invalid model base URL: "${modelBaseUrl}" - an http(s):// URL is required`);
    }
    if (turnBaseUrl !== undefined && !HTTP_URL_RE.test(turnBaseUrl)) {
        errors.push(`invalid turn base URL: "${turnBaseUrl}" - an http(s):// URL is required`);
    }
    let turns = DEFAULT_MAX_TURNS;
    if (maxTurns !== undefined) {
        turns = Number(maxTurns);
        if (!(Number.isFinite(turns) && turns >= 1)) {
            errors.push(`invalid max turns: "${maxTurns}" - a number >= 1 is required`);
            turns = DEFAULT_MAX_TURNS;
        }
    }
    if (level !== undefined && (typeof level !== 'string' || level.trim() === '')) {
        errors.push('invalid level: a puzzle id is required (the service scopes its session by it)');
    }

    if (errors.length) return { errors, config: null };
    return {
        errors: [],
        config: Object.freeze({
            model,
            modelBaseUrl,
            turnBaseUrl,
            apiKey,
            maxTurns: turns,
            level,
        }),
    };
}

/** The chat-completions tool descriptors: the observation entry point first, then the action rows. */
const CHAT_TOOLS = [OBSERVE_TOOL, ...ACTION_TOOLS].map((row) => ({
    type: 'function',
    function: {
        name: row.name ?? row.verb,
        description: row.description,
        parameters: row.parameters,
    },
}));

/**
 * The OpenAI-compatible chat-completions model transport - the MODEL seam
 * the browser driver asks through. NEVER THROWS: provider errors,
 * unreachable endpoints and unreadable bodies all come back as structured
 * data ({ error }) the loop degrades on - the same shape convention the
 * turn transport keeps.
 * @param {{ baseUrl: string, model: string, apiKey?: string,
 *          fetchImpl?: typeof fetch }} config - baseUrl the chat-completions
 *   root (e.g. http://127.0.0.1:11434/v1), apiKey the optional bearer key.
 * @returns {{ ask(messages: Array<object>): Promise<{
 *   text?: string, calls: Array<{ name: string, args: object }>, error?: string }> }}
 */
export function createChatModelTransport({ baseUrl, model, apiKey, fetchImpl = globalThis.fetch } = {}) {
    const endpoint = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`;
    return {
        /** One model response per call: { text?, calls, error? }. */
        async ask(messages) {
            const headers = { 'content-type': 'application/json' };
            if (apiKey) headers.authorization = `Bearer ${apiKey}`; // the key rides the header only
            try {
                const res = await fetchImpl(endpoint, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ model, messages, tools: CHAT_TOOLS }),
                });
                if (!res.ok) {
                    return { calls: [], error: `model provider HTTP ${res.status} at ${endpoint}` };
                }
                let body = null;
                try { body = await res.json(); } catch {
                    return { calls: [], error: `model provider answered outside the chat-completions shape at ${endpoint}` };
                }
                const message = body?.choices?.[0]?.message;
                if (!message || typeof message !== 'object') {
                    return { calls: [], error: `model provider answered without a message at ${endpoint}` };
                }
                const calls = (message.tool_calls ?? []).map((call) => {
                    const fn = call?.function ?? {};
                    return { name: String(fn.name ?? ''), args: asArgs(fn.arguments) };
                });
                const text = typeof message.content === 'string' && message.content.trim() !== '' ? message.content : undefined;
                return { text, calls };
            } catch (err) {
                const detail = err?.cause?.code ?? err?.cause?.message ?? err?.message ?? String(err);
                return { calls: [], error: `model provider unreachable at ${endpoint}: ${detail}` };
            }
        },
    };
}

/**
 * The IN-PAGE turn transport (no turn service configured): the page's own
 * session through runTurn - byte-for-byte what the Node driver's host mode
 * executes, which makes "no service" a first-class configuration, not a
 * degradation. The sandbox watch drives this posture by construction (the
 * goal-less board lives on the page, ADR 0011).
 * @param {import('../../agent/session.js').AgentSession} session
 * @returns {{ local: true, turn(actionJson: object): Promise<{ observation: string, result: object }> }}
 */
export function createLocalTurnTransport(session) {
    return {
        local: true, // the flow mirrors nothing: this transport IS the page's game
        async turn(actionJson) {
            return runTurn(actionJson, session);
        },
    };
}

export { createHttpTurnTransport };
