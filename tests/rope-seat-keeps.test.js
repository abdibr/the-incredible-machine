/**
 * Knots keep their seats across growth and re-lay — GitHub issues #87/#90.
 *
 * A chain-count change — a tie-grow re-count, the hand re-laying a rope
 * whose knots already live on it — keeps every knot on its seat. Since
 * #90 the knot's address IS the seat ROLE, so the keeping is by
 * construction: a knot tied on the 'mid' seat IS the middle's knot, an
 * 'end' knot the tail's, the 'anchor' knot the anchor's — whatever body
 * each role then names, the reconcile realizes the knot's engine link
 * from it, and nothing is written at re-count time. (Issues #84–#87 built
 * the re-seating machinery that kept literal seat indices riding the
 * roles; #90 deleted it with the index surface.)
 *
 * Seams under test:
 * - Rope.attachEndpoint — the tie-grow that re-counts a chain: the mid
 *   knot's ref and realized engine link land on the new middle body.
 * - Rope.relayFreeEnd / Rope.setEndpoints — the hand's re-lay: a shorter
 *   re-lay re-derives the mid/end bodies and prunes none; a grow keeps
 *   all three roles bound.
 * - PhysicsEngine.getAttachedConstraints — the realized-link bodies, one
 *   step after the count changed.
 * - serializePlacedBoard / restorePlacedFromSnapshot — a tie-grown rope
 *   does not creep longer across a save → load → save cycle.
 *
 * Companion suites: rope-seats (issues #84/#90 — the seat answers),
 * rope-ties (role ties + one knot per seat), pinned-rope-length (reach
 * per seat, #86), rope-span (span-derived counts + the world reconcile).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { PhysicsEngine } from '../js/engine/PhysicsEngine.js';
import { objectRegistry } from '../js/objects/ObjectRegistry.js';
import { registerAllObjects } from '../js/objects/registerAllObjects.js';
import Rope from '../js/objects/Rope.js';
import Balloon from '../js/objects/Balloon.js';
import { serializePlacedBoard, restorePlacedFromSnapshot } from '../js/reset/levelReset.js';

registerAllObjects();

const DT = 1000 / 60;
const engines = [];

afterEach(() => {
    for (const engine of engines) engine.dispose();
    engines.length = 0;
});

function makeEngine(width = 800, height = 600) {
    const engine = new PhysicsEngine(width, height);
    engines.push(engine);
    return engine;
}

const knotLinks = (engine, target) => engine.getAttachedConstraints()
    .filter((c) => c.bodyB === target.bodies[0]);

describe('Knots keep their seats — a tie-grow re-count (issue #87)', () => {
    it('a tie-grow that doubles the segment count keeps the mid knot on the middle; its link realizes from the new middle body', () => {
        // A length-less free rope births at its first tie (issue #55): an
        // anchor tie spawns the 6-segment chain (span 100: the floor band)
        // hanging from balloon A's knot. Tying its mid seat to balloon B's
        // knot 190px out grows the span to cover the knot (the mid seat's
        // covering rule, issue #86) through the two-pass seal (issue #99):
        // the provisional 190*6/2.5 = 456 names count 12, and the seal re-
        // divides by count 12's own mid fraction (5.5/12) to ~414.5, whose
        // own count answer is 11. The mid knot IS the mid seat's (issue
        // #90), so the new middle body is its body, its literal birth index
        // notwithstanding.
        const engine = makeEngine();
        const roper = objectRegistry.create('free-rope', 300, 100); // the bundle
        const anchor = new Balloon(300, 100); // knot at (300, 125.6)
        const target = new Balloon(300, 290); // knot at (300, 315.6): 190px out
        engine.addObject(roper);
        engine.addObject(anchor);
        engine.addObject(target);

        roper.attachEndpoint('anchor', anchor, 'knot'); // spawns the 6-chain
        expect(roper.bodies.length - 1).toBe(6);
        const bornMidBody = roper.getTieSeats()[1].body; // the birth chain's middle

        roper.attachEndpoint('mid', target, 'knot'); // the mid-seat tie beyond reach grows
        expect(roper.bodies.length - 1).toBe(11); // 414.5px span re-counted 6 to 11
        expect(roper.getAttachmentRefs().map((r) => r.seat)).toEqual(['anchor', 'mid']); // role refs, unchanged by the grow

        engine.step(DT);
        const midLinks = knotLinks(engine, target);
        expect(midLinks).toHaveLength(1);
        expect(midLinks[0].bodyA).toBe(roper.bodies[6]); // the new middle body (anchor + seg 5)

        // The seat answer agrees — the mid role IS where the knot lives —
        // and the old seat's body lost the knot for good.
        const [mid, end] = roper.getTieSeats().slice(1);
        expect(mid.body).toBe(roper.bodies[6]);
        expect(mid.body).not.toBe(bornMidBody);
        expect(end.body).toBe(roper.bodies[11]);
        expect(knotLinks(engine, target).map((l) => l.bodyA)).toEqual([roper.bodies[6]]);
        roper.dispose();
        anchor.dispose();
        target.dispose();
    });
});

describe('Knots keep their seats — the hand\'s re-lay (issue #87)', () => {
    it('a hand re-lay that shrinks the count re-seats the mid knot lower; no knot is dropped', () => {
        // An authored free rope lays 11 segments (440px = ceil 11) as it
        // enters a world (issue #56); the anchor tie re-roots the chain on
        // balloon A's knot (not a re-count — the count survives it), then a
        // mid-seat tie at 200px sits inside its covering circle (440·5.5/11
        // = 220 — the mid of an odd count is exactly the middle): no grow.
        // The free family owes the hand any span (relayFreeEnd, tied or
        // not): demanding 300px re-counts 11 → 8, and the mid knot must end
        // up on the new middle body (seg 3 of 8) — its old body still
        // exists, but it is not the middle any more.
        const engine = makeEngine();
        const roper = objectRegistry.create('free-rope', 300, 100, { length: 440 });
        const anchor = new Balloon(300, 74.4); // knot at (300, 100): the rope's own root
        const target = new Balloon(300, 274.4); // knot at (300, 300): 200px out, ≤ 220
        engine.addObject(roper);
        engine.addObject(anchor);
        engine.addObject(target);
        expect(roper.bodies.length - 1).toBe(11);

        roper.attachEndpoint('anchor', anchor, 'knot'); // the re-root: same count, same span
        expect(roper.bodies.length - 1).toBe(11);
        roper.attachEndpoint('mid', target, 'knot'); // within reach: no grow, no re-count
        expect(roper.bodies.length - 1).toBe(11);
        expect(roper.getAttachmentRefs().map((r) => r.seat)).toEqual(['anchor', 'mid']);
        engine.step(DT);
        expect(knotLinks(engine, target)[0].bodyA).toBe(roper.bodies[6]); // seg 5, the middle of 11

        // The hand re-lays: free family, tied knots and all, any span. The
        // END square must sit at demanded·count/(count−0.5) from the ANCHOR
        // to land the span at 300 (240 < span ≤ 320 → count 8: the demand
        // is aimed well inside that band so float dust cannot flip it).
        // The aim reads the anchor as it lies (one step ran; the balloon's
        // bob moves the moving knot a little) — relayFreeEnd measures from
        // there.
        const root = roper.bodies[0].position;
        roper.relayFreeEnd(root.x, root.y + 300 * (10.5 / 11));
        expect(roper.bodies.length - 1).toBe(8); // 11 → 8, the tail traded
        expect(roper._length).toBeCloseTo(300, 3);
        expect(roper.getAttachmentRefs().map((r) => r.seat)).toEqual(['anchor', 'mid']); // the roles never moved

        engine.step(DT);
        const midLinks = knotLinks(engine, target);
        expect(midLinks).toHaveLength(1);
        expect(midLinks[0].bodyA).toBe(roper.bodies[4]); // the new middle body (anchor + seg 3)
        // Both knots kept: the anchor and the riding mid — none dropped.
        expect(roper.getAttachmentRefs()).toHaveLength(2);
        const [, mid] = roper.getTieSeats();
        expect(mid.body).toBe(roper.bodies[4]);
        expect(midLinks[0].bodyA).toBe(mid.body); // the knot is ON the mid square
        roper.dispose();
        anchor.dispose();
        target.dispose();
    });

    it('a re-lay that trades the count in both directions keeps every live knot bound', () => {
        // The full three-seat rope (issue #85): a 480px authored free rope
        // lays 12 segments; the anchor tie re-roots on A, the mid tie (seg
        // 5, covering 220) holds B 200px out, and the end tie (seg 11,
        // covering 460) holds C 440px out — all three inside their own
        // windows, so nothing grows at tie time. Then the hand re-lays LONG
        // (span 590 → count 15) and SHORT again (span 240 → count 6): every
        // knot ends up on its role's body and realizes there — none pruned,
        // none left on a stale body — while the ref list stays anchor-first
        // in role order.
        const engine = makeEngine();
        const roper = objectRegistry.create('free-rope', 300, 100, { length: 480 });
        const anchorB = new Balloon(300, 74.4); // knot (300, 100)
        const midB = new Balloon(300, 274.4); // knot (300, 300): 200px, ≤ 220
        const endB = new Balloon(300, 514.4); // knot (300, 540): 440px, ≤ 460
        engine.addObject(roper);
        engine.addObject(anchorB);
        engine.addObject(midB);
        engine.addObject(endB);
        expect(roper.bodies.length - 1).toBe(12);

        roper.attachEndpoint('anchor', anchorB, 'knot');
        roper.attachEndpoint('mid', midB, 'knot');
        roper.attachEndpoint('end', endB, 'knot');
        expect(roper.bodies.length - 1).toBe(12); // all ties inside their windows
        expect(roper.getAttachmentRefs().map((r) => r.seat)).toEqual(['anchor', 'mid', 'end']);
        engine.step(DT);
        expect(knotLinks(engine, midB)[0].bodyA).toBe(roper.bodies[6]); // seg 5, the middle of 12
        expect(knotLinks(engine, endB)[0].bodyA).toBe(roper.bodies[12]); // seg 11, the tail

        // LONG: the anchor as it lies, aim down-right so the re-lay stays
        // in the playfield; span 590 → count 15 (well inside the band).
        const root = roper.bodies[0].position;
        const demand = 590 * (11.5 / 12); // end square at demand for the span 590
        roper.relayFreeEnd(root.x + 0.6 * demand, root.y + 0.8 * demand);
        expect(roper.bodies.length - 1).toBe(15);
        expect(roper.getAttachmentRefs().map((r) => r.seat)).toEqual(['anchor', 'mid', 'end']); // roles unchanged by the re-count

        engine.step(DT);
        expect(knotLinks(engine, midB)[0].bodyA).toBe(roper.bodies[8]); // seg 7, the middle of 15
        expect(knotLinks(engine, endB)[0].bodyA).toBe(roper.bodies[15]); // the new tail
        expect(roper.getAttachmentRefs()).toHaveLength(3); // nobody pruned

        // SHORT: span ~236 → count 6; the roles collapse back inboard. The
        // aim sits a few px inside the 240px band edge so float dust cannot
        // flip the re-derived count (the dust here rides the balloons' bob
        // noise through the hauled anchor). The anchor is a moving knot
        // (decision 5): the step above hauled it, so re-aim from where it
        // lies NOW — the demand measures from there.
        const root2 = roper.bodies[0].position;
        const demand2 = 236 * (14.5 / 15); // the end square at the 15-chain's fraction, span ~236
        roper.relayFreeEnd(root2.x + 0.6 * demand2, root2.y + 0.8 * demand2);
        expect(roper.bodies.length - 1).toBe(6);
        expect(roper.getAttachmentRefs().map((r) => r.seat)).toEqual(['anchor', 'mid', 'end']); // still the same three roles

        engine.step(DT);
        expect(knotLinks(engine, midB)[0].bodyA).toBe(roper.bodies[3]); // seg 2, the middle of 6
        expect(knotLinks(engine, endB)[0].bodyA).toBe(roper.bodies[6]); // the tail
        expect(roper.getAttachmentRefs()).toHaveLength(3); // still nobody pruned
        // The stale link audit: exactly three knot links in the world, each
        // from its seat's own body — nothing from dropped bodies.
        const ropeLinks = engine.getAttachedConstraints().filter((c) =>
            roper.bodies.includes(c.bodyA));
        expect(ropeLinks).toHaveLength(3);
        roper.dispose();
        anchorB.dispose();
        midB.dispose();
        endB.dispose();
    });
});

describe('Knots keep their seats — save → load → save (issue #87)', () => {
    it('a tie-grown free rope with a mid knot does not creep longer across save/load cycles', () => {
        // The creep that literal-index knots suffered: a mid-seat tie
        // grows the span to cover itself (190px, count 6: the two-pass
        // seal's provisional 456 names 12 bodies, whose mid fraction
        // 5.5/12 re-seals to ~414.5, whose own count answer is 11) but a
        // knot kept at its birth fraction (2.5/6 of 6) would re-derive a
        // smaller covering fraction on a restored 11-chain and grow AGAIN
        // on every bind: the rope crept a doubling per cycle. With the
        // knot ON the mid seat (mid of 11 = seg 5), the restored covering
        // (5.5/11 = 0.5) stays past the tied fraction (190/414.5 = 0.458):
        // the bind re-seats, covers, settles, and the second save is the
        // first's twin.
        const anchorB = new Balloon(300, 100); // knot (300, 125.6)
        const target = new Balloon(300, 290); // knot (300, 315.6): 190px out
        const roper = objectRegistry.create('free-rope', 300, 100); // the coil
        roper.attachEndpoint('anchor', anchorB, 'knot'); // spawn the 6-chain
        roper.attachEndpoint('mid', target, 'knot'); // mid tie beyond reach: 414.5 / 11
        expect(roper.bodies.length - 1).toBe(11);
        expect(roper._length).toBeCloseTo(190 * 12 / 5.5, 3);

        const rows = serializePlacedBoard([anchorB, target, roper]);
        const board2 = [];
        restorePlacedFromSnapshot(board2, rows);
        const roper2 = board2.find((o) => o.type === 'free-rope');
        expect(roper2.bodies.length - 1).toBe(11); // the span re-derives 11 (414.5/40)
        expect(roper2._length).toBeCloseTo(190 * 12 / 5.5, 3); // no grow fired on the bind
        expect(roper2.getAttachmentRefs().map((r) => r.seat)).toEqual(['anchor', 'mid']);
        // The mid knot landed on the restored chain's middle body.
        expect(roper2.getTieSeats()[1].body).toBe(roper2.bodies[6]);

        const rows2 = serializePlacedBoard(board2);
        const board3 = [];
        restorePlacedFromSnapshot(board3, rows2);
        const roper3 = board3.find((o) => o.type === 'free-rope');
        expect(roper3.bodies.length - 1).toBe(roper2.bodies.length - 1); // 11 again
        expect(roper3._length).toBeCloseTo(roper2._length, 3); // not one px longer
        expect(roper3.getAttachmentRefs().map((r) => r.seat)).toEqual(['anchor', 'mid']);

        roper.dispose();
        anchorB.dispose();
        target.dispose();
        for (const obj of board2) obj.dispose();
        for (const obj of board3) obj.dispose();
    });

    it('a tie-grown pinned rope round-trips idempotently; its seats hold (one covering rule)', () => {
        // The tie-grow's covering rule is ONE rule (issue #89): the mid tie
        // grows the span to 240 — whose own segmentsForSpan answer is still
        // six — so the chain rides the grow with its count, the mid seat
        // still the middle. Save → load → save: the restore re-derives the
        // same 6 from the saved span, the token lands back on the middle
        // body, and the covering gate stays shut (240 × 2.5/6 = the tied
        // 100, no fire — no creep per cycle).
        const target = new Balloon(300, 74.4); // knot (300, 100): 100px out
        const roper = new Rope(300, 200, { length: 100 });
        expect(roper.bodies.length - 1).toBe(6);
        roper.attachEndpoint('mid', target, 'knot');
        expect(roper.bodies.length - 1).toBe(6); // the re-count holds 6 (240/40)
        expect(roper._length).toBeCloseTo(240, 5); // 100px covered at 2.5/6
        expect(roper.getAttachmentRefs().map((r) => r.seat)).toEqual(['mid']);

        const rows = serializePlacedBoard([target, roper]);
        const board2 = [];
        restorePlacedFromSnapshot(board2, rows);
        const roper2 = board2.find((o) => o.type === 'rope');
        expect(roper2.bodies.length - 1).toBe(6); // the span re-derives the same 6 (240/40)
        expect(roper2._length).toBeCloseTo(240, 3);
        expect(roper2.getAttachmentRefs().map((r) => r.seat)).toEqual(['mid']);
        expect(roper2.getTieSeats()[1].body).toBe(roper2.bodies[3]); // still the middle of 6

        const rows2 = serializePlacedBoard(board2);
        const board3 = [];
        restorePlacedFromSnapshot(board3, rows2);
        const roper3 = board3.find((o) => o.type === 'rope');
        expect(roper3.bodies.length - 1).toBe(6);
        expect(roper3._length).toBeCloseTo(roper2._length, 3); // not one px longer
        expect(roper3.getAttachmentRefs().map((r) => r.seat)).toEqual(['mid']);

        roper.dispose();
        target.dispose();
        for (const obj of board2) obj.dispose();
        for (const obj of board3) obj.dispose();
    });
});
