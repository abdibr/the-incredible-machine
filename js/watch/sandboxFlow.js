/**
 * sandboxFlow - the sandbox view's run controller (issue #64).
 *
 * The second watch flow: a goal-less sandbox session (ADR 0011) whose
 * board is built by a deterministic script and then played, over the same
 * seams the Solve & Watch cycle already uses:
 *
 * - the board starts EMPTY (loadLevel of the posture's minimal goal-less
 *   board document), then the scripted build applies its placement beats
 *   one per paced tick through the phase-1 action API; after every beat
 *   the session re-materializes the board (materializeBoard, the build
 *   side of "construction IS the restore") and the part appears live. A
 *   refused beat is data: the status narrates it and the build moves on;
 * - Run opens the steppable trial (beginTrial, the #61 seam) over the
 *   built placements and advances it in small capped batches on the
 *   page's cadence - the same watch machinery as the level view; the run
 *   ends by its BUDGET or a manual stop (stopRun), and the finalized
 *   result the sandbox posture judges is always 'timeout': NO goal banner
 *   ever - bannerForSandboxResult composes only stop/timeout payloads and
 *   the event log tells the story (a bucket catch is data, not a verdict,
 *   ADR 0011);
 * - Reset returns the board to empty (reset): an interrupted run is
 *   finalized first - its owned loop:reset end fact lands, the run-end
 *   banner does NOT (a reset is not a run story) - the placements are
 *   wiped, the board re-materialized empty and the cycle returns to
 *   idle, one start() away from a fresh build.
 *
 * The two-phase Pause and the run-phase single-frame step land behind
 * their own pinned red tests, one cycle per acceptance criterion.
 *
 * Watching never mutates player state: no recorder, no editor, no
 * progress marks - none of that machinery is even constructed here
 * (ADR 0010). The session is the browser posture: unseeded (a page has
 * no process env) and born goal-less.
 */

import { reset as resetPlacements } from '../../agent/actions.js';
import { AgentSession } from '../../agent/session.js';
import { FIXED_STEP_MS } from '../../js/engine/GameLoop.js';
import {
    SANDBOX_BUILD_SCRIPT,
    SANDBOX_RUN_SECONDS,
    applyBuildBeat,
    beatLabel,
} from './sandboxScript.js';

/**
 * The goal-less board document the sandbox watch builds on (issue #63's
 * minimal sandbox doc: id, name, the empty board - no goal, no budget, no
 * ADR 0009 solution proof; none of the puzzle's furniture).
 */
export const SANDBOX_BOARD = {
    id: 'sandbox-watch-board',
    name: "Sandbox - the agent's empty board",
    fixedObjects: [],
};

/**
 * The run banner payload a sandbox run ends with (issue #64): the sandbox
 * posture judges NOTHING, so the labels are only stop and timeout - the
 * goal verdict vocabulary (reached / failed) can never come out of this
 * compositor.
 * @param {{ outcome: string, elapsed: number }} result the finalized run result
 * @param {{ stopped?: boolean, seconds?: number }} [options] a manual stop and the run's budget
 * @returns {{ label: string, text: string, kind: 'stopped'|'timeout'|'ended' }}
 */
export function bannerForSandboxResult(result, { stopped = false, seconds = SANDBOX_RUN_SECONDS } = {}) {
    const spent = ((result?.elapsed ?? 0) / 1000).toFixed(2);
    const budget = (seconds ?? SANDBOX_RUN_SECONDS).toFixed(2);
    if (stopped) {
        return {
            label: 'RUN STOPPED',
            text: `stopped at ${spent}s of its ${budget}s budget - sandbox judges no goal; the event log is the story`,
            kind: 'stopped',
        };
    }
    if (result?.outcome === 'timeout') {
        return {
            label: 'TIMEOUT',
            text: `the run stepped out of its ${budget}s budget with no verdict - sandbox judges no goal; the event log is the story`,
            kind: 'timeout',
        };
    }
    return { label: 'RUN ENDED', text: `outcome: ${result?.outcome ?? '?'}`, kind: 'ended' };
}

/**
 * SandboxFlow - the sandbox watch cycle's controller (issue #64).
 *
 * Lifecycle: start() installs the goal-less board document and applies
 * the scripted build, one beat per paced tick (status 'building' ->
 * 'built'); run() opens the steppable trial over the built placements
 * and animates it ('running'), ending by its budget or a manual stop
 * ('ended') with the never-a-goal-banner payload; reset() returns the
 * board to empty ('idle'). Every page tick rides the injected
 * `schedule` (requestAnimationFrame in the browser, a manual pump in
 * tests); between ticks the caller may read the live board (liveObjects)
 * and the open run (session.trialRun). The listeners are the page's
 * seams: onBoardLoaded (the board document), onStatus, onEvent (HUD rows
 * as they happen), onFrame (repaint the board), onSandboxRunEnded (the
 * run-end payload), onError.
 */
export class SandboxFlow {
    /**
     * @param {{ session?: import('../../agent/session.js').AgentSession,
     *          script?: Array<object>, boardDocument?: object,
     *          runSeconds?: number, buildBeatMs?: number, maxBatchFrames?: number,
     *          schedule?: (cb: (now?: number) => void) => number,
     *          listeners?: { onBoardLoaded?, onStatus?, onEvent?, onFrame?,
     *                        onSandboxRunEnded?, onError? } }} [options]
     */
    constructor({
        session = null,
        script = null,
        boardDocument = SANDBOX_BOARD,
        runSeconds = SANDBOX_RUN_SECONDS,
        buildBeatMs = 400, // the build's page pacing: one beat every ~400ms wall clock
        maxBatchFrames = 3, // the run's per-tick batch cap (the WatchFlow bound)
        schedule = (cb) => globalThis.requestAnimationFrame(cb),
        listeners = {},
    } = {}) {
        // seed: null keeps the browser-safe unseeded posture (no `process`
        // is consulted); sandbox: true is the goal-less posture (ADR 0011):
        // the parts palette as the placement budget, no goal checker.
        this.session = session ?? new AgentSession({ seed: null, sandbox: true });
        this._script = script ?? SANDBOX_BUILD_SCRIPT;
        this._boardDocument = boardDocument;
        this._runSeconds = runSeconds;
        this._maxBatchFrames = maxBatchFrames;
        this._accCapMs = 50; // the run's wall-clock accumulator cap (the ADR 0008 spiral bound)
        this._schedule = schedule;
        this._listeners = listeners;
        /** @type {'idle'|'building'|'built'|'running'|'ended'|'cancelled'|'error'} */
        this.status = 'idle';
        /** @type {object|null} the last finalized run's result (null until one ends) */
        this.result = null;
        /** @type {'manual'|'budget'|null} how the last run ended */
        this.stoppedHow = null;
        this._beatIndex = 0;
        this._buildAccMs = 0;
        this._buildLast = null;
        this._run = null;
        this._accMs = 0;
        this._lastNow = null;
        this._eventCursor = 0;
        this._cancelled = false;
    }

    /**
     * Start the cycle: install the goal-less board document (the empty
     * playfield) and begin the scripted build on the scheduler. Resolves
     * once the board stands; the beats then ride the cadence.
     */
    async start() {
        if (this._cancelled || this.status !== 'idle') return;
        this.status = 'building';
        this._beatIndex = 0;
        this._buildAccMs = 0;
        this._buildLast = null;
        this._onStatus('sandbox - loading the empty board...');
        try {
            await this.session.loadLevel(this._boardDocument);
        } catch (e) {
            this._fail(e); // a refused board document ends the cycle as data
            return;
        }
        if (this._cancelled) return; // the load landed after the cycle was abandoned
        this._onBoardLoaded(this._boardDocument);
        this.session.materializeBoard(); // the empty board stands; parts appear from here
        this._onFrame();
        this._onStatus('build starts - the scripted placements apply live');
        this._schedule((now) => this._pumpBuild(now));
    }

    /**
     * Play the built contraption (issue #64): open the steppable trial
     * over the current placements (the #61 seam) and advance it in small
     * batches on the page's cadence, exactly like a watched level run.
     */
    run() {
        if (this._cancelled) return;
        if (this.status !== 'built' && this.status !== 'ended') return; // build first (or re-play an ended board)
        this.status = 'running';
        this.result = null;
        this.stoppedHow = null;
        this._accMs = 0;
        this._lastNow = null;
        this._eventCursor = 0;
        try {
            this._run = this.session.beginTrial({ seconds: this._runSeconds });
        } catch (e) {
            this._fail(e);
            return;
        }
        this._onStatus(`run open - the built machine plays (${this._runSeconds}s budget - sandbox judges no goal)`);
        this._schedule((now) => this._tickRun(now));
    }

    /**
     * Abandon the cycle and dispose its session (the worlds a build or a
     * run watch belong to the session - they must not outlive the page's
     * interest in this cycle).
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

    /** Manual stop (issue #64): end the running trial now - stopping, not budgeting out. */
    stopRun() {
        if (this._cancelled || this.status !== 'running' || !this._run) return null;
        this._finishRun(true);
        return this.result;
    }

    /**
     * Reset (issue #64): the board returns to empty. An open run is
     * finalized first - its owned loop:reset end fact lands, the run-end
     * banner does not (a reset is not a run story) - the placements are
     * wiped and the empty board stands again; status back to idle, one
     * start() away from a fresh build.
     */
    reset() {
        if (this._cancelled) return;
        if (this.session.trialRun) this.session.finalizeTrial(); // close the interrupted run's fact stream
        resetPlacements(this.session);
        this._beatIndex = 0;
        this._buildAccMs = 0;
        this._buildLast = null;
        this._run = null;
        this._accMs = 0;
        this._lastNow = null;
        this._eventCursor = 0;
        this.result = null;
        this.stoppedHow = null;
        this.status = 'idle';
        this.session.materializeBoard(); // the empty board (the board doc carries no furniture)
        this._onFrame();
        this._onStatus('reset - the board is empty again');
    }

    // ---- the build phase: one scripted beat per paced tick ----

    /** @private */
    _pumpBuild(now) {
        if (this._cancelled || this.status !== 'building') return;
        if (this._beatIndex >= this._script.length) {
            this.status = 'built';
            this._onStatus('build complete - press Run to watch the machine play');
            return;
        }
        // Wall-clock pacing: one beat per ~buildBeatMs of page time; the
        // accumulator caps at the beat interval, so a stall can never
        // fast-forward the script.
        if (typeof now === 'number' && this._buildLast !== null) {
            this._buildAccMs = Math.min(this._buildAccMs + Math.max(0, now - this._buildLast), this._buildBeatMs);
        }
        if (typeof now === 'number') this._buildLast = now;
        if (this._buildAccMs < this._buildBeatMs) {
            this._schedule((t) => this._pumpBuild(t));
            return;
        }
        this._buildAccMs = 0;
        this._applyNextBeat();
    }

    /** @private */
    _applyNextBeat() {
        const beat = this._script[this._beatIndex];
        this._beatIndex++;
        const result = applyBuildBeat(this.session, beat);
        this.session.materializeBoard(); // the beat's placement stands on the board (issue #64)
        this._onFrame();
        const progress = `beat ${this._beatIndex}/${this._script.length}`;
        this._onStatus(result.ok
            ? `building - ${progress}: ${beatLabel(beat)}`
            // Reported, never thrown: a refused beat is data (the never-throw
            // result envelope does not judge the script).
            : `building - ${progress} refused - ${result.error}`);
        this._schedule((t) => this._pumpBuild(t));
    }

    // ---- the run phase: small advance batches on the page's cadence ----

    /** @private */
    _tickRun(now) {
        if (this._cancelled || this.status !== 'running' || !this._run) return;
        // Wall-clock pacing (the WatchFlow accumulator, ADR 0008's discipline):
        // whole FIXED_STEP_MS quanta per tick, the batch capped at
        // maxBatchFrames - real-time pacing, never a whole trial in one call.
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
            this._schedule((t) => this._tickRun(t));
            return;
        }
        this._finishRun(false); // the budget stepped out - the outcome the sandbox posture judges
    }

    /** @private */
    _finishRun(stopped) {
        const result = this.session.finalizeTrial();
        this._emitNewEvents(); // rows landed between the last paint and finalize
        this._run = null;
        this.result = result;
        this.stoppedHow = stopped ? 'manual' : 'budget';
        this.status = 'ended';
        this._onSandboxRunEnded(result, { stopped, seconds: this._runSeconds });
        this._onStatus(stopped
            ? `run stopped at ${(result.elapsed / 1000).toFixed(2)}s of its ${this._runSeconds}s budget - the log has the story`
            : `run ended - ${result.outcome} - sandbox judges no goal, the log has the story`);
    }

    /** @private */
    _emitNewEvents() {
        const onEvent = this._listeners.onEvent;
        if (!onEvent || !this._run) return; // the build emits no run rows (no recorder is open)
        const rows = this._run.events ?? [];
        if (rows.length > this._eventCursor) {
            onEvent(rows.slice(this._eventCursor));
            this._eventCursor = rows.length;
        }
    }

    // ---- page seams (one place, never scattered) ----

    /** @private */ _onBoardLoaded(doc) { this._listeners.onBoardLoaded?.(doc); }
    /** @private */ _onStatus(text) { this._listeners.onStatus?.(text); }
    /** @private */ _onFrame() { this._listeners.onFrame?.(); }
    /** @private */ _onSandboxRunEnded(result, meta) { this._listeners.onSandboxRunEnded?.(result, meta); }
    /** @private */ _onError(message) { this._listeners.onError?.(message); }
}
