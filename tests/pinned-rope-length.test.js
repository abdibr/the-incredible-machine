/**
 * Pinned rope fixed length with beyond-reach refusal — GitHub issue #54,
 * the second slice of the rope connection redesign (ADR 0007 decision 4).
 *
 * Seams under test:
 * - Rope fixed length: a fresh drop hangs 100 px straight down (registry
 *   route included); the chain's span capacity ("reach") is its rest-length
 *   sum, measured from the static anchor by Rope.isPointWithinReach — the
 *   connect flow gates both its glow and its tie clicks with this one
 *   predicate, so what glows is exactly what ties.
 * - Rope.relayFreeEnd — the hand re-lay: the free-end tie square rides to
 *   the cursor (the chain spans a 6/5.5 factor of the demanded square
 *   distance); an untied rope clamps at the minimum viable span
 *   (MIN_ROPE_SPAN — six segments stay a chain, never collapse) and a
 *   frozen rope re-orients around its frozen reach only, length unmoved.
 * - Rope.attachEndpoint — the first tie freezes the length; a tie reaching
 *   past the laid capacity grows the fixed length to cover its knot (and
 *   re-lays the live chain so its rest lengths span the tied span exactly —
 *   nothing over-tensioned); ties never shrink the rope (max length with
 *   slack — never a rigid rod).
 * - PhysicsEngine._restoreRopeConstraints — the chain-converge consumer
 *   now swaps chains: a re-lay's previous chain leaves the world as the
 *   rebuilt one enters (registration-guarded, bus-global).
 * - Snapshot round-trip: rope length and its frozen-after-first-tie state
 *   ride the placed-board rows through serializePlacedBoard /
 *   restorePlacedFromSnapshot's two-phase ordinal bind.
 */

import { describe, it, expect } from 'vitest';
import Matter from 'matter-js';
import ConnectFlow from '../js/ui/ConnectFlow.js';
import Rope, { MIN_ROPE_SPAN } from '../js/objects/Rope.js';
import Balloon from '../js/objects/Balloon.js';
import Bucket from '../js/objects/Bucket.js';
import { PhysicsEngine } from '../js/engine/PhysicsEngine.js';
import { serializePlacedBoard, restorePlacedFromSnapshot } from '../js/reset/levelReset.js';
import { objectRegistry } from '../js/objects/ObjectRegistry.js';
import { registerAllObjects } from '../js/objects/registerAllObjects.js';

const { Composite } = Matter;

// The chain's span capacity (anchor → tie body): six links — half a
// segment to the first segment's center, then five full segments — so
// (SEGMENTS − 0.5) / SEGMENTS of the fixed length.
const CAPACITY = (length) => (length * 5.5) / 6;

describe('Pinned rope fixed length (issue #54, ADR 0007 decision 4)', () => {
    it('a fresh drop hangs exactly 100 px straight down from its anchor', () => {
        const rope = new Rope(400, 300);
        expect(rope._length).toBe(100);
        expect(rope._endPoint).toEqual({ x: 400, y: 400 });
        expect(rope.bodies[0].position).toEqual({ x: 400, y: 300 });
        // The free-end tie square is the last segment's center: (5.5/6) of
        // the span down the line.
        const end = rope.bodies[rope.bodies.length - 1].position;
        expect(end.x).toBeCloseTo(400, 5);
        expect(end.y).toBeCloseTo(300 + CAPACITY(100), 5);
        expect(rope.lengthFrozen).toBe(false); // never tied: length is the hand's

        // The registry route (the toolbox drop) hangs the same way.
        registerAllObjects();
        const dropped = objectRegistry.create('rope', 400, 300);
        expect(dropped._length).toBe(100);
        expect(dropped._endPoint).toEqual({ x: 400, y: 400 });
        rope.dispose();
        dropped.dispose();
    });

    it('MIN_ROPE_SPAN keeps six 3px segments a chain: 48 px', () => {
        expect(MIN_ROPE_SPAN).toBe(48);
    });

    it('relayFreeEnd clamps: the square rides the demand, the minimum span, or the frozen circle', () => {
        const rope = new Rope(300, 100, { length: 40 });
        // Untied, in range: the tie square lands exactly on the demand and
        // the chain spans 6/5.5 of the square distance (the layout end
        // rides half a segment beyond the square).
        rope.relayFreeEnd(300, 240);
        const endAfterRelay = rope.bodies[rope.bodies.length - 1].position;
        expect(endAfterRelay.x).toBeCloseTo(300, 5);
        expect(endAfterRelay.y).toBeCloseTo(240, 5);
        expect(rope._length).toBeCloseTo(140 * 6 / 5.5, 5);
        expect(rope._endPoint.y).toBeCloseTo(100 + 140 * 6 / 5.5, 5);

        // Untied, too short: clamped to the minimum span down the same
        // direction — the chain survives (six segments, never collapsed).
        rope.relayFreeEnd(303, 106);
        const d = Math.hypot(3, 6);
        expect(rope._length).toBe(MIN_ROPE_SPAN);
        expect(rope._endPoint.x).toBeCloseTo(300 + (3 / d) * MIN_ROPE_SPAN, 5);
        expect(rope._endPoint.y).toBeCloseTo(100 + (6 / d) * MIN_ROPE_SPAN, 5);
        expect(rope.constraints).toHaveLength(6);
        expect(rope.bodies[1].position.x).toBeCloseTo(300 + (3 / d) * MIN_ROPE_SPAN / 12, 5);
        expect(rope.bodies[1].position.y).toBeCloseTo(100 + (6 / d) * MIN_ROPE_SPAN / 12, 5);

        // Frozen at the length it had at the tie (the knot on the anchored
        // start froze the rope mid-clamp): every demand rides the frozen
        // reach circle; the length itself never moves.
        const balloon = new Balloon(320, 74.4); // knot at (320, 100), 20px right of the anchor
        rope.attachEndpoint(0, balloon, 'knot');
        expect(rope.lengthFrozen).toBe(true);
        rope.relayFreeEnd(300, 700);
        expect(rope._length).toBe(MIN_ROPE_SPAN); // frozen exactly where the tie left it
        expect(rope._endPoint).toEqual({ x: 300, y: 100 + MIN_ROPE_SPAN });
        expect(rope.bodies[rope.bodies.length - 1].position.y).toBeCloseTo(100 + CAPACITY(MIN_ROPE_SPAN), 5);
        rope.relayFreeEnd(303, 106); // an inward demand rides the same circle
        expect(rope._length).toBe(MIN_ROPE_SPAN);
        expect(rope._endPoint.x).toBeCloseTo(300 + (3 / d) * MIN_ROPE_SPAN, 5);
        expect(rope._endPoint.y).toBeCloseTo(100 + (6 / d) * MIN_ROPE_SPAN, 5);
        rope.dispose();
        balloon.dispose();
    });

    it('isPointWithinReach measures the chain capacity from the static anchor', () => {
        const rope = new Rope(300, 100, { length: 40 });
        expect(rope.isPointWithinReach(300, 100 + CAPACITY(40))).toBe(true); // exactly the capacity
        expect(rope.isPointWithinReach(300, 100 + CAPACITY(40) + 1)).toBe(false);
        expect(rope.isPointWithinReach(300, 100 + CAPACITY(40) + 1, 5)).toBe(true); // the aim slack
        expect(rope.isPointWithinReach(300, 300 + CAPACITY(40), 5)).toBe(false);
        rope.dispose();
    });

    it('the free-end seek reels the rope to the cursor — the hand sets the length, the tie freezes it', () => {
        const flow = new ConnectFlow();
        flow._mode = 'EDITING';
        const rope = new Rope(300, 100, { length: 40 });
        const balloon = new Balloon(280, 214.4); // its knot: (280, 240)
        const end = rope.bodies[rope.bodies.length - 1].position;
        const knot = balloon.getAttachmentWorldPoint('knot');

        flow.handlePointerDown(end.x, end.y, [rope, balloon]); // free-end seek
        flow.setPreview(300, 240); // reel straight down: the square rides to the cursor
        const reeled = rope.bodies[rope.bodies.length - 1].position;
        expect(reeled.x).toBeCloseTo(300, 5);
        expect(reeled.y).toBeCloseTo(240, 5);
        expect(rope._length).toBeCloseTo(140 * 6 / 5.5, 5);
        expect(rope.lengthFrozen).toBe(false);

        flow.setPreview(knot.x, knot.y); // reel onto the target: reach follows the hand
        const consumed = flow.handlePointerDown(knot.x, knot.y, [rope, balloon]);

        expect(consumed).toBe(true);
        expect(flow.seek).toBe(null);
        expect(rope.getAttachmentRefs()).toContainEqual({ endpoint: 1, target: balloon, pointId: 'knot' });
        expect(rope.lengthFrozen).toBe(true); // the first tie froze the hand-set length
        expect(rope._length).toBeCloseTo(Math.hypot(20, 140) * 6 / 5.5, 3);
        rope.dispose();
        balloon.dispose();
    });

    it('the first tie keeps the laid length — a tied pinned rope is max length plus slack', () => {
        const rope = new Rope(400, 300);
        const balloon = new Balloon(400, 334.4); // knot at (400, 360): 60px down the chain
        rope.attachEndpoint(1, balloon, 'knot');

        expect(rope._length).toBe(100); // a tie never shrinks the rope
        expect(rope.lengthFrozen).toBe(true);
        // The chain's rest lengths still sum to the chain capacity — 91.7 px
        // of chain for a 60 px knot span leaves ~32 px of slack to sag with.
        const restSum = rope.constraints.reduce((sum, c) => sum + c.length, 0);
        expect(restSum).toBeCloseTo(CAPACITY(100), 5);
        rope.dispose();
        balloon.dispose();
    });

    it('a tie reaching past the laid capacity grows the fixed length to cover its knot', () => {
        const rope = new Rope(300, 100, { length: 40 });
        const balloon = new Balloon(330, 115); // knot at (330, 140.6): 50.48px out
        rope.attachEndpoint(1, balloon, 'knot');
        const tied = Math.hypot(30, 40.6);
        expect(rope._length).toBeCloseTo(tied * 6 / 5.5, 3); // grown to cover the knot
        expect(rope._length).toBeGreaterThan(40);
        expect(rope.lengthFrozen).toBe(true);
        // The covering grow re-lays the LIVE chain too, not just the _length
        // accounting: the rebuilt rest lengths span the tied span exactly and
        // the tie square lands ON the knot. A bump-only grow left the laid
        // 36.67px chain in place — the length-0 knot link then resolved the
        // ≤14px deficit by hauling the target inboard / stretching the chain
        // taut (the silent snap ADR 0007 decision 4 refuses).
        const restSum = rope.constraints.reduce((sum, c) => sum + c.length, 0);
        expect(restSum).toBeCloseTo(tied, 3);
        const end = rope.bodies[rope.bodies.length - 1].position;
        const knot = balloon.getAttachmentWorldPoint('knot');
        expect(end.x).toBeCloseTo(knot.x, 3);
        expect(end.y).toBeCloseTo(knot.y, 3);
        rope.dispose();
        balloon.dispose();
    });

    it('the anchor-side tie consumes no chain and grows no length', () => {
        const rope = new Rope(300, 100);
        // The rim 23.3px from the anchor: the endpoint-0 knot realizes at
        // the anchor itself — the fixed length stays exactly as laid.
        const bucket = new Bucket(280, 132); // rim at (280, 112)
        const rim = bucket.getAttachmentWorldPoint('rim');
        expect(Math.hypot(rim.x - 300, rim.y - 100)).toBeCloseTo(23.32, 2);
        rope.attachEndpoint(0, bucket, 'rim');
        expect(rope._length).toBe(100);
        expect(rope.lengthFrozen).toBe(true);
        rope.dispose();
        bucket.dispose();
    });

    it('rope length and frozen state round-trip the board snapshot', () => {
        const balloon = new Balloon(320, 74.4);  // knot at (320, 100), in reach
        const tied = new Rope(300, 100, { length: 40 });
        tied.attachEndpoint(0, balloon, 'knot');
        const free = new Rope(500, 500);
        free.setEndpoints({ x: 500, y: 500 }, { x: 500, y: 570 }); // hand-laid 70px, never tied
        const board = [balloon, tied, free];

        const snapshot = serializePlacedBoard(board);
        expect(snapshot[1].options.length).toBe(40);
        expect(snapshot[1].options.lengthFrozen).toBe(true);
        expect(snapshot[2].options.length).toBe(70);
        expect(snapshot[2].options.lengthFrozen).toBe(false);

        const board2 = [];
        restorePlacedFromSnapshot(board2, snapshot);
        const balloon2 = board2.find((o) => o.type === 'balloon');
        const restoredTied = board2.find((o) => o.type === 'rope' && o.x === 300);
        const restoredFree = board2.find((o) => o.type === 'rope' && o.x === 500);
        expect(restoredTied._length).toBe(40);
        expect(restoredTied.lengthFrozen).toBe(true); // the tie refroze it
        expect(restoredTied.getAttachmentRefs()).toContainEqual({ endpoint: 0, target: balloon2, pointId: 'knot' });
        expect(restoredFree._length).toBe(70);
        expect(restoredFree.lengthFrozen).toBe(false);
        for (const obj of board) obj.dispose();
        for (const obj of board2) obj.dispose();
    });

    it('re-laying an in-world rope swaps its chain in the physics world', () => {
        const physics = new PhysicsEngine(800, 600);
        const rope = new Rope(400, 300);
        physics.addObject(rope);
        physics.step(16.67);
        const before = rope.constraints;
        expect(before).toHaveLength(6);
        expect(Composite.allConstraints(physics.world)).toContain(before[0]);

        rope.relayFreeEnd(420, 480);

        expect(rope.constraints).not.toBe(before);
        expect(rope.constraints).toHaveLength(6);
        const inWorld = Composite.allConstraints(physics.world);
        expect(inWorld).toHaveLength(6);
        for (const constraint of rope.constraints) expect(inWorld).toContain(constraint);
        for (const constraint of before) expect(inWorld).not.toContain(constraint);
        physics.dispose();
        rope.dispose();
    });

    it('a re-lay outside any physics world leaks no chain into live engines', () => {
        const physics = new PhysicsEngine(800, 600);
        const other = new Rope(200, 200);
        physics.addObject(other);
        expect(Composite.allConstraints(physics.world)).toHaveLength(6);

        const stray = new Rope(600, 100); // never added to an engine
        stray.relayFreeEnd(700, 300);
        // The converge event guards on world membership: nothing lands.
        expect(Composite.allConstraints(physics.world)).toHaveLength(6);
        physics.dispose();
        stray.dispose();
        other.dispose();
    });

    it('a covering grow on an in-world rope swaps its chain and hauls nothing', () => {
        const physics = new PhysicsEngine(800, 600);
        const rope = new Rope(300, 100, { length: 40 });
        const balloon = new Balloon(330, 115); // knot at (330, 140.6): 50.48px out
        physics.addObject(rope);
        physics.addObject(balloon);
        physics.step(16.67);
        const before = rope.constraints;
        expect(before).toHaveLength(6);

        rope.attachEndpoint(1, balloon, 'knot'); // ties past laid capacity, inside the aim tolerance

        // The rebuilt (covering) chain entered the world as the laid (short)
        // one left it — no stale, over-tensioned members stepping into play.
        expect(rope.constraints).not.toBe(before);
        const inWorld = Composite.allConstraints(physics.world);
        for (const constraint of rope.constraints) expect(inWorld).toContain(constraint);
        for (const constraint of before) expect(inWorld).not.toContain(constraint);
        // The knot link realizes on the next step against a chain that is
        // exactly taut at the tie: the balloon stays where it was tied, no
        // deficit haul, no stretch-taut.
        physics.step(16.67);
        const knot = balloon.getAttachmentWorldPoint('knot');
        expect(Math.hypot(knot.x - 330, knot.y - 140.6)).toBeLessThan(2);
        physics.dispose();
        rope.dispose();
        balloon.dispose();
    });
});