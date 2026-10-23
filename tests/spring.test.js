/**
 * Spring launcher regression — bug-20261023T180834Z-gwce
 * ("the ball did not bounce from the spring ??").
 *
 * The recorded bowling-ball-on-spring run exposed two compounding defects:
 * 1. The pair resolves at max(the two live restitutions) = the ball's own
 *    0.3 (the platform's declared 0.1 is zeroed by matter's static flip), so
 *    the ball rebounded and floated ~9 px above the platform (recording
 *    poses t36-t42) when the release tick came — 13 ticks after arming.
 *    A touching-only sweep found nobody, the burst went nowhere, the
 *    30-tick cooldown swallowed the re-landings (collisions at t48/t53),
 *    and the ball rolled off to sleep. Fixed by remembering the bodies that
 *    armed the launch and bursting them at release while they stay within
 *    SPRING_CAPTURE_RADIUS.
 * 2. Even a touching rider got an absolute force 0.08; matter integrates
 *    Δv = F/m·dt², so launch speed was inversely proportional to mass —
 *    bowling ≈ 2.7 px/tick, tennis ≈ 24.6. The force now scales with
 *    body.mass: every rider leaves at ≈ 22 px/tick regardless of mass.
 */
import { describe, expect, it } from 'vitest';
import { objectRegistry } from '../js/objects/ObjectRegistry.js';
import { registerAllObjects } from '../js/objects/registerAllObjects.js';
import { PhysicsEngine } from '../js/engine/PhysicsEngine.js';

registerAllObjects();

const DT = 1000 / 60;

describe('Spring launch (bug-20261023T180834Z-gwce)', () => {
    it('launches a dropped bowling ball that rebounded off the platform during compression', () => {
        const engine = new PhysicsEngine(1000, 600);
        const spring = objectRegistry.create('spring', 500, 500);
        const ball = objectRegistry.create('ball', 500, 224, { variant: 'bowling' }); // bug-recording drop height
        engine.addObject(spring);
        engine.addObject(ball);

        // Enough ticks for the drop (~t41 contact), the 13-tick compression,
        // the release, and the rise.
        let minY = Infinity;
        let launched = false;
        for (let i = 0; i < 120; i++) {
            engine.step(DT);
            const body = ball.bodies[0];
            minY = Math.min(minY, body.position.y);
            if (body.velocity.y < -10) launched = true;
        }

        // The bug recording topped out at y ≈ 354 (a ~9 px rebound above the
        // platform, rest at y ≈ 364). A rider that actually gets its burst
        // leaves at Δv ≈ 22 px/tick and clears y < 120.
        expect(launched).toBe(true);
        expect(minY).toBeLessThan(120);
    });

    it('launches a resting rider at the same speed regardless of mass (bowling vs tennis)', () => {
        const engine = new PhysicsEngine(1000, 600);
        const springA = objectRegistry.create('spring', 300, 500);
        const springB = objectRegistry.create('spring', 700, 500);
        // Both balls start 2 px sunk into their platforms (platform top = 481),
        // so the first step's collisionStart arms each spring through the
        // matrix; release comes ~13 ticks later. Bowling: r 18, m ≈ 8.1.
        // Tennis: r 12, m ≈ 0.9 — a 9× mass ratio.
        const bowling = objectRegistry.create('ball', 300, 465, { variant: 'bowling' });
        const tennis = objectRegistry.create('ball', 700, 471, { variant: 'tennis' });
        for (const obj of [springA, springB, bowling, tennis]) engine.addObject(obj);

        let minVyBowling = 0;
        let minVyTennis = 0;
        for (let i = 0; i < 20; i++) {
            engine.step(DT);
            minVyBowling = Math.min(minVyBowling, bowling.bodies[0].velocity.y);
            minVyTennis = Math.min(minVyTennis, tennis.bodies[0].velocity.y);
        }

        // The gwce bug shipped Δv ∝ 1/mass: bowling ≈ -2.7, tennis ≈ -24.6.
        // Mass-proportional force: both ≈ -0.08 × 16.667² ≈ -22 px/tick.
        expect(minVyBowling).toBeLessThan(-20);
        expect(minVyTennis).toBeLessThan(-20);
        expect(Math.abs(minVyBowling - minVyTennis)).toBeLessThan(2);
    });

    it('launches its remembered rider even while it is airborne at release', () => {
        const engine = new PhysicsEngine(1000, 600);
        const spring = objectRegistry.create('spring', 500, 500);
        engine.addObject(spring);
        // Rider parked 51 px above the platform top (481): too far to touch
        // it during the 13-tick window, so only the remembered-rider path
        // can deliver the burst — the exact state the recorded ball was in.
        const ball = objectRegistry.create('ball', 500, 430, { variant: 'bowling' });
        engine.addObject(ball);

        spring.armLaunch(ball);
        for (let i = 0; i < 13; i++) engine.step(DT);

        // The burst is an impulse added to existing velocity (Δv = F/m·dt²):
        // the parked rider has been falling for 13 ticks by release (vy ≈
        // +3.6 down), so the launch lands it at vy ≈ −22.2 + 3.6 ≈ −18.6 —
        // vs the old absolute 0.08 force, which would have left it at
        // vy ≈ +0.9, still falling, never launched.
        expect(ball.bodies[0].velocity.y).toBeLessThan(-15);
    });
});