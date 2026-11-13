/**
 * Segment tie tests (issue #56).
 *
 * Knots are no longer endpoint slots (0|1): every chain segment of a rope
 * is a tie seat (−1 = the anchor, 0…MAX_SEGMENTS-2 = mid-chain, the top
 * seat = the chain end — the schema range caps at MAX_SEGMENTS while a
 * rope's live chain lays only its span's worth, issue #56). This suite
 * pins:
 * - Rope.validSegment — the −1/0…MAX_SEGMENTS-1 schema gate;
 * - a mid-chain knot realizes its engine link from that segment's body,
 *   and the stale link drops one step after untie (every rope body joins
 *   the reconcile scan);
 * - one knot per seat (issue #85): a second tie into an occupied seat
 *   refuses; other seats tie on and untie per seat;
 * - the legacy issue-04 token migration: `{ endpoint: 0|1 }` binds as
 *   `{ segment: -1|chain-tail }` with a warning, and a token past the
 *   live chain's laid seats drops;
 * - getAttachmentRefs ordering (anchor −1 first);
 * - ConnectFlow.getRopeSquares on a bodyless free bundle: a single coil
 *   square (segment −1), then the three named seats after the first tie
 *   (issue #85 — squares per seat, not per chain body).
 *
 * Companion suites: rope-knots (endpoint→chain-end ties), rope-connector
 * (API + realization), rope.test (zero attach calls), free-rope (bundle
 * lifecycle), connect-flow (the click state machine).
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

describe('Rope segment ties (issue #56) — the seat gate', () => {
    it('validates the seat: -1 and 0…15 tie schema-wide, -2/16/garbage refuse; past-rope seats refuse at bind', () => {
        const rope = new Rope(200, 100, { length: 100 });
        // The schema gate is count-capped (issue #56): -1…MAX_SEGMENTS-1.
        expect(Rope.validSegment(-1)).toBe(true);
        expect(Rope.validSegment(0)).toBe(true);
        expect(Rope.validSegment(5)).toBe(true);
        expect(Rope.validSegment(15)).toBe(true);
        expect(Rope.validSegment(16)).toBe(false);
        expect(Rope.validSegment(-2)).toBe(false);
        expect(Rope.validSegment(false)).toBe(false);
        // The live chain lays only its span's worth (100px → 6 segments):
        // seat 6 is in-schema but has no body here — refused at bind, and
        // nothing lands.
        expect(() => rope.attachEndpoint(6, null, 'knot')).toThrow();
        expect(() => rope.attachEndpoint(-2, null, 'knot')).toThrow();
        expect(rope.getAttachmentRefs()).toEqual([]);
        rope.dispose();
    });

    it('a mid-chain knot realizes its engine link from that segment body, not the anchor', () => {
        const physics = new PhysicsEngine(800, 600);
        engines.push(physics);
        const rope = new Rope(200, 100, { length: 60 });
        const balloon = new Balloon(300, 300);
        physics.addObject(rope);
        physics.addObject(balloon);

        rope.attachEndpoint(2, balloon, 'knot');
        physics.step(DT);

        const link = physics.getAttachedConstraints()[0];
        expect(link.bodyA).toBe(rope.bodies[3]); // _segments[2] — bodies[anchor,0,1,2]
        expect(link.bodyB).toBe(balloon.bodies[0]);
        expect(rope.lengthFrozen).toBe(true); // any tie freezes the pinned length

        rope.detachEndpoint(2, balloon, 'knot');
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

        rope.attachEndpoint(4, balloon, 'knot');
        const refs = rope.getAttachmentRefs();
        expect(refs).toHaveLength(1);
        // The seat is taken: a second tie into it refuses (issue #85 — one
        // knot per seat; the flow squares only three seats, so a fourth
        // knot is unreachable, and no tie may stack onto one).
        expect(() => rope.attachEndpoint(4, bucket, 'rim')).toThrow(/already holds a knot/);
        expect(rope.getAttachmentRefs()).toEqual(refs);
        physics.step(DT);
        expect(physics.getAttachedConstraints()).toHaveLength(1); // the one knot only

        // Another seat still takes its first knot.
        rope.attachEndpoint(-1, bucket, 'rim');
        expect(rope.getAttachmentRefs().map((r) => r.segment)).toEqual([-1, 4]);
        physics.step(DT);
        expect(physics.getAttachedConstraints()).toHaveLength(2);

        rope.detachEndpoint(4, balloon, 'knot');
        physics.step(DT);
        expect(physics.getAttachedConstraints()).toHaveLength(1); // the rim knot lives
    });
});
describe('Rope segment ties (issue #56) — legacy endpoint tokens migrate', () => {
    it('{ endpoint: 0|1 } tie tokens bind as { segment: -1|5 } with a warning apiece', () => {
        const warns = vi.fn();
        const origWarn = console.warn;
        console.warn = warns;
        try {
            const data = {
                type: 'rope', x: 200, y: 100, angle: 0, isFixed: false,
                options: { length: 100 },
                attachments: [
                    { endpoint: 0, targetType: 'balloon', targetOrdinal: 0, pointId: 'knot' },
                    { endpoint: 1, targetType: 'balloon', targetOrdinal: 0, pointId: 'knot' },
                ],
            };
            const rope = Rope.deserialize(data);
            const balloon = new Balloon(320, 260);
            rope.bindAttachment([balloon]);
            console.warn = origWarn;
            expect(warns).toHaveBeenCalledTimes(2); // one migrated-token warn per token
            expect(rope.getAttachmentRefs().map((r) => r.segment)).toEqual([-1, 5]);
            const physics = new PhysicsEngine();
            physics.addObject(rope);
            physics.addObject(balloon);
            physics.step(DT);
            expect(physics.getAttachedConstraints()).toHaveLength(2);
            physics.dispose();
            rope.dispose();
            balloon.dispose();
        } finally {
            console.warn = origWarn;
        }
    });

    it("a { segment: 6 } token past this chain's laid seats drops with a single warning", () => {
        const warns = vi.fn();
        const origWarn = console.warn;
        console.warn = warns;
        try {
            const data = {
                type: 'rope', x: 200, y: 100, angle: 0, isFixed: false,
                options: { length: 100 },
                attachments: [{ segment: 6, targetType: 'balloon', targetOrdinal: 0, pointId: 'knot' }],
            };
            const rope = Rope.deserialize(data);
            const balloon = new Balloon(320, 260);
            rope.bindAttachment([balloon]);
            console.warn = origWarn;
            expect(warns).toHaveBeenCalledTimes(1); // the caller's warn-drop
            expect(rope.getAttachmentRefs()).toEqual([]);
            rope.dispose();
            balloon.dispose();
        } finally {
            console.warn = origWarn;
        }
    });
});

describe('Rope segment ties (issue #56) — refs order', () => {
    it('getAttachmentRefs sorts knots anchor-first, then in chain order', () => {
        const rope = new Rope(200, 100, { length: 60 });
        const balloon = new Balloon(300, 300);
        const bucket = new Bucket(500, 300);
        rope.attachEndpoint(5, bucket, 'rim'); // chain end, tied first
        rope.attachEndpoint(2, balloon, 'knot'); // mid-chain
        rope.attachEndpoint(-1, bucket, 'rim'); // the anchor
        expect(rope.getAttachmentRefs().map((r) => r.segment)).toEqual([-1, 2, 5]);
        rope.dispose();
        balloon.dispose();
        bucket.dispose();
    });
});

describe('Rope segment ties (issue #56) — the bundle coil square', () => {
    it('a bodyless free bundle squares as one coil seat; the spawned chain squares per body', () => {
        const balloon = new Balloon(220, 140);
        const rope = objectRegistry.create('free-rope', 220, 200, { length: 60 });
        const flow = new ConnectFlow();

        let squares = flow.getRopeSquares([rope], null);
        expect(squares).toHaveLength(1); // the coil, no chain to click yet
        expect(squares[0]).toEqual(expect.objectContaining({ rope, segment: -1, tied: false }));

        rope.attachEndpoint(-1, balloon, 'knot'); // first tie spawns the chain
        squares = flow.getRopeSquares([rope], null);
        expect(squares).toHaveLength(3); // the three named seats (issue #85)
        expect(squares.map((s) => s.segment)).toEqual([-1, 2, 5]);
        expect(squares[0]).toEqual(expect.objectContaining({ rope, segment: -1, tied: true }));

        rope.clearAttachments(); // last untie collapses back to the bundle
        squares = flow.getRopeSquares([rope], null);
        expect(squares).toHaveLength(1);
        expect(squares[0].tied).toBe(false); // a bundle cannot stay tied
        rope.dispose();
        balloon.dispose();
    });
});

describe('Rope segment ties (issue #56) — mid-chain knots across counts', () => {
    it('a long rope ties at several seats and each knot realizes from its own segment body', () => {
        const engine = new PhysicsEngine(800, 600);
        engines.push(engine);
        const rope = new Rope(100, 100, { length: 420 });
        const balloon = new Balloon(180, 140);
        const bucket = new Bucket(420, 140);
        engine.addObject(rope);
        engine.addObject(balloon);
        engine.addObject(bucket);

        rope.setEndpoints({ x: 100, y: 100 }, { x: 520, y: 100 }); // 420px lays 11 segments (issue #56 span-derived)
        rope.attachEndpoint(3, balloon, 'knot');
        rope.attachEndpoint(9, bucket, 'rim');
        engine.step(DT);

        // One engine link per knot, each realized from its segment's body:
        // seat 3 → _segments[3] (bodies[4]) and seat 9 → _segments[9] (bodies[10]).
        const links = engine.getAttachedConstraints().filter(
            (c) => c.bodyB === balloon.bodies[0] || c.bodyB === bucket.bodies[2]
        );
        expect(links).toHaveLength(2);
        expect(links.find((c) => c.bodyB === balloon.bodies[0]).bodyA).toBe(rope.bodies[4]);
        expect(links.find((c) => c.bodyB === bucket.bodies[2]).bodyA).toBe(rope.bodies[10]);
        expect(rope.getAttachmentRefs().map((r) => r.segment)).toEqual([3, 9]);
        expect(rope._length).toBe(420); // both knots sat inside their seats' windows — no tie re-laid anything
        rope.dispose();
        balloon.dispose();
        bucket.dispose();
    });

    it('deleting a target prunes only its knots; the other seat keeps its live link', () => {
        const engine = new PhysicsEngine(800, 600);
        engines.push(engine);
        const rope = new Rope(100, 100, { length: 420 });
        const balloon = new Balloon(180, 140);
        const bucket = new Bucket(420, 140);
        engine.addObject(rope);
        engine.addObject(balloon);
        engine.addObject(bucket);

        rope.setEndpoints({ x: 100, y: 100 }, { x: 520, y: 100 }); // 11 segments
        rope.attachEndpoint(3, balloon, 'knot');
        rope.attachEndpoint(9, bucket, 'rim');
        engine.step(DT);
        expect(rope.getAttachmentRefs().map((r) => r.segment)).toEqual([3, 9]);

        // The balloon leaves the board (popped / deleted): the rope's own
        // knot list is what prunes — a knot dies with its target, and only
        // that knot (ADR 0007 decision 6: several knots ride one rope,
        // deleting a target prunes only its own).
        engine.removeObject(balloon);
        engine.step(DT);

        expect(rope.getAttachmentRefs().map((r) => r.segment)).toEqual([9]);
        const links = engine.getAttachedConstraints().filter(
            (c) => c.bodyB === bucket.bodies[2]
        );
        expect(links, 'the surviving knot keeps its realized link').toHaveLength(1);
        expect(links[0].bodyA).toBe(rope.bodies[10]); // seat 9, its own body
        expect(rope._length).toBe(420); // no tie re-laid anything

        rope.dispose();
        bucket.dispose();
    });

    it('mixed-type knots round-trip serialize → two-phase bind on both rope lifecycles', () => {
        const balloon = new Balloon(100, 220);
        const bucket = new Bucket(700, 220);
        const pinned = new Rope(100, 100, { length: 420 }); // 11 segments
        pinned.attachEndpoint(-1, balloon, 'knot');
        pinned.attachEndpoint(4, bucket, 'rim');
        const free = objectRegistry.create('free-rope', 420, 300, { length: 60 });
        free.attachEndpoint(-1, balloon, 'knot'); // spawns the chain
        free.attachEndpoint(3, balloon, 'knot'); // mid-chain seat on the spawned chain

        const rows = serializePlacedBoard([balloon, bucket, pinned, free]);
        expect(rows[2].attachments).toContainEqual({
            segment: -1, targetType: 'balloon', targetOrdinal: 0, pointId: 'knot',
        });
        expect(rows[2].attachments).toContainEqual({
            segment: 4, targetType: 'bucket', targetOrdinal: 1, pointId: 'rim',
        });
        expect(rows[3].attachments).toContainEqual({
            segment: 3, targetType: 'balloon', targetOrdinal: 0, pointId: 'knot',
        });

        const board2 = [];
        restorePlacedFromSnapshot(board2, rows);
        const balloon2 = board2.find((o) => o.type === 'balloon');
        const bucket2 = board2.find((o) => o.type === 'bucket');
        const pinned2 = board2.find((o) => o.type === 'rope');
        const free2 = board2.find((o) => o.type === 'free-rope');
        // The pinned rope: both tokens bind through the two-phase ordinals…
        expect(pinned2.getAttachmentRefs()).toContainEqual({ segment: -1, target: balloon2, pointId: 'knot' });
        expect(pinned2.getAttachmentRefs()).toContainEqual({ segment: 4, target: bucket2, pointId: 'rim' });
        expect(pinned2._length).toBeCloseTo(Math.hypot(600, 100) * 11 / 4.5, 3); // the seat-4 tie's grown span: seat 4 covers (4 + 0.5)/11, frozen count
        expect(pinned2.lengthFrozen).toBe(true); // the bind re-derives the freeze
        expect(pinned2._segments.length).toBe(11); // the restore births the persisted count, not a re-derived one
        // A SECOND save → restore cycle changes nothing (issue #56): the row
        // carries the laid count, so the restore births the same chain and the
        // covering gate stays shut — the rope never creeps longer per cycle.
        const rows2 = serializePlacedBoard(board2);
        expect(rows2[2].options.segments).toBe(11);
        const board3 = [];
        restorePlacedFromSnapshot(board3, rows2);
        const pinned3 = board3.find((o) => o.type === 'rope');
        expect(pinned3._length).toBeCloseTo(pinned2._length, 3);
        expect(pinned3._segments.length).toBe(pinned2._segments.length);

        // …and the free rope re-spawns at bind with its mid-chain knot back.
        expect(free2.bodies.length).toBeGreaterThan(0);
        expect(free2.constraints.length).toBeGreaterThan(0);
        expect(free2.getAttachmentRefs()).toContainEqual({ segment: 3, target: balloon2, pointId: 'knot' });

        for (const obj of [balloon, bucket, pinned, free]) obj.dispose();
        for (const obj of board2) obj.dispose();
        for (const obj of board3) obj.dispose();
    });
});