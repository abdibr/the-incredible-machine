/**
 * Unit tests for the PhysicsEngine discovery & wake seam (ADR 0002).
 *
 * queryTouching / queryZone / queryPoint are the only way objects discover
 * other bodies; wakeBodies is the only approved way to wake one. These tests
 * pin the shared discovery policy — movable, non-wall, non-own bodies only;
 * discovery never wakes; zone matching is position-in-rect in the reference
 * body's local frame — and the wake-on-act integration that closed the
 * sleeping-rider defect.
 */

import { describe, it, expect, afterEach } from 'vitest';
import Matter from 'matter-js';
import { PhysicsEngine } from '../js/engine/PhysicsEngine.js';
import Ball from '../js/objects/Ball.js';
import Spring from '../js/objects/Spring.js';
import Conveyor from '../js/objects/Conveyor.js';
import Gear from '../js/objects/Gear.js';
import Balloon from '../js/objects/Balloon.js';
import Candle from '../js/objects/Candle.js';
import Scissors from '../js/objects/Scissors.js';

const { Bodies, Composite, Sleeping } = Matter;
const STEP_MS = 16.667;

/** Minimal stand-in wrapping bodies so addObject registers an owner. */
const wrapper = (...bodies) => ({ type: 'wrapper', bodies, constraints: [] });

describe('Discovery & wake seam (ADR 0002)', () => {
    const engines = [];
    afterEach(() => {
        for (const engine of engines) engine.dispose();
        engines.length = 0;
    });

    function createEngine(width = 800, height = 600) {
        const engine = new PhysicsEngine(width, height);
        engines.push(engine);
        return engine;
    }

    const wallFloorOf = (engine) =>
        Composite.allBodies(engine.world).find((b) => b.label === 'wall-floor');

    function ballAt(engine, x, y) {
        const ball = new Ball(x, y);
        engine.addObject(ball);
        return ball.bodies[0];
    }

    describe('queryTouching', () => {
        it('discovers a dynamic body overlapping a source body', () => {
            const engine = createEngine();
            const actor = wrapper(Bodies.rectangle(400, 300, 40, 20, { label: 'actor' }));
            engine.addObject(actor);
            const ball = ballAt(engine, 400, 320); // ball top 4px inside the actor body

            expect(engine.queryTouching(actor)).toEqual([ball]);
        });

        it('skips static candidates unless opted in', () => {
            const engine = createEngine();
            const actor = wrapper(Bodies.rectangle(400, 300, 40, 20, { label: 'actor' }));
            engine.addObject(actor);
            const staticBody = Bodies.rectangle(400, 313, 40, 10, { isStatic: true, label: 'static-thing' });
            Composite.add(engine.world, staticBody); // 2px overlap with the actor body

            expect(engine.queryTouching(actor)).toEqual([]);
            expect(engine.queryTouching(actor, { includeStatic: true })).toEqual([staticBody]);
        });

        it('skips boundary walls unless opted in', () => {
            const engine = createEngine();
            const actor = wrapper(Bodies.rectangle(400, 592, 40, 20, { label: 'actor' }));
            engine.addObject(actor);

            expect(engine.queryTouching(actor)).toEqual([]); // floor wall 2px beneath
            expect(engine.queryTouching(actor, { includeStatic: true, includeWalls: true }))
                .toEqual([wallFloorOf(engine)]);
        });

        it('skips its own bodies as contacts', () => {
            const engine = createEngine();
            const first = Bodies.rectangle(500, 300, 40, 20, { label: 'part-a' });
            const second = Bodies.rectangle(500, 303, 40, 20, { label: 'part-b' });
            const actor = wrapper(first, second); // both dynamic, overlapping each other
            engine.addObject(actor);

            expect(engine.queryTouching(actor)).toEqual([]); // both are sources
            expect(engine.queryTouching(actor, { sourceBodies: [first] })).toEqual([]); // second is owned
        });

        it('collides against sourceBodies when given, not actor.bodies', () => {
            const engine = createEngine();
            const first = Bodies.rectangle(300, 300, 40, 20, { label: 'part-a' });
            const second = Bodies.rectangle(500, 300, 40, 20, { label: 'part-b' });
            const actor = wrapper(first, second);
            engine.addObject(actor);
            const ball = ballAt(engine, 500, 318); // touches only `second`

            expect(engine.queryTouching(actor, { sourceBodies: [first] })).toEqual([]);
            expect(engine.queryTouching(actor, { sourceBodies: [second] })).toEqual([ball]);
        });

        it('discovery never wakes a sleeping body', () => {
            const engine = createEngine();
            const actor = wrapper(Bodies.rectangle(400, 300, 40, 20, { label: 'actor' }));
            engine.addObject(actor);
            const ball = ballAt(engine, 400, 320);
            Sleeping.set(ball, true);

            expect(engine.queryTouching(actor)).toEqual([ball]);
            expect(ball.isSleeping).toBe(true);
        });
    });
    describe('queryZone', () => {
        const ZONE = { cx: 0, cy: -100, width: 80, height: 200 }; // fan wind-cone shape

        it('discovers bodies whose position lies inside the unrotated zone', () => {
            const engine = createEngine();
            const ref = Bodies.rectangle(400, 300, 40, 50, { isStatic: true, label: 'zone-ref' });
            engine.addObject(wrapper(ref));
            const inside = ballAt(engine, 400, 250); // zone spans x 360-440, y 100-300
            ballAt(engine, 500, 300); // outside the zone on both axes

            expect(engine.queryZone(ref, ZONE)).toEqual([inside]);
        });

        it('rejects bodies whose bounds only graze the zone or pass the AABB', () => {
            const engine = createEngine();
            const ref = Bodies.rectangle(400, 300, 40, 50, { isStatic: true, label: 'zone-ref' });
            engine.addObject(wrapper(ref));
            ballAt(engine, 400, 93);  // bounds graze the top edge of the zone (y=100)
            ballAt(engine, 450, 250); // bounds graze the right edge of the zone (x=440)

            expect(engine.queryZone(ref, ZONE)).toEqual([]);
        });

        it('rotates the zone with the reference body', () => {
            const engine = createEngine();
            const ref = Bodies.rectangle(400, 300, 40, 50, { isStatic: true, angle: Math.PI / 2, label: 'zone-ref' });
            engine.addObject(wrapper(ref));
            const east = ballAt(engine, 500, 300); // the face-rotated cone covers +x now
            ballAt(engine, 400, 193); // inside the unrotated cone, outside the rotated one

            expect(engine.queryZone(ref, ZONE)).toEqual([east]);
        });

        it('skips sibling bodies and statics unless opted in', () => {
            const engine = createEngine();
            const ref = Bodies.rectangle(400, 300, 40, 50, { isStatic: true, label: 'zone-ref' });
            const sibling = Bodies.rectangle(410, 250, 20, 20, { label: 'zone-sibling' });
            engine.addObject(wrapper(ref, sibling));
            const staticBody = Bodies.rectangle(400, 180, 30, 30, { isStatic: true, label: 'static-thing' });
            Composite.add(engine.world, staticBody);
            const inside = ballAt(engine, 380, 250);

            expect(engine.queryZone(ref, ZONE)).toEqual([inside]);
            expect(engine.queryZone(ref, ZONE, { includeStatic: true })).toContain(staticBody);
        });

        it('honours the static and wall opt-ins', () => {
            const engine = createEngine();
            const ref = Bodies.rectangle(400, 550, 40, 20, { isStatic: true, label: 'zone-ref' });
            engine.addObject(wrapper(ref));
            const coneOnFloor = { cx: 0, cy: 100, width: 200, height: 60 }; // y 620-680 covers the floor body

            expect(engine.queryZone(ref, coneOnFloor)).toEqual([]);
            expect(engine.queryZone(ref, coneOnFloor, { includeStatic: true, includeWalls: true }))
                .toEqual([wallFloorOf(engine)]);
        });

        it('discovery never wakes a sleeping body', () => {
            const engine = createEngine();
            const ref = Bodies.rectangle(400, 300, 40, 50, { isStatic: true, label: 'zone-ref' });
            engine.addObject(wrapper(ref));
            const ball = ballAt(engine, 400, 250);
            Sleeping.set(ball, true);

            expect(engine.queryZone(ref, ZONE)).toEqual([ball]);
            expect(ball.isSleeping).toBe(true);
        });
    });
    describe('queryZoneOverlap (overlap semantics on the zone query)', () => {
        it('discovers a large body whose centre is outside the zone but whose bounds overlap it', () => {
            const engine = createEngine();
            const ref = Bodies.rectangle(400, 300, 40, 50, { isStatic: true, label: 'zone-ref' });
            engine.addObject(wrapper(ref));
            const ZONE = { cx: 0, cy: -100, width: 80, height: 200 }; // world rect x 360-440, y 100-300
            // A 20x300 pillar centred just south of the zone: centre (400, 305)
            // is outside (zone max y = 300), but its body reaches up to y = 155.
            const pillar = Bodies.rectangle(400, 305, 20, 300);
            engine.addObject(wrapper(pillar));

            expect(engine.queryZone(ref, ZONE)).toEqual([]); // position-inside variant: invisible
            expect(engine.queryZoneOverlap(ref, ZONE)).toEqual([pillar]); // bounds overlap: discovered
        });

        it('stays frame-accurate: enclosing-AABB corners do not match on a rotated zone', () => {
            const engine = createEngine();
            const ref = Bodies.rectangle(400, 300, 40, 50, { isStatic: true, angle: Math.PI / 4, label: 'zone-ref' });
            engine.addObject(wrapper(ref));
            // Band rotated 45°: spans from (400, 17) up-right to (683, 300);
            // its enclosing AABB corners lie outside the band itself.
            const ZONE45 = { cx: 0, cy: -200, width: 60, height: 400 };
            const inBand = Bodies.rectangle(541.4, 158.6, 20, 20); // mid-band of the rotated rect
            const stray = Bodies.rectangle(390.0, 310.0, 10, 10);  // AABB corner region, off the band
            engine.addObject(wrapper(inBand, stray));

            expect(engine.queryZoneOverlap(ref, ZONE45)).toEqual([inBand]);
        });

        it('honours the discovery policy: statics and own sibling bodies skipped unless opted in', () => {
            const engine = createEngine();
            const ref = Bodies.rectangle(400, 550, 40, 20, { isStatic: true, label: 'zone-ref' });
            const sibling = Bodies.rectangle(430, 520, 20, 20); // same owner, overlaps the zone
            engine.addObject(wrapper(ref, sibling));
            const staticCrate = Bodies.rectangle(400, 480, 30, 30, { isStatic: true, label: 'static-crate' });
            Composite.add(engine.world, staticCrate);
            const ZONE = { cx: 0, cy: -50, width: 100, height: 100 }; // world rect x 350-450, y 450-550

            expect(engine.queryZoneOverlap(ref, ZONE)).toEqual([]); // both skipped
            expect(engine.queryZoneOverlap(ref, ZONE, { includeStatic: true })).toEqual([staticCrate]); // own sibling still skipped
        });

        it('discovery never wakes: a sleeping body overlapping the zone stays asleep', () => {
            const engine = createEngine();
            const ref = Bodies.rectangle(400, 300, 40, 50, { isStatic: true, label: 'zone-ref' });
            engine.addObject(wrapper(ref));
            const ZONE = { cx: 0, cy: -100, width: 80, height: 200 };
            const ball = ballAt(engine, 400, 250);
            Sleeping.set(ball, true);

            engine.queryZoneOverlap(ref, ZONE);

            expect(ball.isSleeping).toBe(true);
        });
    });

    describe('queryPoint', () => {
        it('finds the body containing the point, statics and walls included', () => {
            const engine = createEngine();
            const ball = ballAt(engine, 400, 100);
            const floor = wallFloorOf(engine); // spans y 600-650

            expect(engine.queryPoint({ x: 200, y: 60 })).toEqual([]); // empty space
            expect(engine.queryPoint(ball.position)).toEqual([ball]);
            expect(engine.queryPoint({ x: 400, y: 620 })).toEqual([floor]);
        });

        it('excludeOwner keeps an actor from probing itself', () => {
            const engine = createEngine();
            const own = Bodies.rectangle(400, 300, 40, 20, { label: 'actor' });
            const actor = wrapper(own);
            engine.addObject(actor);

            expect(engine.queryPoint(own.position)).toEqual([own]);
            expect(engine.queryPoint(own.position, { excludeOwner: actor })).toEqual([]);
        });
    });

    describe('object-level discovery (ADR 0002: by canonical type, by body label)', () => {
        it('queryObjectsByType fetches registered objects of a canonical type, in registration order', () => {
            const engine = createEngine();
            const first = new Ball(200, 100);
            const second = new Ball(600, 100);
            const spring = new Spring(400, 100);
            engine.addObject(first);
            engine.addObject(spring);
            engine.addObject(second);

            expect(engine.queryObjectsByType('ball')).toEqual([first, second]); // order pinned
            expect(engine.queryObjectsByType('spring')).toEqual([spring]);
            expect(engine.queryObjectsByType('no-such-type')).toEqual([]); // unknown → empty
        });

        it('queryObjectsByBodyLabel fetches registered objects owning a labeled body', () => {
            const engine = createEngine();
            const scissors = new Scissors(400, 100);
            const candle = new Candle(600, 100);
            engine.addObject(scissors);
            engine.addObject(candle);

            // either scissors body matches; the label query reaches across one object's bodies
            expect(engine.queryObjectsByBodyLabel('scissors-blade')).toEqual([scissors]);
            expect(engine.queryObjectsByBodyLabel('scissors-handle')).toEqual([scissors]);
            expect(engine.queryObjectsByBodyLabel('candle-flame')).toEqual([candle]);
            expect(engine.queryObjectsByBodyLabel('no-such-label')).toEqual([]);
        });

        it('removed objects stop being discoverable', () => {
            const engine = createEngine();
            const candle = new Candle(400, 100);
            engine.addObject(candle);

            expect(engine.queryObjectsByType('candle')).toEqual([candle]);
            engine.removeObject(candle);

            expect(engine.queryObjectsByType('candle')).toEqual([]);
            expect(engine.queryObjectsByBodyLabel('candle-flame')).toEqual([]);
        });

        it('excludeOwner keeps an object from fetching itself', () => {
            const engine = createEngine();
            const a = new Candle(400, 100);
            const b = new Candle(400, 400);
            engine.addObject(a);
            engine.addObject(b);

            expect(engine.queryObjectsByType('candle', { excludeOwner: a })).toEqual([b]);
            expect(engine.queryObjectsByBodyLabel('candle-flame', { excludeOwner: a })).toEqual([b]);
        });

        it('object-level discovery is a pure read (never wakes)', () => {
            const engine = createEngine();
            const candle = new Candle(400, 100);
            engine.addObject(candle);
            const body = candle.bodies[0];
            Sleeping.set(body, true);

            engine.queryObjectsByType('candle');
            engine.queryObjectsByBodyLabel('candle-flame');

            expect(body.isSleeping).toBe(true);
        });
    });

    describe('wakeBodies', () => {
        it('wakes a single body, an array, and tolerates nulls', () => {
            const engine = createEngine();
            const a = ballAt(engine, 200, 100);
            const b = ballAt(engine, 600, 100);
            const c = ballAt(engine, 300, 100);
            Sleeping.set(a, true);
            Sleeping.set(b, true);
            Sleeping.set(c, true);

            engine.wakeBodies(a);
            expect(a.isSleeping).toBe(false);

            engine.wakeBodies([b, null]);
            expect(b.isSleeping).toBe(false);

            expect(() => engine.wakeBodies(null)).not.toThrow();
            expect(c.isSleeping).toBe(true); // untouched
        });
    });

    describe('wake-on-act (the sleeping-rider defect)', () => {
        it('a sleeping ball is awakened and launched by an arming spring', () => {
            const engine = createEngine();
            const spring = new Spring(400, 300);
            engine.addObject(spring);
            const ball = ballAt(engine, 400, 275); // overlapping the platform top
            Sleeping.set(ball, true);
            spring.armLaunch();

            for (let i = 0; i < 13; i++) engine.step(STEP_MS); // 0.08/frame release fires on frame 13

            expect(ball.isSleeping).toBe(false);
            expect(ball.velocity.y).toBeLessThan(-10); // launch impulse delivered (mass-proportional burst; measured ≈ -22 for the default bowling ball)
        });

        it('a sleeping rider is awakened and carried by a conveyor belt', () => {
            const engine = createEngine();
            const belt = new Conveyor(400, 300);
            engine.addObject(belt);
            const ball = ballAt(engine, 400, 280); // 2px into the belt surface
            Sleeping.set(ball, true);

            engine.step(STEP_MS);

            expect(ball.isSleeping).toBe(false);
            expect(ball.velocity.x).toBeGreaterThan(0.1); // driven +x along the belt
        });

        it('a sleeping rider is awakened and dragged by gear teeth', () => {
            const engine = createEngine();
            const gear = new Gear(200, 200); // default angularSpeed 0.03
            engine.addObject(gear);
            const ball = ballAt(engine, 200, 160); // 2px into the tooth rim
            Sleeping.set(ball, true);

            for (let i = 0; i < 12; i++) engine.step(STEP_MS);

            expect(ball.isSleeping).toBe(false);
            expect(ball.velocity.x).toBeGreaterThan(0.5); // carried along the rim
        });

        it('a sleeping balloon is awakened by its own buoyancy', () => {
            const engine = createEngine();
            const balloon = new Balloon(400, 300);
            engine.addObject(balloon);
            const body = balloon.bodies[0];
            Sleeping.set(body, true);

            for (let i = 0; i < 5; i++) engine.step(STEP_MS);

            expect(body.isSleeping).toBe(false);
            expect(body.velocity.y).toBeLessThan(0);
        });
    });

    describe('impulse-field primitive (ADR 0002: applyImpulseField)', () => {
        const FIELD = { zone: { cx: 0, cy: -100, width: 80, height: 200 }, range: 200, force: 0.0008 };

        function sourceAt(engine, x, y, angle = 0) {
            const ref = Bodies.rectangle(x, y, 40, 50, { isStatic: true, angle, label: 'field-src' });
            engine.addObject(wrapper(ref));
            return ref;
        }

        it('applies a linearly-falloff force along the source body’s local up', () => {
            const engine = createEngine();
            const ref = sourceAt(engine, 400, 300);
            const near = ballAt(engine, 400, 250); // dist 50 → falloff factor 0.75
            const far = ballAt(engine, 400, 150);  // dist 150 → falloff factor 0.25

            const acted = engine.applyImpulseField(ref, FIELD);

            expect(acted).toEqual([near, far]); // world order; the source body itself is skipped
            expect(near.force.x).toBeCloseTo(0, 12);
            expect(near.force.y).toBeLessThan(0); // local up = "out of the face"
            expect(Math.abs(near.force.y)).toBeCloseTo(FIELD.force * 0.75 * near.mass, 12);
            expect(Math.abs(far.force.y)).toBeCloseTo(FIELD.force * 0.25 * far.mass, 12);
        });

        it('rotates the direction with the source body (90° maps local up to +x)', () => {
            const engine = createEngine();
            const ref = sourceAt(engine, 400, 300, Math.PI / 2);
            const ahead = ballAt(engine, 500, 300); // 100px east — the rotated "up" cone
            const north = ballAt(engine, 400, 200); // the unrotated cone's up — now off the zone

            const acted = engine.applyImpulseField(ref, FIELD);

            expect(acted).toEqual([ahead]);
            expect(ahead.force.y).toBeCloseTo(0, 12);
            expect(ahead.force.x).toBeGreaterThan(0);
            expect(ahead.force.x).toBeCloseTo(FIELD.force * 0.5 * ahead.mass, 12); // dist 100 → factor 0.5
        });

        it('skips statics, walls, and its own sibling bodies', () => {
            const engine = createEngine();
            const ref = Bodies.rectangle(400, 300, 40, 50, { isStatic: true, label: 'field-src' });
            const sibling = Bodies.rectangle(430, 250, 20, 20); // same owner, inside the zone
            engine.addObject(wrapper(ref, sibling));
            const staticCrate = Bodies.rectangle(400, 150, 30, 30, { isStatic: true, label: 'static-crate' });
            Composite.add(engine.world, staticCrate);

            const acted = engine.applyImpulseField(ref, FIELD);

            expect(acted).toEqual([]);
            expect(sibling.force.x).toBe(0);
            expect(sibling.force.y).toBe(0);
            expect(staticCrate.force.x).toBe(0);
            expect(staticCrate.force.y).toBe(0);
        });

        it('wakes every body it acts on (wake-on-act) and leaves outsiders asleep', () => {
            const engine = createEngine();
            const ref = sourceAt(engine, 400, 300);
            const inside = ballAt(engine, 400, 250);
            const outside = ballAt(engine, 400, 80); // beyond the zone (zone starts at y 100)
            Sleeping.set(inside, true);
            Sleeping.set(outside, true);

            engine.applyImpulseField(ref, FIELD);

            expect(inside.isSleeping).toBe(false);
            expect(outside.isSleeping).toBe(true);
        });

        it('bodies in the zone but beyond the falloff range receive no force', () => {
            const engine = createEngine();
            const ref = sourceAt(engine, 400, 300);
            const corner = ballAt(engine, 440, 100); // rect corner, dist ≈ 203.96 > range 200
            const centre = ballAt(engine, 400, 300); // exactly on the source centre: degenerate

            const acted = engine.applyImpulseField(ref, FIELD);

            expect(acted).toEqual([]);
            expect(corner.force.x).toBe(0);
            expect(corner.force.y).toBe(0);
            expect(centre.force.x).toBe(0);
            expect(centre.force.y).toBe(0);
        });

        it('match: "overlap" reaches bodies whose centre is outside the zone', () => {
            const engine = createEngine();
            const ref = sourceAt(engine, 400, 300);
            const pillar = Bodies.rectangle(400, 305, 20, 300); // centre outside, body reaches in
            engine.addObject(wrapper(pillar));

            expect(engine.applyImpulseField(ref, FIELD)).toEqual([]); // position-inside default
            expect(engine.applyImpulseField(ref, { ...FIELD, match: 'overlap' })).toEqual([pillar]);
        });
    });
});
