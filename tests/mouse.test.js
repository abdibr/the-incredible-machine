/**
 * Unit tests for Mouse walking behavior — ticket #9 (no jitter).
 *
 * Seams under test (public interface):
 * - PhysicsEngine.step() driving Mouse.onBeforeUpdate / onCollision end-to-end,
 * - Mouse.onCollision(other, pair) fed Matter-style pair data,
 * - Mouse.serialize().options.direction as the direction seam,
 * - PhysicsEngine take/restore/clearSnapshot for play/reset determinism.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PhysicsEngine } from '../js/engine/PhysicsEngine.js';
import Mouse from '../js/objects/Mouse.js';
import Ramp from '../js/objects/Ramp.js';
import Ball from '../js/objects/Ball.js';
import Matter from 'matter-js';

const DT = 1000 / 60;
const FLOOR_Y = 600; // top edge of the engine's boundary floor

/** Count direction flips across a history of samples (module-level helper). */
const totalFlips = (history) =>
    history.filter((s, i) => i > 0 && s.dir !== history[i - 1].dir).length;

describe('Mouse walking', () => {
    let engine;

    beforeEach(() => {
        engine = new PhysicsEngine(800, 600);
    });

    it('walks steadily on static ground without crashing', () => {
        const mouse = new Mouse(400, FLOOR_Y - 6, { direction: 1 });
        engine.addObject(mouse);

        // Must not throw (bug: step() passed dt where objects expect the engine).
        for (let i = 0; i < 30; i++) engine.step(DT);

        const x = mouse.bodies[0].position.x;
        // Floor friction damps the hard-set velocity; real pace ≈ 0.47px/step.
        // The point is steady forward progress (no crash, no jitter stall).
        expect(x).toBeGreaterThan(400 + 10);
        expect(mouse.serialize().options.direction).toBe(1); // kept course
        engine.dispose();
    });
});

describe('Mouse collision reversal (debounced)', () => {
    let engine;

    beforeEach(() => {
        engine = new PhysicsEngine(800, 600);
    });

    function verticalWall(x, width = 120) {
        const wall = new Ramp(x, 540, { width, angle: Math.PI / 2 });
        engine.addObject(wall);
        return wall;
    }

    /** Matter-style collision pair: normal points from bodyA to bodyB. */
    function contactPair(mouseObj, otherObj) {
        const bodyA = mouseObj.bodies[0];
        const bodyB = otherObj.bodies[0];
        const dx = bodyB.position.x - bodyA.position.x;
        const dy = bodyB.position.y - bodyA.position.y;
        const len = Math.hypot(dx, dy) || 1;
        return { bodyA, bodyB, normal: { x: dx / len, y: dy / len } };
    }

    const directionOf = (mouse) => mouse.serialize().options.direction;

    it('reverses once on a head-on wall contact, holds during cooldown, resumes after expiry', () => {
        const mouse = new Mouse(400, FLOOR_Y - 6, { direction: 1 });
        engine.addObject(mouse);
        const rightWall = verticalWall(600);
        const leftWall = verticalWall(200);

        mouse.onBeforeUpdate(engine); // grounded → sets walking velocity
        mouse.onCollision(rightWall, contactPair(mouse, rightWall));
        expect(directionOf(mouse)).toBe(-1); // first head-on contact reverses

        // 5 frames later, still inside the cooldown: bumping the left wall
        // again must NOT flip-flop.
        for (let i = 0; i < 5; i++) mouse.onBeforeUpdate(engine);
        mouse.onCollision(leftWall, contactPair(mouse, leftWall));
        expect(directionOf(mouse)).toBe(-1);

        // After the cooldown expires, a head-on contact reverses again.
        for (let i = 0; i < 35; i++) mouse.onBeforeUpdate(engine);
        mouse.onCollision(leftWall, contactPair(mouse, leftWall));
        expect(directionOf(mouse)).toBe(1);
        engine.dispose();
    });

    it('ignores contacts that are not front-facing (walking away from it)', () => {
        const mouse = new Mouse(500, FLOOR_Y - 6, { direction: -1 });
        engine.addObject(mouse);
        const wall = verticalWall(600); // on the right; mouse walks left
        mouse.onBeforeUpdate(engine);

        mouse.onCollision(wall, contactPair(mouse, wall));
        expect(directionOf(mouse)).toBe(-1);
        engine.dispose();
    });

    it('ignores ground-level contacts (surface underfoot)', () => {
        const mouse = new Mouse(500, 587, { direction: 1 });
        engine.addObject(mouse);
        const platform = new Ramp(500, FLOOR_Y + 6); // static platform below
        engine.addObject(platform);
        mouse.onBeforeUpdate(engine);

        mouse.onCollision(platform, contactPair(mouse, platform));
        expect(directionOf(mouse)).toBe(1);
        engine.dispose();
    });

    it('does not reverse while pushing a dynamic body already moving with it', () => {
        const mouse = new Mouse(470, FLOOR_Y - 6, { direction: 1 });
        const ball = new Ball(520, FLOOR_Y - 12, { variant: 'tennis' });
        engine.addObject(mouse);
        engine.addObject(ball);
        mouse.onBeforeUpdate(engine);

        // Sustained push: ball already carried along at the mouse's speed.
        Matter.Body.setVelocity(ball.bodies[0], { x: 1.2, y: 0 });
        mouse.onCollision(ball, contactPair(mouse, ball));
        expect(directionOf(mouse)).toBe(1); // pushing stays deterministic
        engine.dispose();
    });
});

describe('Mouse static-scenery reversal (end-to-end)', () => {
    let engine;

    beforeEach(() => {
        engine = new PhysicsEngine(800, 600);
    });

    /** Run n steps, sampling x/y/direction each step. */
    function run(engineObj, mouse, n) {
        const history = [];
        for (let i = 0; i < n; i++) {
            engineObj.step(DT);
            history.push({
                x: mouse.bodies[0].position.x,
                y: mouse.bodies[0].position.y,
                dir: mouse.serialize().options.direction,
            });
        }
        return history;
    }

    /** Direction flips over each rolling window of `window` steps. */
    function maxFlipsInWindow(history, window) {
        let worst = 0;
        for (let start = 0; start < history.length; start++) {
            let flips = 0;
            for (let i = start + 1; i < history.length && i <= start + window; i++) {
                if (history[i].dir !== history[i - 1].dir) flips++;
            }
            if (flips > worst) worst = flips;
        }
        return worst;
    }

    const totalFlips = (history) =>
        history.filter((s, i) => i > 0 && s.dir !== history[i - 1].dir).length;

    it('reverses exactly once at a static wall and walks away (no ping-pong)', () => {
        const wall = new Ramp(400, 540, { width: 120, angle: Math.PI / 2 });
        engine.addObject(wall);
        const mouse = new Mouse(500, FLOOR_Y - 6, { direction: -1 });
        engine.addObject(mouse);

        const history = run(engine, mouse, 240);

        expect(totalFlips(history)).toBe(1); // turned around once at the wall
        expect(history[history.length - 1].dir).toBe(1); // now walking right
        expect(history[history.length - 1].x).toBeGreaterThan(430); // away from wall
        engine.dispose();
    });

    it('reverses at a platform edge and stays on the platform', () => {
        // Elevated platform spanning x ∈ [340, 460], top at y=454.
        const platform = new Ramp(400, 460);
        engine.addObject(platform);
        const mouse = new Mouse(400, 447, { direction: 1 });
        engine.addObject(mouse);

        const history = run(engine, mouse, 400); // patrol cadence ≈ 255 frames

        expect(totalFlips(history)).toBeGreaterThanOrEqual(2); // patrols the platform
        const last = history[history.length - 1];
        expect(last.x).toBeGreaterThan(385); // still on the platform
        expect(last.x).toBeLessThan(415);
        expect(last.y).toBeLessThan(470); // never fell off
        for (const s of history) {
            expect(s.y).toBeLessThan(480); // stayed on top the whole time
            expect(s.x).toBeGreaterThan(300); // never left the platform
            expect(s.x).toBeLessThan(500);
        }
        engine.dispose();
    });
});

describe('Mouse pushing (end-to-end, no oscillation)', () => {
    let engine;

    beforeEach(() => {
        engine = new PhysicsEngine(800, 600);
    });

    /** Direction flips in each rolling window of `window` steps. */
    function maxFlipsInWindow(history, window) {
        let worst = 0;
        for (let start = 0; start < history.length; start++) {
            let flips = 0;
            for (let i = start + 1; i < history.length && i <= start + window; i++) {
                if (history[i].dir !== history[i - 1].dir) flips++;
            }
            if (flips > worst) worst = flips;
        }
        return worst;
    }

    it('pushing a resting light ball: one bump, walk away, no oscillation', () => {
        const ball = new Ball(480, FLOOR_Y - 12, { variant: 'tennis' });
        engine.addObject(ball);
        const mouse = new Mouse(400, FLOOR_Y - 6, { direction: 1 });
        engine.addObject(mouse);

        const history = [];
        for (let i = 0; i < 300; i++) {
            engine.step(DT);
            history.push({ dir: mouse.serialize().options.direction });
        }

        expect(maxFlipsInWindow(history, 30)).toBeLessThanOrEqual(1); // no rapid oscillation
        expect(totalFlips(history)).toBe(1); // single debounced reversal at the ball
        expect(history[history.length - 1].dir).toBe(-1); // walks away after the bump

        const ballFinalX = ball.bodies[0].position.x;
        expect(ballFinalX).toBeGreaterThan(480); // contact transferred a shove
        engine.dispose();
    });
});

describe('Mouse determinism across play/reset cycles', () => {
    let engine;

    beforeEach(() => {
        engine = new PhysicsEngine(800, 600);
    });

    function record(engineObj, mouse, n) {
        const out = [];
        for (let i = 0; i < n; i++) {
            engineObj.step(DT);
            out.push({
                x: mouse.bodies[0].position.x,
                y: mouse.bodies[0].position.y,
                dir: mouse.serialize().options.direction,
            });
        }
        return out;
    }

    it('replays identically after resets (bodies and walking direction, 3 cycles)', () => {
        const wall = new Ramp(400, 540, { width: 120, angle: Math.PI / 2 });
        engine.addObject(wall);
        const mouse = new Mouse(450, FLOOR_Y - 6, { direction: -1 }); // walks left into wall
        engine.addObject(mouse);

        // Play cycle 1: snapshot on play, run, drift on, then reset.
        engine.takeSnapshot();
        const cycleA = record(engine, mouse, 240);
        record(engine, mouse, 60);
        engine.restoreSnapshot(); // GameLoop.reset()
        engine.clearSnapshot();

        // Cycles 2–4: replay from the restored state each time and compare
        // step-for-step to the first run (positions + direction, bit-exact).
        let reference = cycleA;
        for (let cycle = 2; cycle <= 4; cycle++) {
            engine.takeSnapshot(); // GameLoop.play() snapshots from restored state
            const next = record(engine, mouse, 240);
            expect(next).toEqual(reference);
            record(engine, mouse, 60); // drift on, then reset
            engine.restoreSnapshot();
            engine.clearSnapshot();
            reference = next;
        }
        engine.dispose();
    });
});

describe('Mouse ledge reversal (edge-probe cooldown, Phase 5 #6)', () => {
    let engine;

    beforeEach(() => {
        engine = new PhysicsEngine(800, 600);
    });

    // Walkable plank with a real left edge at x=100: Ramp body is a
    // 12px-thick rectangle, so center y=506 puts the walkable top at y=500
    // (mouse center ≈ 494, mirroring the FLOOR_Y - 6 rigs above).
    function makePlank() {
        const plank = new Ramp(380, 506, { width: 560, angle: 0 });
        engine.addObject(plank);
        return plank;
    }

    /** Matter-style collision pair: normal points from bodyA to bodyB. */
    function contactPair(mouseObj, otherObj) {
        const bodyA = mouseObj.bodies[0];
        const bodyB = otherObj.bodies[0];
        const dx = bodyB.position.x - bodyA.position.x;
        const dy = bodyB.position.y - bodyA.position.y;
        const len = Math.hypot(dx, dy) || 1;
        return { bodyA, bodyB, normal: { x: dx / len, y: dy / len } };
    }

    const directionOf = (mouse) => mouse.serialize().options.direction;

    it('reverses at a ledge despite an active contact-reversal cooldown', () => {
        makePlank();
        const mouse = new Mouse(112, 494, { direction: 1 });
        engine.addObject(mouse);
        // Ball parked clear of the mouse purely as a stand-in to arm the
        // shared contact debounce, exactly like a real head-on bump.
        const bump = new Ball(160, 488, { variant: 'tennis' });
        engine.addObject(bump);

        mouse.onBeforeUpdate(engine); // grounded → walking velocity armed
        // Head-on ball contact from the right: flips direction and arms the
        // 30-frame contact debounce.
        mouse.onCollision(bump, contactPair(mouse, bump));
        expect(directionOf(mouse)).toBe(-1);

        // Same instant, a ledge opens up in the (new) walking direction —
        // (112 - 15, 505) is past the plank's left edge at x=100. The edge
        // probe is instantaneous and geometric; it must not be silenced by
        // the contact jitter debounce. The old shared cooldown swallowed
        // this reversal and walked the mouse off the plank.
        mouse.onBeforeUpdate(engine);
        expect(directionOf(mouse)).toBe(1);
        engine.dispose();
    });

    it('does not walk off a plank after a ball bump (edge reversal not swallowed)', () => {
        makePlank();
        const mouse = new Mouse(112, 494, { direction: 1 });
        engine.addObject(mouse);
        const bump = new Ball(160, 488, { variant: 'tennis' });
        engine.addObject(bump);

        // Arm the post-bump state through the real seams (deterministic —
        // in-engine bump timing depends on solver damping), then hand over to
        // physics: walking direction is already toward the plank's left edge
        // while the contact cooldown is still running.
        mouse.onBeforeUpdate(engine);
        mouse.onCollision(bump, contactPair(mouse, bump));
        expect(directionOf(mouse)).toBe(-1);

        let maxY = mouse.bodies[0].position.y;
        for (let i = 0; i < 120; i++) {
            engine.step(DT);
            maxY = Math.max(maxY, mouse.bodies[0].position.y);
        }

        // Old shared-cooldown behavior: the ledge reversal is swallowed for
        // 30 frames, the mouse walks ~22px past the edge and falls (y grows
        // well past the plank top of y=500).
        expect(maxY).toBeLessThan(505);
        engine.dispose();
    });
});