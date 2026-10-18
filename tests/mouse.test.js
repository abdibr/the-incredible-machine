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