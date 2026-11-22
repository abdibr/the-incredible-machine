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
 * - Rope.sever + the reconcile - cutting a tied target releases the ropes
 *   knotted INTO it while its own pieces keep their knots.
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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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

        // The per-seat refusal is the rope's OWN seat gate (issue #85):
        // what refuses is a SEAT that already holds its knot — the seat it
        // armed, not the aim it clicked. Issue #103 (the group spec's
        // decision 7): the armed free-rope seek stays armed after its tie
        // (issue #56) ON THE NEXT FREE seat, so the second aim at this
        // same knot is the ADVANCED seat's own tie — it lands (one knot
        // per SEAT: the anchor seat's knot stays) and the flow arms the
        // end seat after it.
        const ropeD = objectRegistry.create('free-rope', 400, 480); // the coil square
        const dKnot = balloonB.getAttachmentWorldPoint('knot');
        flow.handlePointerDown(400, 480, [ropeD, balloonB]); // the coil square seeks
        flow.handlePointerDown(dKnot.x, dKnot.y, [ropeD, balloonB]); // the first tie lands (spawn)
        expect(ropeD.getAttachmentRefs()).toEqual([
            { seat: 'anchor', target: balloonB, pointId: 'knot' },
        ]);
        flow.handlePointerDown(dKnot.x, dKnot.y, [ropeD, balloonB]); // the advanced mid seat ties the same aim
        expect(ropeD.getAttachmentRefs()).toHaveLength(2); // the new seat took the aim (one per SEAT)
        expect(ropeD.getAttachmentRefs().map((r) => r.seat)).toEqual(['anchor', 'mid']);
        expect(flow.seek).toEqual({ rope: ropeD, role: 'end' }); // the advance continues (issue #103)
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
        // The free family keeps its seek armed after the spawn tie (issue
        // #56), armed on the NEXT free seat — the newborn chain's mid
        // square (issue #103): the seat it just tied never re-arms.
        expect(flow.seek).toEqual({ rope: bundle, role: 'mid' });
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

        // Piece severing (issue #58) does not reopen the refusal: a rope
        // cut into pieces is still not a tie target.
        const ropeA2 = new Rope(100, 100, { length: 100 });
        const splitB = new Rope(160, 100, { length: 100 });
        splitB.sever(2);
        expect(() => ropeA2.attachEndpoint('end', splitB, 'end'))
            .toThrow(/severed|holds no knots/i);
        expect(ropeA2.getAttachmentRefs()).toEqual([]);
        ropeA2.dispose();
        splitB.dispose();
    });

    it('cutting a tied target releases the ropes knotted into it, while its own pieces keep their knots', () => {
        const physics = new PhysicsEngine(800, 600);
        engines.push(physics);
        const ropeA = new Rope(100, 100, { length: 100 });
        const ropeB = new Rope(160, 100, { length: 100 });
        const ropeC = new Rope(220, 100, { length: 100 });
        const balloon = new Balloon(160, 135); // knot (160, 160.6), 60.6px under the end cover
        physics.addObject(ropeA);
        physics.addObject(ropeB);
        physics.addObject(ropeC);
        physics.addObject(balloon);
        // A and C knot INTO B (A into its tail, C into its anchor) while B
        // ties OUT to a payload through its own end seat.
        ropeA.attachEndpoint('end', ropeB, 'end');
        ropeC.attachEndpoint('end', ropeB, 'anchor');
        ropeB.attachEndpoint('end', balloon, 'knot');
        physics.step(DT);
        physics.step(DT);
        expect(physics.getAttachedConstraints()).toHaveLength(3);

        // Piece severing (issue #58) keeps the severed-target policy: the
        // cut kills every knot hanging INTO the cut rope - its engine links
        // die at the cut (the consumer kills the links no surviving piece
        // keeps) and the holders prune their dead refs on the next step -
        // nothing dangles, nothing re-realizes.
        ropeB.sever(2);
        const links = physics.getAttachedConstraints();
        expect(links, 'only the cut rope own piece knot survives').toHaveLength(1);
        const tailB = ropeB.bodies[ropeB.bodies.length - 1];
        expect(links[0].bodyA === tailB || links[0].bodyB === tailB).toBe(true);
        expect(links[0].bodyA === balloon.bodies[0] || links[0].bodyB === balloon.bodies[0])
            .toBe(true);

        for (let i = 0; i < 12; i++) physics.step(DT);
        expect(physics.getAttachedConstraints(), 'nothing re-realizes').toHaveLength(1);
        expect(ropeA.getAttachmentRefs()).toEqual([]); // pruned with the cut
        expect(ropeC.getAttachmentRefs()).toEqual([]); // pruned with the cut
        expect(ropeB.getAttachmentRefs()).toEqual([
            { seat: 'end', target: balloon, pointId: 'knot' },
        ]); // B kept its own piece knot
        expect(ropeB.getPieces()).toHaveLength(2);
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

/**
 * The bugfile tie repro — bug-20261114T021258Z-ufzs (issue #93).
 *
 * The reporter clicked to tie the two ropes; their download's board
 * snapshot carries no rope-to-rope tie — the free rope (anchor seat → the
 * balloon's knot, span re-laid across the pinned rope's chain) and the
 * pinned rope (end seat → the bucket's rim) only rest against each other.
 * A tie click in this exact configuration must make the knot REALIZE and
 * SURVIVE the save/restore through the token seam — or the flow must paint
 * why it can't. No silent refusal is acceptable between those two; the
 * second test pins that the flow's last silent path (a rope-side
 * `attachEndpoint` throw swallowed by the click loop) paints now.
 *
 * The board is the recording's own `boardSnapshot`, restored through the
 * same placed-snapshot seam the sandbox rewind runs (restorePlacedFrom-
 * Snapshot + the two-phase token bind), so every square the repro clicks
 * is a square exactly where the reporter saw one.
 */
describe("The bugfile tie repro — bug-20261114T021258Z-ufzs (issue #93)", () => {
    const UFZS_FIXTURE = fileURLToPath(new URL('./fixtures/bugfiles/bug-20261114T021258Z-ufzs.json', import.meta.url));

    /** The recorded board: [pinned rope, bucket, balloon, free rope]. */
    function recordedBoard() {
        const file = JSON.parse(readFileSync(UFZS_FIXTURE, 'utf8'));
        const placed = [];
        restorePlacedFromSnapshot(placed, file.runs[0].boardSnapshot);
        return placed;
    }

    it("the reporter's tie click ties the ropes — the knot realizes and survives the token seam", () => {
        const board = recordedBoard();
        const [pinnedRope, , balloon, freeRope] = board;
        const flow = new ConnectFlow();
        flow._mode = 'SANDBOX';

        // The restored free chain rides its SAVED SPAN — the recorded lay
        // (length 86.209 toward endPoint (120.55, 290.06)), not the
        // straight-down hang the pre-fix restore spawned (the divergence
        // verdict, ADR 0006 amendment): the tail sits half a pitch inboard
        // of the saved endPoint, on the anchor→endPoint direction.
        const savedEnd = freeRope.serialize().options.endPoint;
        const tail = freeRope.bodies[freeRope.bodies.length - 1];
        expect(tail.position.x).toBeLessThan(freeRope.bodies[0].position.x - 40); // lays leftward, not straight down
        expect(Math.hypot(tail.position.x - savedEnd.x, tail.position.y - savedEnd.y)).toBeLessThan(8);

        // The reporter's click, through the real flow: seek from the free
        // rope's untied END seat square...
        const freeEndSquare = freeRope.getTieSeats().find((s) => s.role === 'end').worldPoint;
        expect(flow.handlePointerDown(freeEndSquare.x, freeEndSquare.y, board)).toBe(true);
        expect(flow.seek).toEqual({ rope: freeRope, role: 'end' });

        // ...then click the other rope's target square (the pinned rope's
        // tail endpoint; click exactly on the square so the nearest-square
        // tiebreak picks the rope, not the bucket rim 2.75px above it).
        const ropeTarget = pinnedRope.getAttachmentWorldPoint('end');
        flow.setPreview(ropeTarget.x, ropeTarget.y); // the end seek reels the tail to the aim
        expect(flow.handlePointerDown(ropeTarget.x, ropeTarget.y, board)).toBe(true);
        expect(flow.refusal).toBeNull(); // the tie landed — nothing was refused
        expect(freeRope.getAttachmentRefs()).toEqual([
            { seat: 'anchor', target: balloon, pointId: 'knot' },
            { seat: 'end', target: pinnedRope, pointId: 'end' },
        ]);
        expect(pinnedRope.getAttachmentRefs().map((r) => r.pointId)).toEqual(['rim']); // the target side keeps its own knot

        // The knot realizes: one step after play the zero-length link ties
        // both tails — alongside the two knots the recorded board already
        // carried (the free rope's balloon link and the pinned rope's rim link).
        const physics = new PhysicsEngine(1000, 600);
        engines.push(physics);
        for (const obj of board) physics.addObject(obj);
        physics.step(DT);
        const links = physics.getAttachedConstraints();
        expect(links).toHaveLength(3);
        const knotLink = links.find((link) =>
            (link.bodyA === tail || link.bodyB === tail)
            && (link.bodyA === pinnedRope.bodies[pinnedRope.bodies.length - 1]
                || link.bodyB === pinnedRope.bodies[pinnedRope.bodies.length - 1]));
        expect(knotLink).toBeDefined(); // free tail ↔ pinned tail, length 0
        expect(knotLink.length).toBe(0);

        // ...and survives the token seam: the annotator carries the
        // rope-to-rope token, the restore re-binds it, and the re-bound
        // knot re-realizes through the reconcile's inbound pairs (#57).
        const rows = serializePlacedBoard(board);
        expect(rows[3].attachments).toContainEqual({
            seat: 'end', targetType: 'rope', targetOrdinal: 0, pointId: 'end',
        });
        const restored = [];
        restorePlacedFromSnapshot(restored, rows);
        const [pinned2, , balloon2, free2] = restored;
        expect(free2.getAttachmentRefs()).toEqual([
            { seat: 'anchor', target: balloon2, pointId: 'knot' },
            { seat: 'end', target: pinned2, pointId: 'end' },
        ]);
        const physics2 = new PhysicsEngine(1000, 600);
        engines.push(physics2);
        for (const obj of restored) physics2.addObject(obj);
        physics2.step(DT);
        const tail2 = free2.bodies[free2.bodies.length - 1];
        const pinnedTail2 = pinned2.bodies[pinned2.bodies.length - 1];
        expect(physics2.getAttachedConstraints().some((link) =>
            (link.bodyA === tail2 && link.bodyB === pinnedTail2)
            || (link.bodyA === pinnedTail2 && link.bodyB === tail2))).toBe(true);
        for (const obj of board) obj.dispose();
        for (const obj of restored) obj.dispose();
    });

    it('a tie the rope-side gates refuse paints instead of vanishing — no silent refusal (issue #93)', () => {
        const board = recordedBoard();
        const [pinnedRope, , , freeRope] = board;
        const flow = new ConnectFlow();
        flow._mode = 'SANDBOX';

        // Seek from the free rope's untied END seat square.
        const freeEndSquare = freeRope.getTieSeats().find((s) => s.role === 'end').worldPoint;
        flow.handlePointerDown(freeEndSquare.x, freeEndSquare.y, board);
        expect(flow.seek).toEqual({ rope: freeRope, role: 'end' });

        // The rope-side seat gates can still refuse what the flow's aim
        // checks enumerated (a race at the rope's own seam — the occupied
        // and severed gates re-read inside attachEndpoint). Whatever the
        // flow could not land, it must SAY: the refusal paints at the aim,
        // the seek survives, and no knot appears — the click never
        // vanishes silently (the reporter's case).
        const throwRefusal = new Error('[Rope] attachEndpoint: the end seat already holds a knot — one knot per seat');
        const attachSpy = vi.spyOn(freeRope, 'attachEndpoint').mockImplementation(() => {
            throw throwRefusal;
        });
        const ropeTarget = pinnedRope.getAttachmentWorldPoint('end');
        flow.setPreview(ropeTarget.x, ropeTarget.y);
        expect(flow.handlePointerDown(ropeTarget.x, ropeTarget.y, board)).toBe(true);
        expect(attachSpy).toHaveBeenCalled();
        expect(flow.refusal).toMatchObject({ x: ropeTarget.x, y: ropeTarget.y, reason: 'refused' }); // the refused aim paints
        expect(freeRope.getAttachmentRefs().map((r) => r.seat)).toEqual(['anchor']); // no knot landed
        expect(flow.seek).toEqual({ rope: freeRope, role: 'end' }); // the seek survives a refused tie
        for (const obj of board) obj.dispose();
    });
});
