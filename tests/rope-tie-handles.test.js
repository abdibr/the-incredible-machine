/**
 * Three tie seats, one knot per seat — GitHub issue #85.
 *
 * The connect flow squares a rope's three NAMED tie seats (issue #84's
 * getTieSeats) in place of the old one square per chain body: anchor, mid,
 * end — however long the span — plus the bodyless free bundle's single coil
 * square. A seek can only start from one of the three, so a click-tied rope
 * holds at most three knots, one per seat; a square that already holds a
 * knot unties on click instead of seeking, and a seat that already holds a
 * knot refuses a second tie (no knot created).
 *
 * Seams under test:
 * - ConnectFlow.getRopeSquares — the squares answer the seats: exactly
 *   three on a laid rope (any chain count), each at its seat's live world
 *   point, hover-revealed while free; the bundle's one coil square and the
 *   three seats its first tie spawns.
 * - ConnectFlow.handlePointerDown — a free square seeks at that seat; an
 *   occupied square unties exactly that knot (the target keeps its point);
 *   a tie through the mid square realizes from the middle chain body; the
 *   armed free-rope seek refuses a second tie into its occupied seat.
 * - Rope.attachEndpoint — the rope-side seat gate: one knot per seat.
 *
 * Companion suites: rope-seats (issues #84/#90 — the seat answers),
 * rope-ties (role ties + one knot per seat), connect-flow (the click state
 * machine), free-rope (bundle lifecycle).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import ConnectFlow from '../js/ui/ConnectFlow.js';
import Rope from '../js/objects/Rope.js';
import Balloon from '../js/objects/Balloon.js';
import Bucket from '../js/objects/Bucket.js';
import { PhysicsEngine } from '../js/engine/PhysicsEngine.js';
import { objectRegistry } from '../js/objects/ObjectRegistry.js';
import { registerAllObjects } from '../js/objects/registerAllObjects.js';

registerAllObjects();

const DT = 1000 / 60;
const engines = [];

afterEach(() => {
    for (const engine of engines) engine.dispose();
    engines.length = 0;
    vi.restoreAllMocks();
});

describe('ConnectFlow — the squares ARE the tie seats (issue #85)', () => {
    let flow;

    beforeEach(() => {
        flow = new ConnectFlow();
        flow._mode = 'EDITING';
    });

    it('a placed rope squares exactly three seats — anchor, mid, end — however long the span', () => {
        // 6-chain (100px ≤ SEGMENTS × 40): seats anchor, mid, end of
        // [anchor, seg0…5].
        const rope = new Rope(200, 100, { length: 100 });
        let squares = flow.getRopeSquares([rope], null);
        expect(squares).toHaveLength(3);
        expect(squares.map((s) => s.role)).toEqual(['anchor', 'mid', 'end']);
        // Geometry: each square sits at its seat's live world point, with
        // the bodies-list index of the seat's own body.
        expect(squares[0]).toEqual(expect.objectContaining({ x: 200, y: 100, bodyIndex: 0 }));
        expect(squares[1].x).toBeCloseTo(200, 5);
        expect(squares[1].y).toBeCloseTo(100 + (100 / 6) * 2.5, 5);
        expect(squares[1].bodyIndex).toBe(3);
        expect(squares[2].bodyIndex).toBe(6);
        // Free squares are hover-revealed; nothing is tied yet.
        expect(squares.every((s) => !s.tied && !s.visible)).toBe(true);
        squares = flow.getRopeSquares([rope], { x: 200, y: 100 + (100 / 6) * 2.5 });
        expect(squares[1].visible).toBe(true);
        expect(squares[1].hovered).toBe(true);
        expect(squares.filter((s) => s.visible)).toHaveLength(1);
        rope.dispose();

        // A long span (940px → the 16-segment cap) keeps the same three:
        // mid seg 7, end seg 15 — never one square per segment.
        const long = new Rope(100, 80, { length: 940 });
        squares = flow.getRopeSquares([long], null);
        expect(squares).toHaveLength(3);
        expect(squares.map((s) => s.role)).toEqual(['anchor', 'mid', 'end']);
        long.dispose();
    });

    it('a bodyless bundle squares its one coil seat; its first tie spawns the three seats', () => {
        const rope = objectRegistry.create('free-rope', 300, 300); // bodyless coil (issue #55)
        const bucket = new Bucket(360, 240);

        let squares = flow.getRopeSquares([rope], null);
        expect(squares).toHaveLength(1);
        expect(squares[0]).toEqual(expect.objectContaining({
            rope, role: 'anchor', bodyIndex: -1, tied: false,
            x: 300, y: 300,
        }));

        // First tie through the coil: the chain spawns, and the coil square
        // becomes the anchor seat of exactly three.
        flow.handlePointerDown(300, 300, [rope, bucket]);
        const rim = bucket.getAttachmentWorldPoint('rim');
        flow.handlePointerDown(rim.x, rim.y, [rope, bucket]);
        expect(rope.getAttachmentRefs()).toEqual([{ seat: 'anchor', target: bucket, pointId: 'rim' }]);

        squares = flow.getRopeSquares([rope], null); // the spawned 100px chain: 6 segments
        expect(squares).toHaveLength(3);
        expect(squares.map((s) => s.role)).toEqual(['anchor', 'mid', 'end']);
        expect(squares[0].tied).toBe(true); // the coil seat is now the tied anchor
        expect(squares[0].visible).toBe(true);
        flow.cancel();
        rope.dispose();
        bucket.dispose();
    });
});

describe('One knot per seat (issue #85)', () => {
    let flow;

    beforeEach(() => {
        flow = new ConnectFlow();
        flow._mode = 'EDITING';
    });

    it('the rope refuses a second tie into a seat that already holds a knot', () => {
        const rope = new Rope(200, 100, { length: 100 });
        const first = new Balloon(200, 120); // knot (200, 145.6): the mid seat's tie
        const second = new Balloon(240, 120);
        rope.attachEndpoint('mid', first, 'knot'); // the mid seat, tied
        expect(rope.getAttachmentRefs()).toHaveLength(1);

        // The occupied seat refuses — no knot, and a throw before anything
        // re-lays (the covering grow must never run for a refused tie).
        expect(() => rope.attachEndpoint('mid', second, 'knot')).toThrow(/already holds a knot/);
        expect(rope.getAttachmentRefs()).toEqual([{ seat: 'mid', target: first, pointId: 'knot' }]);

        // A different seat still takes its first knot — three seats, one
        // knot each, is the rope's whole tying capacity through its squares.
        rope.attachEndpoint('anchor', second, 'knot');
        expect(rope.getAttachmentRefs().map((r) => r.seat)).toEqual(['anchor', 'mid']);
        rope.dispose();
        first.dispose();
        second.dispose();
    });

    it('a tie through the mid square realizes from the middle chain body, not the anchor', () => {
        const rope = new Rope(300, 100, { length: 100 }); // 6-chain, mid seat 2 at (300, 141.67)
        const balloon = new Balloon(300, 116.07); // knot at (300, 141.67): exactly the mid square
        const physics = new PhysicsEngine(800, 600);
        engines.push(physics);
        physics.addObject(rope);
        physics.addObject(balloon);

        // Clicking the mid square starts the seek at the mid seat…
        const mid = rope.getTieSeats()[1].worldPoint;
        expect(flow.handlePointerDown(mid.x, mid.y, [rope, balloon])).toBe(true);
        expect(flow.seek).toEqual({ rope, role: 'mid' });
        // …and the tie click realizes the knot from the mid seat's body: the
        // mid square ties the middle chain body, never the anchor.
        expect(flow.handlePointerDown(mid.x, mid.y, [rope, balloon])).toBe(true);
        expect(rope.getAttachmentRefs()).toEqual([{ seat: 'mid', target: balloon, pointId: 'knot' }]);
        physics.step(DT);
        const link = physics.getAttachedConstraints()[0];
        expect(link.bodyA).toBe(rope.bodies[3]); // _segments[2] — the MIDDLE body
        expect(link.bodyB).toBe(balloon.bodies[0]);
        flow.cancel();
        physics.dispose();
        rope.dispose();
        balloon.dispose();
    });

    it('an occupied square unties exactly that seat\u2019s knot; targets keep their points', () => {
        const physics = new PhysicsEngine(800, 600);
        engines.push(physics);
        const rope = new Rope(300, 100, { length: 100 });
        const anchorBalloon = new Balloon(300, 74.4); // knot (300, 100): the anchor square
        const endBalloon = new Balloon(300, 154.4); // knot (300, 180): inside the end square
        physics.addObject(rope);
        physics.addObject(anchorBalloon);
        physics.addObject(endBalloon);
        rope.attachEndpoint('anchor', anchorBalloon, 'knot');
        rope.attachEndpoint('end', endBalloon, 'knot'); // 80px tied: inside the end seat's reach

        // The end seat holds a knot: its click unties THAT knot,
        // instead of seeking.
        const end = rope.bodies[rope.bodies.length - 1].position;
        expect(flow.handlePointerDown(end.x, end.y, [rope, anchorBalloon, endBalloon])).toBe(true);
        expect(flow.seek).toBe(null); // untie is not a seek
        expect(rope.getAttachmentRefs()).toEqual([{ seat: 'anchor', target: anchorBalloon, pointId: 'knot' }]);
        // The untied target keeps its attachment point.
        expect(endBalloon.attachmentPoints.some((p) => p.id === 'knot')).toBe(true);
        expect(endBalloon.getAttachmentWorldPoint('knot')).not.toBe(null);
        // The freed link drops on the next step; the anchor knot's link lives.
        physics.step(DT);
        const links = physics.getAttachedConstraints().filter(
            (c) => c.bodyB === endBalloon.bodies[0] || c.bodyB === anchorBalloon.bodies[0]
        );
        expect(links).toHaveLength(1);
        expect(links[0].bodyB).toBe(anchorBalloon.bodies[0]);

        // …and the anchor square's click unties exactly the anchor knot.
        expect(flow.handlePointerDown(300, 100, [rope, anchorBalloon])).toBe(true);
        expect(rope.getAttachmentRefs()).toEqual([]);
        physics.dispose();
        rope.dispose();
        anchorBalloon.dispose();
        endBalloon.dispose();
    });

    it('the armed free-rope seek refuses a second tie into its occupied seat; the next seat ties on', () => {
        const rope = objectRegistry.create('free-rope', 300, 300); // bodyless coil
        const bucket = new Bucket(360, 240);
        const balloon = new Balloon(320, 340);

        // First tie from the coil spawns the chain; the FREE family's seek
        // stays armed at the anchor seat it just tied (ADR 0007 amendment 3).
        flow.handlePointerDown(300, 300, [rope, bucket]);
        const rim = bucket.getAttachmentWorldPoint('rim');
        flow.handlePointerDown(rim.x, rim.y, [rope, bucket]);
        expect(flow.seek).toEqual({ rope, role: 'anchor' });
        expect(rope.getAttachmentRefs()).toHaveLength(1);

        // A second tie click into the now-occupied seat refuses: no knot,
        // the seek survives, and the refusal paints its own reason.
        const knot = balloon.getAttachmentWorldPoint('knot');
        expect(flow.handlePointerDown(knot.x, knot.y, [rope, bucket, balloon])).toBe(true);
        expect(rope.getAttachmentRefs()).toHaveLength(1); // one knot per seat
        expect(flow.refusal).toMatchObject({ x: knot.x, y: knot.y, reason: 'occupied' });

        // Exit the armed seek and tie from a FREE seat: the end square.
        flow.cancel();
        const end = rope.bodies[rope.bodies.length - 1].position;
        flow.handlePointerDown(end.x, end.y, [rope, bucket, balloon]);
        expect(flow.seek).toEqual({ rope, role: 'end' });
        flow.handlePointerDown(knot.x, knot.y, [rope, bucket, balloon]);
        expect(rope.getAttachmentRefs().map((r) => r.seat)).toEqual(['anchor', 'end']);
        flow.cancel();
        rope.dispose();
        bucket.dispose();
        balloon.dispose();
    });
});
