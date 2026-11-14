/**
 * Rope-to-rope knots — GitHub issue #57 (child of #19 / ADR 0007).
 *
 * Ropes become TIE TARGETS: their endpoint bodies (the anchor and the
 * tail segment) are exposed as attachment points with squares, so a seek
 * from any square can click a rope's square and knot rope-to-rope. The
 * knot is a body-to-body zero-length engine link (the same reconcile seam
 * as every other tie) and restores through the same seated ordinal token
 * bind — the target's endpoint point ids are its seat roles themselves.
 *
 * Severing the chain a rope-to-rope knot attaches to (the pre-piece-
 * severing policy: a severed rope holds no knots, from either side)
 * clears that knot cleanly — its engine link is co-terminated by the
 * sever consumer and its live ref prunes on the next reconcile step, so
 * nothing dangles and nothing re-realizes.
 *
 * Seams under test:
 * - Rope.attachmentPoints / getAttachmentWorldPoint — the offering (a
 *   laid rope answers its anchor and tail endpoint; a bodyless bundle and
 *   a disposed rope answer nothing);
 * - ConnectFlow.getTieSquares / handlePointerDown — the squares glow as
 *   tie targets and clicking one ties the seeking rope's seat to the
 *   rope's point; severed ropes (and the seeking rope itself) are
 *   excluded; rope targets tie in place (no anchor-seat pull);
 * - the physics reconcile — the knot realizes as a zero-length link
 *   between the seeking seat's body and the target endpoint's body, and
 *   two knotted ropes move together;
 * - serializePlacedBoard / restorePlacedFromSnapshot — rope-target tokens
 *   round-trip, including a target rope that must birth its chain during
 *   its own bind pass (the spawned free rope's token order);
 * - Rope.sever + the reconcile — severing the target chain clears the
 *   knots attached to it.
 *
 * Companion suites: rope-ties (seat-role ties to payloads), connect-flow
 * (the click state machine), rope-connector (realization + rewind),
 * connector-reset (the placed snapshot seam).
 */

import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import Matter from 'matter-js';
import ConnectFlow from '../js/ui/ConnectFlow.js';
import Rope from '../js/objects/Rope.js';
import Balloon from '../js/objects/Balloon.js';
import { PhysicsEngine } from '../js/engine/PhysicsEngine.js';
import { objectRegistry } from '../js/objects/ObjectRegistry.js';
import { registerAllObjects } from '../js/objects/registerAllObjects.js';
import { serializePlacedBoard, restorePlacedFromSnapshot } from '../js/reset/levelReset.js';

const { Body } = Matter;

registerAllObjects();

const DT = 1000 / 60;
const engines = [];

beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    for (const engine of engines) engine.dispose();
    engines.length = 0;
    vi.restoreAllMocks();
});

describe('Rope as a tie target (issue #57) — the offering', () => {
    it('a laid rope offers its endpoint bodies — the anchor and the tail segment, offset 0', () => {
        const rope = new Rope(200, 100, { length: 100 });
        const tail = rope.bodies[rope.bodies.length - 1];

        const points = rope.attachmentPoints;
        expect(points.map((p) => p.id)).toEqual(['anchor', 'end']);
        expect(points[0].body).toBe(rope.bodies[0]); // the anchor body itself
        expect(points[1].body).toBe(tail);
        expect(points[0].offset).toEqual({ x: 0, y: 0 });
        expect(points[1].offset).toEqual({ x: 0, y: 0 });
        // The world points ARE the body centers: where a square draws and
        // the knot link pins (length 0).
        expect(rope.getAttachmentWorldPoint('anchor')).toEqual({
            x: rope.bodies[0].position.x, y: rope.bodies[0].position.y,
        });
        expect(rope.getAttachmentWorldPoint('end')).toEqual({
            x: tail.position.x, y: tail.position.y,
        });
        rope.dispose();
    });

    it('a spawned free rope offers both endpoints too — the knot anchor and its tail', () => {
        const balloon = new Balloon(260, 140);
        const rope = objectRegistry.create('free-rope', 260, 200, { length: 60 });
        rope.attachEndpoint('anchor', balloon, 'knot'); // spawn the chain

        const points = rope.attachmentPoints;
        expect(points.map((p) => p.id)).toEqual(['anchor', 'end']);
        expect(points[0].body).toBe(rope.bodies[0]); // the dynamic knot
        expect(points[1].body).toBe(rope.bodies[rope.bodies.length - 1]);
        rope.dispose();
        balloon.dispose();
    });

    it('a bodyless free bundle and a disposed rope offer nothing', () => {
        const bundle = objectRegistry.create('free-rope', 300, 300);
        expect(bundle.attachmentPoints).toEqual([]); // no bodies to bear a point

        const rope = new Rope(200, 100, { length: 100 });
        rope.dispose();
        expect(rope.attachmentPoints).toEqual([]); // disposed: parity with bodies
    });
});

describe('Rope as a tie target (issue #57) — the click flow', () => {
    let flow;

    beforeEach(() => {
        flow = new ConnectFlow();
        flow._mode = 'EDITING';
    });

    it("B's endpoint squares glow as tie targets during A's seek; clicking one ties A's seat to B's point", () => {
        const ropeA = new Rope(300, 100, { length: 40 });
        const ropeB = new Rope(400, 400, { length: 40 });
        const endSquare = ropeA.bodies[ropeA.bodies.length - 1].position;
        const targetSquare = ropeB.getAttachmentWorldPoint('anchor');

        flow.handlePointerDown(endSquare.x, endSquare.y, [ropeA, ropeB]); // A's end seat seeks
        // Glow follows the reach gate (issue #86 — what glows is exactly
        // what ties): before the reel the aim is far past A's tiny span...
        expect(flow.getTieSquares([ropeA, ropeB], null)
            .every((t) => t.target !== ropeB || !t.glows)).toBe(true);

        // The reel puts A's tail square on the aim before the tie click.
        flow.setPreview(targetSquare.x, targetSquare.y);
        const targets = flow.getTieSquares([ropeA, ropeB], null);
        const bSquares = targets.filter((t) => t.target === ropeB);
        expect(bSquares.map((t) => t.pointId).sort()).toEqual(['anchor', 'end']);
        expect(bSquares.every((t) => t.visible)).toBe(true); // target squares while seeking
        expect(bSquares.find((t) => t.pointId === 'anchor').glows).toBe(true); // the aim's square: tieable
        // (B's end square sits one span past the aim — past this seat's
        // reach band it stays faint, the honest "what glows is what ties"
        // gate; clicking it would refuse.)

        const consumed = flow.handlePointerDown(targetSquare.x, targetSquare.y, [ropeA, ropeB]);
        expect(consumed).toBe(true);
        // The knot lives on the SEEING side: A's end seat, tied to B's
        // 'anchor' point (targetB square point id); B holds no refs.
        expect(ropeA.getAttachmentRefs()).toEqual([
            { seat: 'end', target: ropeB, pointId: 'anchor' },
        ]);
        expect(ropeB.getAttachmentRefs()).toEqual([]);
        expect(flow.seek).toBe(null); // a pinned rope's tie ends the seek
        ropeA.dispose();
        ropeB.dispose();
    });

    it('clicking B\'s tail square knots the two tail segments together', () => {
        const ropeA = new Rope(300, 200, { length: 40 });
        const ropeB = new Rope(480, 260, { length: 40 });
        const endSquare = ropeA.bodies[ropeA.bodies.length - 1].position;
        const tailSquare = ropeB.getAttachmentWorldPoint('end');

        flow.handlePointerDown(endSquare.x, endSquare.y, [ropeA, ropeB]);
        flow.setPreview(tailSquare.x, tailSquare.y);
        flow.handlePointerDown(tailSquare.x, tailSquare.y, [ropeA, ropeB]);

        expect(ropeA.getAttachmentRefs()).toEqual([
            { seat: 'end', target: ropeB, pointId: 'end' },
        ]);
        ropeA.dispose();
        ropeB.dispose();
    });

    it('a seeking rope never offers itself; a bodyless bundle and a severed rope offer no target squares', () => {
        const ropeA = new Rope(300, 100, { length: 40 });
        const bundle = objectRegistry.create('free-rope', 500, 400);
        const endSquare = ropeA.bodies[ropeA.bodies.length - 1].position;

        // The seeking rope is excluded from its own targets (a self-knot
        // through the flow would pull the rope onto itself).
        flow.handlePointerDown(endSquare.x, endSquare.y, [ropeA]);
        expect(flow.getTieSquares([ropeA], null)).toEqual([]);
        flow.cancel();

        // A bodyless bundle: no bodies, no tie-in points (its coil square
        // stays a seek entry for the bundle's own ties, issue #55).
        flow.handlePointerDown(endSquare.x, endSquare.y, [ropeA, bundle]);
        expect(flow.getTieSquares([ropeA, bundle], null)).toEqual([]);
        flow.cancel();

        // A severed rope holds no knots and accepts no new ones: its
        // endpoint bodies exist but its pieces are falling apart.
        const severed = new Rope(430, 300, { length: 40 });
        severed.sever();
        flow.handlePointerDown(endSquare.x, endSquare.y, [ropeA, severed]);
        expect(flow.getTieSquares([ropeA, severed], null)).toEqual([]);
        ropeA.dispose();
        bundle.dispose();
        severed.dispose();
    });

    it("an occupied endpoint still accepts another rope's tie — one point serves several ropes", () => {
        const ropeA = new Rope(300, 100, { length: 40 });
        const ropeB = new Rope(400, 400, { length: 40 });
        const balloonB = new Balloon(400, 515); // under B's drop path
        // B ties its own end seat out to a payload: the endpoint rides a
        // live knot of its own (the covering grow re-lays B's span — its
        // tail rides the new end square).
        ropeB.attachEndpoint('end', balloonB, 'knot');
        const endSquare = ropeA.bodies[ropeA.bodies.length - 1].position;
        const tailSquare = ropeB.getAttachmentWorldPoint('end');

        // A ties into the same endpoint B is tied out of.
        flow.handlePointerDown(endSquare.x, endSquare.y, [ropeA, ropeB]);
        flow.setPreview(tailSquare.x, tailSquare.y);
        flow.handlePointerDown(tailSquare.x, tailSquare.y, [ropeA, ropeB]);
        expect(ropeA.getAttachmentRefs()).toEqual([
            { seat: 'end', target: ropeB, pointId: 'end' },
        ]);
        expect(ropeB.getAttachmentRefs()).toEqual([
            { seat: 'end', target: balloonB, pointId: 'knot' },
        ]);

        // The same-seat refusal is the rope's OWN seat gate (issue #85):
        // a rope's seek ties the balloon once, and its second tie aim at
        // the seat that now holds the knot refuses (no knot created).
        // The same-seat refusal is the rope's OWN seat gate (issue #85),
        // seen from the flow: a FREE rope's seek stays armed after its
        // tie (issue #56), so the second tie aim into any knot refuses —
        // "seat already tied" — and no second knot is created.
        const ropeD = objectRegistry.create('free-rope', 400, 480); // the coil square
        const dKnot = balloonB.getAttachmentWorldPoint('knot');
        flow.handlePointerDown(400, 480, [ropeD, balloonB]); // the coil square seeks
        flow.handlePointerDown(dKnot.x, dKnot.y, [ropeD, balloonB]); // the first tie lands (spawn)
        expect(ropeD.getAttachmentRefs()).toEqual([
            { seat: 'anchor', target: balloonB, pointId: 'knot' },
        ]);
        flow.handlePointerDown(dKnot.x, dKnot.y, [ropeD, balloonB]); // the armed seek aims again
        expect(ropeD.getAttachmentRefs()).toHaveLength(1); // the occupied seat refuses (no second knot)
        ropeA.dispose();
        ropeB.dispose();
        ropeD.dispose();
        balloonB.dispose();
    });

    it("untying A's tied square removes exactly that knot — B keeps its own ties", () => {
        const balloonB = new Balloon(400, 560);
        const ropeA = new Rope(300, 100, { length: 40 });
        const ropeB = new Rope(400, 400, { length: 40 });
        ropeB.attachEndpoint('end', balloonB, 'knot'); // B's own knot first

        // Tie A's end seat into B's tail square through the flow.
        const endSquare = ropeA.bodies[ropeA.bodies.length - 1].position;
        const tailSquare = ropeB.getAttachmentWorldPoint('end');
        flow.handlePointerDown(endSquare.x, endSquare.y, [ropeA, ropeB]);
        flow.setPreview(tailSquare.x, tailSquare.y);
        flow.handlePointerDown(tailSquare.x, tailSquare.y, [ropeA, ropeB]);
        expect(ropeA.getAttachmentRefs()).toHaveLength(1);

        // The tied square's click unties exactly that seat's knot: A's
        // square holds A's knot (one per seat); B's knot to the balloon
        // is untouched.
        const freed = ropeA.getAttachmentWorldPoint('end');
        flow.handlePointerDown(freed.x, freed.y, [ropeA, ropeB]);
        expect(ropeA.getAttachmentRefs()).toEqual([]);
        expect(ropeB.getAttachmentRefs()).toEqual([
            { seat: 'end', target: balloonB, pointId: 'knot' },
        ]);
        ropeA.dispose();
        ropeB.dispose();
        balloonB.dispose();
    });

    it('an anchor-seat tie into a rope target ties in place — the pull never relocates the target rope', () => {
        const ropeA = new Rope(300, 100, { length: 100 });
        const ropeB = new Rope(380, 160, { length: 40 });
        const anchorSquareB = ropeB.getAttachmentWorldPoint('anchor');
        const anchorSquareA = ropeA.bodies[0].position;
        const before = ropeB.bodies.map((b) => ({ ...b.position }));

        flow.handlePointerDown(anchorSquareA.x, anchorSquareA.y, [ropeA, ropeB]); // A's anchor seat seeks
        const consumed = flow.handlePointerDown(anchorSquareB.x, anchorSquareB.y, [ropeA, ropeB]);
        expect(consumed).toBe(true);
        expect(ropeA.getAttachmentRefs()).toEqual([
            { seat: 'anchor', target: ropeB, pointId: 'anchor' },
        ]);
        // The target rope is structure, not a payload: its bodies stay
        // exactly where they were (the knot settles the residual gap at
        // play, the same policy as immovable targets).
        ropeB.bodies.forEach((b, i) => {
            expect(b.position.x).toBeCloseTo(before[i].x, 5);
            expect(b.position.y).toBeCloseTo(before[i].y, 5);
        });
        ropeA.dispose();
        ropeB.dispose();
    });

    it("a bundle's coil-square seek into a rope's square spawns its chain hanging from the rope", () => {
        const bundle = objectRegistry.create('free-rope', 300, 500);
        const ropeB = new Rope(400, 100, { length: 40 });
        const anchorSquareB = ropeB.getAttachmentWorldPoint('anchor');

        flow.handlePointerDown(300, 500, [bundle, ropeB]); // the coil square seeks
        const consumed = flow.handlePointerDown(anchorSquareB.x, anchorSquareB.y, [bundle, ropeB]);
        expect(consumed).toBe(true);
        expect(bundle.isFreeBundle).toBe(false); // the tie unrolled the coil
        expect(bundle.getAttachmentRefs()).toEqual([
            { seat: 'anchor', target: ropeB, pointId: 'anchor' },
        ]);
        // The spawn hangs the newborn chain FROM the clicked rope square.
        expect(bundle.bodies[0].position.x).toBeCloseTo(anchorSquareB.x, 5);
        expect(bundle.bodies[0].position.y).toBeCloseTo(anchorSquareB.y, 5);
        expect(flow.seek).toEqual({ rope: bundle, role: 'anchor' }); // the free family keeps its seek armed
        bundle.dispose();
        ropeB.dispose();
    });
});

describe('Rope as a tie target (issue #57) — realization and physics', () => {
    it('a rope-target knot realizes as a body-to-body zero-length link on the next step', () => {
        const physics = new PhysicsEngine(800, 600);
        engines.push(physics);
        const ropeA = new Rope(100, 100, { length: 100 });
        const ropeB = new Rope(160, 100, { length: 100 });
        physics.addObject(ropeA);
        physics.addObject(ropeB);

        // A's end seat, tied to B's anchor body — inside the end seat's
        // covering circle (60px of a 91.7px capacity), no re-lay fires.
        ropeA.attachEndpoint('end', ropeB, 'anchor');
        physics.step(DT);

        const link = physics.getAttachedConstraints()[0];
        expect(link.bodyA).toBe(ropeA.bodies[ropeA.bodies.length - 1]); // the end seat's body
        expect(link.bodyB).toBe(ropeB.bodies[0]); // the target rope's anchor body
        expect(link.length).toBe(0);
        expect(link.stiffness).toBe(0.9);
        // Idempotent: steps never duplicate the knot link.
        for (let i = 0; i < 10; i++) physics.step(DT);
        expect(physics.getAttachedConstraints()).toHaveLength(1);
        ropeA.dispose();
        ropeB.dispose();
    });

    it('two knotted ropes move together: the target body rides the knot', () => {
        const physics = new PhysicsEngine(800, 600);
        engines.push(physics);
        // A's tail to B's tail — both bodies dynamic.
        const ropeA = new Rope(100, 500, { length: 100 });
        const ropeB = new Rope(160, 400, { length: 100 });
        physics.addObject(ropeA);
        physics.addObject(ropeB);
        ropeA.attachEndpoint('end', ropeB, 'end');
        physics.step(DT);
        expect(physics.getAttachedConstraints()).toHaveLength(1);

        const tailB = ropeB.bodies[ropeB.bodies.length - 1];
        const tailBStart = { ...tailB.position };
        const tailA = ropeA.bodies[ropeA.bodies.length - 1];
        physics.wakeBodies([tailA]);
        Body.setVelocity(tailA, { x: 60, y: 0 }); // swing A's tail toward x
        for (let i = 0; i < 12; i++) physics.step(DT);

        // The knot keeps the two tails together: B's tail followed A's.
        expect(Math.hypot(tailB.position.x - tailBStart.x, tailB.position.y - tailBStart.y))
            .toBeGreaterThan(20);
        ropeA.dispose();
        ropeB.dispose();
    });
});

describe('Rope as a tie target (issue #57) — severing the target chain', () => {
    it('the API refuses a tie into a severed rope with a clear error', () => {
        const ropeA = new Rope(100, 100, { length: 100 });
        const severedB = new Rope(160, 100, { length: 100 });
        severedB.sever();
        expect(() => ropeA.attachEndpoint('end', severedB, 'end'))
            .toThrow(/severed|holds no knots/i);
        expect(ropeA.getAttachmentRefs()).toEqual([]);
        ropeA.dispose();
        severedB.dispose();
    });

    it('severing the target chain clears the knots attached to it — nothing dangles or re-realizes', () => {
        const physics = new PhysicsEngine(800, 600);
        engines.push(physics);
        const ropeA = new Rope(100, 100, { length: 100 });
        const ropeB = new Rope(160, 100, { length: 100 });
        const ropeC = new Rope(220, 100, { length: 100 });
        physics.addObject(ropeA);
        physics.addObject(ropeB);
        physics.addObject(ropeC);
        // A and C both knot INTO B — A into its tail, C into its anchor.
        ropeA.attachEndpoint('end', ropeB, 'end');
        ropeC.attachEndpoint('end', ropeB, 'anchor');
        physics.step(DT);
        expect(physics.getAttachedConstraints()).toHaveLength(2);

        // Pre-piece-severing policy: the cut disintegrates B's chain, and
        // the sever consumer co-terminates every engine link touching its
        // bodies — A's and C's knots included.
        ropeB.sever();
        expect(physics.getAttachedConstraints()).toHaveLength(0);

        // The next reconcile step prunes the dead refs, and nothing ever
        // re-realizes: no orphaned links, no unresolved references.
        physics.step(DT);
        for (let i = 0; i < 10; i++) physics.step(DT);
        expect(physics.getAttachedConstraints()).toHaveLength(0);
        expect(ropeA.getAttachmentRefs()).toEqual([]);
        expect(ropeC.getAttachmentRefs()).toEqual([]);
        ropeA.dispose();
        ropeB.dispose();
    });
});

describe('Rope as a tie target (issue #57) — the snapshot seam', () => {
    it("rope-target tokens round-trip; the target rope with its own knots restores too", () => {
        const balloonB = new Balloon(440, 140); // knot (440, 165.6): 76.8px from B's anchor
        const ropeA = new Rope(300, 100, { length: 100 });
        const ropeB = new Rope(400, 100, { length: 100 });
        ropeB.attachEndpoint('end', balloonB, 'knot'); // B's own knot: 76.8 ≤ 91.7, no grow
        ropeA.attachEndpoint('end', ropeB, 'end'); // A's covering grow: the tail lands on B's tail

        const board = [ropeA, balloonB, ropeB];
        const rows = serializePlacedBoard(board);
        expect(rows[0].attachments).toContainEqual({
            seat: 'end', targetType: 'rope', targetOrdinal: 2, pointId: 'end',
        });
        expect(rows[2].attachments).toContainEqual({
            seat: 'end', targetType: 'balloon', targetOrdinal: 1, pointId: 'knot',
        });

        const board2 = [];
        restorePlacedFromSnapshot(board2, rows);
        const ropeA2 = board2.find((o) => o.type === 'rope' && o.x === 300);
        const ropeB2 = board2.find((o) => o.type === 'rope' && o.x === 400);
        expect(ropeA2.getAttachmentRefs()).toEqual([
            { seat: 'end', target: ropeB2, pointId: 'end' },
        ]);
        expect(ropeB2.getAttachmentRefs().map((r) => [r.seat, r.target?.type, r.pointId]))
            .toEqual([['end', 'balloon', 'knot']]);
        // The knot rides the restored chain's END role, wherever the
        // re-derived count puts the tail.
        expect(ropeA2.getTieSeats().find((s) => s.role === 'end').body)
            .toBe(ropeA2.bodies[ropeA2.bodies.length - 1]);
        expect(ropeA2.lengthFrozen).toBe(true);

        // Save → restore → save is idempotent from the covering fixed
        // point on (the first restore re-covers from the shorter
        // serialized span; the second changes nothing).
        const rows2 = serializePlacedBoard(board2);
        const board3 = [];
        restorePlacedFromSnapshot(board3, rows2);
        const ropeA3 = board3.find((o) => o.type === 'rope' && o.x === 300);
        expect(ropeA3._length).toBeCloseTo(ropeA2._length, 3);
        expect(ropeA3.getAttachmentRefs()).toEqual([
            { seat: 'end', target: board3.find((o) => o.type === 'rope' && o.x === 400), pointId: 'end' },
        ]);
        for (const o of board) o.dispose();
        for (const o of board2) o.dispose();
        for (const o of board3) o.dispose();
    });

    it('a token into a rope whose chain births during its own bind pass defers and binds on retry', () => {
        const balloonPayload = new Balloon(440, 140);
        const ropeA = new Rope(300, 100, { length: 100 });
        const ropeB = objectRegistry.create('free-rope', 400, 300, { length: 100 });
        // Board order: A placed BEFORE B — A's into-token binds before
        // B's own anchor token spawns its chain; the token defers to the
        // retry pass instead of dropping.
        ropeB.attachEndpoint('anchor', balloonPayload, 'knot'); // B's spawn knot
        ropeA.attachEndpoint('end', ropeB, 'end'); // A's knot into B's tail square

        const board = [ropeA, balloonPayload, ropeB];
        const rows = serializePlacedBoard(board);
        expect(rows[0].attachments).toEqual([
            { seat: 'end', targetType: 'free-rope', targetOrdinal: 2, pointId: 'end' },
        ]);

        const board2 = [];
        restorePlacedFromSnapshot(board2, rows);
        const ropeA2 = board2[0];
        const ropeB2 = board2[2];
        expect(ropeB2.isFreeBundle, "B's own token spawned its chain").toBe(false);
        expect(ropeA2.getAttachmentRefs(), "the deferred token bound on the retry pass").toEqual([
            { seat: 'end', target: ropeB2, pointId: 'end' },
        ]);
        for (const o of board) o.dispose();
        for (const o of board2) o.dispose();
    });

    it("a token into a rope that is severed at bind drops with a warning — nothing lands", () => {
        const ropeA = new Rope(300, 100, { length: 100 });
        const ropeB = new Rope(400, 100, { length: 100 });
        ropeA.attachEndpoint('end', ropeB, 'end');
        ropeB.sever(); // B cut before the snapshot: A's ref survives pre-prune, the annotator is dumb

        const rows = serializePlacedBoard([ropeA, ropeB]);
        const board2 = [];
        restorePlacedFromSnapshot(board2, rows);
        const ropeA2 = board2[0];
        expect(ropeA2.getAttachmentRefs()).toEqual([]); // the token dropped
        expect(ropeA2._pendingAttachments).toEqual([]); // nothing stays pending
        expect(console.warn).toHaveBeenCalled(); // the refusal was told out loud
        ropeA.dispose();
        ropeB.dispose();
    });
});
