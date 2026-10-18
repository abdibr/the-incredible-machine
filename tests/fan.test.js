/**
 * Unit tests for Fan — rotation-aware wind zone (GitHub issue #6), served by
 * the PhysicsEngine discovery seam (ADR 0002): zone scans run through
 * queryZone() and blown bodies are woken as part of acting on them.
 */

import { describe, it, expect } from 'vitest';
import Matter from 'matter-js';
import PhysicsEngine from '../js/engine/PhysicsEngine.js';
import Fan from '../js/objects/Fan.js';

const { Sleeping } = Matter;

// ── Fan Wind Zone Tests ───────────────────────────

describe('Fan wind zone', () => {
    it('should push bodies above an unrotated fan upward and ignore bodies behind it', () => {
        const engine = new PhysicsEngine(800, 600, { enableSleeping: false });
        const fan = new Fan(400, 300, { angle: 0 });
        engine.addObject(fan);
        const inZone = Matter.Bodies.rectangle(420, 200, 20, 20);
        const behind = Matter.Bodies.rectangle(420, 380, 20, 20);
        Matter.Composite.add(engine.world, [inZone, behind]);

        fan.onBeforeUpdate(engine);

        expect(inZone.force.y).toBeLessThan(0);   // blown up, out the face
        expect(inZone.force.x).toBeCloseTo(0, 10);
        expect(behind.force.x).toBe(0);           // below the face: no wind
        expect(behind.force.y).toBe(0);
    });

    it("should push bodies in a 90° fan's face direction and ignore bodies behind the face", () => {
        const engine = new PhysicsEngine(800, 600, { enableSleeping: false });
        // At 90° clockwise the face (drawn wind lines) points to the right (+x).
        const fan = new Fan(400, 300, { angle: Math.PI / 2 });
        engine.addObject(fan);
        const inFront = Matter.Bodies.rectangle(500, 300, 20, 20);   // dead ahead of the face
        const offAxis = Matter.Bodies.rectangle(560, 280, 20, 20);   // ahead, 20px off centerline
        const behind = Matter.Bodies.rectangle(320, 370, 20, 20);    // inside the old broken ghost zone
        Matter.Composite.add(engine.world, [inFront, offAxis, behind]);

        fan.onBeforeUpdate(engine);

        expect(inFront.force.x).toBeGreaterThan(0);
        expect(inFront.force.y).toBeCloseTo(0, 10);
        expect(offAxis.force.x).toBeGreaterThan(0);
        expect(behind.force.x).toBe(0);
        expect(behind.force.y).toBe(0);
    });

    it('should keep the 90° zone one fan-width across the centerline and windRange long', () => {
        const engine = new PhysicsEngine(800, 600, { enableSleeping: false });
        const fan = new Fan(400, 300, { angle: Math.PI / 2 });
        engine.addObject(fan);
        const nearEdge = Matter.Bodies.rectangle(445, 330, 20, 20);  // 30px off centerline: inside
        const tooWide = Matter.Bodies.rectangle(520, 355, 20, 20);   // 55px off centerline: outside
        const farEnd = Matter.Bodies.rectangle(580, 290, 20, 20);    // 180px ahead: inside
        const beyond = Matter.Bodies.rectangle(610, 300, 20, 20);    // 210px ahead: outside range
        Matter.Composite.add(engine.world, [nearEdge, tooWide, farEnd, beyond]);

        fan.onBeforeUpdate(engine);

        expect(nearEdge.force.x).toBeGreaterThan(0);
        expect(tooWide.force.x).toBe(0);
        expect(tooWide.force.y).toBe(0);
        expect(farEnd.force.x).toBeGreaterThan(0);
        expect(beyond.force.x).toBe(0);
        expect(beyond.force.y).toBe(0);
    });

    it('should apply stronger force to bodies nearer the face', () => {
        const engine = new PhysicsEngine(800, 600, { enableSleeping: false });
        const fan = new Fan(400, 300, { angle: Math.PI / 2 });
        engine.addObject(fan);
        const near = Matter.Bodies.rectangle(450, 300, 20, 20);      // 50px ahead
        const far = Matter.Bodies.rectangle(560, 300, 20, 20);       // 160px ahead
        Matter.Composite.add(engine.world, [near, far]);

        fan.onBeforeUpdate(engine);

        // Both on the face centerline, so the only difference is distance falloff.
        expect(near.force.x).toBeGreaterThan(far.force.x);
    });

    it('should actually blow bodies to the right from a 90° fan across engine steps', () => {
        const engine = new PhysicsEngine(800, 600, { gravityY: 0, enableSleeping: false });
        const fan = new Fan(400, 300, { angle: Math.PI / 2 });
        engine.addObject(fan);
        const ball = Matter.Bodies.circle(500, 300, 10);
        Matter.Composite.add(engine.world, [ball]);
        const y0 = ball.position.y;

        for (let i = 0; i < 24; i++) {
            fan.onBeforeUpdate(engine);
            engine.step(16.667);
        }

        expect(ball.position.x).toBeGreaterThan(500);
        expect(ball.position.y).toBeCloseTo(y0, 6);
    });
});

// ── Wake-on-act Tests (ADR 0002) ──────────────────
// A sleeping body skips force integration in Matter, so wind on a sleeping
// body used to stall it forever-in-place. Waking is now part of acting.

describe('Fan wake-on-act', () => {
    it('wakes a sleeping body inside the wind zone so the force can act', () => {
        const engine = new PhysicsEngine(800, 600);
        const fan = new Fan(400, 300, { angle: 0 });
        engine.addObject(fan);
        const sleeping = Matter.Bodies.rectangle(420, 200, 20, 20);
        Matter.Composite.add(engine.world, [sleeping]);
        Sleeping.set(sleeping, true);

        fan.onBeforeUpdate(engine);

        expect(sleeping.isSleeping).toBe(false); // woken as part of acting
        expect(sleeping.force.y).toBeLessThan(0);
    });

    it('leaves sleeping bodies outside the zone untouched', () => {
        const engine = new PhysicsEngine(800, 600);
        const fan = new Fan(400, 300, { angle: 0 });
        engine.addObject(fan);
        const behind = Matter.Bodies.rectangle(420, 380, 20, 20);
        Matter.Composite.add(engine.world, [behind]);
        Sleeping.set(behind, true);

        fan.onBeforeUpdate(engine);

        expect(behind.isSleeping).toBe(true);
        expect(behind.force.x).toBe(0);
        expect(behind.force.y).toBe(0);
    });
});