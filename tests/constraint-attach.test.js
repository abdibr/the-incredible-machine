/**
 * Unit tests for the runtime constraint-attach seam (ticket 02, ADR 0004):
 *
 * - `PhysicsEngine.attachConstraint(bodyA, bodyB, opts)` attaches a Matter
 *   constraint between two already-registered, live game objects at runtime
 *   and wakes both endpoints (wake-on-act, ADR 0002).
 * - `PhysicsEngine.detachConstraint(constraint)` removes a single link
 *   without removing either object, and never touches object-owned
 *   constraints (rope chains).
 * - Links ride the snapshot restore seam (ADR 0003): captured as records at
 *   takeSnapshot, re-attached on restoreSnapshot by body id whenever both
 *   endpoint bodies are still alive.
 * - Removing/evicting an object detaches links endpoined at its bodies
 *   (co-termination): an orphaned endpoint would drag the survivor toward
 *   a dead body forever.
 *
 * No user-visible behavior by itself — this is the seam under "rope as a
 * connector", balloon tethers, pulley routing and cut-releases-payload.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Matter from 'matter-js';

const { Composite, Constraint, Sleeping, Body } = Matter;

// ── Helpers ───────────────────────────────────────────────────────

/** Distance between two body centers. */
function centerDist(a, b) {
    return Math.hypot(b.position.x - a.position.x, b.position.y - a.position.y);
}

/** Park a body asleep in mid-air with zero velocity (force integration is skipped for sleepers). */
function parkAsleep(body) {
    Body.setVelocity(body, { x: 0, y: 0 });
    Body.setAngularVelocity(body, 0);
    Sleeping.set(body, true);
}

describe('PhysicsEngine.attachConstraint — runtime link between live objects', () => {
    let PhysicsEngine;
    let Ramp;
    let Ball;

    beforeEach(async () => {
        const engineMod = await import('../js/engine/PhysicsEngine.js');
        const rampMod = await import('../js/objects/Ramp.js');
        const ballMod = await import('../js/objects/Ball.js');
        PhysicsEngine = engineMod.PhysicsEngine;
        Ramp = rampMod.default;
        Ball = ballMod.default;
    });

    it('adds a Matter constraint between two registered bodies to the world and records it', () => {
        const physics = new PhysicsEngine(800, 600);
        const ramp = new Ramp(200, 40);
        const ball = new Ball(200, 140, { variant: 'tennis' });
        physics.addObject(ramp);
        physics.addObject(ball);

        const link = physics.attachConstraint(ramp.bodies[0], ball.bodies[0], { length: 60, stiffness: 0.9 });

        // Matter constraints are plain records from Constraint.create (the
        // Constraint object itself is a factory, not a constructor).
        expect(link.type).toBe('constraint');
        expect(Composite.allConstraints(physics.world)).toContain(link);
        expect(physics.getAttachedConstraints()).toEqual([link]);
        // Endpoints are exactly the bodies passed in, with the requested params
        expect(link.bodyA).toBe(ramp.bodies[0]);
        expect(link.bodyB).toBe(ball.bodies[0]);
        expect(link.length).toBe(60);
        expect(link.stiffness).toBe(0.9);

        physics.dispose();
    });

    it('physically ties a mid-play sleeping ball to a static anchor (wake-on-attach)', () => {
        const physics = new PhysicsEngine(800, 600);
        const ramp = new Ramp(200, 40);
        const ball = new Ball(200, 140, { variant: 'tennis' });
        physics.addObject(ramp);
        physics.addObject(ball);

        // Tennis ball 100px below the static ramp center, asleep mid-air
        const ballBody = ball.bodies[0];
        parkAsleep(ballBody);
        physics.step(16.67);
        expect(ballBody.isSleeping).toBe(true);
        expect(centerDist(ramp.bodies[0], ballBody)).toBeCloseTo(100, 0);

        const link = physics.attachConstraint(ramp.bodies[0], ballBody, { length: 60, stiffness: 1, damping: 0.1 });

        // Wake-on-act: attach wakes exactly the bodies it acts on
        expect(ballBody.isSleeping).toBe(false);

        // The link acts: the ball hangs ~60px below the anchor instead of
        // staying frozen asleep (distance 100) or free-falling (distance 100+).
        for (let i = 0; i < 40; i++) physics.step(16.67);
        const dist = centerDist(ramp.bodies[0], ballBody);
        expect(dist).toBeGreaterThan(45);
        expect(dist).toBeLessThan(75);

        expect(Composite.allConstraints(physics.world)).toContain(link);
        physics.dispose();
    });

    it('throws when either endpoint is not a body of a registered game object', () => {
        const physics = new PhysicsEngine(800, 600);
        const ball = new Ball(200, 140);
        physics.addObject(ball);

        const raw = Matter.Bodies.rectangle(500, 300, 40, 40); // in the world but NOT registered

        expect(() => physics.attachConstraint(raw, ball.bodies[0])).toThrow(/registered/);
        expect(() => physics.attachConstraint(ball.bodies[0], raw)).toThrow(/registered/);
        expect(() => physics.attachConstraint(null, ball.bodies[0])).toThrow(/registered/);

        // Failed attempts leave no registry entries or world additions behind
        expect(physics.getAttachedConstraints()).toHaveLength(0);
        expect(Composite.allConstraints(physics.world)).toHaveLength(0);

        physics.dispose();
    });

    it('detach removes only that link: bodies, registration and other links stay intact', () => {
        const physics = new PhysicsEngine(800, 600);
        const ramp = new Ramp(200, 40);
        const ball = new Ball(200, 140);
        const ball2 = new Ball(500, 140);
        physics.addObject(ramp);
        physics.addObject(ball);
        physics.addObject(ball2);

        const link1 = physics.attachConstraint(ramp.bodies[0], ball.bodies[0], { length: 60 });
        const link2 = physics.attachConstraint(ramp.bodies[0], ball2.bodies[0], { length: 60 });

        physics.detachConstraint(link1);

        const worldConstraints = Composite.allConstraints(physics.world);
        expect(worldConstraints).not.toContain(link1);
        expect(worldConstraints).toContain(link2);
        expect(physics.getAttachedConstraints()).toEqual([link2]);

        // Per-constraint detach: bodies keep existing, object state stays consistent
        expect(physics.getObjects().has(ramp)).toBe(true);
        expect(physics.getObjects().has(ball)).toBe(true);
        expect(physics.getObjects().has(ball2)).toBe(true);
        expect(Composite.allBodies(physics.world)).toContain(ramp.bodies[0]);
        expect(Composite.allBodies(physics.world)).toContain(ball.bodies[0]);
        expect(physics.getObjectForBody(ball.bodies[0])).toBe(ball);
        expect(physics.getObjectForBody(ramp.bodies[0])).toBe(ramp);

        physics.dispose();
    });

    it('detach wakes the freed body so gravity acts again', () => {
        const physics = new PhysicsEngine(800, 600);
        const ramp = new Ramp(200, 40);
        const ball = new Ball(200, 140, { variant: 'tennis' });
        physics.addObject(ramp);
        physics.addObject(ball);
        physics.attachConstraint(ramp.bodies[0], ball.bodies[0], { length: 60, stiffness: 1, damping: 0.1 });
        for (let i = 0; i < 40; i++) physics.step(16.67); // settle into the hang
        const ballBody = ball.bodies[0];

        // Hanging balls can fall asleep — a freed sleeper must be woken or it
        // would float forever (force integration is skipped for sleepers).
        // No step may intervene: matter 0.20's Constraint.postSolveAll wakes
        // constraint endpoints on every Engine.update, so a parked body can
        // only be observed asleep between the park call and the next step.
        parkAsleep(ballBody);
        expect(ballBody.isSleeping).toBe(true);

        physics.detachConstraint(physics.getAttachedConstraints()[0]);

        expect(ballBody.isSleeping).toBe(false);
        expect(physics.getAttachedConstraints()).toHaveLength(0);
        for (let i = 0; i < 40; i++) physics.step(16.67);
        // Freed from a 60px hang: far past it after 40 ticks of free fall
        expect(centerDist(ramp.bodies[0], ballBody)).toBeGreaterThan(150);

        physics.dispose();
    });

    it('throws when detaching a constraint the engine does not manage', async () => {
        const ropeMod = await import('../js/objects/Rope.js');
        const Rope = ropeMod.default;

        const physics = new PhysicsEngine(800, 600);
        const rope = new Rope(200, 40, { length: 60 });
        physics.addObject(rope);

        const foreign = Constraint.create({ pointA: { x: 0, y: 0 }, pointB: { x: 10, y: 10 } });

        expect(() => physics.detachConstraint(foreign)).toThrow(/not attached/);
        // Rope-owned constraints belong to the rope object, not this seam
        expect(() => physics.detachConstraint(rope.constraints[0])).toThrow(/not attached/);
        expect(physics.getAttachedConstraints()).toHaveLength(0);

        physics.dispose();
    });

    it('removeObject detaches links endpoined at the removed object; survivors stay intact', () => {
        const physics = new PhysicsEngine(800, 600);
        const ramp = new Ramp(200, 40);
        const ball = new Ball(200, 140);
        const ball2 = new Ball(500, 140);
        physics.addObject(ramp);
        physics.addObject(ball);
        physics.addObject(ball2);

        physics.attachConstraint(ramp.bodies[0], ball.bodies[0], { length: 60 });
        const link2 = physics.attachConstraint(ramp.bodies[0], ball2.bodies[0], { length: 60 });
        const ball2Body = ball2.bodies[0]; // capture before removal (dispose() nulls bodies)

        physics.removeObject(ball2);

        const worldConstraints = Composite.allConstraints(physics.world);
        expect(worldConstraints).not.toContain(link2);
        expect(physics.getAttachedConstraints()).toHaveLength(1);
        expect(worldConstraints).toEqual(physics.getAttachedConstraints());

        // The removed object is really gone: bodies evicted, registration cleared
        expect(physics.getObjects().has(ball2)).toBe(false);
        expect(Composite.allBodies(physics.world)).not.toContain(ball2Body);
        expect(physics.getObjectForBody(ball2Body)).toBeNull();

        // Survivors untouched
        expect(physics.getObjectForBody(ball.bodies[0])).toBe(ball);
        expect(physics.getObjectForBody(ramp.bodies[0])).toBe(ramp);

        physics.dispose();
    });

    it('popping a balloon evicts its body and detaches links endpoined at it', async () => {
        const { default: Balloon } = await import('../js/objects/Balloon.js');

        const physics = new PhysicsEngine(800, 600);
        const balloon = new Balloon(200, 100);
        const ball = new Ball(400, 300);
        physics.addObject(balloon);
        physics.addObject(ball);

        const balloonBody = balloon.bodies[0];
        const link = physics.attachConstraint(balloonBody, ball.bodies[0], { length: 40, stiffness: 1 });

        balloon.pop();

        // Body evicted from the world by the popped event consumer…
        expect(Composite.allBodies(physics.world)).not.toContain(balloonBody);
        expect(physics.getObjectForBody(balloonBody)).toBeNull();
        // …and the link dies with it, so the ball is never dragged toward a dead body
        expect(Composite.allConstraints(physics.world)).not.toContain(link);
        expect(physics.getAttachedConstraints()).toHaveLength(0);

        // The surviving endpoint keeps existing, consistent state
        expect(physics.getObjectForBody(ball.bodies[0])).toBe(ball);
        expect(Composite.allBodies(physics.world)).toContain(ball.bodies[0]);

        physics.dispose();
    });

});

describe('constraint links ride the snapshot restore seam (ADR 0003)', () => {
    let PhysicsEngine;
    let Ramp;
    let Ball;
    let Rope;

    beforeEach(async () => {
        const engineMod = await import('../js/engine/PhysicsEngine.js');
        const rampMod = await import('../js/objects/Ramp.js');
        const ballMod = await import('../js/objects/Ball.js');
        const ropeMod = await import('../js/objects/Rope.js');
        PhysicsEngine = engineMod.PhysicsEngine;
        Ramp = rampMod.default;
        Ball = ballMod.default;
        Rope = ropeMod.default;
    });

    it('re-attaches a snapshot-time link that was detached mid-play, on the same body ids and params', () => {
        const physics = new PhysicsEngine(800, 600);
        const ramp = new Ramp(200, 40);
        const ball = new Ball(200, 140, { variant: 'tennis' });
        physics.addObject(ramp);
        physics.addObject(ball);

        const link = physics.attachConstraint(ramp.bodies[0], ball.bodies[0], { length: 60, stiffness: 0.9 });
        physics.takeSnapshot();
        const snapshotBallY = ball.bodies[0].position.y;

        // Mid-play: detach and let the world drift
        physics.detachConstraint(link);
        for (let i = 0; i < 20; i++) physics.step(16.67);
        expect(ball.bodies[0].position.y).not.toBe(snapshotBallY);

        physics.restoreSnapshot();

        // The link is back — a new instance re-created from the record, between
        // the same live bodies (restore-by-id), with the recorded params.
        const links = physics.getAttachedConstraints();
        expect(links).toHaveLength(1);
        expect(links[0]).not.toBe(link);
        expect(links[0].bodyA).toBe(ramp.bodies[0]);
        expect(links[0].bodyB).toBe(ball.bodies[0]);
        expect(links[0].length).toBe(60);
        expect(links[0].stiffness).toBe(0.9);
        expect(Composite.allConstraints(physics.world)).toContain(links[0]);
        expect(physics.getObjectForBody(ball.bodies[0])).toBe(ball);

        // …and it still acts: the ball hangs at the link length again
        for (let i = 0; i < 30; i++) physics.step(16.67);
        expect(centerDist(ramp.bodies[0], ball.bodies[0])).toBeLessThan(80);

        physics.dispose();
    });

    it('drops links attached after the snapshot was taken (link set converges to snapshot state)', () => {
        const physics = new PhysicsEngine(800, 600);
        const ramp = new Ramp(200, 40);
        const ball = new Ball(200, 140);
        physics.addObject(ramp);
        physics.addObject(ball);

        physics.takeSnapshot(); // no links yet
        const link = physics.attachConstraint(ramp.bodies[0], ball.bodies[0], { length: 60 });
        physics.restoreSnapshot();

        expect(physics.getAttachedConstraints()).toHaveLength(0);
        expect(Composite.allConstraints(physics.world)).not.toContain(link);
        // Bodies/poses still restored normally
        expect(physics.getObjectForBody(ball.bodies[0])).toBe(ball);

        physics.dispose();
    });

    it('re-attaches by body id: a link whose endpoint object left mid-play is not resurrected', () => {
        const physics = new PhysicsEngine(800, 600);
        const ramp = new Ramp(200, 40);
        const ball = new Ball(200, 140);
        const ball2 = new Ball(500, 140);
        physics.addObject(ramp);
        physics.addObject(ball);
        physics.addObject(ball2);

        physics.attachConstraint(ramp.bodies[0], ball.bodies[0], { length: 60 });
        physics.attachConstraint(ramp.bodies[0], ball2.bodies[0], { length: 80 });
        physics.takeSnapshot();

        // Mid-play removal diverges the snapshot (warn + self-heal retake path)
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        physics.removeObject(ball2);
        physics.restoreSnapshot();

        expect(warnSpy).toHaveBeenCalled();
        warnSpy.mockRestore();

        // Only the fully-alive link re-attached; the dead-endpoint record is skipped
        const links = physics.getAttachedConstraints();
        expect(links).toHaveLength(1);
        expect(links[0].bodyA).toBe(ramp.bodies[0]);
        expect(links[0].bodyB).toBe(ball.bodies[0]);
        expect(links[0].length).toBe(60);
        expect(Composite.allConstraints(physics.world)).toEqual(links);

        // Survivors consistent
        expect(physics.getObjectForBody(ball.bodies[0])).toBe(ball);
        expect(physics.getObjectForBody(ramp.bodies[0])).toBe(ramp);

        physics.dispose();
    });

    it('captures Matter-computed defaults (length from current distance) and replays them', () => {
        const physics = new PhysicsEngine(800, 600);
        const ramp = new Ramp(200, 40);
        const ball = new Ball(200, 140);
        physics.addObject(ramp);
        physics.addObject(ball);

        // No length given: Matter computes it from the current endpoint distance (100)
        physics.attachConstraint(ramp.bodies[0], ball.bodies[0], { stiffness: 0.9 });
        physics.takeSnapshot();
        physics.detachConstraint(physics.getAttachedConstraints()[0]);
        physics.restoreSnapshot();

        const links = physics.getAttachedConstraints();
        expect(links).toHaveLength(1);
        expect(links[0].length).toBe(100);
        expect(links[0].pointA).toEqual({ x: 0, y: 0 });
        expect(links[0].pointB).toEqual({ x: 0, y: 0 });

        physics.dispose();
    });

    it('replays explicit anchor offsets (pointA/pointB) on restore', () => {
        const physics = new PhysicsEngine(800, 600);
        const ramp = new Ramp(200, 40);
        const ball = new Ball(200, 140);
        physics.addObject(ramp);
        physics.addObject(ball);

        physics.attachConstraint(ramp.bodies[0], ball.bodies[0], {
            length: 60, stiffness: 0.9, pointA: { x: 0, y: 10 }, pointB: { x: 0, y: -5 },
        });
        physics.takeSnapshot();
        physics.detachConstraint(physics.getAttachedConstraints()[0]);
        physics.restoreSnapshot();

        const link = physics.getAttachedConstraints()[0];
        expect(link.pointA).toEqual({ x: 0, y: 10 });
        expect(link.pointB).toEqual({ x: 0, y: -5 });

        physics.dispose();
    });

    it('the runtime seam never touches object-owned (rope) constraints across attach/detach', () => {
        const physics = new PhysicsEngine(800, 600);
        const rope = new Rope(200, 40, { length: 60 });
        const ball = new Ball(400, 300);
        physics.addObject(rope);
        physics.addObject(ball);

        const link = physics.attachConstraint(rope.bodies[0], ball.bodies[0], { length: 30 });
        let worldConstraints = Composite.allConstraints(physics.world);
        for (const ropeConstraint of rope.constraints) {
            expect(worldConstraints).toContain(ropeConstraint);
        }
        expect(worldConstraints).toContain(link);

        physics.detachConstraint(link);
        worldConstraints = Composite.allConstraints(physics.world);
        for (const ropeConstraint of rope.constraints) {
            expect(worldConstraints).toContain(ropeConstraint);
        }
        expect(physics.getAttachedConstraints()).toHaveLength(0);

        physics.dispose();
    });
});