/**
 * Knots keep their seats across growth and re-lay — GitHub issue #87.
 *
 * A chain-count change — a free rope's tie-grow re-count, the hand
 * re-laying a rope whose knots already live on it, a pinned tie-grow
 * stretching the span — re-seats every knot that holds a named seat
 * (issue #84): the mid knot rides the new chain's middle body, the end
 * knot its new tail, the anchor knot the anchor (−1 is the anchor in
 * every count). The reconcile then realizes each knot's engine link from
 * whatever body its seat names after the change. The seats' own
 * keep-rule in setEndpoints replaces issue #56's chain-end ride: a knot
 * keeps its seat because the seats re-derive, not because a tie writes
 * them — so nothing about the per-seat attachment has to lean on seat
 * indices staying put.
 *
 * Seams under test:
 * - Rope.attachEndpoint — the tie-grow that re-counts a free chain: the
 *   mid knot's ref and realized engine link land on the new middle body.
 * - Rope.relayFreeEnd / Rope.setEndpoints — the hand's re-lay: a shorter
 *   re-lay re-seats mid and end knots on the new count's middle/tail and
 *   prunes none; a grow keeps all three roles bound.
 * - PhysicsEngine.getAttachedConstraints — the realized-link bodies, one
 *   step after the count changed.
 * - serializePlacedBoard / restorePlacedFromSnapshot — a tie-grown rope
 *   does not creep longer across a save → load → save cycle.
 *
 * Companion suites: rope-seats (issue #84 — the seat answers), rope-ties
 * (segment ties + one knot per seat, #85), pinned-rope-length (reach per
 * seat, #86), rope-span (span-derived counts + the world reconcile).
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

describe('Knots keep their seats — a free tie-grow re-count (issue #87)', () => {
    it('a tie-grow that doubles the segment count re-seats the mid knot; its link realizes from the new middle body', () => {
        // A length-less free rope births at its first tie (issue #55): an
        // anchor tie spawns the 6-segment chain (span 100 ≤ floor band)
        // hanging from balloon A's knot. Tying its mid seat to balloon B's
        // knot 190px out grows the span to 190·6/2.5 = 456 (the mid seat's
        // covering rule, issue #86) → count 12 (ceil(456/40)) — exactly
        // double. The mid knot must ride the NEW chain's middle (seat 5),
        // not keep its literal birth index (2).
        const engine = makeEngine();
        const roper = objectRegistry.create('free-rope', 300, 100); // the bundle
        const anchor = new Balloon(300, 100); // knot at (300, 125.6)
        const target = new Balloon(300, 290); // knot at (300, 315.6): 190px out
        engine.addObject(roper);
        engine.addObject(anchor);
        engine.addObject(target);

        roper.attachEndpoint(-1, anchor, 'knot'); // spawns the 6-chain
        expect(roper.bodies.length - 1).toBe(6);
        const bornMidBody = roper.getTieSeats()[1].body; // the birth chain's middle

        roper.attachEndpoint(2, target, 'knot'); // the mid-seat tie beyond reach grows
        expect(roper.bodies.length - 1).toBe(12); // 456px span re-counted 6 → 12
        expect(roper.getAttachmentRefs().map((r) => r.segment)).toEqual([-1, 5]); // re-seated

        engine.step(DT);
        const midLinks = knotLinks(engine, target);
        expect(midLinks).toHaveLength(1);
        expect(midLinks[0].bodyA).toBe(roper.bodies[6]); // the new middle body (anchor + seat 5)

        // The seat answer agrees — the mid role IS where the knot lives —
        // and the old seat-2 body lost the knot for good.
        const [mid, end] = roper.getTieSeats().slice(1);
        expect(mid.segment).toBe(5);
        expect(mid.body).toBe(roper.bodies[6]);
        expect(mid.body).not.toBe(bornMidBody);
        expect(end.segment).toBe(11);
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
        // mid-seat tie (seat 5, exactly the middle of an odd count) at 200px
        // sits inside its covering circle (440·5.5/11 = 220): no grow. The
        // free family owes the hand any span (relayFreeEnd, tied or not):
        // demanding 300px re-counts 11 → 8, and the mid knot must ride the
        // new middle (seat 3 of 8) — its old seat-5 body still exists, but
        // it is not the middle any more.
        const engine = makeEngine();
        const roper = objectRegistry.create('free-rope', 300, 100, { length: 440 });
        const anchor = new Balloon(300, 74.4); // knot at (300, 100): the rope's own root
        const target = new Balloon(300, 274.4); // knot at (300, 300): 200px out, ≤ 220
        engine.addObject(roper);
        engine.addObject(anchor);
        engine.addObject(target);
        expect(roper.bodies.length - 1).toBe(11);

        roper.attachEndpoint(-1, anchor, 'knot'); // the re-root: same count, same span
        expect(roper.bodies.length - 1).toBe(11);
        roper.attachEndpoint(5, target, 'knot'); // within reach: no grow, no re-count
        expect(roper.bodies.length - 1).toBe(11);
        expect(roper.getAttachmentRefs().map((r) => r.segment)).toEqual([-1, 5]);
        engine.step(DT);
        expect(knotLinks(engine, target)[0].bodyA).toBe(roper.bodies[6]); // seat 5

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
        expect(roper.getAttachmentRefs().map((r) => r.segment)).toEqual([-1, 3]); // 5 → 3

        engine.step(DT);
        const midLinks = knotLinks(engine, target);
        expect(midLinks).toHaveLength(1);
        expect(midLinks[0].bodyA).toBe(roper.bodies[4]); // the new middle body (anchor + seat 3)
        // Both knots kept: the anchor and the re-seated mid — none dropped.
        expect(roper.getAttachmentRefs()).toHaveLength(2);
        const [, mid] = roper.getTieSeats();
        expect(mid.segment).toBe(3);
        expect(mid.body).toBe(roper.bodies[4]);
        expect(midLinks[0].bodyA).toBe(mid.body); // the knot is ON the mid square
        roper.dispose();
        anchor.dispose();
        target.dispose();
    });

    it('a re-lay that trades the count in both directions keeps every live knot bound', () => {
        // The full three-seat rope (issue #85): a 480px authored free rope
        // lays 12 segments; the anchor tie re-roots on A, the mid tie (seat
        // 5, covering 220) holds B 200px out, and the end tie (seat 11,
        // covering 460) holds C 440px out — all three inside their own
        // windows, so nothing grows at tie time. Then the hand re-lays LONG
        // (span 590 → count 15) and SHORT again (span 240 → count 6): every
        // knot re-seats onto its new role's body and realizes there — none
        // pruned, none left on a stale body — while the ref list stays
        // anchor-first in chain order.
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

        roper.attachEndpoint(-1, anchorB, 'knot');
        roper.attachEndpoint(5, midB, 'knot');
        roper.attachEndpoint(11, endB, 'knot');
        expect(roper.bodies.length - 1).toBe(12); // all ties inside their windows
        expect(roper.getAttachmentRefs().map((r) => r.segment)).toEqual([-1, 5, 11]);
        engine.step(DT);
        expect(knotLinks(engine, midB)[0].bodyA).toBe(roper.bodies[6]); // seat 5
        expect(knotLinks(engine, endB)[0].bodyA).toBe(roper.bodies[12]); // seat 11

        // LONG: the anchor as it lies, aim down-right so the re-lay stays
        // in the playfield; span 590 → count 15 (well inside the band).
        const root = roper.bodies[0].position;
        const demand = 590 * (11.5 / 12); // end square at demand for the span 590
        roper.relayFreeEnd(root.x + 0.6 * demand, root.y + 0.8 * demand);
        expect(roper.bodies.length - 1).toBe(15);
        expect(roper.getAttachmentRefs().map((r) => r.segment)).toEqual([-1, 7, 14]); // mid 5→7, end 11→14

        engine.step(DT);
        expect(knotLinks(engine, midB)[0].bodyA).toBe(roper.bodies[8]); // seat 7 of 15
        expect(knotLinks(engine, endB)[0].bodyA).toBe(roper.bodies[15]); // the new tail
        expect(roper.getAttachmentRefs()).toHaveLength(3); // nobody pruned

        // SHORT: span 240 → count 6; the roles collapse back inboard. The
        // anchor is a moving knot (decision 5): the step above hauled it, so
        // re-aim from where it lies NOW — the demand measures from there.
        const root2 = roper.bodies[0].position;
        const demand2 = 240 * (14.5 / 15); // the end square at the 15-chain's fraction
        roper.relayFreeEnd(root2.x + 0.6 * demand2, root2.y + 0.8 * demand2);
        expect(roper.bodies.length - 1).toBe(6);
        expect(roper.getAttachmentRefs().map((r) => r.segment)).toEqual([-1, 2, 5]); // mid 7→2, end 14→5

        engine.step(DT);
        expect(knotLinks(engine, midB)[0].bodyA).toBe(roper.bodies[3]); // seat 2 of 6
        expect(knotLinks(engine, endB)[0].bodyA).toBe(roper.bodies[6]); // the tail seat 5
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
        // The creep that the literal-index knots suffered: a mid-seat tie
        // grows the span to cover itself (190px → 456, count 6 → 12) but a
        // knot kept at its literal seat 2 would re-derive a smaller covering
        // fraction on a restored 12-chain (2.5/12 vs the tied 2.5/6) and
        // grow AGAIN on every bind — the rope crept a doubling per cycle.
        // With the seat kept (mid of 12 = 5), the restored covering
        // (5.5/12 = 0.458) stays past the tied fraction: the bind re-seats,
        // covers, settles — and the second save is the first's twin.
        const anchorB = new Balloon(300, 100); // knot (300, 125.6)
        const target = new Balloon(300, 290); // knot (300, 315.6): 190px out
        const roper = objectRegistry.create('free-rope', 300, 100); // the coil
        roper.attachEndpoint(-1, anchorB, 'knot'); // spawn the 6-chain
        roper.attachEndpoint(2, target, 'knot'); // mid tie beyond reach → 456 / 12
        expect(roper.bodies.length - 1).toBe(12);
        expect(roper._length).toBeCloseTo(190 * 6 / 2.5, 5);

        const rows = serializePlacedBoard([anchorB, target, roper]);
        const board2 = [];
        restorePlacedFromSnapshot(board2, rows);
        const roper2 = board2.find((o) => o.type === 'free-rope');
        expect(roper2.bodies.length - 1).toBe(12); // the row's count restored
        expect(roper2._length).toBeCloseTo(456, 3); // no grow fired on the bind
        expect(roper2.getAttachmentRefs().map((r) => r.segment)).toEqual([-1, 5]);
        // The mid knot landed on the restored chain's middle body.
        expect(roper2.getTieSeats()[1].segment).toBe(5);

        const rows2 = serializePlacedBoard(board2);
        const board3 = [];
        restorePlacedFromSnapshot(board3, rows2);
        const roper3 = board3.find((o) => o.type === 'free-rope');
        expect(roper3.bodies.length - 1).toBe(roper2.bodies.length - 1); // 12 again
        expect(roper3._length).toBeCloseTo(roper2._length, 3); // not one px longer
        expect(roper3.getAttachmentRefs().map((r) => r.segment)).toEqual([-1, 5]);

        roper.dispose();
        anchorB.dispose();
        target.dispose();
        for (const obj of board2) obj.dispose();
        for (const obj of board3) obj.dispose();
    });

    it('a tie-grown pinned rope round-trips idempotently; its seats hold (frozen count)', () => {
        // The pinned family's tie-grow freezes the count (issue #56): the
        // mid tie (seat 2 of 6) grows the span to 240 with the SAME six
        // bodies, the mid seat still the middle. Save → load → save: the
        // persisted count re-births the stretched chain, the token lands
        // back on the middle body, and the covering gate stays shut.
        const target = new Balloon(300, 74.4); // knot (300, 100): 100px out
        const roper = new Rope(300, 200, { length: 100 });
        expect(roper.bodies.length - 1).toBe(6);
        roper.attachEndpoint(2, target, 'knot');
        expect(roper.bodies.length - 1).toBe(6); // the count froze
        expect(roper._length).toBeCloseTo(240, 5); // 100px covered at 2.5/6
        expect(roper.getAttachmentRefs().map((r) => r.segment)).toEqual([2]);

        const rows = serializePlacedBoard([target, roper]);
        const board2 = [];
        restorePlacedFromSnapshot(board2, rows);
        const roper2 = board2.find((o) => o.type === 'rope');
        expect(roper2.bodies.length - 1).toBe(6); // the persisted count
        expect(roper2._length).toBeCloseTo(240, 3);
        expect(roper2.getAttachmentRefs().map((r) => r.segment)).toEqual([2]);
        expect(roper2.getTieSeats()[1].segment).toBe(2); // still the middle of 6

        const rows2 = serializePlacedBoard(board2);
        const board3 = [];
        restorePlacedFromSnapshot(board3, rows2);
        const roper3 = board3.find((o) => o.type === 'rope');
        expect(roper3.bodies.length - 1).toBe(6);
        expect(roper3._length).toBeCloseTo(roper2._length, 3); // not one px longer
        expect(roper3.getAttachmentRefs().map((r) => r.segment)).toEqual([2]);

        roper.dispose();
        target.dispose();
        for (const obj of board2) obj.dispose();
        for (const obj of board3) obj.dispose();
    });
});
