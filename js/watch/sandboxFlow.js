/**
 * sandboxFlow - the sandbox view's run controller (issue #64).
 *
 * The second watch flow: a goal-less sandbox session (ADR 0011) whose
 * board is built by a deterministic script, over the same seams the
 * Solve & Watch cycle already uses. This is the BUILD half of the cycle:
 *
 * - the board starts EMPTY (loadLevel of the posture's minimal goal-less
 *   board document), then the scripted build applies its placement beats
 *   one per paced tick through the phase-1 action API; after every beat
 *   the session re-materializes the board (materializeBoard, the build
 *   side of "construction IS the restore") and the part appears live. A
 *   refused beat is data: the status narrates it and the build moves on.
 *
 * The play half (Run over the steppable seam with the event HUD, ending
 * by timeout or manual stop - never a goal banner), Reset, the two-phase
 * Pause and the run-phase single-frame step land behind their own pinned
 * red tests, one cycle per acceptance criterion.
 *
 * Watching never mutates player state: no recorder, no editor, no
 * progress marks - none of that machinery is even constructed here
 * (ADR 0010). The session is the browser posture: unseeded (a page has
 * no process env) and born goal-less.
 */

import { AgentSession } from '../../agent/session.js';
import { SANDBOX_BUILD_SCRIPT, applyBuildBeat, beatLabel } from './sandboxScript.js';

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
 * SandboxFlow - the sandbox watch cycle's controller (issue #64).
 *
 * Lifecycle (this module's build half): start() installs the goal-less
 * board document and applies the scripted build, one beat per paced tick
 * (status 'building' -> 'built'). Every page tick rides the injected
 * `schedule` (requestAnimationFrame in the browser, a manual pump in
 * tests); between ticks the caller may read the live board
 * (liveObjects). The listeners are the page's seams: onBoardLoaded (the
 * board document), onStatus (the build's narration, refusals included),
 * onFrame (repaint the board), onError.
 */
export class SandboxFlow {
    /**
     * @param {{ session?: import('../../agent/session.js').AgentSession,
     *          script?: Array<object>, boardDocument?: object,
     *          buildBeatMs?: number,
     *          schedule?: (cb: (now?: number) => void) => number,
     *          listeners?: { onBoardLoaded?, onStatus?, onFrame?, onError? } }} [options]
     */
    constructor({
        session = null,
        script = null,
        boardDocument = SANDBOX_BOARD,
        buildBeatMs = 400, // the build's page pacing: one beat every ~400ms wall clock
        schedule = (cb) => globalThis.requestAnimationFrame(cb),
        listeners = {},
    } = {}) {
        // seed: null keeps the browser-safe unseeded posture (no `process`
        // is consulted); sandbox: true is the goal-less posture (ADR 0011):
        // the parts palette as the placement budget, no goal checker.
        this.session = session ?? new AgentSession({ seed: null, sandbox: true });
        this._script = script ?? SANDBOX_BUILD_SCRIPT;
        this._boardDocument = boardDocument;
        this._buildBeatMs = buildBeatMs;
        this._schedule = schedule;
        this._listeners = listeners;
        /** @type {'idle'|'building'|'built'|'cancelled'|'error'} */
        this.status = 'idle';
        this._beatIndex = 0;
        this._buildAccMs = 0;
        this._buildLast = null;
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
     * Abandon the cycle and dispose its session (the world a build watches
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

    // ---- page seams (one place, never scattered) ----

    /** @private */ _onBoardLoaded(doc) { this._listeners.onBoardLoaded?.(doc); }
    /** @private */ _onStatus(text) { this._listeners.onStatus?.(text); }
    /** @private */ _onFrame() { this._listeners.onFrame?.(); }
    /** @private */ _onError(message) { this._listeners.onError?.(message); }
}