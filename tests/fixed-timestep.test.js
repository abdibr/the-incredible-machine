/**
 * Fixed-timestep physics stepping (issue #80) — bug-20261027T151221Z-0txh
 * ("ball flung into the ceiling"; a 30 fps recording stepped raw frame dt,
 * diverging frame by frame from any 60 fps view of the same board).
 *
 * The single seam is GameLoop._frame: it must advance physics only in exact
 * FIXED_DT_MS = 1000/60 quanta via an accumulator — one Engine.update and
 * one loop:frame emission per quantum (the step→emit order the replay
 * harness mirrors, ADR 0006 decision 2) — so:
 *   - a 33.33 ms frame (30 fps) performs two sub-steps, a 16.67 ms frame
 *     performs one, a 5 ms frame performs none (remainder carried forward);
 *   - the same scenario driven at 60 fps, 30 fps, or jittered frame rates
 *     evolves into the bit-identical world (frame-rate independence);
 *   - freshly recorded runs (including 2×-speed ones) replay bit-exactly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eventBus } from '../js/EventBus.js';
import { objectRegistry } from '../js/objects/ObjectRegistry.js';
import { registerAllObjects } from '../js/objects/registerAllObjects.js';
import { PhysicsEngine } from '../js/engine/PhysicsEngine.js';
import { GameLoop } from '../js/engine/GameLoop.js';
import { SessionRecorder } from '../js/recorder/SessionRecorder.js';
import { replayBugFile } from '../js/recorder/replay.js';
import { BUGFILE_SCHEMA_VERSION } from '../js/recorder/schema.js';

registerAllObjects();

/** The fixed physics quantum — identical double to the recorded dt rows. */
const DT = 1000 / 60; // 16.666666666666668

/** Fresh physics + loop with a noop render callback. */
function makeLoop() {
    const physics = new PhysicsEngine(1000, 600);
    const loop = new GameLoop(physics, () => {});
    return { physics, loop };
}

/** Bug-20261023T180834Z-gwce shape: bowling ball dropped onto a spring. */
function makeSpringScenario() {
    const { physics, loop } = makeLoop();
    const spring = objectRegistry.create('spring', 500, 500);
    const ball = objectRegistry.create('ball', 500, 224, { variant: 'bowling' });
    physics.addObject(spring);
    physics.addObject(ball);
    return { physics, loop, spring, ball };
}

/**
 * Tap loop:frame packets, mirroring what SessionRecorder sees.
 * The caller must push this unsub onto its disposable list.
 */
function tapFrames(unsubs) {
    const packets = [];
    unsubs.push(eventBus.on('loop:frame', (packet) => packets.push(packet)));
    return packets;
}

/**
 * Drive loop._frame until physics.step has run exactly `target` times;
 * ratePattern supplies per-frame ms deltas. The final approach switches to
 * 5 ms frames (≤1 step each), so every rate lands on the exact same count.
 * (vi.spyOn wraps the original — physics still runs under the spy.)
 */
function driveToSteps(loop, stepSpy, target, ratePattern, t0 = 1000) {
    let t = t0;
    let i = 0;
    loop._frame(t); // priming frame: play() zeroed lastTimestamp → dt<=0 path
    while (stepSpy.mock.calls.length < target && i < ratePattern.length) {
        const remaining = target - stepSpy.mock.calls.length;
        const frameDt = remaining <= 2 ? 5 : ratePattern[i++];
        loop._frame(t += frameDt);
    }
}

describe('GameLoop fixed-timestep stepping (issue #80)', () => {
    /** @type {Array<() => void>} */
    let unsubs;

    beforeEach(() => {
        vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
        vi.stubGlobal('cancelAnimationFrame', vi.fn());
        unsubs = [];
    });

    afterEach(() => {
        for (const unsub of unsubs) unsub();
        unsubs.length = 0;
        vi.unstubAllGlobals();
    });

    it('splits a 33.33 ms frame into exactly two fixed sub-steps, one loop:frame each', () => {
        const { physics, loop } = makeLoop();
        const stepSpy = vi.spyOn(physics, 'step');
        const packets = tapFrames(unsubs);

        loop.play();
        loop._frame(1000); // priming frame: the dt<=0 fallback is one fixed step
        loop._frame(1033.34); // deliberately ≥ 2×DT → a two-sub-step frame

        // 1 (prime) + 2 sub-steps
        expect(stepSpy.mock.calls.length).toBe(3);
        expect(stepSpy.mock.calls.every((call) => call[0] === DT)).toBe(true);

        expect(packets.length).toBe(3); // one emission per sub-step
        expect(packets[1]).toEqual({ dt: DT, elapsed: 2 * DT });
        expect(packets[2]).toEqual({ dt: DT, elapsed: 3 * DT });
    });

    it('performs zero physics steps on a sub-step frame, carrying the remainder', () => {
        const { physics, loop } = makeLoop();
        const stepSpy = vi.spyOn(physics, 'step');
        const packets = tapFrames(unsubs);

        loop.play();
        loop._frame(1000); // prime: exactly one step, accumulator drained
        const afterPrime = stepSpy.mock.calls.length;

        loop._frame(1005); // +5 ms < DT → no step may run
        expect(stepSpy.mock.calls.length).toBe(afterPrime);

        loop._frame(1021.67); // +16.67 ms → 5 + 16.67 ≥ DT → exactly one step
        expect(stepSpy.mock.calls.length).toBe(afterPrime + 1);

        expect(packets.length).toBe(2); // only the two stepped frames emitted
        expect(packets.every((packet) => packet.dt === DT)).toBe(true);
    });

    it('caps a stalled frame: a 200 ms stall advances at most three quanta, never spirals', () => {
        const { physics, loop } = makeLoop();
        const stepSpy = vi.spyOn(physics, 'step');
        const packets = tapFrames(unsubs);

        loop.play();
        loop._frame(1000); // prime: one step
        loop._frame(1200); // 200 ms stall → capped to _maxDt(50) → two quanta
        // (the 50 ms cap is one ulp below 3×DT → 2 quanta + carried remainder)
        expect(stepSpy.mock.calls.length).toBe(3);

        loop._frame(1201); // +1 ms drains the carried remainder → one step
        expect(stepSpy.mock.calls.length).toBe(4);

        loop._frame(1206); // +5 ms < carried remainder → no step
        expect(stepSpy.mock.calls.length).toBe(4);

        expect(packets.length).toBe(4);
        expect(packets.every((packet) => packet.dt === DT)).toBe(true);
        expect(packets[3].elapsed).toBeCloseTo(4 * DT, 10);
    });

    it('is frame-rate independent: 60 fps, 30 fps and jittered frames evolve into the bit-identical world', () => {
        const TARGET = 121; // same Engine.update count for every rate
        const patterns = {
            '60 fps': Array(140).fill(16.67),
            '30 fps': Array(80).fill(33.33),
            jittered: Array.from({ length: 120 }, (_, i) => [8, 25.33, 16.67, 33.33, 12.5, 20.83][i % 6]),
        };

        const outcomes = {};
        for (const [label, pattern] of Object.entries(patterns)) {
            const { physics, loop, ball } = makeSpringScenario();
            const stepSpy = vi.spyOn(physics, 'step');
            const dts = [];
            let minVy = 0;
            const unsub = eventBus.on('loop:frame', (packet) => {
                dts.push(packet.dt);
                minVy = Math.min(minVy, ball.bodies[0].velocity.y); // per tick, post-step
            });

            loop.play();
            driveToSteps(loop, stepSpy, TARGET, pattern);

            outcomes[label] = {
                timestamp: physics.engine.timing.timestamp,
                x: ball.bodies[0].position.x,
                y: ball.bodies[0].position.y,
                minVy,
                dts,
            };
            unsub(); // drop this run's tap before the next rate runs
            physics.dispose();
        }

        const [a, b, c] = [outcomes['60 fps'], outcomes['30 fps'], outcomes.jittered];

        // Same Engine.update sequence → bit-identical sim clock and world.
        expect(b.timestamp).toBe(a.timestamp);
        expect(c.timestamp).toBe(a.timestamp);
        expect(b.x).toBe(a.x);
        expect(b.y).toBe(a.y);
        expect(c.x).toBe(a.x);
        expect(c.y).toBe(a.y);
        expect(b.minVy).toBe(a.minVy);
        expect(c.minVy).toBe(a.minVy);

        // Sanity: the spring launch fired in all rates (Δv ≈ −22 px/tick).
        expect(a.minVy).toBeLessThan(-20);

        // Recorded dt stream is frame-rate independent (recorder, ADR 0006).
        expect(b.dts).toEqual(a.dts);
        expect(c.dts).toEqual(a.dts);
        expect(a.dts.length).toBe(TARGET);
        expect(a.dts.every((dt) => dt === DT)).toBe(true);
    });

    it('bugfile acceptance: the 0txh scene at 30 fps follows the 60 fps trajectory bit-exactly', () => {
        // The reported scene (bug-20261027T151221Z-0txh): spring @ launchForce
        // 0.08 (its 8 px `spring-platform` body), tennis ball dropped from
        // y ≈ 414. Variable-dt stepping made the 30 fps burst 3.5×
        // (Δv = F/m·dt² ≈ 77) — ceiling slam at tick 34, pass-through of the
        // spring platform on re-entry (no CCD), settle below the base. With
        // fixed stepping the burst magnitude is frame-rate independent (the
        // tuned ≈ 22 px/tick), so both rates produce the identical run. The
        // exact base-relative end state belongs to the original board
        // geometry (not in-repo); here both runs must agree bit-exactly and
        // come to rest.
        const makeBugScene = () => {
            const physics = new PhysicsEngine(1000, 600);
            const spring = objectRegistry.create('spring', 500, 500, { launchForce: 0.08 });
            const ball = objectRegistry.create('ball', 500, 414, { variant: 'tennis' });
            physics.addObject(spring);
            physics.addObject(ball);
            return { physics, loop: new GameLoop(physics, () => {}), ball };
        };

        const runScene = (pattern) => {
            const { physics, loop, ball } = makeBugScene();
            const stepSpy = vi.spyOn(physics, 'step');
            let maxAbsVy = 0;
            const frameUnsub = eventBus.on('loop:frame', () => {
                const vy = ball.bodies[0].velocity.y;
                if (Math.abs(vy) > maxAbsVy) maxAbsVy = Math.abs(vy);
            });
            loop.play();
            driveToSteps(loop, stepSpy, 560, pattern);
            frameUnsub();
            const body = ball.bodies[0];
            return {
                x: body.position.x,
                y: body.position.y,
                vy: body.velocity.y,
                maxAbsVy,
                sleeping: body.isSleeping,
                timestamp: physics.engine.timing.timestamp,
            };
        };

        const slow = runScene(Array.from({ length: 700 }, () => 33.33)); // ~30 fps
        const fast = runScene(Array.from({ length: 700 }, () => 16.67)); // 60 fps

        // The 30 fps run follows the 60 fps trajectory bit-exactly.
        expect(slow).toEqual(fast);

        // Launched at the tuned magnitude in both runs (the bug's 3.5× wrap
        // only existed under variable dt) and comes to rest by the end.
        expect(slow.sleeping).toBe(true);
        expect(Math.abs(slow.vy)).toBeLessThan(0.05);

        // No tunneling: fixed stepping keeps the worst per-tick speed ≲ 24 px
        // (catchable); the pre-fix 30 fps warp re-entered at ~77 px/tick and
        // passed straight through the 8 px spring-platform. The recorded
        // "settles below the base" end state belongs to the original board;
        // this scene is the closest in-repo reconstruction.
        expect(fast.maxAbsVy).toBeLessThan(32);
    });

    it('records a 30 fps run as uniform fixed steps that replays bit-exactly', () => {
        const { physics, loop, spring, ball } = makeSpringScenario();
        const stepSpy = vi.spyOn(physics, 'step');

        const recorder = new SessionRecorder();
        recorder.init({
            getBoard: () => [spring, ball],
            getEngine: () => physics.engine,
            getPlayfield: () => ({ width: 1000, height: 600 }),
            getEngineInfo: () => ({ gravityX: 0, gravityY: 1, enableSleeping: true }),
        });
        unsubs.push(() => recorder.dispose());

        recorder.startSession();
        loop.play(); // emits loop:play → opens the recorded run
        let t = 1000;
        loop._frame(t); // prime → tick 1
        for (let i = 0; i < 40; i++) loop._frame(t += 33.33); // 30 fps → sub-steps
        const run = recorder.closeOpenRun('controls:reset');
        recorder.dispose();
        physics.dispose();

        // One recorded tick per physics step (one loop:frame per quantum).
        expect(run.lastTick).toBe(run.dt.values.length);
        expect(run.dt.values.length).toBe(stepSpy.mock.calls.length);
        expect(run.dt.values.length).toBeGreaterThanOrEqual(60);
        expect(run.dt.values.every((dt) => dt === DT)).toBe(true);
        expect(run.timeScale).toEqual([]);

        const doc = {
            schemaVersion: BUGFILE_SCHEMA_VERSION,
            createdAtUtc: '2026-10-27T15:12:21Z',
            appVersion: 'test',
            matterVersion: 'test',
            userAgent: 'node',
            playfield: { width: 1000, height: 600 },
            engine: { gravityX: 0, gravityY: 1, enableSleeping: true },
            notes: 'issue #80 fixed-timestep regression',
            context: { mode: 'SANDBOX', levelId: null, goal: null, dense: false },
            build: [],
            runs: [run],
        };
        const result = replayBugFile(doc);
        expect(result.ok).toBe(true);
        expect(result.runReports[0].divergence).toBeNull();
    });

    it('replays a mid-run 2× speed recording bit-exactly', () => {
        const { physics, loop, spring, ball } = makeSpringScenario();
        const stepSpy = vi.spyOn(physics, 'step');

        const recorder = new SessionRecorder();
        recorder.init({
            getBoard: () => [spring, ball],
            getEngine: () => physics.engine,
            getPlayfield: () => ({ width: 1000, height: 600 }),
            getEngineInfo: () => ({ gravityX: 0, gravityY: 1, enableSleeping: true }),
        });
        unsubs.push(() => recorder.dispose());

        recorder.startSession();
        loop.play();
        let t = 1000;
        loop._frame(t); // prime
        for (let i = 0; i < 20; i++) loop._frame(t += 33.33); // ~tick 40
        loop.cycleSpeed(); // 2× → physics + a loop:speed row at the current tick
        expect(physics.engine.timing.timeScale).toBe(2);
        for (let i = 0; i < 20; i++) loop._frame(t += 33.33); // ~tick 80
        const run = recorder.closeOpenRun('controls:reset');
        recorder.dispose();
        physics.dispose();

        // One recorded tick per physics step; replay re-applies the speed row.
        expect(run.timeScale.length).toBe(1);
        expect(run.timeScale[0].speed).toBe(2);
        expect(run.lastTick).toBe(run.dt.values.length);
        expect(run.dt.values.length).toBe(stepSpy.mock.calls.length);
        expect(run.dt.values.every((dt) => dt === DT)).toBe(true);

        const doc = {
            schemaVersion: BUGFILE_SCHEMA_VERSION,
            createdAtUtc: '2026-10-27T15:12:21Z',
            appVersion: 'test',
            matterVersion: 'test',
            userAgent: 'node',
            playfield: { width: 1000, height: 600 },
            engine: { gravityX: 0, gravityY: 1, enableSleeping: true },
            notes: 'issue #80 fixed-timestep 2x regression',
            context: { mode: 'SANDBOX', levelId: null, goal: null, dense: false },
            build: [],
            runs: [run],
        };
        const result = replayBugFile(doc);
        expect(result.ok).toBe(true);
        expect(result.runReports[0].divergence).toBeNull();
    });
});