/**
 * Named tie seats — GitHub issue #84.
 *
 * A rope names its three tie seats — anchor, mid, end — and answers, for
 * each one, its seat index (the same number the segment-index API ties
 * through), its tie body, its world point at ask time, and its reach as a
 * fraction of the span. The mid seat is a ROLE resolved against the live
 * chain — the chain's middle body — never a stored index, so it is still
 * the mid seat after a re-lay or a tie-grow, with nothing written at tie
 * time. The segment-index surface, the connect-flow squares and the tie
 * tokens are untouched: seats answer indices, they do not replace them.
 *
 * Seams under test:
 * - Rope.getTieSeats — the three-seat answer: roles/order, indices,
 *   bodies, world points, reach fractions (end = today's seatFraction).
 * - Middle-of-chain resolution on a fresh six-segment drop and on a
 *   longer span-derived chain.
 * - Resolution inertia: the mid seat follows a re-lay (setEndpoints) and
 *   a tie-grow of either family — the one covering rule re-counts both
 *   (issue #89) — with no seat write at tie time.
 * - Presence: a laid rope answers three; a bodyless free bundle answers
 *   only its coil anchor seat; a disposed rope answers nothing.
 *
 * Companion suites: rope-ties (segment ties, issue #56), rope-span
 * (span-derived counts), pinned-rope-length (reach/length freeze),
 * connect-flow (the click state machine this seam feeds, issue #85).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import Rope from '../js/objects/Rope.js';
import Balloon from '../js/objects/Balloon.js';
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

describe('Rope named tie seats (issue #84) — the three-seat answer', () => {
    it('a fresh six-segment chain answers its three seats: anchor, mid, end', () => {
        // 100px ≤ SEGMENTS × 40 = 240 → the fresh-drop floor: 6 segments
        // (rope-span suite's knowledge). Bodies [anchor, seg0…seg5].
        const rope = new Rope(200, 100, { length: 100 });
        const seats = rope.getTieSeats();
        expect(seats.map((s) => s.role)).toEqual(['anchor', 'mid', 'end']);

        const [anchor, mid, end] = seats;
        // Anchor: the anchor body itself, at the drop start; reach 0 — the
        // anchor tie consumes no chain (attachEndpoint's own accounting).
        expect(anchor.segment).toBe(-1);
        expect(anchor.body).toBe(rope.bodies[0]);
        expect(anchor.worldPoint).toEqual({ x: 200, y: 100 });
        expect(anchor.reach).toBe(0);

        // Mid: the live chain's MIDDLE body — seat 2 of 6 (its seat centre
        // 5/12 of the span, the anchor-ward tie of the two middle seats).
        expect(mid.segment).toBe(2);
        expect(mid.body).toBe(rope.bodies[3]); // bodies[0]=anchor, i+1 per seat
        expect(mid.worldPoint).toEqual({ x: 200, y: 100 + (100 / 6) * 2.5 });
        expect(mid.reach).toBe(5 / 12);

        // End: the tail seat — today's covering limit (count−0.5)/count.
        expect(end.segment).toBe(5);
        expect(end.body).toBe(rope.bodies[6]);
        expect(end.reach).toBe(11 / 12);
        rope.dispose();
    });

    it('a longer span-derived chain mid-resolves to its own middle (420px lays 11)', () => {
        // 420px → ceil(420/40) = 11 segments (rope-span suite's knowledge):
        // an odd count, so the middle body is exact — seat 5, its centre
        // 5.5/11 = exactly half the span.
        const rope = new Rope(100, 100, { length: 420 });
        const [mid, end] = rope.getTieSeats().slice(1);
        expect(mid.segment).toBe(5);
        expect(mid.body).toBe(rope.bodies[6]);
        expect(mid.worldPoint).toEqual({ x: 100, y: 100 + (420 / 11) * 5.5 });
        expect(mid.reach).toBe(0.5);
        expect(end.segment).toBe(10);
        expect(end.reach).toBe(21 / 22);
        rope.dispose();
    });

    it('the mid seat follows a re-lay: 100→320px re-counts 6→8 and mid rides to the new middle', () => {
        const rope = new Rope(200, 100, { length: 100 }); // SEGMENTS floor: 6
        const bornMid = rope.getTieSeats()[1];
        expect(bornMid.segment).toBe(2);

        // The hand's re-lay (setEndpoints, the edit-time placement seam):
        // 320px = 8 × 40 → 8 segments, the tail trades, earlier seats keep
        // their bodies. The mid seat is re-asked, never re-written.
        rope.setEndpoints({ x: 200, y: 100 }, { x: 520, y: 100 });
        const [anchor, mid, end] = rope.getTieSeats();
        expect(anchor.body).toBe(rope.bodies[0]); // the anchor keeps its body
        expect(mid.segment).toBe(3); // middle of 8, anchor-ward tie of the pair
        expect(mid.body).toBe(rope.bodies[4]);
        expect(mid.reach).toBe(7 / 16);
        expect(end.segment).toBe(7);
        expect(end.reach).toBe(15 / 16);
        rope.dispose();
    });

    it('the mid seat follows a FREE tie-grow: the recount moves it, nothing written at tie time', () => {
        // An authored free rope lays its 6-segment chain as it enters a
        // world (birthAuthoredChain at addObject). Its end-seat tie to a
        // balloon ~301px away grows the span to ~327 to cover the knot and
        // re-counts the chain (the free family: its span IS its chain,
        // issue #56) → 9 segments. The mid seat is never written at tie
        // time — it re-derives as the new chain's middle.
        const physics = new PhysicsEngine(800, 600);
        engines.push(physics);
        const rope = objectRegistry.create('free-rope', 200, 100, { length: 100 });
        const balloon = new Balloon(500, 100); // knot ≈ (500, 125.6)
        physics.addObject(rope);
        physics.addObject(balloon);
        expect(rope.bodies.length - 1).toBe(6);
        const bornMidBody = rope.getTieSeats()[1].body; // the born chain's middle
        expect(bornMidBody).toBe(rope.bodies[3]);

        rope.attachEndpoint(5, balloon, 'knot'); // end-seat tie beyond reach
        expect(rope.bodies.length - 1).toBe(9); // grown span re-counted 6→9

        const [mid, end] = rope.getTieSeats().slice(1);
        expect(mid.segment).toBe(4); // exact middle of the 9-chain
        expect(mid.body).toBe(rope.bodies[5]);
        expect(mid.body).not.toBe(bornMidBody); // the old middle's body is mid no more
        expect(end.segment).toBe(8); // the re-count re-seated the knot (issue #87)
        rope.dispose();
        balloon.dispose();
    });

    it('the mid seat follows a PINNED tie-grow too: one covering rule, same re-count (issue #89)', () => {
        // The pinned/free counting split is retired (issue #89): a pinned
        // rope's end-seat tie beyond reach grows the span (~100 → ~328)
        // and re-counts the chain exactly like the free family's own
        // tie-grow (issue #56) → 9 segments. The mid seat is never written
        // at tie time — it re-derives as the new chain's middle.
        const rope = new Rope(200, 100, { length: 100 });
        const balloon = new Balloon(500, 100); // knot ≈ (500, 125.6): tied ≈ 301px
        const bornMidBody = rope.getTieSeats()[1].body;

        expect(rope.lengthFrozen).toBe(false); // untied: reach is the hand's
        rope.attachEndpoint(5, balloon, 'knot'); // end-seat tie beyond reach
        expect(rope.lengthFrozen).toBe(true);
        expect(rope.bodies.length - 1).toBe(9); // the grow re-counted 6→9, same rule as free

        const [anchor, mid, end] = rope.getTieSeats();
        expect(anchor.body).toBe(rope.bodies[0]);
        expect(mid.segment).toBe(4); // the re-counted chain's middle
        expect(mid.body).toBe(rope.bodies[5]);
        expect(mid.body).not.toBe(bornMidBody); // the old middle's body is mid no more
        expect(end.segment).toBe(8); // the re-count re-seated the knot (issue #87)
        rope.dispose();
        balloon.dispose();
    });

    it('presence: a bundle answers one coil seat, its spawned chain three; a disposed rope answers nothing', () => {
        const balloon = new Balloon(220, 140);
        const rope = objectRegistry.create('free-rope', 220, 200, { length: 60 });
        // Bodyless bundle (issue #55): only the anchor seat exists — the
        // coil square's seat, no body, the coil centre for a point.
        let seats = rope.getTieSeats();
        expect(seats).toHaveLength(1);
        expect(seats[0].role).toBe('anchor');
        expect(seats[0].segment).toBe(-1);
        expect(seats[0].body).toBeNull();
        expect(seats[0].worldPoint).toEqual({ x: 220, y: 200 });
        expect(seats[0].reach).toBe(0);

        // First tie spawns the chain (issue #55): the three seats appear,
        // the anchor seat now answering the chain's moving knot body.
        rope.attachEndpoint(-1, balloon, 'knot');
        seats = rope.getTieSeats(); // 60px ≤ 240 → SEGMENTS floor: 6
        expect(seats.map((s) => s.role)).toEqual(['anchor', 'mid', 'end']);
        expect(seats[0].body).toBe(rope.bodies[0]);
        expect(seats[1].body).toBe(rope.bodies[3]); // middle of 6
        expect(seats[2].body).toBe(rope.bodies[6]);
        rope.dispose();
        balloon.dispose();

        // Disposed rope: no anchor, no chain — answers nothing (parity
        // with `bodies`, which reads empty on a disposed rope).
        const dead = new Rope(0, 0, { length: 100 });
        dead.dispose();
        expect(dead.bodies).toEqual([]);
        expect(dead.getTieSeats()).toEqual([]);
    });

    describe('seat reach matches the consumers that already act on fractions', () => {
        it("the end seat's number is the reach gate's own limit (isPointWithinReach)", () => {
            const rope = new Rope(200, 100, { length: 100 });
            const end = rope.getTieSeats()[2];
            const reachRadius = 100 * end.reach; // the seat's own reach × span
            // Today's gate (ADR 0007 decision 4): the covering limit sits at
            // end.reach — inside it reaches, beyond it refuses (no slack).
            expect(rope.isPointWithinReach(200 + reachRadius, 100)).toBe(true);
            expect(rope.isPointWithinReach(200 + reachRadius + 0.5, 100)).toBe(false);
            // …but the mid seat covers much less than the end: a point inside
            // the end seat's circle yet past the mid seat's fraction is beyond
            // reaching for a MID tie — each seat answers its OWN fraction.
            const mid = rope.getTieSeats()[1];
            const beyondMid = 100 * (mid.reach + end.reach) / 2; // between them
            expect(beyondMid).toBeGreaterThan(100 * mid.reach);
            expect(beyondMid).toBeLessThan(reachRadius);
            rope.dispose();
        });

        it('a mid-seat tie grows the span by the mid seat\'s own fraction (covering rule)', () => {
            const rope = new Rope(200, 100, { length: 100 });
            // Knot exactly 100px out on the anchor's ray: balloon body at
            // (300, 74.4) → its knot point at (300, 100).
            const balloon = new Balloon(300, 74.4);
            const mid = rope.getTieSeats()[1];
            expect(100 * mid.reach).toBeCloseTo(100 * 2.5 / 6, 12); // 41.67px: the tie aims well past it
            rope.attachEndpoint(mid.segment, balloon, 'knot');
            // The covering rule grows to tied · count/(seat + 0.5) (ADR 0007
            // decision 4, #56) — the same arithmetic the seat's reach
            // answers, spelled from the setup's own numbers: 100px tied at
            // seat 2 of 6 → 100 × 6/2.5 = 240. (The END seat's fraction
            // would have grown it to only 100 × 6/5.5 ≈ 109 — the grow
            // listened to the MID seat's fraction, the seat answer's number.)
            expect(rope._length).toBeCloseTo(100 * 6 / 2.5, 5);
            expect(rope.getTieSeats()[1].reach).toBe(5 / 12); // the re-count holds 6 (240/40)
            rope.dispose();
            balloon.dispose();
        });
    });
});
