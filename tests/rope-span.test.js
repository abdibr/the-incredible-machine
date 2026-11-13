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
 *   their indices; knots that hold named seats re-seat onto the new
 *   count's own end/middle (issue #87). A knot on a seat the rope never
 *   named keeps its index while the count still lays it, and knots whose
 *   seats the tail trade removed prune off the reconcile scan. The packet
 *   emits `added`/`dropped`, and PhysicsEngine._restoreRopeConstraints
 *   reconciles the world (added join, dropped leave, the chain swap
 *   co-terminates).
 * - rope.relayFreeEnd — the hand re-derives the count under the demand;
 *   a frozen pinned rope holds its span, a free rope takes any.
 * - The one covering rule (issue #89): a re-lay re-counts even a tied
 *   rope (no frozen variant left), a pinned tie-grow re-counts like a
 *   free one, and a restore re-derives the chain from the row's span
 *   alone — no chain count rides the row, a stale one is ignored, and
 *   the re-root re-lays to the unchanged span's own answer.
 * - Dead-seat pruning: a named seat RIDES the re-count (issue #87 — the
 *   end knot onto the new tail); only a seat the rope never named unties
 *   off the scan when its body is gone.
 */

import { describe, it, expect, afterEach } from 'vitest';
import Matter from 'matter-js';
import { PhysicsEngine } from '../js/engine/PhysicsEngine.js';
import { objectRegistry } from '../js/objects/ObjectRegistry.js';
import { registerAllObjects } from '../js/objects/registerAllObjects.js';
import { serializePlacedBoard, restorePlacedFromSnapshot } from '../js/reset/levelReset.js';
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
    it('setEndpoints grows the tail: appended segments join the world; the mid knot rides the new middle', () => {
        const engine = makeEngine();
        const rope = new Rope(200, 100, { length: 100 });
        const balloon = new Balloon(200, 205);
        engine.addObject(rope);
        engine.addObject(balloon);
        expect(ropeSegs(rope)).toHaveLength(6);

        // A knot on the MID seat (seat 2 of 6) ties beyond its covering
        // circle (130.6px out vs 41.7): the covering grow re-lays the chain
        // and the count re-derives from the grown span (313.4px → 8 — one
        // covering rule, issue #89), re-seating the knot 2 → 3 (the new
        // middle) before its link even realizes…
        rope.attachEndpoint('mid', balloon, 'knot');
        expect(ropeSegs(rope)).toHaveLength(8); // the tie-grow re-counted
        engine.step(DT);
        let link = engine.getAttachedConstraints().find((c) => c.bodyB === balloon.bodies[0]);
        expect(link.bodyA).toBe(rope.bodies[4]); // the new middle body (seat 3 of 8)

        // …and rides the next re-count onto the NEW middle (issue #87): the
        // knot holds the mid SEAT, so the 8 → 11 re-lay re-seats it 3 → 5
        // and the world keeps every chain body that the append didn't take
        // away.
        const oldSeat = rope.bodies[4];
        rope.setEndpoints({ x: 200, y: 100 }, { x: 200, y: 520 }); // 420px
        expect(ropeSegs(rope)).toHaveLength(11); // ceil(420/40)
        expect(rope.bodies[4]).toBe(oldSeat); // the body kept its chain index…
        expect(rope.getAttachmentRefs().map((r) => r.seat)).toEqual(['mid']); // …the knot IS the mid seat throughout
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
        expect(link, 'the mid-seat knot survives the re-segmentation').toBeTruthy();
        expect(link.bodyA).toBe(rope.bodies[6]); // the new middle body (seat 5 of 11)
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
        // The tail's residual after the step is a HAUL, not a snap: the
        // re-lay parked the knot on the NEW mid seat (issue #87) and its
        // rest sits ~79px past the balloon, so the knot link's first step
        // drags the chain inboard a few px. The intent is unchanged — the
        // append did not snap the tail off the end point, and the residual
        // stays under a pitch (~40px) — it is just the knot's strain now,
        // not one free-fall step (the gravity component is still ~0.6px).
        expect(Math.abs(rope.bodies[11].position.y - 520)).toBeLessThan(420 / 40); // < a pitch
    });

    it('a shorter re-lay rides the end knot onto the new tail; the roles never lose a knot', () => {
        const engine = makeEngine();
        const rope = new Rope(200, 100, { length: 700 }); // 16 segments
        const balloon = new Balloon(200, 205);
        engine.addObject(rope);
        engine.addObject(balloon);
        expect(ropeSegs(rope)).toHaveLength(16);

        // Two knots on one rope: the mid seat (the middle of 16, inside its
        // covering window) and the END seat (the tail, inside the capacity).
        // One knot per seat; two seats may tie the same target point.
        rope.attachEndpoint('mid', balloon, 'knot');
        rope.attachEndpoint('end', balloon, 'knot');
        expect(rope.getAttachmentRefs().map((r) => r.seat)).toEqual(['mid', 'end']);
        engine.step(DT);
        expect(engine.getAttachedConstraints().filter((c) => c.bodyB === balloon.bodies[0]))
            .toHaveLength(2);

        const before = rope.bodies.map((b) => b.id);
        rope.setEndpoints({ x: 200, y: 100 }, { x: 200, y: 380 }); // 280px → 7 counts
        expect(ropeSegs(rope)).toHaveLength(7);
        // The knots keep their seats by themselves (issue #87 kept by #90's
        // roles): both refs still name their roles — the mid knot on the new
        // middle (seg 3 of 7), the end knot on the new tail. No ref can sit
        // on a traded-away body: a role always resolves a live body.
        expect(rope.getAttachmentRefs().map((r) => r.seat)).toEqual(['mid', 'end']);
        engine.step(DT);
        // Both links realize from the roles' new bodies.
        expect(rope.getAttachmentRefs()).toHaveLength(2);
        const links = engine.getAttachedConstraints().filter((c) => c.bodyB === balloon.bodies[0]);
        expect(links).toHaveLength(2);
        const midSeat = rope.getTieSeats().find((s2) => s2.role === 'mid').body;
        const endSeat = rope.getTieSeats().find((s2) => s2.role === 'end').body;
        expect(links.map((l) => l.bodyA).sort((a, b) => a.id - b.id))
            .toEqual([midSeat, endSeat].sort((a, b) => a.id - b.id));
        const after = worldIds(engine);
        for (const id of before.slice(8)) {
            expect(after.has(id), 'pruned segments leave the world').toBe(false);
        }
        for (const id of before.slice(0, 7)) {
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

    it('a re-lay of a tied rope re-counts too: one mode, no frozen variant (issue #89)', () => {
        const engine = makeEngine();
        const rope = new Rope(200, 100, { length: 100 }); // 6 segments
        const balloon = new Balloon(230, 124.4); // knot at (230, 150): 58.3px out ≤ 91.7
        engine.addObject(rope);
        engine.addObject(balloon);
        rope.attachEndpoint('end', balloon, 'knot'); // the first tie freezes the length
        expect(rope.lengthFrozen).toBe(true);
        expect(ropeSegs(rope)).toHaveLength(6);

        const events = trackEvent('rope:chain-converge');
        const chainBefore = rope.bodies.slice();
        rope.setEndpoints({ x: 200, y: 100 }, { x: 200, y: 700 }); // 600px

        // No frozen variant survives: the count re-derives from the new
        // span whatever the tie state is, the earlier seats keep their
        // bodies, and the end knot rides the re-count onto the new tail
        // (issue #87).
        expect(ropeSegs(rope)).toHaveLength(15); // ceil(600/40)
        expect(rope.bodies.slice(0, chainBefore.length)).toEqual(chainBefore);
        expect(rope.getAttachmentRefs().map((r) => r.seat)).toEqual(['end']); // the end knot IS the tail's through the re-count
        expect(rope._length).toBe(600);
        // The rebuilt rest lengths span the new span (half a pitch to
        // seg-0, 1½ pitches out to the appended tail on `end`).
        expect(rope.constraints).toHaveLength(15);
        expect(rope.constraints[0].length).toBeCloseTo(20, 5);
        expect(rope.constraints[14].length).toBeCloseTo(60, 5);
        // The packet reports the tail trade: 9 bodies appended, none dropped.
        expect(events).toHaveLength(1);
        expect(events[0].added).toHaveLength(9);
        expect(events[0].dropped).toEqual([]);
    });

    it('the covering rule is one rule: a pinned tie-grow re-counts like a free tie-grow (issue #89)', () => {
        const engine = makeEngine();
        const balloon = new Balloon(600, 300); // the knot's reach: far past the rope
        const pinned = new Rope(200, 100, { length: 60 }); // 6 segments
        engine.addObject(pinned);
        engine.addObject(balloon);

        const tail = pinned.bodies[pinned.bodies.length - 1]; // seat 5
        pinned.attachEndpoint('end', balloon, 'knot');

        // The grow covered the knot (span = tied·6/5.5) and the count is
        // the grown span's OWN answer — 13, re-counted like any re-lay
        // (the frozen-count exception is retired). The end knot rides the
        // re-count onto the NEW tail (issue #87), so its link realizes
        // from the tail's new body.
        const knot = balloon.getAttachmentWorldPoint('knot');
        const tied = Math.hypot(knot.x - 200, knot.y - 100);
        const grown = tied * 6 / 5.5;
        expect(pinned._length).toBeCloseTo(grown, 5);
        expect(ropeSegs(pinned)).toHaveLength(Rope.segmentsForSpan(grown));
        expect(ropeSegs(pinned)).toHaveLength(13);
        expect(pinned.getAttachmentRefs().map((r) => r.seat)).toEqual(['end']);
        expect(pinned.bodies[13]).not.toBe(tail); // the tail is the re-count's own body
        engine.step(DT);
        const link = engine.getAttachedConstraints().find((c) => c.bodyB === balloon.bodies[0]);
        expect(link.bodyA).toBe(pinned.bodies[13]); // realized from the new tail

        // The free rope's grow was always this rule: same covering, same
        // re-count (grown 865px → past the cap: 16 bodies), the mid knot
        // riding onto the new middle (issue #87). Now the two families
        // share it.
        const far = new Balloon(900, 500);
        const free = objectRegistry.create('free-rope', 200, 400, { length: 60 });
        engine.addObject(free);
        engine.addObject(far);
        free.attachEndpoint('anchor', balloon, 'knot'); // the spawn lays 6
        expect(ropeSegs(free)).toHaveLength(6);
        free.attachEndpoint('mid', far, 'knot');
        expect(ropeSegs(free).length).toBe(Rope.segmentsForSpan(free._length));
        expect(ropeSegs(free).length).toBeGreaterThan(6);
        const recounted = ropeSegs(free).length;
        expect(recounted).toBe(16); // grown 865px → past the cap: 16 bodies
        expect(free.getAttachmentRefs().map((r) => r.seat)).toEqual(['anchor', 'mid']); // the tie is the mid seat, wherever the cap-chain puts it
    });
});

describe('Span-derived counts — the restore re-derives the chain from the span (issue #89)', () => {
    it('a rope row carries no chain count; the restore re-derives the chain from the span', () => {
        const rope = new Rope(200, 100, { length: 480 }); // 12 segments
        const balloon = new Balloon(230, 124.4); // knot within the end seat's cover
        rope.attachEndpoint('end', balloon, 'knot'); // the end seat, inside its cover
        const rows = serializePlacedBoard([balloon, rope]);
        expect(rows[1].options.segments, 'no chain count rides the row').toBeUndefined();
        expect(rows[1].options.length).toBe(480);
        expect(rows[1].attachments).toEqual([
            { seat: 'end', targetType: 'balloon', targetOrdinal: 0, pointId: 'knot' },
        ]);

        const board2 = [];
        restorePlacedFromSnapshot(board2, rows);
        const restored = board2.find((o) => o.type === 'rope');
        expect(restored._length).toBe(480);
        expect(restored.bodies.length - 1).toBe(12); // segmentsForSpan(480)
        expect(restored.getAttachmentRefs().map((r) => r.seat)).toEqual(['end']);

        rope.dispose();
        balloon.dispose();
        for (const obj of board2) obj.dispose();
    });

    it('a stale chain count in a row is ignored: the span alone derives the count', () => {
        // A row saved before #89 may still carry `options.segments` — the
        // restore reads it no more: the count is the span's rule, so a
        // count the span does not derive cannot survive a cycle.
        const rope = objectRegistry.deserialize({
            type: 'rope', x: 100, y: 100,
            options: { length: 300, segments: 4 },
        });
        expect(rope.bodies.length - 1).toBe(8); // segmentsForSpan(300), not the saved 4
        rope.dispose();
    });

    it('the re-root is not a re-count: the re-lay re-derives the count the unchanged span answers', () => {
        const engine = makeEngine();
        const balloon = new Balloon(600, 200);
        engine.addObject(balloon);
        const rope = objectRegistry.create('free-rope', 260, 300, { length: 300 });
        engine.addObject(rope); // the authored span lays 8 as the rope enters the world
        expect(ropeSegs(rope)).toHaveLength(8);
        const firstSeat = rope.bodies[1];

        const converge = trackEvent('rope:chain-converge');
        rope.attachEndpoint('anchor', balloon, 'knot');

        // The re-root moves the chain onto the clicked knot; the count is
        // not re-derived against anything — it is the unchanged span's own
        // answer, the same 8 the chain birthed (the re-lay re-lines the
        // bodies it has and trades nothing).
        expect(ropeSegs(rope), 'the unchanged span re-derives the same count').toHaveLength(8);
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
        rope.attachEndpoint('anchor', balloon, 'knot');
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