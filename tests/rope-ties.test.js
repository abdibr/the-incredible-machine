/**
 * Role tie tests — GitHub issues #56 + #84, the surface narrowed by #90.
 *
 * A rope ties through its three NAMED seats — anchor, mid, end — and a
 * knot is addressed by its seat ROLE and nothing else (issue #90): no
 * rope API accepts or returns a segment index as a seat, and an unknown
 * seat name is refused with a clear error. This suite pins:
 * - the role gate — 'anchor' | 'mid' | 'end' are the only names;
 * - a mid-seat knot realizes its engine link from that seat's body (the
 *   live chain's middle), and the stale link drops one step after untie
 *   (every rope body joins the reconcile scan);
 * - one knot per seat (issue #85): a second tie into an occupied seat
 *   refuses; other seats tie on and untie per seat;
 * - getAttachmentRefs ordering (anchor, mid, end);
 * - ConnectFlow.getRopeSquares on a bodyless free bundle: a single coil
 *   square (the anchor seat), then the three named seats after the first
 *   tie (issue #85 — squares per seat, not per chain body);
 * - the mid and end seats tying two knots that each realize from their
 *   own seat's body, prune per target, and round-trip.
 *
 * Companion suites: rope-knots (endpoint→chain-end ties became roles),
 * rope-connector (API + realization), rope.test (zero attach calls),
 * free-rope (bundle lifecycle), connect-flow (the click state machine),
 * rope-seat-tokens (the role-token schema; legacy numeric tokens refuse).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import ConnectFlow from '../js/ui/ConnectFlow.js';
import Rope from '../js/objects/Rope.js';
import Balloon from '../js/objects/Balloon.js';
import Bucket from '../js/objects/Bucket.js';
import { PhysicsEngine } from '../js/engine/PhysicsEngine.js';
import { objectRegistry } from '../js/objects/ObjectRegistry.js';
import { registerAllObjects } from '../js/objects/registerAllObjects.js';
import { serializePlacedBoard, restorePlacedFromSnapshot } from '../js/reset/levelReset.js';

registerAllObjects();

const DT = 1000 / 60;
const engines = [];

afterEach(() => {
    for (const engine of engines) engine.dispose();
    engines.length = 0;
    vi.restoreAllMocks();
});

describe('Rope role ties (issues #56/#90) — the seat gate', () => {
    it("'anchor', 'mid' and 'end' are the only seat names — anything else refuses with a clear error, nothing lands", () => {
        const rope = new Rope(200, 100, { length: 100 });
        const balloon = new Balloon(300, 300);
        for (const bad of [-1, 0, 5, 15, 'top', 'mid-seat', null, undefined, 2.5]) {
            expect(() => rope.attachEndpoint(bad, balloon, 'knot'))
                .toThrow(/seat must be 'anchor', 'mid' or 'end'/);
            expect(() => rope.detachEndpoint(bad, balloon, 'knot'))
                .toThrow(/seat must be 'anchor', 'mid' or 'end'/);
        }
        // The reach gate validates names the same way; a seatless ask (null)
        // is its own valid form — the capacity circle.
        for (const bad of [-1, 0, 5, 'top', 2.5]) {
            expect(() => rope.isPointWithinReach(300, 300, 0, bad))
                .toThrow(/seat must be 'anchor', 'mid' or 'end'/);
        }
        expect(rope.isPointWithinReach(300, 300, 0, null)).toBe(false); // 253px out, no slack
        expect(rope.getAttachmentRefs()).toEqual([]);
        rope.dispose();
        balloon.dispose();
    });

    it('a chain-less free bundle refuses its chain seats with a clear error; the anchor tie births the chain', () => {
        const bundle = objectRegistry.create('free-rope', 300, 300);
        const balloon = new Balloon(340, 340);
        expect(bundle.bodies).toEqual([]); // the coil: no chain yet
        expect(() => bundle.attachEndpoint('mid', balloon, 'knot'))
            .toThrow(/a bodyless bundle has no mid seat to tie/);
        expect(() => bundle.attachEndpoint('end', balloon, 'knot'))
            .toThrow(/a bodyless bundle has no end seat to tie/);
        expect(() => bundle.attachEndpoint('bogus', balloon, 'knot'))
            .toThrow(/seat must be 'anchor', 'mid' or 'end'/);
        expect(bundle.getAttachmentRefs()).toEqual([]);
        bundle.attachEndpoint('anchor', balloon, 'knot'); // the birth of the chain
        expect(bundle.bodies.length - 1).toBe(6); // the fresh-drop floor
        bundle.dispose();
        balloon.dispose();
    });

    it('a mid-seat knot realizes its engine link from that seat body, not the anchor', () => {
        const physics = new PhysicsEngine(800, 600);
        engines.push(physics);
        const rope = new Rope(200, 100, { length: 60 });
        const balloon = new Balloon(300, 300);
        physics.addObject(rope);
        physics.addObject(balloon);

        rope.attachEndpoint('mid', balloon, 'knot');
        physics.step(DT);

        const link = physics.getAttachedConstraints()[0];
        // The mid-seat tie sits beyond its covering circle (246.8px vs 25),
        // so the covering grow re-counted 6 → 15 and the knot IS the mid
        // seat's — its link realizes from whatever body the role names now
        // (mid of 15 = bodies[8]), not the anchor.
        expect(link.bodyA).toBe(rope.bodies[8]); // the re-counted chain's middle body
        expect(link.bodyB).toBe(balloon.bodies[0]);
        expect(rope.lengthFrozen).toBe(true); // any tie freezes the pinned length

        rope.detachEndpoint('mid', balloon, 'knot');
        physics.step(DT);
        expect(physics.getAttachedConstraints()).toHaveLength(0); // stale link dropped
    });

    it('one knot per seat: a second tie into an occupied seat refuses; other seats tie on', () => {
        const physics = new PhysicsEngine(800, 600);
        engines.push(physics);
        const rope = new Rope(200, 100, { length: 60 });
        const balloon = new Balloon(300, 300);
        const bucket = new Bucket(500, 300);
        physics.addObject(rope);
        physics.addObject(balloon);
        physics.addObject(bucket);

        rope.attachEndpoint('mid', balloon, 'knot');
        const refs = rope.getAttachmentRefs();
        expect(refs).toHaveLength(1);
        // The seat is taken: a second tie into it refuses (issue #85 — one
        // knot per seat; the flow squares only three seats, so a fourth
        // knot is unreachable, and no tie may stack onto one).
        expect(() => rope.attachEndpoint('mid', bucket, 'rim')).toThrow(/already holds a knot/);
        expect(rope.getAttachmentRefs()).toEqual(refs);
        physics.step(DT);
        expect(physics.getAttachedConstraints()).toHaveLength(1); // the one knot only

        // Another seat still takes its first knot.
        rope.attachEndpoint('anchor', bucket, 'rim');
        expect(rope.getAttachmentRefs().map((r) => r.seat)).toEqual(['anchor', 'mid']);
        physics.step(DT);
        expect(physics.getAttachedConstraints()).toHaveLength(2);

        rope.detachEndpoint('mid', balloon, 'knot');
        physics.step(DT);
        expect(physics.getAttachedConstraints()).toHaveLength(1); // the rim knot lives
    });
});

describe('Rope role ties (issues #56/#90) — refs order', () => {
    it('getAttachmentRefs sorts knots anchor-first, then mid, then end — whatever order they tied', () => {
        const rope = new Rope(100, 100, { length: 420 }); // 11 segments: mid covers 210, end 400
        const balloon = new Balloon(180, 74.4); // knot (180, 100): 80px, inside both windows
        const bucket = new Bucket(500, 300); // rim: inside the end's 400 window
        const [midB, endB] = [balloon, bucket];

        rope.attachEndpoint('end', endB, 'rim'); // the end seat, tied first
        expect(rope.getAttachmentRefs().map((r) => r.seat)).toEqual(['end']);
        rope.attachEndpoint('mid', midB, 'knot'); // the mid seat, tied second
        rope.attachEndpoint('anchor', new Bucket(760, 500, { isFixed: true }), 'rim'); // the anchor last
        expect(rope.getAttachmentRefs().map((r) => r.seat)).toEqual(['anchor', 'mid', 'end']);
        expect(rope.getAttachmentRefs()).toHaveLength(3); // one per seat, three seats: the whole capacity
        rope.dispose();
        midB.dispose();
        endB.dispose();
    });
});

describe('Rope role ties (issues #56/#90) — the bundle coil square', () => {
    it('a bodyless free bundle squares as one coil seat; the spawned chain squares per seat', () => {
        const balloon = new Balloon(220, 140);
        const rope = objectRegistry.create('free-rope', 220, 200, { length: 60 });
        const flow = new ConnectFlow();

        let squares = flow.getRopeSquares([rope], null);
        expect(squares).toHaveLength(1); // the coil, no chain to click yet
        expect(squares[0]).toEqual(expect.objectContaining({ rope, role: 'anchor', tied: false }));

        rope.attachEndpoint('anchor', balloon, 'knot'); // first tie spawns the chain
        squares = flow.getRopeSquares([rope], null);
        expect(squares).toHaveLength(3); // the three named seats (issue #85)
        expect(squares.map((s) => s.role)).toEqual(['anchor', 'mid', 'end']);
        expect(squares[0]).toEqual(expect.objectContaining({ rope, role: 'anchor', tied: true }));

        rope.clearAttachments(); // last untie collapses back to the bundle
        squares = flow.getRopeSquares([rope], null);
        expect(squares).toHaveLength(1);
        expect(squares[0].tied).toBe(false); // a bundle cannot stay tied
        rope.dispose();
        balloon.dispose();
    });
});

describe('Rope role ties (issues #56/#90) — mid and end knots across counts', () => {
    it('a long rope ties at its two chain seats and each knot realizes from its own seat body', () => {
        const engine = new PhysicsEngine(800, 600);
        engines.push(engine);
        const rope = new Rope(100, 100, { length: 420 }); // 11 segments: mid covers 210, end 400
        const balloon = new Balloon(180, 74.4); // knot (180, 100): 80px, ≤ 210 — mid-window
        const bucket = new Bucket(420, 140); // rim ≈ (420, 120): hypot(320, 20) ≈ 321 — inside the 400 end window
        // Use a nearer bucket so the end tie stays in-window: rim at (480, 140) ≈ hypot(380, 40).
        engine.addObject(rope);
        engine.addObject(balloon);
        engine.addObject(bucket);

        rope.attachEndpoint('mid', balloon, 'knot');
        rope.attachEndpoint('end', bucket, 'rim');
        engine.step(DT);

        // One engine link per knot, each realized from its seat's body:
        // 'mid' → the middle of 11 (bodies[6]) and 'end' → the tail (bodies[11]).
        const links = engine.getAttachedConstraints().filter(
            (c) => c.bodyB === balloon.bodies[0] || c.bodyB === bucket.bodies[2]
        );
        expect(links).toHaveLength(2);
        expect(links.find((c) => c.bodyB === balloon.bodies[0]).bodyA).toBe(rope.bodies[6]);
        expect(links.find((c) => c.bodyB === bucket.bodies[2]).bodyA).toBe(rope.bodies[11]);
        expect(rope.getAttachmentRefs().map((r) => r.seat)).toEqual(['mid', 'end']);
        expect(rope._length).toBe(420); // both knots sat inside their seats' windows — no tie re-laid anything
        rope.dispose();
        balloon.dispose();
        bucket.dispose();
    });

    it('deleting a target prunes only its knots; the other seat keeps its live link', () => {
        const engine = new PhysicsEngine(800, 600);
        engines.push(engine);
        const rope = new Rope(100, 100, { length: 420 }); // 11 segments
        const balloon = new Balloon(180, 74.4); // knot (180, 100): 80px — mid-window
        const bucket = new Bucket(420, 140); // rim ≈ (420, 120): inside the end window
        engine.addObject(rope);
        engine.addObject(balloon);
        engine.addObject(bucket);

        rope.attachEndpoint('mid', balloon, 'knot');
        rope.attachEndpoint('end', bucket, 'rim');
        engine.step(DT);
        expect(rope.getAttachmentRefs().map((r) => r.seat)).toEqual(['mid', 'end']);

        // The balloon leaves the board (popped / deleted): the rope's own
        // knot list is what prunes — a knot dies with its target, and only
        // that knot.
        engine.removeObject(balloon);
        engine.step(DT);

        expect(rope.getAttachmentRefs().map((r) => r.seat)).toEqual(['end']);
        const links = engine.getAttachedConstraints().filter(
            (c) => c.bodyB === bucket.bodies[2]
        );
        expect(links, 'the surviving knot keeps its realized link').toHaveLength(1);
        expect(links[0].bodyA).toBe(rope.bodies[11]); // the end seat's own body
        expect(rope._length).toBe(420); // no tie re-laid anything

        rope.dispose();
        bucket.dispose();
    });

    it('mixed-type knots round-trip serialize → two-phase bind on both rope lifecycles', () => {
        const balloon = new Balloon(100, 74.4); // knot (100, 100): ON the pinned rope's anchor
        const bucket = new Bucket(250, 120); // rim ≈ (250, 100): 150px — inside the 11-chain's mid window
        const freeAnchorBalloon = new Balloon(420, 74.4); // knot (420, 100): the free rope's spawn point
        const pinned = new Rope(100, 100, { length: 420 }); // 11 segments
        pinned.attachEndpoint('anchor', balloon, 'knot');
        pinned.attachEndpoint('mid', bucket, 'rim');
        const free = objectRegistry.create('free-rope', 420, 100); // the coil
        free.attachEndpoint('anchor', freeAnchorBalloon, 'knot'); // spawns the chain
        free.attachEndpoint('mid', freeAnchorBalloon, 'knot'); // the mid seat, tied to the same point

        const rows = serializePlacedBoard([balloon, bucket, freeAnchorBalloon, pinned, free]);
        // Tokens name the seats by role (issue #88, the only form since
        // #90): every knot is one of the three roles and its token says
        // exactly that.
        expect(rows[3].attachments).toContainEqual({
            seat: 'anchor', targetType: 'balloon', targetOrdinal: 0, pointId: 'knot',
        });
        expect(rows[3].attachments).toContainEqual({
            seat: 'mid', targetType: 'bucket', targetOrdinal: 1, pointId: 'rim',
        });
        expect(rows[4].attachments).toContainEqual({
            seat: 'anchor', targetType: 'balloon', targetOrdinal: 2, pointId: 'knot',
        });
        expect(rows[4].attachments).toContainEqual({
            seat: 'mid', targetType: 'balloon', targetOrdinal: 2, pointId: 'knot',
        });

        const board2 = [];
        restorePlacedFromSnapshot(board2, rows);
        const balloon2 = board2.find((o) => o.type === 'balloon' && o.x === 100);
        const bucket2 = board2.find((o) => o.type === 'bucket');
        const freeAnchorBalloon2 = board2.find((o) => o.type === 'balloon' && o.x === 420);
        const pinned2 = board2.find((o) => o.type === 'rope');
        const free2 = board2.find((o) => o.type === 'free-rope');
        // The pinned rope: both tokens bind through the two-phase ordinals;
        // the restore re-derives the chain from the saved span (issue #89)
        // — 11 segments again — and the knots land on their roles' bodies.
        expect(pinned2.getAttachmentRefs().map((r) => r.seat)).toEqual(['anchor', 'mid']);
        expect(pinned2.getTieSeats()[0].body).toBe(pinned2.bodies[0]); // the anchor knot on the nail
        expect(pinned2.getTieSeats()[1].body).toBe(pinned2.bodies[6]); // the mid knot on the middle of 11
        expect(pinned2._length).toBeCloseTo(420, 3); // the saved span — the ties grew nothing their side
        expect(pinned2.lengthFrozen).toBe(true); // the bind re-derives the freeze
        expect(pinned2._segments.length).toBe(11);
        // A SECOND save → restore cycle changes nothing (issue #89): the
        // count is the span's rule, so the restore re-derives the same
        // chain and the SPAN is the fixed point — the rope never creeps
        // longer per cycle, and no chain count rides the row.
        const rows2 = serializePlacedBoard(board2);
        expect(rows2[3].options.length).toBeCloseTo(rows[3].options.length, 6);
        expect(rows2[3].options.segments).toBeUndefined();
        const board3 = [];
        restorePlacedFromSnapshot(board3, rows2);
        const pinned3 = board3.find((o) => o.type === 'rope');
        expect(pinned3._length).toBeCloseTo(pinned2._length, 3);
        expect(pinned3._segments.length).toBe(pinned2._segments.length);
        expect(pinned3.getAttachmentRefs().map((r) => r.seat)).toEqual(['anchor', 'mid']);

        // …and the free rope re-spawns at bind with its mid knot back on
        // the spawned chain's middle body (seg 2 of the fresh 6-chain).
        expect(free2.bodies.length).toBeGreaterThan(0);
        expect(free2.constraints.length).toBeGreaterThan(0);
        expect(free2.getAttachmentRefs().map((r) => r.seat)).toEqual(['anchor', 'mid']);
        expect(free2.getTieSeats()[1].body).toBe(free2.bodies[3]); // the middle of 6

        for (const obj of [balloon, bucket, freeAnchorBalloon, pinned, free]) obj.dispose();
        for (const obj of board2) obj.dispose();
        for (const obj of board3) obj.dispose();
    });
});
