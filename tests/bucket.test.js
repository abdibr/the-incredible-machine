/**
 * Unit tests for bucket mobility (GitHub issue 04 "rope as a connector"):
 * an unfixed bucket is a dynamic container welded from its bodies — it falls
 * freely, holds its shape under load, and still catches mid-fall; a fixed
 * bucket stays exactly as before (static bodies, no welds).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Matter from 'matter-js';

const { Composite } = Matter;

describe('Bucket mobility — welded dynamic container (issue 04)', () => {
    let PhysicsEngine;
    let Bucket;
    let Ball;

    beforeEach(async () => {
        const engineMod = await import('../js/engine/PhysicsEngine.js');
        const bucketMod = await import('../js/objects/Bucket.js');
        const ballMod = await import('../js/objects/Ball.js');
        PhysicsEngine = engineMod.PhysicsEngine;
        Bucket = bucketMod.default;
        Ball = ballMod.default;
    });

    /** Center-to-center distance between two bodies. */
    const centerDist = (a, b) =>
        Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y);

    /** [left-right, left-floor, right-floor, sensor-floor] center distances. */
    function shapeProfile(bucket) {
        const [left, right, floor, sensor] = bucket.bodies;
        return [
            centerDist(left, right),
            centerDist(left, floor),
            centerDist(right, floor),
            centerDist(sensor, floor),
        ];
    }

    it('builds dynamic bodies with rigid welds and an exclusive collision group when not fixed', () => {
        const bucket = new Bucket(300, 200);
        expect(bucket.bodies).toHaveLength(4);
        for (const body of bucket.bodies) expect(body.isStatic).toBe(false);
        // Rim weld + two seam-end pins per joint (wall↔floor ×2, sensor↔floor)
        expect(bucket.constraints).toHaveLength(7);
        // Every weld ties two of the bucket's own bodies together
        const bodySet = new Set(bucket.bodies);
        for (const weld of bucket.constraints) {
            expect(bodySet.has(weld.bodyA)).toBe(true);
            expect(bodySet.has(weld.bodyB)).toBe(true);
            expect(weld.stiffness).toBe(1);
        }
        // One exclusive negative collision group shared by all four parts:
        // the parts sit in flush contact by construction and must never
        // resolve self-pairs (the pinwheel churn of bug-20261023T152411Z-05xt)
        const groups = bucket.bodies.map((b) => b.collisionFilter.group);
        expect(groups[0]).toBeLessThan(0);
        for (const g of groups) expect(g).toBe(groups[0]);
        // …but never the rope chain's reserved group −1 (rope segments must
        // still collide with — and rest inside — bucket parts)
        expect(groups[0]).not.toBe(-1);
    });

    it('falls freely and holds its shape while falling', () => {
        const physics = new PhysicsEngine(800, 600);
        const bucket = new Bucket(300, 120);
        physics.addObject(bucket);

        const y0 = bucket.bodies.map((b) => b.position.y);
        const shape0 = shapeProfile(bucket);

        for (let i = 0; i < 30; i++) physics.step(16.67);

        for (const [i, body] of bucket.bodies.entries()) {
            expect(body.position.y).toBeGreaterThan(y0[i] + 15);
        }
        for (const [i, d] of shapeProfile(bucket).entries()) {
            expect(Math.abs(d - shape0[i])).toBeLessThan(2);
        }
        // Rigid welds + no self-contact: nothing torques the parts in free
        // fall — the container rotates as one body only when contacted
        for (const body of bucket.bodies) {
            expect(Math.abs(body.angle)).toBeLessThan(0.1);
        }
        physics.dispose();
    });

    it('holds its shape under a dropped ball while falling, and still catches', () => {
        const physics = new PhysicsEngine(800, 600);
        // The ball overlaps the sensor from the first contact beat: the
        // catch must keep working on a moving, dynamic bucket.
        const bucket = new Bucket(300, 120);
        const ball = new Ball(300, 118);
        physics.addObject(bucket);
        physics.addObject(ball);

        const shape0 = shapeProfile(bucket);
        for (let i = 0; i < 40; i++) physics.step(16.67);

        // Welds hold the container shape under the ball's load
        for (const [i, d] of shapeProfile(bucket).entries()) {
            expect(Math.abs(d - shape0[i])).toBeLessThan(2);
        }
        expect(bucket.caughtCount).toBeGreaterThanOrEqual(1);
        physics.dispose();
    });

    it('stays a static fixed bucket with no welds when isFixed', () => {
        const physics = new PhysicsEngine(800, 600);
        const bucket = new Bucket(300, 200, { isFixed: true });
        physics.addObject(bucket);
        expect(bucket.constraints).toEqual([]);
        for (const body of bucket.bodies) expect(body.isStatic).toBe(true);

        const y0 = bucket.bodies.map((b) => b.position.y);
        for (let i = 0; i < 30; i++) physics.step(16.67);
        for (const [i, body] of bucket.bodies.entries()) {
            expect(body.position.y).toBe(y0[i]);
        }
        physics.dispose();
    });

    it('round-trips isFixed through serialize and keeps welds derived', () => {
        const fixed = new Bucket(300, 200, { isFixed: true, catchType: 'ball' });
        const fixedData = fixed.serialize();
        expect(fixedData.isFixed).toBe(true);
        const fixedBack = Bucket.deserialize(fixedData);
        expect(fixedBack.constraints).toEqual([]);
        expect(fixedBack.bodies.every((b) => b.isStatic)).toBe(true);

        const free = new Bucket(300, 200, { catchType: 'ball' });
        const freeData = free.serialize();
        expect(freeData.isFixed).toBe(false);
        const freeBack = Bucket.deserialize(freeData);
        // Welds derive from the construction layout (ADR 0005 decision 12),
        // so the rebuilt object re-welds the full rigid scheme
        expect(freeBack.constraints).toHaveLength(7);
        expect(freeBack.bodies.every((b) => !b.isStatic)).toBe(true);
    });

    it('welds enter the world with the object and leave with it', () => {
        const physics = new PhysicsEngine(800, 600);
        const bucket = new Bucket(300, 200);
        physics.addObject(bucket);
        let worldConstraints = Composite.allConstraints(physics.world);
        for (const weld of bucket.constraints) {
            expect(worldConstraints).toContain(weld);
        }

        physics.removeObject(bucket);
        expect(Composite.allConstraints(physics.world)).toEqual([]);
        physics.dispose();
    });
});