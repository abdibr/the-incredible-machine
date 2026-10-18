/**
 * Unit tests for Fan — rotation-aware wind zone (GitHub issue #6).
 */

import { describe, it, expect } from 'vitest';
import Matter from 'matter-js';
import Fan from '../js/objects/Fan.js';

// ── Fan Wind Zone Tests ───────────────────────────

describe('Fan wind zone', () => {
    it('should push bodies above an unrotated fan upward and ignore bodies behind it', () => {
        const engine = Matter.Engine.create();
        const fan = new Fan(400, 300, { angle: 0 });
        const inZone = Matter.Bodies.rectangle(420, 200, 20, 20);
        const behind = Matter.Bodies.rectangle(420, 380, 20, 20);
        Matter.Composite.add(engine.world, [fan.bodies[0], inZone, behind]);

        fan.onBeforeUpdate(engine);

        expect(inZone.force.y).toBeLessThan(0);   // blown up, out the face
        expect(inZone.force.x).toBeCloseTo(0, 10);
        expect(behind.force.x).toBe(0);           // below the face: no wind
        expect(behind.force.y).toBe(0);

        Matter.Engine.clear(engine);
    });

    it("should push bodies in a 90° fan's face direction and ignore bodies behind the face", () => {
        const engine = Matter.Engine.create({ gravity: { x: 0, y: 0 } });
        // At 90° clockwise the face (drawn wind lines) points to the right (+x).
        const fan = new Fan(400, 300, { angle: Math.PI / 2 });
        const inFront = Matter.Bodies.rectangle(500, 300, 20, 20);   // dead ahead of the face
        const offAxis = Matter.Bodies.rectangle(560, 280, 20, 20);   // ahead, 20px off centerline
        const behind = Matter.Bodies.rectangle(320, 370, 20, 20);    // inside the old broken ghost zone
        Matter.Composite.add(engine.world, [fan.bodies[0], inFront, offAxis, behind]);

        fan.onBeforeUpdate(engine);

        expect(inFront.force.x).toBeGreaterThan(0);
        expect(inFront.force.y).toBeCloseTo(0, 10);
        expect(offAxis.force.x).toBeGreaterThan(0);
        expect(behind.force.x).toBe(0);
        expect(behind.force.y).toBe(0);

        Matter.Engine.clear(engine);
    });

    it('should keep the 90° zone one fan-width across the centerline and windRange long', () => {
        const engine = Matter.Engine.create({ gravity: { x: 0, y: 0 } });
        const fan = new Fan(400, 300, { angle: Math.PI / 2 });
        const nearEdge = Matter.Bodies.rectangle(445, 330, 20, 20);  // 30px off centerline: inside
        const tooWide = Matter.Bodies.rectangle(520, 355, 20, 20);   // 55px off centerline: outside
        const farEnd = Matter.Bodies.rectangle(580, 290, 20, 20);    // 180px ahead: inside
        const beyond = Matter.Bodies.rectangle(610, 300, 20, 20);    // 210px ahead: outside range
        Matter.Composite.add(engine.world, [fan.bodies[0], nearEdge, tooWide, farEnd, beyond]);

        fan.onBeforeUpdate(engine);

        expect(nearEdge.force.x).toBeGreaterThan(0);
        expect(tooWide.force.x).toBe(0);
        expect(tooWide.force.y).toBe(0);
        expect(farEnd.force.x).toBeGreaterThan(0);
        expect(beyond.force.x).toBe(0);
        expect(beyond.force.y).toBe(0);

        Matter.Engine.clear(engine);
    });

    it('should apply stronger force to bodies nearer the face', () => {
        const engine = Matter.Engine.create({ gravity: { x: 0, y: 0 } });
        const fan = new Fan(400, 300, { angle: Math.PI / 2 });
        const near = Matter.Bodies.rectangle(450, 300, 20, 20);      // 50px ahead
        const far = Matter.Bodies.rectangle(560, 300, 20, 20);       // 160px ahead
        Matter.Composite.add(engine.world, [fan.bodies[0], near, far]);

        fan.onBeforeUpdate(engine);

        // Both on the face centerline, so the only difference is distance falloff.
        expect(near.force.x).toBeGreaterThan(far.force.x);

        Matter.Engine.clear(engine);
    });

    it('should actually blow bodies to the right from a 90° fan across engine steps', () => {
        const engine = Matter.Engine.create({ gravity: { x: 0, y: 0 } });
        const fan = new Fan(400, 300, { angle: Math.PI / 2 });
        const ball = Matter.Bodies.circle(500, 300, 10);
        Matter.Composite.add(engine.world, [fan.bodies[0], ball]);
        const y0 = ball.position.y;

        for (let i = 0; i < 24; i++) {
            fan.onBeforeUpdate(engine);
            Matter.Engine.update(engine, 16.667);
        }

        expect(ball.position.x).toBeGreaterThan(500);
        expect(ball.position.y).toBeCloseTo(y0, 6);

        Matter.Engine.clear(engine);
    });
});