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

describe('Gear live mesh discovery', () => {
    it('a touching pair dispatches the mesh row exactly once per contact episode', () => {
        const engine = new PhysicsEngine(400, 400);
        const a = new Gear(120, 200);          // r = 28, ω = 0.03
        const b = new Gear(170, 200);          // centre gap 50 → rims overlap 6px
        engine.addObject(a);
        engine.addObject(b);
        let fired = 0;
        engine.interactions.define({
            id: 'test-gear-gear-spy',
            actor: { type: 'gear' },
            target: { type: 'gear' },
            handler: () => { fired += 1; },
        });

        engine.step(STEP_MS);
        expect(fired).toBe(1); // discovered and dispatched on the first step
        // True counter-rotation: equal magnitudes, opposite signs.
        expect(a.serialize().options.angularSpeed).toBeCloseTo(0.03, 10);
        expect(b.serialize().options.angularSpeed).toBeCloseTo(-0.03, 10);

        for (let i = 0; i < 29; i++) engine.step(STEP_MS);
        expect(fired).toBe(1); // one dispatch per contact episode, not per step
        expect(a.serialize().options.angularSpeed).toBeCloseTo(0.03, 10);
        expect(b.serialize().options.angularSpeed).toBeCloseTo(-0.03, 10);

        // Separation ends the episode; a re-touch may fire the row again.
        a.setPosition(320, 200); // centre gap 200 → rims clear
        engine.step(STEP_MS);
        a.setPosition(170, 200); // touch again → a fresh contact episode
        engine.step(STEP_MS);
        expect(fired).toBe(2); // exactly one dispatch for the second episode

        engine.dispose();
    });

    it('unequal radii mesh at equal rim speeds — drive scales by the radius ratio', () => {
        const engine = new PhysicsEngine(500, 400);
        const small = new Gear(150, 200, { radius: 28 }); // ω = 0.03, added first → row actor
        const large = new Gear(220, 200, { radius: 56 }); // centre gap 70 → rims overlap 14px
        engine.addObject(small);
        engine.addObject(large);

        engine.step(STEP_MS);
        // Actor (small) keeps its own spin; the large gear counter-rotates
        // at 0.03 * (28 / 56) = 0.015. Equal rim speeds: 0.03 * 28 = 0.015 * 56.
        expect(small.serialize().options.angularSpeed).toBeCloseTo(0.03, 10);
        expect(large.serialize().options.angularSpeed).toBeCloseTo(-0.015, 10);

        engine.dispose();
    });

    it('teeth touching alone fires the mesh — bare rims need not overlap', () => {
        const engine = new PhysicsEngine(400, 400);
        const a = new Gear(120, 200);          // r = 28, tooth tip reach 33
        // Centre gap 61 = rA + rB + 5: tooth tip bands (r + 5 = 33) interlock
        // by 5px while the bare rims (28 + 28 = 56) are still 5px apart —
        // meshing is judged on the teeth, not the rims (old trigger: 54).
        const b = new Gear(181, 200);
        engine.addObject(a);
        engine.addObject(b);

        engine.step(STEP_MS);
        // Same counter-rotating pair as a rim-overlapping placement.
        expect(a.serialize().options.angularSpeed).toBeCloseTo(0.03, 10);
        expect(b.serialize().options.angularSpeed).toBeCloseTo(-0.03, 10);

        engine.dispose();
    });

    it('tooth tips just short of contact leave the gears unmeshed', () => {
        const engine = new PhysicsEngine(400, 400);
        const a = new Gear(120, 200);          // r = 28, tooth tip reach 33
        // Tip circles touch only at centre gap 33 + 33 = 66; gap 68 leaves a
        // 2px air gap between tooth tips, so nothing must fire.
        const b = new Gear(188, 200);
        engine.addObject(a);
        engine.addObject(b);

        engine.step(STEP_MS);
        expect(a.serialize().options.angularSpeed).toBeCloseTo(0.03, 10);
        expect(b.serialize().options.angularSpeed).toBeCloseTo(0.03, 10);

        engine.dispose();
    });

    it('tooth tips exactly touching fire the mesh — kissing teeth couple', () => {
        const engine = new PhysicsEngine(400, 400);
        const a = new Gear(120, 200);          // tooth tip reach 28 + 5 = 33
        // Centre gap 66 = tip reach + tip reach: the tooth tip circles touch
        // exactly. Touching teeth are meshed teeth — the pair must fire here
        // (was broken: the trigger sat 2px deeper, silently ignoring every
        // just-touching placement).
        const b = new Gear(186, 200);
        engine.addObject(a);
        engine.addObject(b);

        engine.step(STEP_MS);
        expect(a.serialize().options.angularSpeed).toBeCloseTo(0.03, 10);
        expect(b.serialize().options.angularSpeed).toBeCloseTo(-0.03, 10);

        engine.dispose();
    });

    it('a hairline air gap between the tooth tips keeps the pair silent', () => {
        const engine = new PhysicsEngine(400, 400);
        const a = new Gear(120, 200);          // tooth tip reach 33
        // Centre gap 67 = touch distance 66 + 1: a visible air gap between
        // the tip circles — that is separation, not contact. Pins the upper
        // boundary so no extra slop can creep past the kiss point.
        const b = new Gear(187, 200);
        engine.addObject(a);
        engine.addObject(b);

        engine.step(STEP_MS);
        expect(a.serialize().options.angularSpeed).toBeCloseTo(0.03, 10);
        expect(b.serialize().options.angularSpeed).toBeCloseTo(0.03, 10);

        engine.dispose();
    });
});