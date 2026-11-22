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

import { ACTION_TOOLS, OBSERVE_TOOL, OPENING_DIRECTIVE, STALL_NUDGE, asArgs, createHttpTurnTransport, toolOutput } from '../../agent/driver-protocol.js';
import { runTurn } from '../../agent/turn.js';
import { AgentSession } from '../../agent/session.js';
import { DEFAULT_LEVEL_ID, fetchLevelDocument, levelUrlFor } from './watchFlow.js';
import { SANDBOX_BOARD } from './sandboxFlow.js';

/** The default driver-turn cap - the same number the Node driver enforces. */
export const LIVE_DEFAULT_MAX_TURNS = 20;

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
    let turns = LIVE_DEFAULT_MAX_TURNS;
    if (maxTurns !== undefined) {
        turns = Number(maxTurns);
        if (!(Number.isFinite(turns) && turns >= 1)) {
            errors.push(`invalid max turns: "${maxTurns}" - a number >= 1 is required`);
            turns = LIVE_DEFAULT_MAX_TURNS;
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
export function createChatModelTransport({ baseUrl, model, apiKey, fetchImpl = globalThis.fetch, timeoutMs = MODEL_HTTP_TIMEOUT_MS } = {}) {
    const endpoint = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`;
    return {
        /** One model response per call: { text?, calls, rawMessage?, error? }. */
        async ask(messages) {
            const headers = { 'content-type': 'application/json' };
            if (apiKey) headers.authorization = `Bearer ${apiKey}`; // the key rides the header only
            try {
                const res = await fetchImpl(endpoint, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ model, messages, tools: CHAT_TOOLS }),
                    signal: AbortSignal.timeout(timeoutMs), // a hung provider degrades at the bound, the turn transport's own discipline
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
                // rawMessage rides verbatim: the loop re-posts the assistant turn's
                // tool_calls (with the provider's own ids) into the history and echoes
                // them as tool_call_id - the strict chat-completions contract.
                return { text, calls, rawMessage: message };
            } catch (err) {
                const detail = err?.cause?.code ?? err?.cause?.message ?? err?.message ?? String(err);
                if (err?.name === 'TimeoutError') {
                    return { calls: [], error: `the model provider gave no answer within ${timeoutMs} ms at ${endpoint}` };
                }
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

/** Small capped batches per tick, the WatchFlow bound (ADR 0008's discipline). */
const DEFAULT_MAX_BATCH_FRAMES = 3;

/** The model transport's own HTTP bound - the same number the turn transport carries: a hung provider degrades, never hangs the cycle. */
const MODEL_HTTP_TIMEOUT_MS = 120_000;

/**
 * The envelope failures the loop cannot read through: the transport's own
 * sentences (unreachable / unreadable) and the service's scoping refusals.
 * EVERY other { ok: false } result is an action refusal - DATA, exactly
 * the never-throw contract the model is taught - and the loop continues.
 * @private
 */
const INFRA_FAIL_RE = /turn service unreachable|turn service envelope unreadable|cannot load level|invalid level id/;

const SANDBOX_DEFAULT_RUN_SECONDS = 5;

/**
 * LiveFlow - one live LLM turn source cycle for the watch page (issue #65).
 *
 * Lifecycle: start() installs the page's world (the fetched level doc, or
 * the goal-less sandbox board), takes the OPENING observation through the
 * turn boundary exactly like every model turn (POST /turn with the level
 * stamped, or the in-page runTurn), and rides the driver loop on the
 * page's cadence: a model turn asks the model transport once, executes its
 * tool calls in order (a trial is the watched run - in service mode the
 * page animates its own mirror of the judged trial over the #61 seam; in
 * the in-page posture the watched run IS the judged run and the model
 * waits while the human watches), then asks again. Endings: a judged
 * verdict (reached / failed -> the goal banner payloads), the turn cap
 * (onLiveEnded outcome 'turn-cap'), or a degrade (onDriverError /
 * onServiceUnreachable - never a frozen page: no ticker callback is left
 * armed and the scripted sources stay usable).
 *
 * The listeners are the page's seams: onStatus, onObservation (the model's
 * observation text panel), onEvent (HUD rows with timestamps),
 * onFrame (repaint the board), onWatchOutcome / onSandboxRunEnded (the
 * banner payloads the #62/#64 compositor vocabulary consumes),
 * onLiveEnded (the terminal outcome), onDriverError, onServiceUnreachable.
 */
export class LiveFlow {
    /**
     * @param {{ session?: import('../../agent/session.js').AgentSession,
     *          sandbox?: boolean, levelId?: string, fetchImpl?: typeof fetch,
     *          schedule?: (cb: (now?: number) => void) => number,
     *          model?: { ask(messages: object[]): Promise<{ text?: string,
     *                    calls: Array<{ name: string, args: object }>, rawMessage?: object, error?: string }> },
     *          turns?: { local?: boolean, turn(actionJson: object):
     *                    Promise<{ observation: string, result: object }> },
     *          maxTurns?: number, maxBatchFrames?: number,
     *          listeners?: { onStatus?, onObservation?, onEvent?, onFrame?,
     *                        onWatchOutcome?, onSandboxRunEnded?, onLiveEnded?,
     *                        onDriverError?, onServiceUnreachable? } }} [options]
     */
    constructor({
        session = null,
        sandbox = false,
        levelId = DEFAULT_LEVEL_ID,
        fetchImpl = globalThis.fetch,
        schedule = (cb) => globalThis.requestAnimationFrame(cb),
        model = null,
        turns = null,
        maxTurns = LIVE_DEFAULT_MAX_TURNS,
        maxBatchFrames = DEFAULT_MAX_BATCH_FRAMES,
        listeners = {},
    } = {}) {
        if (!model || typeof model.ask !== 'function') {
            throw new TypeError('LiveFlow needs a model transport (createChatModelTransport) - a { ask } seam');
        }
        if (!turns || typeof turns.turn !== 'function') {
            throw new TypeError('LiveFlow needs a game turn transport (createHttpTurnTransport / createLocalTurnTransport) - a { turn } seam');
        }
        this._isSandbox = !!sandbox;
        this.levelId = levelId;
        this._fetchImpl = fetchImpl;
        this._schedule = schedule;
        this._model = model;
        this._turns = turns;
        this._maxTurns = Number(maxTurns) === maxTurns && Number.isFinite(maxTurns) && maxTurns >= 1 ? maxTurns : LIVE_DEFAULT_MAX_TURNS;
        this._maxBatchFrames = maxBatchFrames;
        this._accCapMs = 50; // placeholder - the cap rides the open run (set in _playTrial)
        this._listeners = listeners;
        // Seed: null keeps the browser-safe unseeded posture (no `process` is
        // consulted); sandbox: true is the goal-less posture (ADR 0011).
        if (session) this.session = session;
        else if (sandbox) this.session = new AgentSession({ seed: null, sandbox: true });
        else this.session = new AgentSession({ seed: null });
        /** @type {'idle'|'loading'|'connecting'|'driving'|'watching'|'ended'|'driver-error'|'cancelled'} */
        this.status = 'idle';
        /** @type {object|null} the judged run's finalized result (the banner payload's source) */
        this.result = null;
        this._run = null;
        this._accMs = 0;
        this._lastNow = null;
        this._eventCursor = 0;
        this._cancelled = false;
        /** @type {((result: object) => void)|null} the trial animation's gate */
        this._watchResolve = null;
    }

    /** @returns {boolean} the cycle reached a terminal status (or never left idle) */
    get done() {
        return ['idle', 'ended', 'driver-error', 'cancelled'].includes(this.status);
    }

    /**
     * The live board the painter draws from - the session's engine objects
     * (the session owns the world; this is its public read).
     * @returns {Array<import('../../js/objects/BaseObject.js').default>}
     */
    liveObjects() {
        return this.session.engine ? [...this.session.engine.getObjects()] : [];
    }

    /**
     * Run the live cycle. Awaits only the SETUP (the world + the opening
     * observation through the turn boundary); the driver loop rides on
     * beyond this promise - pump the page's cadence (the injected schedule)
     * and let the loop's awaited transports advance.
     */
    async start() {
        if (this.status !== 'idle' || this._cancelled) return; // one cycle per flow
        this.status = 'loading';
        try {
            if (this._isSandbox) {
                this._onStatus('sandbox live source - loading the goal-less board...');
                await this.session.loadLevel(SANDBOX_BOARD);
                if (this._cancelled) return;
                this.session.materializeBoard(); // the empty board stands; parts appear from here
                this._onFrame();
                this._onStatus('sandbox - the model builds next');
            } else {
                this._onStatus(`fetching ${levelUrlFor(this.levelId)}...`);
                const doc = await fetchLevelDocument(this.levelId, { fetchImpl: this._fetchImpl });
                if (this._cancelled) return;
                await this.session.loadLevel(doc);
                if (this._cancelled) return;
                this._onLevelLoaded(doc);
                this._onFrame(); // the freshly built board is visible while the model drives
            }
        } catch (e) {
            this._degrade(`the live world could not stand: ${e?.message ?? e}`);
            return;
        }
        if (this._cancelled) return;
        this.status = 'connecting';
        this._onStatus(this._turns.local
            ? 'driving the in-page session (no turn service configured)'
            : 'connecting to the turn service - the game turn boundary');
        const opening = await this._turns.turn({ action: 'observe' });
        if (this._cancelled) return;
        if (this._degradeIfFailed(opening)) return;
        this._onObservation(opening.observation);
        this._driveLoop(opening.observation); // the loop rides on; start() stays awaitable
    }

    /** Abandon the cycle and dispose its session (like every watch flow). */
    cancel() {
        if (this._cancelled) return;
        this._cancelled = true;
        this.session.dispose();
        this.status = 'cancelled';
        this._watchResolve?.(null); // an armed animation drains to a no-op
        this._watchResolve = null;
    }

    // ---- the driver loop: one model response per turn ----

    /** @private */
    async _driveLoop(openingObservation) {
        const goalLine = String(openingObservation ?? '').split('\n')[0] ?? '';
        const messages = [
            { role: 'user', content: `${goalLine}\n\nInitial observation:\n${openingObservation}\n\n${OPENING_DIRECTIVE}` },
        ];
        let turnsUsed = 0;
        try {
            for (let turn = 1; turn <= this._maxTurns; turn++) {
                if (this._cancelled) return;
                this.status = 'driving';
                turnsUsed = turn;
                this._onStatus(`asking the model - turn ${turn} of ${this._maxTurns}`);
                const answer = await this._model.ask(messages);
                if (this._cancelled) return;
                if (answer.error) {
                    this._degrade(answer.error);
                    return;
                }
                messages.push({
                    role: 'assistant',
                    content: answer.text ?? null,
                    ...(answer.rawMessage?.tool_calls?.length ? { tool_calls: answer.rawMessage.tool_calls } : {}),
                });
                if (!answer.calls || answer.calls.length === 0) {
                    // The Node driver's stall posture: a text-only turn is nudged,
                    // still counted against the cap - the model cannot run forever.
                    messages.push({ role: 'user', content: STALL_NUDGE });
                    this._onStatus(`turn ${turn}: the model answered text only - nudged to call one tool`);
                    continue;
                }
                const rawCalls = answer.rawMessage?.tool_calls ?? [];
                let verdict = null;
                for (let i = 0; i < answer.calls.length; i++) {
                    if (this._cancelled) return;
                    const call = answer.calls[i];
                    const output = await this._executeCall(call);
                    if (this._cancelled) return;
                    if (output === null) return; // a degrade handled the turn boundary's end
                    messages.push({
                        role: 'tool',
                        tool_call_id: rawCalls[i]?.id ?? `call_${i}`,
                        content: output.json,
                    });
                    if (output.result?.outcome === 'reached' || output.result?.outcome === 'failed') {
                        verdict = output.result.outcome;
                    }
                }
                if (verdict) {
                    this.status = 'ended';
                    this._onStatus(`the model's ${verdict === 'reached' ? 'machine reached the goal' : 'run failed'} after ${turn} model turn(s)`);
                    this._onLiveEnded({ outcome: verdict === 'reached' ? 'goal-reached' : 'goal-failed', turns: turn });
                    return;
                }
            }
            if (this._cancelled) return; // cancelled over the last turn: no ghost cap banner over the takeover
            this.status = 'ended';
            this._onLiveEnded({ outcome: 'turn-cap', turns: turnsUsed });
            this._onStatus(`the live source used its ${turnsUsed} turns - the cap is the driver's, not the model's`);
        } catch (e) {
            this._degrade(`live driver loop error: ${e?.message ?? String(e)}`);
        }
    }

    /**
     * Execute ONE tool call against the turn boundary. Returns the tool
     * message payload { json, result } - or null when the cycle degraded
     * (the loop ends).
     * @private
     */
    async _executeCall(call) {
        const name = String(call?.name ?? '');
        const args = call?.args && typeof call.args === 'object' && !Array.isArray(call.args) ? call.args : {};
        if (name === 'observe') {
            const envelope = await this._turns.turn({ action: 'observe', cell: args.cell });
            if (this._cancelled) return null; // cancelled mid-turn: the takeover path keeps the new cycle's HUD
            if (this._degradeIfFailed(envelope)) return null;
            this._onObservation(envelope.observation);
            this._onStatus('the model re-read the world');
            return { json: toolOutput({ action: 'observe' }, envelope), result: envelope.result };
        }
        const row = ACTION_TOOLS.find((candidate) => candidate.verb === name);
        if (!row) {
            // An invented tool is data: the model reads the refusal like any other.
            this._onStatus(`the model tried an unknown tool (${name}) - refused as data`);
            return {
                json: JSON.stringify({ action: name, result: { ok: false, error: `unknown tool: ${name}` }, observation: null }),
                result: { ok: false, error: `unknown tool: ${name}` },
            };
        }
        const guard = row.guard ? row.guard(args) : null;
        if (guard) {
            // The clamp refusal reads the world back and keeps the run - the
            // tool contract's shape in both drivers, byte-identical wording.
            const readBack = await this._turns.turn({ action: 'observe' });
            if (this._degradeIfFailed(readBack)) return null;
            this._onObservation(readBack.observation);
            this._onStatus(`the model's ${name} was refused at the clamp - ${guard}`);
            return {
                json: JSON.stringify({ action: name, result: { ok: false, error: guard }, observation: readBack.observation }),
                result: { ok: false, error: guard },
            };
        }
        const actionJson = row.build(args);
        if (actionJson.action === 'trial') return this._executeTrial(actionJson, args);
        // Every other verb rides the boundary, then applies LIVE on the page's
        // own session through the same never-throw action API.
        const envelope = await this._turns.turn(actionJson);
        if (this._cancelled) return null; // cancelled mid-turn: no ghost observation, status or mirror
        if (this._degradeIfFailed(envelope)) return null;
        this._onObservation(envelope.observation);
        this._applyLive(actionJson);
        this._onStatus(envelope.result.ok
            ? `the model ${this._verbSentence(actionJson, envelope.result)}`
            : `the model's ${actionJson.action} was refused as data - ${envelope.result.error}`);
        return { json: toolOutput(actionJson, envelope), result: envelope.result };
    }

    /** Human sentence for a verb that landed (the status line narrates the model's move). @private */
    _verbSentence(actionJson, result) {
        switch (actionJson.action) {
            case 'place': return `placed ${result.type} at (${result.x}, ${result.y})`;
            case 'rotate': return `rotated ${actionJson.type}`;
            case 'nudge': return `nudged ${actionJson.type}`;
            case 'remove': return `removed ${actionJson.type}`;
            case 'reset': return 'reset its placements';
            default: return `${actionJson.action} happened`;
        }
    }

    /**
     * Apply the model's action to the page's own session (LIVE placement -
     * the watched world). The in-page posture's transport ALREADY ran
     * runTurn over this session, so only the re-materialized board is
     * painted; the service posture mirrors the envelope locally.
     * @private
     */
    _applyLive(actionJson) {
        if (!this._turns.local) {
            runTurn(actionJson, this.session); // the same action JSON on the mirror session (same code, same doc)
        }
        if (this._isSandbox) {
            this.session.materializeBoard(); // the part appears live (the #64 build view)
        }
        this._onFrame();
    }

    /**
     * The trial turn: in the in-page posture the watched run IS the judged
     * run (the model waits while the human watches it play). In the service
     * posture the service judges all-at-once (the envelope the model reads)
     * and the page animates its own mirror of the same deterministic trial
     * over the #61 seam, capped batches on the page's cadence.
     * @private
     */
    async _executeTrial(actionJson, args) {
        const seconds = args.seconds;
        const dt = args.dt;
        if (!this._turns.local) {
            const judged = await this._turns.turn(actionJson); // the service judges the model's run
            if (this._cancelled) return null; // cancelled mid-turn
            if (this._degradeIfFailed(judged)) return null;
            this._onObservation(judged.observation);
            const watched = await this._playTrial({ seconds, dt }); // the same trial, re-watched live
            if (this._cancelled) return null; // cancelled mid-turn
            if (watched && judged.result?.outcome && watched.outcome !== judged.result.outcome) {
                // Mirror parity is by construction for the same placements; a
                // verdict mismatch is REPORTED as data, never hidden.
                this._onStatus(`mirror note: the watched run ended ${watched.outcome}, the service judged ${judged.result.outcome}`);
            }
            const envelope = { observation: judged.observation, result: judged.result };
            this.result = judged.result;
            this._finishTrialBanner(judged.result, seconds);
            return { json: toolOutput(actionJson, envelope), result: judged.result };
        }
        const watched = await this._playTrial({ seconds, dt });
        if (this._cancelled || watched === null) return null;
        const readBack = await this._turns.turn({ action: 'observe' }); // the post-run observation, events narrated
        if (this._cancelled) return null; // cancelled mid-turn
        if (this._degradeIfFailed(readBack)) return null;
        this._onObservation(readBack.observation);
        this.result = watched;
        this._finishTrialBanner(watched, seconds);
        return {
            json: JSON.stringify({ action: 'trial', result: watched, observation: readBack.observation }),
            result: watched,
        };
    }

    /** One banner payload per finalized run - the #62/#64 compositors' inputs. @private */
    _finishTrialBanner(result, seconds) {
        if (this._isSandbox) {
            this._onSandboxRunEnded(result, { stopped: false, seconds: seconds ?? SANDBOX_DEFAULT_RUN_SECONDS });
        } else {
            this._onWatchOutcome(result);
        }
    }

    /**
     * Open the steppable trial (the #61 seam), animate it in small capped
     * batches on the page's cadence and resolve with the finalized result.
     * @private
     */
    _playTrial({ seconds, dt } = {}) {
        this.status = 'watching';
        this._run = this.session.beginTrial({ seconds, dt });
        // The accumulator cap rides the run (the dt-bound): one tick may
        // spend at most a full batch's worth of the run's own dt, so a
        // coarse custom-dt trial (the model's mirror quanta) still moves a
        // whole batch per paced tick instead of starving under the default
        // wall-clock cap - ADR 0008's cadence discipline stays whole.
        this._accCapMs = this._maxBatchFrames * this._run.dt;
        this._accMs = 0;
        this._lastNow = null;
        this._eventCursor = 0;
        this._onStatus(`the model tests the machine - watching the run live (${this._run.steps} frame budget)`);
        return new Promise((resolve) => {
            this._watchResolve = resolve;
            this._schedule((now) => this._watchTick(now));
        });
    }

    /** @private */
    _watchTick(now) {
        if (this._cancelled || !this._run) {
            if (this._watchResolve) { const r = this._watchResolve; this._watchResolve = null; r(null); }
            return;
        }
        // Wall-clock pacing (the WatchFlow accumulator discipline, ADR 0008):
        // whole frames of the run's own dt per tick, the batch capped at
        // maxBatchFrames - never a whole trial in one call.
        if (this._lastNow !== null && typeof now === 'number') {
            this._accMs = Math.min(this._accMs + Math.max(0, now - this._lastNow), this._accCapMs);
        }
        if (typeof now === 'number') this._lastNow = now;
        let frames = Math.floor(this._accMs / this._run.dt);
        if (frames > this._maxBatchFrames) frames = this._maxBatchFrames;
        this._accMs -= frames * this._run.dt;
        if (this._accMs < 0) this._accMs = 0;
        const response = this.session.advanceTrial(frames);
        this._onFrame();
        this._emitNewEvents();
        if (!response.done) {
            this._schedule((t) => this._watchTick(t));
            return;
        }
        const result = this.session.finalizeTrial();
        this._emitNewEvents(); // rows landed between the last paint and finalize
        this._run = null;
        this.status = 'driving';
        this._onStatus(`run ended - ${result.outcome}`);
        if (this._watchResolve) { const r = this._watchResolve; this._watchResolve = null; r(result); }
    }

    /** @private */
    _emitNewEvents() {
        const onEvent = this._listeners.onEvent;
        if (!onEvent || !this._run) return; // (the run's recorder rows as they happen)
        const rows = this._run.events ?? [];
        if (rows.length > this._eventCursor) {
            onEvent(rows.slice(this._eventCursor));
            this._eventCursor = rows.length;
        }
    }

    /**
     * Envelope failures the loop cannot read through degrade the cycle;
     * action refusals ({ok: false} game data) ride as data. @private
     */
    _degradeIfFailed(envelope) {
        if (!envelope || typeof envelope !== 'object' || !envelope.result || envelope.result.ok !== false) return false;
        const error = String(envelope.result.error ?? '');
        if (INFRA_FAIL_RE.test(error)) {
            const unreachable = /unreachable/.test(error);
            this._degrade(error, { unreachable });
            return true;
        }
        return false;
    }

    /**
     * Degrade the cycle: a clear terminal error state, no callback armed,
     * the scripted sources still usable (the never-frozen rule).
     * @private
     */
    _degrade(message, { unreachable = false } = {}) {
        this.status = 'driver-error';
        if (unreachable) {
            this._onServiceUnreachable({ message });
            this._onStatus('the turn service is unreachable - the scripted watch stays usable');
        } else {
            this._onDriverError({ message });
            this._onStatus('the live source ended on an error - the scripted watch stays usable');
        }
    }

    // ---- page seams (one place, never scattered) ----

    /** @private */ _onStatus(text) { this._listeners.onStatus?.(text); }
    /** @private */ _onObservation(text) { this._listeners.onObservation?.(text); }
    /** @private */ _onEvent(rows) { this._listeners.onEvent?.(rows); }
    /** @private */ _onFrame() { this._listeners.onFrame?.(); }
    /** @private */ _onWatchOutcome(result) { this._listeners.onWatchOutcome?.(result); }
    /** @private */ _onSandboxRunEnded(result, meta) { this._listeners.onSandboxRunEnded?.(result, meta); }
    /** @private */ _onLiveEnded(payload) { this._listeners.onLiveEnded?.(payload); }
    /** @private */ _onDriverError(payload) { this._listeners.onDriverError?.(payload); }
    /** @private */ _onServiceUnreachable(payload) { this._listeners.onServiceUnreachable?.(payload); }
    /** @private */ _onLevelLoaded(doc) { this._listeners.onLevelLoaded?.(doc); }
}
