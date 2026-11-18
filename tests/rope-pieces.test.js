/**
 * Piece severing (GitHub issue #58) - ADR 0007 decision 7.
 *
 * A cut severs exactly where it hits: only the chain constraint at the cut
 * dies, and the rope's chain falls into its surviving CONNECTED COMPONENTS -
 * the pieces. Each piece keeps the knots attached to its own segments,
 * realizes them in play, and falls carrying its payloads; a pinned rope's
 * anchor-side piece stays hung from the board anchor; repeated cuts yield
 * more pieces. The whole-rope demolition survives only as the fallback for
 * producers with no hit information (sever() with no hit) and for restoring
 * legacy rows.
 *
 * Seams under test:
 * - Rope.sever(hit) - the piece cut (hit: a rope body or a segment index);
 *   bare sever() stays the wholesale fallback;
 * - Rope.getPieces() - the piece structure observable;
 * - the chain constraint getter + the physics world - only the cut
 *   constraint leaves it, the survivors hold the pieces together;
 * - the reconcile + engine links - pieces realize their own knots; the
 *   sever consumer kills exactly the links no surviving piece keeps;
 * - serialize/deserialize + takeSnapshot/restoreSnapshot - pieces, knots
 *   and the severed flag round-trip (cuts ride the rope row).
 *
 * Companion suites: rope.test.js (the rewritten severing suite),
 * pair-conformance (the four cut rows), rope-to-rope (the severed-target
 * policy for pieces), connector-reset (the placed board round-trip),
 * rope-connector (the co-termination rewrite), scissors, connect-flow.
 */

import { describe, it, expect, afterEach } from 'vitest';
import Matter from 'matter-js';
import { PhysicsEngine } from '../js/engine/PhysicsEngine.js';
import { eventBus } from '../js/EventBus.js';
import { objectRegistry } from '../js/objects/ObjectRegistry.js';
import { registerAllObjects } from '../js/objects/registerAllObjects.js';
import Rope from '../js/objects/Rope.js';
import Balloon from '../js/objects/Balloon.js';
import Bucket from '../js/objects/Bucket.js';
import Candle from '../js/objects/Candle.js';
import Scissors from '../js/objects/Scissors.js';
import Ball from '../js/objects/Ball.js';

const { Composite } = Matter;

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

function trackEvent(name) {
    const events = [];
    unsubscribers.push(eventBus.on(name, (payload) => events.push(payload ?? null)));
    return events;
}

/**
 * The pieces of `rope` as chains of body indices into rope.bodies - the
 * public piece structure, compared by position in the chain rather than by
 * deep-equality over Matter bodies.
 */
const piecesOf = (rope) => rope.getPieces().map((piece) => piece.map((b) => rope.bodies.indexOf(b)));

describe('Piece severing (issue #58) - a cut splits the chain at the hit segment', () => {
    it('pieces are the surviving connected components of the chain (intact = one piece)', () => {
        const rope = new Rope(200, 100);
        expect(rope.bodies).toHaveLength(7); // anchor + 6 segments
        expect(rope.constraints).toHaveLength(6);
        expect(piecesOf(rope)).toEqual([[0, 1, 2, 3, 4, 5, 6]]);
        expect(rope.isSevered).toBe(false);
        rope.dispose();
    });

    it('a mid-chain cut splits exactly at the hit segment: only the cut constraint dies, both sides keep their segments', () => {
        const rope = new Rope(200, 100);
        rope.sever(2); // the hit lands on chain segment 2

        expect(rope.isSevered).toBe(true);
        // Pieces: anchor-side [anchor, seg0, seg1, seg2] vs falling [seg3, seg4, seg5]
        expect(piecesOf(rope)).toEqual([[0, 1, 2, 3], [4, 5, 6]]);
        // Both sides keep EVERY body (no demolition), and the hit segment
        // stays with the piece its anchor side carries.
        expect(rope.bodies).toHaveLength(7);
        expect(rope.bodies.every(Boolean)).toBe(true);
        // Only one chain constraint died: five survivors remain, and none
        // of them joins the two pieces.
        expect(rope.constraints).toHaveLength(5);
        for (const link of rope.constraints) {
            const a = rope.bodies.indexOf(link.bodyA);
            const b = rope.bodies.indexOf(link.bodyB);
            // the cut edge (bodies 3-4) is the only dead one
            expect((a === 3 && b === 4) || (a === 4 && b === 3)).toBe(false);
        }
        // The cut accepts a body hit exactly the same as an index.
        const rope2 = new Rope(200, 100);
        rope2.sever(rope2.bodies[3]); // body hit: chain segment 2
        expect(piecesOf(rope2)).toEqual([[0, 1, 2, 3], [4, 5, 6]]);
        rope2.dispose();
    });

    it('a cut at the first segment keeps it with the anchor piece; a cut at the tail clamps to the tail link', () => {
        const firstCut = new Rope(200, 100);
        firstCut.sever(0); // hit segment 0: the boundary sits between it and segment 1
        expect(piecesOf(firstCut)).toEqual([[0, 1], [2, 3, 4, 5, 6]]);
        firstCut.dispose();

        const tailCut = new Rope(200, 100);
        tailCut.sever(5); // hit the tail: the only adjacent link is the tail link
        expect(piecesOf(tailCut)).toEqual([[0, 1, 2, 3, 4, 5], [6]]);
        tailCut.dispose();
    });

    it('repeated cuts yield 3+ pieces; an already-cut location absorbs the second cut', () => {
        const rope = new Rope(200, 100);
        rope.sever(1);
        expect(piecesOf(rope)).toEqual([[0, 1, 2], [3, 4, 5, 6]]);

        rope.sever(3); // cutting an already-cut rope works
        expect(piecesOf(rope)).toEqual([[0, 1, 2], [3, 4], [5, 6]]);

        rope.sever(3); // the same location again: absorbed, nothing changes
        expect(piecesOf(rope)).toEqual([[0, 1, 2], [3, 4], [5, 6]]);
        rope.dispose();
    });

    it('a wholesale sever without a hit stays the legacy fallback: every constraint dies', () => {
        const physics = makeEngine();
        const rope = new Rope(200, 100);
        physics.addObject(rope);

        rope.sever(); // no hit information: the rope-level fallback

        expect(rope.isSevered).toBe(true);
        expect(rope.constraints).toEqual([]);
        expect(rope.getPieces()).toEqual([]); // no piece structure recorded
        expect(Composite.allConstraints(physics.world)).toEqual([]);
        physics.dispose();
        // No resurrection on re-add (the legacy contract, kept)
        const physics2 = makeEngine();
        physics2.addObject(rope);
        expect(Composite.allConstraints(physics2.world)).toEqual([]);
    });

    it('the engine detaches exactly the cut constraint from the world; the surviving pieces stand', () => {
        const physics = makeEngine();
        const rope = new Rope(200, 100);
        physics.addObject(rope);
        expect(Composite.allConstraints(physics.world)).toEqual(rope.constraints);

        rope.sever(2);
        // The world holds exactly the surviving chain: the cut edge is gone,
        // every other link stands and holds its piece together.
        expect(Composite.allConstraints(physics.world)).toEqual(rope.constraints);
        expect(rope.constraints).toHaveLength(5);
        physics.dispose();
    });

    it('through the real candle row, a single-pair flame splits exactly at the segment it touches', () => {
        const physics = makeEngine();
        // A long-span rope: 40px pitch, so exactly one segment (seg 2, at
        // y = 140) rests within the flame sensor's 13px reach.
        const rope = new Rope(200, 40, { length: 240});
        const candle = new Candle(212, 165); // flame centre (212, 140), 12px from seg 2
        physics.addObject(rope);
        physics.addObject(candle);
        const severed = trackEvent('rope:severed');

        for (let i = 0; i < 5 && !rope.isSevered; i++) physics.step(DT);

        expect(rope.isSevered).toBe(true);
        expect(severed).toHaveLength(1);
        // The hit segment 2 stays with the anchor side; the cut is its own
        // boundary constraint (edge 3), and nothing else died.
        expect(piecesOf(rope)).toEqual([[0, 1, 2, 3], [4, 5, 6]]);
        expect(rope.constraints).toHaveLength(5);

        // The anchored piece stays hung; the falling piece drops away.
        const tail = rope.getPieces()[1].slice(-1)[0];
        const tailY = tail.position.y;
        for (let i = 0; i < 45; i++) physics.step(DT);
        expect(tail.position.y).toBeGreaterThan(tailY + 20);
        for (const body of rope.getPieces()[0]) {
            expect(body.position.y).toBeLessThan(230); // near its laid layout
        }
    });

    it('one cut per beat: a flame band overlapping three segments cuts once', () => {
        const physics = makeEngine();
        // The classic rig: 10px pitch puts segments 0, 1 and 2 all inside the
        // flame sensor's reach, so one beat dispatches several hit pairs.
        const rope = new Rope(200, 40, { length: 60 });
        const candle = new Candle(200, 80);
        physics.addObject(rope);
        physics.addObject(candle);
        const severed = trackEvent('rope:severed');

        physics.step(DT);
        physics.step(DT);
        physics.step(DT);
        physics.step(DT);

        // Exactly one cut, one event, two pieces - whichever segment of the
        // band won the beat's first hit.
        expect(rope.isSevered).toBe(true);
        expect(severed).toHaveLength(1);
        expect(piecesOf(rope)).toHaveLength(2);
        expect(rope.constraints).toHaveLength(5);
        physics.dispose();
    });

    it('through the real scissors snap, the fan cut is one cut at the in-fan segment', () => {
        const physics = makeEngine();
        const rope = new Rope(400, 40, { length: 60 });
        const scissors = new Scissors(400, 55);
        const ball = new Ball(379, 28, { variant: 'tennis' });
        physics.addObject(rope);
        physics.addObject(scissors);
        physics.addObject(ball);
        const severed = trackEvent('rope:severed');

        let cut = false;
        for (let i = 0; i < 90 && !cut; i++) {
            physics.step(DT);
            cut = rope.isSevered;
        }
        expect(cut).toBe(true);
        expect(scissors.isClosed).toBe(true);

        // The most anchor-ward in-fan segment is segment 1 (segment 0 sits
        // behind the pivot): the cut boundary is edge 2, leaving
        // [anchor, seg0, seg1] hung and [seg2..seg5] falling.
        expect(piecesOf(rope)).toEqual([[0, 1, 2], [3, 4, 5, 6]]);
        expect(severed).toHaveLength(1);
        physics.dispose();
    });
});

describe('Piece severing (issue #58) - pieces keep their knots and their payloads', () => {
    it('each piece keeps the knots attached to its segments and realizes them in play', () => {
        const physics = makeEngine();
        const rope = new Rope(200, 100);
        const balloon = new Balloon(200, 160); // knot (200, 185.6): the mid tie covers itself
        physics.addObject(rope);
        physics.addObject(balloon);
        rope.attachEndpoint('mid', balloon, 'knot'); // the knot rides the middle segment
        physics.step(DT);
        expect(physics.getAttachedConstraints()).toHaveLength(1);

        rope.sever(2); // cut right where the knot sits (segment 2)
        // The knot stays with segment 2's piece and its link keeps standing.
        expect(physics.getAttachedConstraints()).toHaveLength(1);
        const link = physics.getAttachedConstraints()[0];
        const mid = rope.bodies[3]; // chain segment 2
        expect(link.bodyA === mid || link.bodyB === mid).toBe(true);

        // Realized in play, over time: nothing drops, nothing duplicates.
        for (let i = 0; i < 10; i++) physics.step(DT);
        expect(physics.getAttachedConstraints()).toHaveLength(1);
        expect(rope.getAttachmentRefs()).toEqual([
            { seat: 'mid', target: balloon, pointId: 'knot' },
        ]);
        expect(rope.getPieces()[0]).toContain(mid); // the knot's piece
        physics.dispose();
    });

    it('payloads fall with their piece, tied to it, never floating free', () => {
        const physics = makeEngine();
        const rope = new Rope(400, 60, { length: 80 });
        const bucket = new Bucket(400, 260); // rim (the floor's mouth-top point) at (400, 240)
        physics.addObject(rope);
        physics.addObject(bucket);
        rope.attachEndpoint('end', bucket, 'rim'); // the payload rides the tail
        for (let i = 0; i < 10; i++) physics.step(DT);
        expect(physics.getAttachedConstraints()).toHaveLength(1);

        const bucketFloor = bucket.bodies[2];
        const floorStartY = bucketFloor.position.y;

        rope.sever(1); // cut near the anchor: the tail piece carries the payload
        expect(physics.getAttachedConstraints(), 'the knot stands through the cut').toHaveLength(1);

        // The tail piece + the payload descend together: the knot link never
        // drops, so the payload is never floating free.
        for (let i = 0; i < 40; i++) physics.step(DT);
        expect(physics.getAttachedConstraints()).toHaveLength(1);
        expect(bucketFloor.position.y).toBeGreaterThan(floorStartY + 30);
        // ...and it rides this piece: the knot's seat (the tail segment) is
        // part of the falling piece the standing link ties the bucket to.
        expect(rope.getPieces()[1]).toContain(rope.bodies[6]);
        physics.dispose();
    });

    it('pinned rope cut near the board anchor: the anchor-side piece stays hung from the nail', () => {
        const physics = makeEngine();
        const rope = new Rope(200, 100);
        physics.addObject(rope);
        rope.sever(0); // hit segment 0: [anchor, seg0] hangs, the rest falls

        const anchorY = rope.bodies[0].position.y;
        const seg0RestDown = rope.bodies[1].position.y - anchorY; // laid: half a link (8.3px)
        for (let i = 0; i < 60; i++) physics.step(DT);
        // The nail does not move; segment 0 dangles just past its laid height
        // below it (the anchor piece hangs from the board anchor).
        expect(rope.bodies[0].isStatic).toBe(true);
        expect(Math.abs(rope.bodies[0].position.y - anchorY)).toBeLessThan(0.01);
        expect(rope.bodies[1].position.y - rope.bodies[0].position.y)
            .toBeLessThan(seg0RestDown + 6);
        // Everything below the cut fell away.
        for (const seg of rope.bodies.slice(2)) {
            expect(seg.position.y).toBeGreaterThan(200);
        }
        physics.dispose();
    });

    it('a cut can absorb a piece that has no knots (it falls empty)', () => {
        const physics = makeEngine();
        const rope = new Rope(200, 100);
        const balloon = new Balloon(200, 160);
        physics.addObject(rope);
        physics.addObject(balloon);
        rope.attachEndpoint('end', balloon, 'knot');
        for (let i = 0; i < 10; i++) physics.step(DT);
        expect(physics.getAttachedConstraints()).toHaveLength(1);

        rope.sever(1); // [anchor+0+1] hung | [2..5] falling, knot at the tail
        physics.step(DT); // the next beat: one cut per beat keeps same-beat hits one cut
        rope.sever(3); // [anchor+0+1] | [2,3] | [4,5+knot]: the middle has no knots

        expect(piecesOf(rope)).toEqual([[0, 1, 2], [3, 4], [5, 6]]);
        // Only the tail knot survives: the knot-less middle piece realizes
        // nothing, keeps its own shape, and falls empty with the rest.
        expect(physics.getAttachedConstraints()).toHaveLength(1);
        const middle = rope.getPieces()[1]; // [seg2, seg3]
        const midStartY = middle[0].position.y;
        const laidGap = Math.hypot(
            middle[1].position.x - middle[0].position.x,
            middle[1].position.y - middle[0].position.y,
        );
        for (let i = 0; i < 40; i++) physics.step(DT);
        expect(physics.getAttachedConstraints()).toHaveLength(1);
        for (const body of middle) {
            expect(body.position.y).toBeGreaterThan(midStartY + 20); // falling
        }
        const gapNow = Math.hypot(
            middle[1].position.x - middle[0].position.x,
            middle[1].position.y - middle[0].position.y,
        );
        expect(gapNow).toBeLessThan(laidGap * 2 + 10); // the piece never disintegrates
        physics.dispose();
    });
});

describe('Piece severing (issue #58) - severed state with pieces survives round-trips', () => {
    it('serialize/deserialize round-trips the pieces, the severed flag and the cut', () => {
        const rope = new Rope(200, 100);
        rope.sever(2);
        expect(piecesOf(rope)).toEqual([[0, 1, 2, 3], [4, 5, 6]]);

        const data = rope.serialize();
        expect(data.options.severed).toBe(true);
        expect(data.options.cuts).toEqual([3]); // the boundary edge of the hit segment

        const restored = Rope.deserialize(data);
        expect(restored.isSevered).toBe(true);
        expect(piecesOf(restored)).toEqual([[0, 1, 2, 3], [4, 5, 6]]);
        expect(restored.constraints).toHaveLength(5);
        // Save -> load -> save is idempotent.
        expect(restored.serialize().options.cuts).toEqual([3]);
        expect(restored.serialize().options.severed).toBe(true);
        restored.dispose();
        rope.dispose();
    });

    it('a piece-cut rope rebinding its tokens restores the knots its pieces keep', () => {
        const balloon = new Balloon(200, 160);
        const rope = new Rope(200, 100);
        rope.attachEndpoint('end', balloon, 'knot');
        rope.sever(2);

        const data = rope.serialize();
        data.attachments = [{ seat: 'end', targetType: 'balloon', targetOrdinal: 0, pointId: 'knot' }];

        const restored = Rope.deserialize(data);
        restored.bindAttachment([new Balloon(200, 160)]);
        expect(restored.isSevered).toBe(true);
        expect(piecesOf(restored)).toEqual([[0, 1, 2, 3], [4, 5, 6]]);
        expect(restored.getAttachmentRefs().map((r) => r.seat)).toEqual(['end']);
        restored.dispose();
        rope.dispose();
        balloon.dispose();
    });

    it('a legacy severed row without piece data restores severed with nothing to keep', () => {
        const data = {
            type: 'rope', x: 200, y: 100, angle: 0, isFixed: false,
            options: { length: 100, severed: true },
            attachments: [{ seat: 'end', targetType: 'balloon', targetOrdinal: 0, pointId: 'knot' }],
        };
        const restored = Rope.deserialize(data);
        expect(restored.isSevered).toBe(true);
        expect(restored.constraints).toEqual([]); // the wholesale shape
        expect(restored.getPieces()).toEqual([]); // no piece structure recorded
        restored.bindAttachment([new Balloon(200, 160)]);
        expect(restored.getAttachmentRefs()).toEqual([]); // binds nothing
        restored.dispose();
    });

    it('a piece-cut snapshot rewinds onto the live rope: pieces, flag and knot converge', () => {
        const physics = makeEngine();
        const rope = new Rope(200, 100);
        const balloon = new Balloon(200, 160);
        physics.addObject(rope);
        physics.addObject(balloon);
        rope.attachEndpoint('end', balloon, 'knot');
        physics.step(DT);
        expect(physics.getAttachedConstraints()).toHaveLength(1);

        rope.sever(2); // two pieces at snapshot time
        physics.step(DT);
        physics.takeSnapshot();

        rope.sever(4); // play on: a third piece - the hit's boundary edge is edge 5
        expect(piecesOf(rope)).toEqual([[0, 1, 2, 3], [4, 5], [6]]);
        for (let i = 0; i < 5; i++) physics.step(DT);

        const converge = trackEvent('rope:chain-converge');
        physics.restoreSnapshot();

        // Back to the snapshot's piece state, flag and knot included.
        expect(rope.isSevered).toBe(true);
        expect(piecesOf(rope)).toEqual([[0, 1, 2, 3], [4, 5, 6]]);
        expect(rope.constraints).toHaveLength(5);
        // The world holds the surviving chain plus the piece's re-attached
        // knot (the snapshot realized it; the link records bring it back).
        const worldLinks = Composite.allConstraints(physics.world);
        for (const link of rope.constraints) expect(worldLinks).toContain(link);
        expect(worldLinks).toHaveLength(6);
        expect(rope.getAttachmentRefs().map((r) => r.seat)).toEqual(['end']);
        for (let i = 0; i < 5; i++) physics.step(DT);
        expect(physics.getAttachedConstraints()).toHaveLength(1); // the knot re-realized
        expect(converge.length).toBeGreaterThan(0); // the world was told about the swap
        physics.dispose();
    });

    it('an equal-cut rewind preserves the piece rope untouched; an intact rewind revives it', () => {
        const physics = makeEngine();
        const rope = new Rope(200, 100);
        physics.addObject(rope);
        physics.step(DT);
        rope.sever(2);
        physics.step(DT);
        physics.takeSnapshot();
        const piecesBefore = piecesOf(rope);
        const converge = trackEvent('rope:chain-converge');

        physics.restoreSnapshot(); // same cuts: no rebuild, no converge
        expect(piecesOf(rope)).toEqual(piecesBefore);
        expect(converge).toHaveLength(0);
        physics.dispose();

        // A rewind onto an INTACT snapshot revives the severed rope (the
        // standing converge contract, now over pieces as well).
        const rope2 = new Rope(400, 100);
        const physics2 = makeEngine();
        physics2.addObject(rope2);
        physics2.step(DT);
        physics2.takeSnapshot();
        rope2.sever(2);
        for (let i = 0; i < 5; i++) physics2.step(DT);
        physics2.restoreSnapshot();
        expect(rope2.isSevered).toBe(false);
        expect(piecesOf(rope2)).toEqual([[0, 1, 2, 3, 4, 5, 6]]);
        expect(rope2.constraints).toHaveLength(6);
        physics2.dispose();
    });
});

describe('Piece severing (issue #58) - the free rope severs too', () => {
    it('a spawned chain severs into pieces; its anchor piece stays hung from the target knot', () => {
        const physics = makeEngine();
        const rope = objectRegistry.create('free-rope', 200, 40, { length: 60 });
        const balloon = new Balloon(200, 10);
        physics.addObject(rope);
        physics.addObject(balloon);
        rope.attachEndpoint('anchor', balloon, 'knot'); // the chain's birth
        expect(rope.bodies.length).toBeGreaterThan(0);
        for (let i = 0; i < 5; i++) physics.step(DT);
        expect(physics.getAttachedConstraints()).toHaveLength(1); // the anchor knot

        rope.sever(2);
        // The anchor piece (anchor knot + its segments) hangs from the
        // target through its own kept knot; the tail piece falls.
        expect(rope.isSevered).toBe(true);
        expect(piecesOf(rope)).toHaveLength(2);
        expect(physics.getAttachedConstraints(), 'the anchor piece keeps its knot')
            .toHaveLength(1);
        const tailStartY = rope.bodies[6].position.y;
        for (let i = 0; i < 40; i++) physics.step(DT);
        expect(physics.getAttachedConstraints()).toHaveLength(1);
        expect(rope.bodies[6].position.y).toBeGreaterThan(tailStartY + 25);
        physics.dispose();
    });

    it('a cut spawned chain never collapses into a bundle, even fully untied', () => {
        const physics = makeEngine();
        const rope = objectRegistry.create('free-rope', 200, 40, { length: 60 });
        const balloon = new Balloon(200, 10);
        physics.addObject(rope);
        physics.addObject(balloon);
        rope.attachEndpoint('anchor', balloon, 'knot'); // spawn
        for (let i = 0; i < 5; i++) physics.step(DT);

        rope.sever(2);
        rope.detachEndpoint('anchor', balloon, 'knot'); // the last knot goes
        physics.step(DT); // the freed knot link drops at the reconcile (the standing untie contract)

        // Severing suspends the bundle lifecycle: the pieces stand and fall
        // in the world; the rope never coils back up.
        expect(rope.isFreeBundle).toBe(false);
        expect(piecesOf(rope)).toHaveLength(2);
        expect(physics.getAttachedConstraints()).toHaveLength(0);
        for (let i = 0; i < 30; i++) physics.step(DT);
        expect(rope.isSevered).toBe(true);
        expect(piecesOf(rope)).toHaveLength(2);
        expect(physics.queryObjectsByType('free-rope')).toContain(rope);
        physics.dispose();
    });
});
