/**
 * In-reach ties re-seat the rope, not the knot - GitHub issue #98
 * (Implementation Decision 2 of the rope-ties group spec).
 *
 * A tie made inside the seat's covering circle used to store the ref and
 * move nothing: the drawn seat stayed up to a reach-gap off the knot in
 * edit modes (the headless probe measured a 68.9px seat-to-knot gap for a
 * 260px rope tied straight down), and at play start the length-0 knot link
 * hauled the seat onto the knot with a worst single-beat jump of 70.5px -
 * the violent yank the anchor seat already engineered against. The re-seat
 * lays the chain so the seat IS on the knot at tie time, on a bowed path
 * when the knot sits inside the leg's reach: the tie never shortens the
 * rope (ADR 0007 decision 4), and the path's length stays exactly the
 * budget of rest lengths (ADR 0005 decision 12), so play start has nothing
 * to yank - the seat holds the knot within the 2px settle budget.
 *
 * Seams under test:
 * - Rope.attachEndpoint (public API) - the in-reach tie's geometry.
 * - Rope.getTieSeats() - the seat's world point vs the target's
 *   getAttachmentWorldPoint: the same two points the tie square and the
 *   knot ring draw from, so "seat on the knot" is exact.
 * - ConnectFlow.handlePointerDown - a beyond-reach tie still refuses
 *   (ADR 0007 decision 4): no knot, the seek survives, feedback paints.
 *
 * Companion suites: rope-seat-keeps (seats across re-count/re-lay),
 * pinned-rope-length (reach per seat, #86), connect-flow (the click
 * state machine), rope-span (span-derived counts).
 */

import { describe, it, expect, afterEach } from 'vitest';
import ConnectFlow from '../js/ui/ConnectFlow.js';
import Rope from '../js/objects/Rope.js';
import Balloon from '../js/objects/Balloon.js';
import Bucket from '../js/objects/Bucket.js';
import { PhysicsEngine } from '../js/engine/PhysicsEngine.js';
import { serializePlacedBoard, restorePlacedFromSnapshot } from '../js/reset/levelReset.js';
import { registerAllObjects } from '../js/objects/registerAllObjects.js';

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

/** Seat-to-knot distance: the two points the tie square and knot ring draw from. */
function seatGap(rope, seatRole, target, pointId) {
    const seat = rope.getTieSeats().find((s) => s.role === seatRole);
    const world = target.getAttachmentWorldPoint(pointId);
    return Math.hypot(seat.worldPoint.x - world.x, seat.worldPoint.y - world.y);
}

describe('In-reach ties re-seat the rope, not the knot (issue #98)', () => {
    it('an in-reach end tie lays the seat on the knot in edit mode and play start holds it within the settle budget', () => {
        const engine = makeEngine();
        const rope = new Rope(100, 100, { length: 260 });
        const bucket = new Bucket(200, 280, { isFixed: true });
        engine.addObject(rope);
        engine.addObject(bucket);

        const rim = bucket.getAttachmentWorldPoint('rim');
        // The aim sits inside the end seat's covering circle (the in-reach
        // case) but well off the chain's straight drop - the pre-re-seat
        // shape left the tail on the drop line at the reach limit.
        expect(rope.isPointWithinReach(rim.x, rim.y, 0, 'end')).toBe(true);
        expect(seatGap(rope, 'end', bucket, 'rim')).toBeGreaterThan(50);

        rope.attachEndpoint('end', bucket, 'rim');

        // The tie never shortens the rope (ADR 0007 decision 4) and never
        // re-counts it (the count is the span's rule - the span is intact).
        expect(rope._length).toBe(260);
        expect(rope._segments.length).toBe(7); // ceil(260/40), the birth count
        // The seat stands ON the knot at tie time (edit mode, no physics):
        // what the tie square draws and what the knot ring draws agree.
        expect(seatGap(rope, 'end', bucket, 'rim')).toBeLessThanOrEqual(0.5);

        // Play start: the length-0 knot link finds the seat already seated -
        // no yank. The seat holds the knot within the 2px settle budget
        // every beat while the bowed chain settles under gravity.
        let worst = 0;
        for (let i = 0; i < 30; i++) {
            engine.step(DT);
            worst = Math.max(worst, seatGap(rope, 'end', bucket, 'rim'));
        }
        expect(worst).toBeLessThanOrEqual(2);
        // And the knot survives to the end of the settle.
        expect(rope.getAttachmentRefs()).toEqual([{ seat: 'end', target: bucket, pointId: 'rim' }]);
    });

    it('a tie made after the target moved seats the rope on the moved knot', () => {
        const rope = new Rope(100, 100, { length: 260 });
        const bucket = new Bucket(150, 180, { isFixed: true });
        // The bucket is carried 100px down (the dragged-target case), then
        // tied - the tie reads the knot where it IS now.
        const rim = bucket.getAttachmentWorldPoint('rim');
        bucket.setPosition(150, 280);
        const movedRim = bucket.getAttachmentWorldPoint('rim');
        expect(movedRim.y).toBeGreaterThan(rim.y + 90);

        rope.attachEndpoint('end', bucket, 'rim');

        expect(rope.isPointWithinReach(movedRim.x, movedRim.y, 0, 'end')).toBe(true);
        expect(seatGap(rope, 'end', bucket, 'rim')).toBeLessThanOrEqual(0.5);
        expect(rope._length).toBe(260); // the moved tie shrinks nothing
        rope.dispose();
        bucket.dispose();
    });

    it('a restore keeps the recorded lay: the token bind re-binds but never re-seats the row shape (ADR 0006 decision 1)', () => {
        // The re-seat is tie-MAKING policy (the flow's and the hand's tie,
        // a tie made after the target moved). A token bind restores the
        // board the row describes - the same not-moving contract the
        // anchor-seat pull keeps at restore (ConnectFlow: "the direct rope
        // API and restore paths keep their contract of not moving targets
        // (ADR 0006 divergence)") - because a bug file's recorded board
        // must keep replaying bit-exactly whatever tie policy now ships:
        // the recorded chain lay is the recording's own fact, and a
        // bind-time re-lay would rewrite it (the committed ufzs fixture
        // pins exactly this: its recorded rope's tie is in-reach).
        const rope = new Rope(100, 100, { length: 260 });
        const bucket = new Bucket(200, 280, { isFixed: true });
        rope.attachEndpoint('end', bucket, 'rim'); // live tie: seats the rope
        expect(seatGap(rope, 'end', bucket, 'rim')).toBeLessThanOrEqual(0.5);

        const rows = serializePlacedBoard([bucket, rope]);
        const board2 = [];
        restorePlacedFromSnapshot(board2, rows);
        const rope2 = board2.find((o) => o.type === 'rope');
        const bucket2 = board2.find((o) => o.type === 'bucket');
        try {
            expect(rope2.getAttachmentRefs()).toEqual([{ seat: 'end', target: bucket2, pointId: 'rim' }]);
            // The token bound, but the chain still lies the ROW's shape -
            // straight over the row's span toward the row's end point, the
            // restore lay the bug file replay reproduces. The seat policy
            // heals the board at the next live tie, not at the load.
            const restoredReach = 260 * rope2.getTieSeats().find((s2) => s2.role === 'end').reach;
            const restoredTail = rope2.getTieSeats().find((s2) => s2.role === 'end').worldPoint;
            expect(Math.hypot(restoredTail.x - 100, restoredTail.y - 100)).toBeCloseTo(restoredReach, 1); // the straight row lay
            expect(seatGap(rope2, 'end', bucket2, 'rim')).toBeGreaterThan(50); // the row gap, not the seated one
            expect(rope2._length).toBeCloseTo(260, 3); // the row's span
        } finally {
            rope.dispose();
            bucket.dispose();
            for (const obj of board2) obj.dispose();
        }
    });

    it('a beyond-reach end tie still refuses per ADR 0007 decision 4 - no knot, the seek survives, feedback paints', () => {
        const flow = new ConnectFlow();
        flow._mode = 'EDITING';
        const rope = new Rope(300, 100, { length: 100 });
        const balloon = new Balloon(300, 320); // knot (300, 345.6): 245.6px out
        const knot = balloon.getAttachmentWorldPoint('knot');
        expect(rope.isPointWithinReach(knot.x, knot.y, 14, 'end')).toBe(false); // past even the slack band

        const end = rope.getTieSeats()[2].worldPoint;
        expect(flow.handlePointerDown(end.x, end.y, [rope, balloon])).toBe(true); // the seek
        expect(flow.handlePointerDown(knot.x, knot.y, [rope, balloon])).toBe(true); // the refused tie click
        expect(flow.seek).toEqual({ rope, role: 'end' }); // the seek survives
        expect(rope.getAttachmentRefs()).toEqual([]); // no knot was created
        expect(rope._length).toBe(100); // nothing re-laid
        expect(rope.lengthFrozen).toBe(false);
        expect(flow.refusal).toMatchObject({ x: knot.x, y: knot.y }); // feedback paints
        rope.dispose();
        balloon.dispose();
    });
});
