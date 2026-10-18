/**
 * Unit tests for Gear tooth interaction.
 *
 * A gear's physics body is a static circle; Matter.js ignores the rotation of
 * static bodies, so the teeth must push contacting bodies explicitly. Tests
 * verify the tooth interaction through the public simulation seam: a real
 * PhysicsEngine, real objects, engine.step().
 */

import { describe, it, expect } from 'vitest';
import { PhysicsEngine } from '../js/engine/PhysicsEngine.js';
import Gear from '../js/objects/Gear.js';
import Ball from '../js/objects/Ball.js';

const STEP_MS = 16.667;

/**
 * Set up a gear + ball resting slightly overlapped on the tooth rim and step
 * the simulation. Returns the average +x ball velocity over the steps in
 * `[steps - sampleN + 1, steps]` — the steady tangential speed the body is
 * carried/flung at.
 */
function rideCarrySpeed(gearOptions, ballY, steps = 30, sampleN = 6) {
    const engine = new PhysicsEngine(400, 400);
    const gear = new Gear(200, 200, gearOptions);
    engine.addObject(gear);
    const ball = new Ball(200, ballY);
    engine.addObject(ball);
    const body = ball.bodies[0];

    const samples = [];
    for (let i = 0; i < steps; i++) {
        engine.step(STEP_MS);
        if (i >= steps - sampleN) samples.push(body.velocity.x);
    }
    engine.dispose();
    return samples.reduce((sum, v) => sum + v, 0) / sampleN;
}

describe('Gear tooth interaction', () => {
    it('should launch a resting object tangentially at the tooth surface speed', () => {
        // Tooth surface speed = omega * radius = 5.6 px/step; the ball is
        // carried around the rim and leaves it ballistically at that speed.
        const avgVx = rideCarrySpeed({ angularSpeed: 0.10, radius: 56 }, 200 - 56 - 14);
        expect(avgVx).toBeGreaterThanOrEqual(0.85 * 5.6);
    });

    it('should sustain the carry while a body rides the teeth of a slow gear', () => {
        // Slow gear (tooth speed 1.4 px/step): the ball stays on the rim for
        // the whole 12-step window; steps 7-12 sample it still riding.
        const avgVx = rideCarrySpeed({ angularSpeed: 0.05 }, 200 - 28 - 14, 12);
        expect(avgVx).toBeGreaterThanOrEqual(0.85 * 1.4);
        expect(avgVx).toBeGreaterThan(0); // carried toward +x for positive spin
    });

    it('should carry opposite when the gear spins the other way', () => {
        const avgVx = rideCarrySpeed({ angularSpeed: -0.05 }, 200 - 28 - 14, 12);
        expect(avgVx).toBeLessThanOrEqual(-0.85 * 1.4);
    });

    it('should keep play/reset cycles stable — snapshot restore returns to the snapshotted state', () => {
        const engine = new PhysicsEngine(400, 400);
        const gear = new Gear(200, 200, { angularSpeed: 0.05 });
        engine.addObject(gear);
        const ball = new Ball(200, 200 - 28 - 14);
        engine.addObject(ball);
        const body = ball.bodies[0];

        engine.takeSnapshot();
        const snap = {
            gearAngle: gear.bodies[0].angle,
            pos: { x: body.position.x, y: body.position.y },
            vel: { x: body.velocity.x, y: body.velocity.y },
        };

        // Ride away for a while
        for (let i = 0; i < 40; i++) engine.step(STEP_MS);
        expect(Math.abs(body.position.x - snap.pos.x)).toBeGreaterThan(10); // meaningful ride

        engine.restoreSnapshot();
        expect(gear.bodies[0].angle).toBeCloseTo(snap.gearAngle, 10);
        expect(body.position.x).toBeCloseTo(snap.pos.x, 4);
        expect(body.position.y).toBeCloseTo(snap.pos.y, 4);
        expect(body.velocity.x).toBeCloseTo(snap.vel.x, 4);
        expect(body.velocity.y).toBeCloseTo(snap.vel.y, 4);

        // Play resumes cleanly after the reset
        for (let i = 0; i < 5; i++) engine.step(STEP_MS);
        expect(body.velocity.x).toBeGreaterThan(0.85 * 1.4);
        engine.dispose();
    });

    it('should not affect bodies that never touch the gear', () => {
        const engine = new PhysicsEngine(400, 400);
        const gear = new Gear(200, 200, { angularSpeed: 0.05 });
        engine.addObject(gear);
        const ball = new Ball(60, 380); // falls to the floor far from the gear
        engine.addObject(ball);
        const body = ball.bodies[0];

        for (let i = 0; i < 30; i++) engine.step(STEP_MS);
        expect(body.velocity.x).toBeCloseTo(0, 6);

        engine.dispose();
    });
});