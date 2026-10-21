/**
 * Unit tests for rope-as-connector (GitHub issue 04):
 * ropes tie to payloads at named attachment points; ties realize as
 * engine-attached constraint links on the next physics step; they survive
 * snapshot rewinds; a severed rope releases its payload co-terminally.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Matter from 'matter-js';
import { eventBus } from '../js/EventBus.js';

const { Composite } = Matter;

describe('Rope as connector (issue 04)', () => {
    let PhysicsEngine;
    let Rope;
    let Balloon;
    let Bucket;

    beforeEach(async () => {
        const engineMod = await import('../js/engine/PhysicsEngine.js');
        const ropeMod = await import('../js/objects/Rope.js');
        const balloonMod = await import('../js/objects/Balloon.js');
        const bucketMod = await import('../js/objects/Bucket.js');
        PhysicsEngine = engineMod.PhysicsEngine;
        Rope = ropeMod.default;
        Balloon = balloonMod.default;
        Bucket = bucketMod.default;
    });

    // ── severed contract ─────────────────────────────────────────────

    it('builds a severed rope from the severed option (no chain, no resurrection)', () => {
        const physics = new PhysicsEngine(800, 600);
        const rope = new Rope(200, 100, { severed: true });
        expect(rope.isSevered).toBe(true);
        expect(rope.constraints).toEqual([]);
        physics.addObject(rope);
        expect(Composite.allConstraints(physics.world)).toEqual([]);
        physics.dispose();
        rope.dispose();
    });

    it('round-trips severed state through serialize/deserialize', () => {
        const severed = new Rope(200, 100, { severed: true });
        const severedData = severed.serialize();
        expect(severedData.options.severed).toBe(true);
        const restoredSevered = Rope.deserialize(severedData);
        expect(restoredSevered.isSevered).toBe(true);
        expect(restoredSevered.constraints).toEqual([]);

        const intact = new Rope(200, 100);
        const intactData = intact.serialize();
        expect(intactData.options.severed ?? false).toBe(false);
        const restoredIntact = Rope.deserialize(intactData);
        expect(restoredIntact.isSevered).toBe(false);
        expect(restoredIntact.constraints).toHaveLength(6); // anchor link + 5 segment links
    });

    it('drops unbindable attachment tokens on a severed rope', () => {
        const data = {
            type: 'rope', x: 200, y: 100, angle: 0, isFixed: false,
            options: { length: 100, severed: true },
            attachments: [{ endpoint: 1, targetType: 'balloon', targetOrdinal: 0, pointId: 'knot' }],
        };
        const rope = Rope.deserialize(data);
        const balloon = new Balloon(400, 300);
        rope.bindAttachment([balloon]);
        expect(rope.getAttachmentRefs()).toEqual([]);
    });

    // ── co-termination on sever ──────────────────────────────────────

    it('releases a tied payload the moment the rope severs', () => {
        const physics = new PhysicsEngine(800, 600);
        const rope = new Rope(400, 60, { length: 60 });
        const balloon = new Balloon(400, 220);
        physics.addObject(rope);
        physics.addObject(balloon);
        rope.attachEndpoint(1, balloon, 'knot');
        for (let i = 0; i < 10; i++) physics.step(16.67); // realize the link, let it strain
        expect(physics.getAttachedConstraints()).toHaveLength(1);
        const balloonYAtSever = balloon.bodies[0].position.y;

        rope.sever();
        // The engine-attached link is co-terminated with the chain
        expect(physics.getAttachedConstraints()).toHaveLength(0);
        // The freed balloon keeps rising (buoyancy, unrestrained)
        for (let i = 0; i < 40; i++) physics.step(16.67);
        expect(balloon.bodies[0].position.y).toBeLessThan(balloonYAtSever - 10);
        physics.dispose();
    });

    // ── attachment API + realization ─────────────────────────────────

    it('validates attachEndpoint calls', () => {
        const rope = new Rope(200, 100);
        const balloon = new Balloon(400, 300);
        expect(() => rope.attachEndpoint(2, balloon, 'knot')).toThrow();
        expect(() => rope.attachEndpoint(0, balloon, 'no-such-point')).toThrow();
        expect(rope.getAttachmentRefs()).toEqual([]);
    });

    it('realizes a knot as an engine-attached link on the next step', () => {
        const physics = new PhysicsEngine(800, 600);
        const rope = new Rope(200, 100);
        const balloon = new Balloon(300, 300);
        physics.addObject(rope);
        physics.addObject(balloon);

        rope.attachEndpoint(1, balloon, 'knot');
        physics.step(16.67);

        const link = physics.getAttachedConstraints()[0];
        const lastSegment = rope.bodies[rope.bodies.length - 1];
        expect(link.bodyA).toBe(lastSegment);
        expect(link.bodyB).toBe(balloon.bodies[0]);
        expect(link.length).toBe(0);
        expect(link.stiffness).toBe(0.9);
        // knot offset length: Matter re-rotates pointB in place as the
        // balloon rotates, so the stored vector's magnitude is the stable
        // part of the param
        expect(Math.hypot(link.pointB.x, link.pointB.y)).toBeCloseTo(18 * 1.2 + 4, 5);
        physics.dispose();
    });

    it('keeps exactly one link across many steps (idempotent reconcile)', () => {
        const physics = new PhysicsEngine(800, 600);
        const rope = new Rope(200, 100);
        const balloon = new Balloon(300, 300);
        physics.addObject(rope);
        physics.addObject(balloon);
        rope.attachEndpoint(1, balloon, 'knot');
        for (let i = 0; i < 10; i++) physics.step(16.67);
        expect(physics.getAttachedConstraints()).toHaveLength(1);
        physics.dispose();
    });

    it('ties several knots to one endpoint and one point to several ropes', () => {
        const physics = new PhysicsEngine(800, 600);
        const rope = new Rope(200, 100);
        const rope2 = new Rope(260, 100);
        const balloon = new Balloon(300, 300);
        const fixedBucket = new Bucket(600, 200, { isFixed: true });
        physics.addObject(rope);
        physics.addObject(rope2);
        physics.addObject(balloon);
        physics.addObject(fixedBucket);

        rope.attachEndpoint(1, balloon, 'knot');
        rope.attachEndpoint(1, fixedBucket, 'rim'); // two knots on one endpoint
        rope2.attachEndpoint(1, fixedBucket, 'rim'); // same point, another rope
        for (let i = 0; i < 10; i++) physics.step(16.67);

        // 3 links: rope-last↔balloon, rope-last↔bucket-floor, rope2-last↔bucket-floor
        const links = physics.getAttachedConstraints();
        expect(links).toHaveLength(3);
        const floorLinks = links.filter((l) => l.bodyB === fixedBucket.bodies[2]);
        expect(floorLinks).toHaveLength(2);
        physics.dispose();
    });

    it('drops the physical links when the knots are untied', () => {
        const physics = new PhysicsEngine(800, 600);
        const rope = new Rope(200, 100);
        const balloon = new Balloon(300, 300);
        physics.addObject(rope);
        physics.addObject(balloon);
        rope.attachEndpoint(1, balloon, 'knot');
        physics.step(16.67);
        expect(physics.getAttachedConstraints()).toHaveLength(1);

        rope.clearAttachments();
        physics.step(16.67);
        expect(physics.getAttachedConstraints()).toHaveLength(0);
        expect(rope.getAttachmentRefs()).toEqual([]);
        expect(Composite.allConstraints(physics.world)).toEqual(rope.constraints);
        physics.dispose();
    });

    it('drops a knot whose target popped, and never re-attaches', () => {
        const physics = new PhysicsEngine(800, 600);
        const rope = new Rope(200, 100);
        const balloon = new Balloon(300, 300);
        physics.addObject(rope);
        physics.addObject(balloon);
        rope.attachEndpoint(1, balloon, 'knot');
        physics.step(16.67);
        expect(physics.getAttachedConstraints()).toHaveLength(1);

        balloon.pop(); // engine co-terminates the link with the popped body
        physics.step(16.67);
        expect(physics.getAttachedConstraints()).toHaveLength(0);
        expect(rope.getAttachmentRefs()).toEqual([]); // dead ref pruned
        physics.dispose();
    });

    // ── snapshot rewind convergence ──────────────────────────────────

    it('rewinds a severed live rope to an intact snapshot (chain + link converge)', () => {
        const physics = new PhysicsEngine(800, 600);
        const rope = new Rope(400, 60, { length: 60 });
        const balloon = new Balloon(400, 220);
        physics.addObject(rope);
        physics.addObject(balloon);

        const convergeSpy = vi.fn();
        eventBus.on('rope:chain-converge', convergeSpy);

        rope.attachEndpoint(1, balloon, 'knot');
        physics.step(16.67); // realize + capture the link
        physics.takeSnapshot(); // intact rope, payload link attached
        rope.sever();
        expect(physics.getAttachedConstraints()).toHaveLength(0);
        for (let i = 0; i < 10; i++) physics.step(16.67);

        physics.restoreSnapshot();
        expect(rope.isSevered).toBe(false);
        expect(rope.constraints).toHaveLength(6);
        // chain re-added to the world + payload link re-attached by its record
        const worldConstraints = Composite.allConstraints(physics.world);
        for (const constraint of rope.constraints) {
            expect(worldConstraints).toContain(constraint);
        }
        expect(physics.getAttachedConstraints()).toHaveLength(1);
        expect(convergeSpy).toHaveBeenCalledWith(expect.objectContaining({ rope }));

        // and the replayed state stays converged (no duplicates, no drops)
        for (let i = 0; i < 5; i++) physics.step(16.67);
        expect(physics.getAttachedConstraints()).toHaveLength(1);

        eventBus.off('rope:chain-converge', convergeSpy);
        physics.dispose();
    });

    it('keeps a snapshot-severed rope severed across a rewind', () => {
        const physics = new PhysicsEngine(800, 600);
        const rope = new Rope(400, 60, { length: 60 });
        physics.addObject(rope);
        rope.sever();
        physics.takeSnapshot(); // severed at snapshot time
        for (let i = 0; i < 10; i++) physics.step(16.67);

        const convergeSpy = vi.fn();
        eventBus.on('rope:chain-converge', convergeSpy);
        physics.restoreSnapshot();
        expect(rope.isSevered).toBe(true);
        expect(rope.constraints).toEqual([]);
        expect(Composite.allConstraints(physics.world)).toEqual([]);
        expect(convergeSpy).not.toHaveBeenCalled();
        eventBus.off('rope:chain-converge', convergeSpy);
        physics.dispose();
    });

    it('leaves an already-converged intact rope untouched by a rewind', () => {
        const physics = new PhysicsEngine(800, 600);
        const rope = new Rope(200, 100);
        physics.addObject(rope);
        physics.step(16.67);
        physics.takeSnapshot();
        for (let i = 0; i < 10; i++) physics.step(16.67);
        const before = rope.constraints;
        physics.restoreSnapshot();
        expect(rope.constraints).toBe(before); // same constraint objects, no rebuild
        physics.dispose();
    });

    it('does not leak a restored chain into a second live engine', () => {
        const physics1 = new PhysicsEngine(800, 600);
        const rope1 = new Rope(200, 100);
        physics1.addObject(rope1);
        physics1.step(16.67);
        physics1.takeSnapshot();
        rope1.sever();

        const physics2 = new PhysicsEngine(800, 600);
        const rope2 = new Rope(500, 100);
        physics2.addObject(rope2);
        const world2Before = Composite.allConstraints(physics2.world);

        physics1.restoreSnapshot(); // rope1 converges severed→intact on the global bus
        expect(rope1.isSevered).toBe(false);
        // engine2's rope2 chain untouched
        expect(Composite.allConstraints(physics2.world)).toEqual(world2Before);

        physics1.dispose();
        physics2.dispose();
        rope1.dispose();
        rope2.dispose();
    });

    // ── setEndpoints (placement snap) ────────────────────────────────

    it('re-lays the rope between two points (edit-time placement seam)', () => {
        const rope = new Rope(200, 100);
        rope.setEndpoints({ x: 400, y: 80 }, { x: 460, y: 260 });
        expect(rope.bodies[0].position).toEqual({ x: 400, y: 80 });
        for (let i = 0; i < 6; i++) {
            const t = (i + 0.5) / 6;
            expect(rope.bodies[i + 1].position.x).toBeCloseTo(400 + 60 * t, 5);
            expect(rope.bodies[i + 1].position.y).toBeCloseTo(80 + 180 * t, 5);
        }
        expect(rope.constraints).toHaveLength(6);
        // The re-lay is round-trip stable
        const data = rope.serialize();
        expect(data.x).toBe(400);
        expect(data.y).toBe(80);
        expect(data.options.endPoint).toEqual({ x: 460, y: 260 });

        // The rebuilt chain still hangs from the (moved) anchor in the world
        const physics = new PhysicsEngine(800, 600);
        physics.addObject(rope);
        const anchor = rope.bodies[0];
        for (let i = 0; i < 20; i++) physics.step(16.67);
        for (const body of rope.bodies) {
            const dist = Math.hypot(
                body.position.x - anchor.position.x,
                body.position.y - anchor.position.y,
            );
            expect(dist).toBeLessThan(140); // slack chain contracts, but stays attached
        }
        physics.dispose();
        rope.dispose();
    });
});