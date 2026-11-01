/**
 * Span-derived chain counts — GitHub issue #56 (ADR 0007 decision 3).
 *
 * A rope's chain is no longer a fixed 6-segment drop: the laid segment
 * count derives from the span at the SEGMENT_DENSITY_PX pitch (~40px per
 * segment), floored at SEGMENTS (the classic fresh-drop length) and
 * capped at MAX_SEGMENTS, so huge spans stretch instead of exploding the
 * body count.
 *
 * Seams under test:
 * - Rope.segmentsForSpan — the pure count rule; invalid spans fall back
 *   to the fresh-drop count.
 * - Constructor / _spawnChain — both birth paths (pinned drop, free-rope
 *   spawn) derive the count honestly.
 * - Rope.setEndpoints — the re-lay trades the tail: earlier seats keep
 *   their indices (live knot refs stay valid), the packet emits
 *   `added`/`dropped`, and PhysicsEngine._restoreRopeConstraints
 *   reconciles the world (added join, dropped leave, the chain swap
 *   co-terminates).
 * - rope.relayFreeEnd — the hand re-derives the count under the demand;
 *   a frozen pinned rope holds its span, a free rope takes any.
 * - Dead-seat pruning: knots whose seats a shorter re-lay pruned drop
 *   on the reconcile scan (their bodies no longer resolve).
 */

import { describe, it, expect, afterEach } from 'vitest';
import Matter from 'matter-js';
import { PhysicsEngine } from '../js/engine/PhysicsEngine.js';
import { objectRegistry } from '../js/objects/ObjectRegistry.js';
import { registerAllObjects } from '../js/objects/registerAllObjects.js';
import Rope from '../js/objects/Rope.js';
import Balloon from '../js/objects/Balloon.js';
import { eventBus } from '../js/EventBus.js';

registerAllObjects();

const DT = 1000 / 60;
const engines = [];
const unsubscribers = [];

afterEach(() => {
    for (const off of unsubscribers.splice(0)) off();
    for (const engine of engines) engine.dispose();
    engines.length = 0;
});

function makeEngine(width = 800, height = 600) {
    const engine = new PhysicsEngine(width, height);
    engines.push(engine);
    return engine;
}

/** Subscribe to a module-singleton bus event for one test only. */
function trackEvent(name) {
    const events = [];
    unsubscribers.push(eventBus.on(name, (payload) => events.push(payload ?? null)));
    return events;
}

const ropeSegs = (rope) => rope.bodies.filter((b) => b.label?.startsWith('rope-seg'));
const worldIds = (engine) => new Set(Matter.Composite.allBodies(engine.world).map((b) => b.id));
const worldConstraintIds = (engine) =>
    new Set(Matter.Composite.allConstraints(engine.world).map((c) => c.id));

describe('Span-derived counts — the counting rule (issue #56)', () => {
    it('segmentsForSpan: ~40px per segment, floored at 6, invalid spans fall back to the fresh drop', () => {
        expect(Rope.segmentsForSpan(40)).toBe(6);
        expect(Rope.segmentsForSpan(100)).toBe(6); // ceil(2.5) = 3 → floored
        expect(Rope.segmentsForSpan(239)).toBe(6);
        expect(Rope.segmentsForSpan(241)).toBe(7); // first count above the floor
        expect(Rope.segmentsForSpan(300)).toBe(8);
        expect(Rope.segmentsForSpan(480)).toBe(12); // no stretch at the 40px pitch
        expect(Rope.segmentsForSpan(-5)).toBe(6); // invalid → fresh-drop count
        expect(Rope.segmentsForSpan(0)).toBe(6);
        expect(Rope.segmentsForSpan(Number.NaN)).toBe(6);
        expect(Rope.segmentsForSpan(Infinity)).toBe(6);
    });

    it('the 16-segment cap stretches huge spans instead of exploding the body count', () => {
        expect(Rope.segmentsForSpan(600)).toBe(15); // last uncapped count
        expect(Rope.segmentsForSpan(620)).toBe(16); // first capped count
        expect(Rope.segmentsForSpan(700)).toBe(16); // ceil(17.5) stays 16
        expect(Rope.segmentsForSpan(1600)).toBe(16);

        // Birth honors the rule at both ends.
        const short = new Rope(100, 100, { length: 100 });
        const mid = new Rope(100, 100, { length: 480 });
        const huge = new Rope(100, 100, { length: 700 });
        expect(ropeSegs(short)).toHaveLength(6);
        expect(ropeSegs(mid)).toHaveLength(12);
        expect(ropeSegs(huge)).toHaveLength(16);
        short.dispose();
        mid.dispose();
        huge.dispose();
    });

    it('a free rope spawns count-honest: the spawn births what its length demands, like a drop', () => {
        const engine = makeEngine();
        const free = objectRegistry.create('free-rope', 260, 300, { length: 60 });
        const dropped = new Rope(100, 100, { length: 60 });
        engine.addObject(free);
        expect(ropeSegs(free)).toHaveLength(6); // the fresh-drop floor…
        expect(ropeSegs(dropped)).toHaveLength(6); // …matching a pinned rope's drop
        free.dispose();
        dropped.dispose();
    });
});

describe('Span-derived counts — tail trades and the world reconcile (issue #56)', () => {
    it('setEndpoints grows the tail: appended segments join the world, early seats keep their knots', () => {
        const engine = makeEngine();
        const rope = new Rope(200, 100, { length: 100 });
        const balloon = new Balloon(200, 205);
        engine.addObject(rope);
        engine.addObject(balloon);
        expect(ropeSegs(rope)).toHaveLength(6);

        // A knot on seat 2 realizes before the re-lay…
        rope.attachEndpoint(2, balloon, 'knot');
        engine.step(DT);
        let link = engine.getAttachedConstraints().find((c) => c.bodyB === balloon.bodies[0]);
        expect(link.bodyA).toBe(rope.bodies[3]); // seat 2 = _segments[2]

        // …and keeps riding the SAME seat-2 body through the re-lay:
        // appending keeps early bodies (and their seats) in place.
        const oldSeat = rope.bodies[3];
        rope.setEndpoints({ x: 200, y: 100 }, { x: 200, y: 520 }); // 420px
        expect(ropeSegs(rope)).toHaveLength(11); // ceil(420/40)
        expect(rope.bodies[3]).toBe(oldSeat);
        const bodies = worldIds(engine);
        for (const body of rope.bodies) {
            expect(bodies.has(body.id), 'every appended segment joins the world').toBe(true);
        }
        const constraints = worldConstraintIds(engine);
        for (const constraint of rope.constraints) {
            expect(constraints.has(constraint.id), 'the rebuilt chain joins the world').toBe(true);
        }
        engine.step(DT);
        link = engine.getAttachedConstraints().find((c) => c.bodyB === balloon.bodies[0]);
        expect(link, 'the mid-chain knot survives the re-segmentation').toBeTruthy();
        expect(link.bodyA).toBe(rope.bodies[3]);
        // Anchor and tail sit on the endpoints — the anchor exactly (static),
        // the tail as exactly as a post-step read can be: the lay itself puts
        // it ON `end` (issue #56, handoff fix 4 — an appended tail is not
        // centre-laid half a pitch inboard), but these reads run AFTER the
        // step above, and one 16.7ms gravity step drops a free dynamic body
        // ~0.6px while the constraint solve leaves float dust in x (1e-11).
        // So: coordinate-wise closeness — 3 decimals in x (dust only), a
        // sub-pixel band in y (one step's fall) — which keeps the geometry
        // intent without asserting that integration is a no-op.
        expect([rope.bodies[0].position.x, rope.bodies[0].position.y]).toEqual([200, 100]);
        expect(rope.bodies[11].position.x).toBeCloseTo(200, 3);
        expect(Math.abs(rope.bodies[11].position.y - 520)).toBeLessThan(1); // < one step's free fall
    });

    it('dropping the tail removes bodies and chain constraints; over-pruned knots untie off the scan', () => {
        const engine = makeEngine();
        const rope = new Rope(200, 100, { length: 700 }); // 16 segments
        const balloon = new Balloon(200, 205);
        engine.addObject(rope);
        engine.addObject(balloon);
        expect(ropeSegs(rope)).toHaveLength(16);

        rope.attachEndpoint(8, balloon, 'knot');
        rope.attachEndpoint(15, balloon, 'knot'); // the tail seat too
        expect(rope.getAttachmentRefs().map((r) => r.segment)).toEqual([8, 15]);
        engine.step(DT);
        expect(engine.getAttachedConstraints().filter((c) => c.bodyB === balloon.bodies[0]))
            .toHaveLength(2);

        const before = rope.bodies.map((b) => b.id);
        rope.setEndpoints({ x: 200, y: 100 }, { x: 200, y: 380 }); // 280px → 7 counts
        expect(ropeSegs(rope)).toHaveLength(7);
        engine.step(DT);
        // Seats 8 and 15 no longer resolve: their knots prune off the
        // reconcile scan and their realized links co-terminated.
        expect(rope.getAttachmentRefs(), 'both knots sat on pruned seats').toEqual([]);
        expect(engine.getAttachedConstraints().filter((c) => c.bodyB === balloon.bodies[0]))
            .toEqual([]);
        const after = worldIds(engine);
        for (const id of before.slice(8)) {
            expect(after.has(id), 'pruned segments leave the world').toBe(false);
        }
        for (const id of before.slice(0, 8)) {
            expect(after.has(id), 'kept segments stay').toBe(true);
        }
    });

    it('the converge packet reports the exact tail trade: added and dropped body lists', () => {
        const engine = makeEngine();
        const rope = new Rope(200, 100, { length: 100 });
        engine.addObject(rope);
        const events = trackEvent('rope:chain-converge');

        rope.setEndpoints({ x: 200, y: 100 }, { x: 200, y: 520 }); // 6 → 11 counts
        expect(events).toHaveLength(1);
        const [packet] = events;
        expect(packet.rope).toBe(rope);
        expect(packet.dropped).toEqual([]);
        expect(packet.added).toHaveLength(5);
        expect(packet.added.every((b) => b.label?.startsWith('rope-seg'))).toBe(true);
        expect(packet.added.every((b) => rope.bodies.includes(b))).toBe(true);

        rope.setEndpoints({ x: 200, y: 100 }, { x: 200, y: 380 }); // 11 → 7 counts
        expect(events).toHaveLength(2);
        expect(events[1].added).toEqual([]);
        expect(events[1].dropped).toHaveLength(4);
        expect(events[1].dropped.every((b) => !rope.bodies.includes(b))).toBe(true);
    });

    it('a frozen re-lay (resegment: false) keeps every body and seat, and stretches the rest lengths', () => {
        const engine = makeEngine();
        const rope = new Rope(200, 100, { length: 100 }); // 6 segments
        engine.addObject(rope);
        const chainBefore = rope.bodies.slice();
        const tailBefore = rope.bodies[rope.bodies.length - 1]; // seat 5
        const events = trackEvent('rope:chain-converge');

        rope.setEndpoints({ x: 200, y: 100 }, { x: 200, y: 700 }, { resegment: false }); // 600px

        // No re-count: the same bodies in the same seats (knots store literal
        // seat indices, so a frozen re-lay is what keeps them on their own
        // body — seat 5 is still the tail).
        expect(rope.bodies).toEqual(chainBefore);
        expect(rope.bodies[rope.bodies.length - 1]).toBe(tailBefore);
        expect(ropeSegs(rope)).toHaveLength(6);
        expect(rope._length).toBe(600);
        // …and the chain's rest lengths stretched to the new span (600/6 per
        // link, half of it anchor→seat 0) so the chain rests taut at 600.
        expect(rope.constraints).toHaveLength(6);
        expect(rope.constraints[0].length).toBeCloseTo(50, 5);
        expect(rope.constraints[1].length).toBeCloseTo(100, 5);
        // Nothing joined or left the world: the packet's tail trade is empty.
        expect(events).toHaveLength(1);
        expect(events[0].rope).toBe(rope);
        expect(events[0].added).toEqual([]);
        expect(events[0].dropped).toEqual([]);
        const bodies = worldIds(engine);
        for (const body of rope.bodies) {
            expect(bodies.has(body.id), 'the kept bodies stay in the world').toBe(true);
        }
    });

    it('a pinned tie-grow freezes the chain count; a free rope tie-grow re-counts it', () => {
        const engine = makeEngine();
        const balloon = new Balloon(600, 300); // the knot's reach: far past the rope
        const pinned = new Rope(200, 100, { length: 60 }); // authored 6-chain
        engine.addObject(pinned);
        engine.addObject(balloon);

        const tail = pinned.bodies[pinned.bodies.length - 1]; // seat 5
        pinned.attachEndpoint(5, balloon, 'knot');

        // The grow covered the knot (span = tied·6/5.5) without reshaping the
        // chain the level authored: seat 5 is still the tail, so the knot's
        // link still realizes from its own body.
        const knot = balloon.getAttachmentWorldPoint('knot');
        const tied = Math.hypot(knot.x - 200, knot.y - 100);
        expect(ropeSegs(pinned)).toHaveLength(6);
        expect(pinned.bodies[pinned.bodies.length - 1]).toBe(tail);
        expect(pinned._length).toBeCloseTo(tied * 6 / 5.5, 5);
        expect(pinned.getAttachmentRefs().map((r) => r.segment)).toEqual([5]);

        // A free rope owns no authored chain: its span IS the chain, so the
        // same grow re-derives the count from the span it grew to.
        const far = new Balloon(900, 500);
        const free = objectRegistry.create('free-rope', 200, 400, { length: 60 });
        engine.addObject(free);
        engine.addObject(far);
        free.attachEndpoint(-1, balloon, 'knot'); // the spawn lays 6
        expect(ropeSegs(free)).toHaveLength(6);
        free.attachEndpoint(2, far, 'knot');
        expect(ropeSegs(free).length).toBe(Rope.segmentsForSpan(free._length));
        expect(ropeSegs(free).length).toBeGreaterThan(6);
        expect(free.getAttachmentRefs().map((r) => r.segment)).toEqual([-1, 2]);
    });
});

describe('Span-derived counts — the persisted count beats a re-derive (issue #56)', () => {
    it('a restored count the span does not derive survives the first anchor tie (a re-root is not a re-count)', () => {
        const engine = makeEngine();
        const balloon = new Balloon(600, 200);
        engine.addObject(balloon);
        // A row's chain count is a restore contract (`options.segments`,
        // issue #56): the rope comes back with the chain it was SAVED with,
        // whether or not the span alone derives that count. A pinned rope's
        // frozen-count tie-grow is the natural producer (6 bodies over an
        // 811px span); a hand-authored row is the same shape. 4 over 300px
        // — segmentsForSpan(300) answers 8.
        const rope = objectRegistry.deserialize({
            type: 'free-rope', x: 260, y: 300,
            options: { length: 300, segments: 4 },
        });
        engine.addObject(rope);
        expect(ropeSegs(rope), 'the restore births the saved count').toHaveLength(4);
        const firstSeat = rope.bodies[1];

        const converge = trackEvent('rope:chain-converge');
        rope.attachEndpoint(-1, balloon, 'knot');

        // The re-root moves the chain onto the clicked knot; it must not
        // re-count it. With the default re-segment it would answer
        // segmentsForSpan(300) = 8 and silently grow the restored chain,
        // voiding the count the row fixed — and on a live free rope it
        // would mint/prune a body on a re-root that changed no span at all
        // (the sealed length and the hypot dust either side of a boundary).
        expect(ropeSegs(rope), 'the re-root is not a re-count').toHaveLength(4);
        expect(rope.bodies[1]).toBe(firstSeat); // same seat, same body
        expect(converge).toHaveLength(1);
        expect(converge[0].added).toEqual([]);
        expect(converge[0].dropped).toEqual([]);
        expect(rope._length).toBeCloseTo(300, 5);
        const knot = balloon.getAttachmentWorldPoint('knot');
        expect(rope.bodies[0].position.x).toBeCloseTo(knot.x, 5); // it did re-root
        expect(rope.bodies[0].position.y).toBeCloseTo(knot.y, 5);

        rope.dispose();
        balloon.dispose();
    });
});

describe('Span-derived counts — the hand and the freeze (issue #56)', () => {
    it('relayFreeEnd re-derives the count under the demand; a frozen rope re-orients on its circle', () => {
        const engine = makeEngine();
        const rope = new Rope(100, 100, { length: 240 }); // 6 segments
        engine.addObject(rope);

        rope.relayFreeEnd(100, 420); // a 320px demand
        // The under-span trick: the tail square backs to the demand at the
        // current count — span = demand·c/(c−0.5) — and the count
        // re-derives from that grown span.
        expect(rope._length).toBeCloseTo(320 * 6 / 5.5, 5);
        expect(ropeSegs(rope)).toHaveLength(9); // ceil(349.1/40)
        // A second demand at the settled count converges (9 segments).
        rope.relayFreeEnd(100, 420);
        expect(rope._length).toBeCloseTo(320 * 9 / 8.5, 5);
        expect(ropeSegs(rope)).toHaveLength(9);

        // Tie: the rope freezes; further re-lays only re-orient along the
        // frozen span (the reach circle is capacity, not the hand's reach).
        const balloon = new Balloon(140, 140);
        engine.addObject(balloon);
        rope.attachEndpoint(-1, balloon, 'knot');
        expect(rope.lengthFrozen).toBe(true);
        rope.relayFreeEnd(300, 700); // a 632px demand
        // The tie never shrinks the span: the relay's converged span holds,
        // re-sealed exact after every frozen re-orient.
        expect(rope._length).toBeCloseTo(320 * 9 / 8.5, 5);
        expect(ropeSegs(rope)).toHaveLength(9); // the frozen span still re-derives 9
        const tail = rope.bodies[rope.bodies.length - 1].position;
        // The capacity circle, not the layout end: half a segment inboard.
        expect(Math.hypot(tail.x - 100, tail.y - 100)).toBeCloseTo(320, 5); // span·(9−0.5)/9 = the demand
    });
});