/**
 * watchFlow - the watch page's run controller (issue #62).
 *
 * Solve & Watch, driven headlessly over the phase-1 surface only, for a
 * page that stays responsive:
 *
 * - the browser fetches the level JSON itself (ADR 0010 keeps
 *   AgentSession's fs loader Node-only) and hands the session the level
 *   data object;
 * - the scripted solver searches through its steppable facade
 *   (solveTrials), one judged candidate per scheduled tick - progress
 *   streams, the page never blocks on the search;
 * - the winning trial is then stepped over the steppable trial seam
 *   (#61) in small advance batches on the page's own cadence - the
 *   wall-clock accumulator keeps whole FIXED_STEP_MS quanta per tick and
 *   caps the batch, ADR 0008's discipline - so the playfield animates at
 *   interactive rates without ever stepping a whole trial in one call;
 * - the event log (the #78 owner facts -> the recorder rows) streams to
 *   the HUD as it happens, and the finalized result ends the run with the
 *   outcome banner payload (goal reached / failed / timeout).
 *
 * Watching never mutates player state: this controller never touches the
 * progress, recorder or editor machinery - none of those components is
 * even constructed here (ADR 0010); unseeded construction (seed: null - a
 * browser page has no process env) keeps the trials deterministic, the
 * same trials trial() judges.
 */

import { place, reset as resetPlacements } from '../../agent/actions.js';
import { AgentSession } from '../../agent/session.js';
import { solveTrials } from '../../agent/solver.js';
import { FIXED_STEP_MS } from '../../js/engine/GameLoop.js';

/** The page's default subject: Solve & Watch targets level-01 (issue #62). */
export const DEFAULT_LEVEL_ID = 'level-01';

/** The URL the campaign loader fetches the same file from. */
export function levelUrlFor(levelId) {
    return `/js/levels/puzzles/${levelId}.json`;
}

/**
 * The browser's own level loader (ADR 0010): fetch the served level JSON,
 * parse it, hand the raw document back. Validation stays where it lives -
 * AgentSession.loadLevel (the object branch) answers to the level owner's
 * schema gate when the document is installed.
 * @param {string} levelId
 * @param {{ fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<object>} the parsed level document
 */
export async function fetchLevelDocument(levelId, { fetchImpl = globalThis.fetch } = {}) {
    const url = levelUrlFor(levelId);
    let resp;
    try {
        resp = await fetchImpl(url);
    } catch (e) {
        throw new Error(`[watch] level fetch failed for ${url}: ${e?.message ?? e}`);
    }
    if (!resp.ok) throw new Error(`[watch] level fetch failed: HTTP ${resp.status} for ${url}`);
    let doc;
    try {
        doc = await resp.json();
    } catch {
        throw new Error(`[watch] the fetched level document is malformed JSON for ${url}`);
    }
    return doc;
}

/** One HUD event line - the same sentence shape trial observations render. */
export function formatEventRow(row) {
    return `t=${row?.t ?? '?'}s  ${row?.text ?? ''}`;
}

/**
 * The run banner payload (goal reached / failed / timeout).
 * @param {{ outcome: string, elapsed: number, failureReason?: string }} result
 * @returns {{ label: string, text: string }}
 */
export function bannerForRunResult(result) {
    const seconds = (result.elapsed / 1000).toFixed(2);
    switch (result.outcome) {
        case 'reached':
            return { label: 'GOAL REACHED', text: `the target reached the zone - the run ended at ${seconds}s` };
        case 'failed':
            return { label: 'RUN FAILED', text: result.failureReason ?? 'the goal was not reached' };
        case 'timeout':
            return { label: 'TIMEOUT', text: `the run stepped out of its ${seconds}s budget without a verdict` };
        default:
            return { label: 'RUN ENDED', text: `outcome: ${result.outcome}` };
    }
}

/**
 * WatchFlow - one Solve & Watch cycle on one session.
 *
 * Lifecycle: start() fetches the level, installs it, runs the solver, and
 * - on a win - opens the steppable trial and animates it (startWatch, the
 * page's direct rewatch seam too). Every page tick goes through the
 * injected `schedule` (requestAnimationFrame in the browser, a manual
 * pump in tests); between ticks the caller may read the live run view
 * (session.trialRun). The listeners are the page's seams: onStatus
 * (progress text), onEvent (new HUD rows with timestamps), onFrame
 * (repaint the board), onWatchOutcome (the banner payload),
 * onSolverUnsolved (a clean, reported no-win), onError.
 */
export class WatchFlow {
    /**
     * @param {{ session?: import('../../agent/session.js').AgentSession,
     *          levelId?: string, fetchImpl?: typeof fetch,
     *          schedule?: (cb: (now?: number) => void) => number,
     *          maxBatchFrames?: number, watchSeconds?: number,
     *          maxTrials?: number, secondsPerTrial?: number, lattice?: number,
     *          listeners?: { onStatus?, onEvent?, onFrame?, onWatchOutcome?, onSolverUnsolved?, onError? } }} [options]
     */
    constructor({
        session = null,
        levelId = DEFAULT_LEVEL_ID,
        fetchImpl = globalThis.fetch,
        schedule = (cb) => globalThis.requestAnimationFrame(cb),
        maxBatchFrames = 3, // small batches: at most ~3 catch-up quanta per tick (ADR 0008's bound)
        watchSeconds = 5,
        maxTrials = 800,
        secondsPerTrial = 5,
        lattice = 50,
        listeners = {},
    } = {}) {
        // seed: null keeps the browser-safe unseeded posture: no `process`
        // env is consulted (a page has none), and the trials stay the
        // deterministic trials trial() judges (ADR 0010).
        this.session = session ?? new AgentSession({ seed: null });
        this.levelId = levelId;
        this._fetchImpl = fetchImpl;
        this._schedule = schedule;
        this._maxBatchFrames = maxBatchFrames;
        this._accCapMs = 50; // the wall-clock accumulator cap, ADR 0008's spiral bound
        this._solveOptions = { maxTrials, secondsPerTrial, lattice };
        this._watchSeconds = watchSeconds;
        this._listeners = listeners;
        /** @type {'idle'|'loading'|'solving'|'watching'|'ended'|'unsolved'|'error'|'cancelled'} */
        this.status = 'idle';
        /** @type {object|null} the solver's final report, once found */
        this.solverReport = null;
        /** @type {object|null} the watched run's finalized trial result */
        this.result = null;
        this._solverIterator = null;
        this._run = null;
        this._accMs = 0;
        this._lastNow = null;
        this._eventCursor = 0;
        this._cancelled = false;
    }

    /** @returns {boolean} the cycle reached a terminal status (or never left idle) */
    get done() {
        return ['idle', 'ended', 'unsolved', 'error', 'cancelled'].includes(this.status);
    }

    /**
     * Run the cycle: fetch -> install -> solve -> (on a win) animate the
     * winning trial. Resolves when the cycle reached a terminal status or
     * handed stepping over to the scheduler; it never rejects.
     */
    async start() {
        if (this.status !== 'idle') return; // one cycle per flow
        this.status = 'loading';
        this._onStatus(`fetching ${levelUrlFor(this.levelId)}...`);
        let doc;
        try {
            doc = await fetchLevelDocument(this.levelId, { fetchImpl: this._fetchImpl });
            if (this._cancelled) return; // the fetch landed after the cycle was abandoned
            await this.session.loadLevel(doc);
        } catch (e) {
            this._fail(e);
            return;
        }
        if (this._cancelled) return;
        this._onLevelLoaded(doc);
        this._onFrame(); // the freshly built board (the level furniture) is visible while solving
        this.status = 'solving';
        try {
            this._solverIterator = solveTrials(this.session, this._solveOptions);
        } catch (e) {
            this._fail(e);
            return;
        }
        this._onStatus('solving - the scripted solver searches for winning placements');
        // The search never blocks the page, not even its first candidate:
        // every judgment rides a scheduled tick (the page's frame cadence).
        this._schedule(() => this._pumpSolver());
    }

    /**
     * Abandon the cycle and dispose its session (the world a run watches
     * belongs to the session - it must not outlive the page's interest).
     */
    cancel() {
        if (this._cancelled) return;
        this._cancelled = true;
        this.session.dispose();
        this.status = 'cancelled';
    }

    /**
     * The live board the painter draws from - the engine's current objects
     * (the session owns the world; this is its public read).
     * @returns {Array<import('../../js/objects/BaseObject.js').default>}
     */
    liveObjects() {
        return this.session.engine ? [...this.session.engine.getObjects()] : [];
    }

    // ---- the solver phase: one judged candidate per scheduled tick ----

    /** @private */
    _pumpSolver() {
        if (this._cancelled) return;
        let step;
        try {
            step = this._solverIterator.next();
        } catch (e) {
            this._fail(e);
            return;
        }
        if (step.done) {
            this._solverFinished(step.value);
            return;
        }
        this._onStatus(`solving - trial #${step.value.trials}`);
        this._schedule(() => this._pumpSolver());
    }

    /** @private */
    _solverFinished(report) {
        if (this._cancelled) return;
        this.solverReport = report;
        if (report.outcome !== 'reached') {
            // Reported, not fixed: a no-win search ends the cycle with the
            // diagnosis as data (the charter rule - level-04 stays a clean
            // failure, never a hang or a crash).
            this.status = 'unsolved';
            this._onSolverUnsolved(report);
            this._onStatus(`solver could not win this level - ${report.diagnosis}`);
            return;
        }
        const summary = (report.placements ?? [])
            .map((p) => `${p.type} at (${p.x}, ${p.y})`)
            .join(', ');
        this._onStatus(`solved after ${report.trials} trial(s) - ${summary} - watching the winning trial`);
        this.startWatch(report.placements);
    }

    /**
     * Watch a placements run play out over the steppable seam - the watch
     * phase of the Solve & Watch cycle, and the page's direct rewatch seam
     * (#64 drives it too). The placements go on the session through the
     * phase-1 surface (reset + place); the steppable trial is then opened
     * (beginTrial, the #61 seam), and each scheduled tick advances a small,
     * capped batch of frames - the playfield animates live at interactive
     * rates, never stepping a whole trial in one call. Ends with the
     * finalized-run banner payload (onWatchOutcome).
     * @param {Array<{type: string, x: number, y: number, angle?: number}>} placements
     * @param {{ seconds?: number }} [options]
     */
    startWatch(placements, { seconds = this._watchSeconds } = {}) {
        if (this._cancelled) {
            throw new Error('[WatchFlow] this flow was cancelled - start a new one to watch again');
        }
        try {
            resetPlacements(this.session);
            for (const p of placements) {
                const r = place(this.session, p.type, p.x, p.y, { angle: p.angle ?? 0 });
                if (!r.ok) throw new Error(`[WatchFlow] placement refused: ${r.error}`);
            }
        } catch (e) {
            this._fail(e);
            return;
        }
        this.status = 'watching';
        try {
            // The steppable trial the all-at-once trial() composes (#61):
            // the watched frames are the frames the solver judgment ran.
            this._run = this.session.beginTrial({ seconds });
        } catch (e) {
            this._fail(e);
            return;
        }
        this._accMs = 0;
        this._lastNow = null;
        this._eventCursor = 0;
        this._schedule((now) => this._tick(now));
    }

    // ---- the watch phase: small advance batches on the page's cadence ----

    /** @private */
    _tick(now) {
        if (this._cancelled || !this._run) return;
        // Wall-clock pacing (ADR 0008's accumulator discipline): whole
        // FIXED_STEP_MS quanta per tick, the over-cap part bounded - the
        // sim runs close to real time and a stall can never fire a whole
        // trial in one tick, because the batch is capped at maxBatchFrames.
        if (this._lastNow !== null && typeof now === 'number') {
            this._accMs = Math.min(this._accMs + Math.max(0, now - this._lastNow), this._accCapMs);
        }
        if (typeof now === 'number') this._lastNow = now;
        let frames = Math.floor(this._accMs / FIXED_STEP_MS);
        if (frames > this._maxBatchFrames) frames = this._maxBatchFrames;
        this._accMs -= frames * FIXED_STEP_MS;
        if (this._accMs < 0) this._accMs = 0;

        const response = this.session.advanceTrial(frames);
        this._onFrame();
        this._emitNewEvents();
        if (!response.done) {
            this._schedule((t) => this._tick(t));
            return;
        }
        this._finishWatch();
    }

    /** @private */
    _finishWatch() {
        const result = this.session.finalizeTrial();
        this._emitNewEvents(); // rows landed between the last paint and finalize
        this.result = result;
        this._run = null;
        this.status = 'ended';
        this._onWatchOutcome(result);
        this._onStatus(`run ended - ${result.outcome}`);
    }

    /** @private */
    _emitNewEvents() {
        const onEvent = this._listeners.onEvent;
        if (!onEvent || !this._run) return;
        const rows = this._run.events ?? [];
        if (rows.length > this._eventCursor) {
            onEvent(rows.slice(this._eventCursor));
            this._eventCursor = rows.length;
        }
    }

    /** @private */
    _fail(e) {
        this.status = 'error';
        this._onError(e?.message ?? String(e));
        this._onStatus('the watch could not run - see the error');
    }

    // ---- page seams (one place, never scattered) ----

    /** @private */ _onStatus(text) { this._listeners.onStatus?.(text); }
    /** @private */ _onEvent(rows) { this._listeners.onEvent?.(rows); }
    /** @private */ _onFrame() { this._listeners.onFrame?.(); }
    /** @private */ _onWatchOutcome(result) { this._listeners.onWatchOutcome?.(result); }
    /** @private */ _onSolverUnsolved(report) { this._listeners.onSolverUnsolved?.(report); }
    /** @private */ _onLevelLoaded(doc) { this._listeners.onLevelLoaded?.(doc); }
    /** @private */ _onError(message) { this._listeners.onError?.(message); }
}

