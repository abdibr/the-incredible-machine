/**
 * GameLoop — Play/pause/reset state machine
 *
 * Controls simulation lifecycle with requestAnimationFrame,
 * speed scaling, fixed-timestep stepping (accumulator; issue #80), and
 * snapshot management.
 */

import { eventBus } from '../EventBus.js';

/**
 * Fixed physics step in ms (issue #80): frames of ANY rate feed an
 * accumulator; physics advances only in quanta of this — one Engine.update +
 * one loop:frame per quantum — so runs record a frame-rate-independent dt
 * stream (every row ≡ 1000/60) that the replay harness consumes bit-exactly
 * (ADR 0006 decision 2). Same double the `AgentSession.trial()` headless loop
 * uses as its `dt` default.
 */
export const FIXED_STEP_MS = 1000 / 60;

/** @enum {string} */
export const LoopState = Object.freeze({
    STOPPED: 'stopped',
    RUNNING: 'running',
    PAUSED: 'paused',
});

export class GameLoop {
    /**
     * @param {import('./PhysicsEngine.js').PhysicsEngine} physics
     * @param {(objects: Set, physics: import('./PhysicsEngine.js').PhysicsEngine) => void} renderCallback
     */
    constructor(physics, renderCallback) {
        /** @type {import('./PhysicsEngine.js').PhysicsEngine} */
        this.physics = physics;

        /** @type {Function} */
        this._renderCallback = renderCallback;

        /** @type {string} */
        this._state = LoopState.STOPPED;

        /** @type {number|null} */
        this._rafId = null;

        /** @type {number} Elapsed simulation time in ms */
        this._elapsed = 0;

        /** @type {number} Last rAF timestamp */
        this._lastTimestamp = 0;

        /** @type {number} Carried sim ms not yet stepped (fixed-timestep accumulator) */
        this._accumulator = 0;

        /** @type {number} 1 or 2 */
        this._speed = 1;

        /** @type {number} Max dt cap to prevent spiral of death (ms) */
        this._maxDt = 50;

        // Bind the frame method
        this._frame = this._frame.bind(this);
    }

    // ── State Queries ─────────────────────────────

    /** @returns {string} */
    get state() { return this._state; }

    /** @returns {boolean} */
    get isRunning() { return this._state === LoopState.RUNNING; }

    /** @returns {boolean} */
    get isPaused() { return this._state === LoopState.PAUSED; }

    /** @returns {boolean} */
    get isStopped() { return this._state === LoopState.STOPPED; }

    /** @returns {number} */
    get elapsed() { return this._elapsed; }

    /** @returns {number} */
    get speed() { return this._speed; }

    // ── Controls ──────────────────────────────────

    /** Start or resume the simulation. */
    play() {
        if (this._state === LoopState.RUNNING) return;

        if (this._state === LoopState.STOPPED) {
            // Take snapshot on first play so we can reset
            this.physics.takeSnapshot();
            this._elapsed = 0;
        }

        this._state = LoopState.RUNNING;
        this._lastTimestamp = 0;
        this._accumulator = 0; // fresh step budget after any play/pause gap
        this._rafId = requestAnimationFrame(this._frame);

        eventBus.emit('loop:play', { elapsed: this._elapsed });
    }

    /** Pause the simulation (can resume). */
    pause() {
        if (this._state !== LoopState.RUNNING) return;

        this._state = LoopState.PAUSED;
        if (this._rafId !== null) {
            cancelAnimationFrame(this._rafId);
            this._rafId = null;
        }

        eventBus.emit('loop:pause', { elapsed: this._elapsed });
    }

    /** Stop and reset to the snapshot. */
    reset() {
        if (this._rafId !== null) {
            cancelAnimationFrame(this._rafId);
            this._rafId = null;
        }

        this._state = LoopState.STOPPED;
        this._elapsed = 0;
        this._lastTimestamp = 0;
        this._accumulator = 0;

        // Restore physics to snapshot
        this.physics.restoreSnapshot();
        this.physics.clearSnapshot();

        // One final render to show restored state
        this._renderCallback(this.physics.getObjects(), this.physics);
        // (`loop:reset` was pruned — no listener; reset side-effects happen
        // inline above: snapshot restore + final render.)
    }

    /** Toggle between 1× and 2× speed. */
    cycleSpeed() {
        this._speed = this._speed === 1 ? 2 : 1;
        this.physics.setTimeScale(this._speed);
        eventBus.emit('loop:speed', { speed: this._speed });
    }

    // ── Frame Loop ────────────────────────────────

    /**
     * @private
     * @param {number} timestamp — rAF timestamp in ms
     */
    _frame(timestamp) {
        if (this._state !== LoopState.RUNNING) return;

        // Calculate frame delta
        if (this._lastTimestamp === 0) {
            this._lastTimestamp = timestamp;
        }

        let frameDt = timestamp - this._lastTimestamp;
        this._lastTimestamp = timestamp;

        // Cap frame delta to prevent death spirals after tab stalls
        if (frameDt > this._maxDt) frameDt = this._maxDt;
        if (frameDt <= 0) frameDt = FIXED_STEP_MS; // first frame after play()

        // Fixed-timestep stepping (issue #80): frames of ANY rate feed the
        // accumulator; physics advances only in exact FIXED_STEP_MS quanta —
        // one Engine.update + one loop:frame per quantum, in the step →
        // elapsed → emit order the replay harness mirrors (ADR 0006
        // decision 2). A run's recorded dt stream is therefore uniform
        // 1000/60 rows, frame-rate-independent and replay-bit-exact. The
        // sub-quantum remainder carries forward; the over-cap part is
        // dropped (at most ~3 catch-up steps per frame, no spiral of death).
        this._accumulator += frameDt;
        while (this._accumulator >= FIXED_STEP_MS) {
            this.physics.step(FIXED_STEP_MS);
            this._accumulator -= FIXED_STEP_MS;
            this._elapsed += FIXED_STEP_MS;
            eventBus.emit('loop:frame', { dt: FIXED_STEP_MS, elapsed: this._elapsed });
        }

        // Render once per frame, after all of the frame's sub-steps
        this._renderCallback(this.physics.getObjects(), this.physics);

        // Schedule next frame
        this._rafId = requestAnimationFrame(this._frame);
    }

    // ── Cleanup ───────────────────────────────────

    /** Stop the loop and release resources. */
    dispose() {
        if (this._rafId !== null) {
            cancelAnimationFrame(this._rafId);
            this._rafId = null;
        }
        this._state = LoopState.STOPPED;
    }
}

export default GameLoop;
