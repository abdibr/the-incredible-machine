/**
 * Placement-time rope tying — the visible, drop-based half of issue 04.
 *
 * Seams under test (private but behavior-pinned):
 * - DragDropManager._snapRopeEndpoints — a dropped rope ties each endpoint
 *   to the nearest attachment point within ROPE_SNAP_RADIUS (re-laying it
 *   exactly onto the point); farther endpoints stay unattached and unmoving.
 * - DragDropManager._snapObjectToRopes — a dropped knot-bearing object
 *   (balloon knot, bucket rim) ties any board rope endpoint within
 *   ROPE_SNAP_RADIUS to itself; the laid rope is not re-layed, making tying
 *   order-independent and letting a deleted payload be replaced.
 * - Renderer._drawRopeSnapHints — while a rope hangs on the cursor, every
 *   board attachment point is marked: bright + tie-line when a clamped drop
 *   would tie it, faint dashed otherwise.
 * - Renderer._drawRopeEndpointHints — the object-side mirror: while a
 *   knot-bearing part hangs on the cursor, every board rope endpoint is
 *   marked the same way.
 * - Renderer._drawRopeKnots — post-drop ties stay visible (strengthened ring).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import DragDropManager from '../js/ui/DragDropManager.js';
import { renderer as _renderer } from '../js/render/Renderer.js';
import Renderer from '../js/render/Renderer.js';
import Rope, { ROPE_SNAP_RADIUS } from '../js/objects/Rope.js';
import Balloon from '../js/objects/Balloon.js';
import Bucket from '../js/objects/Bucket.js';

const FAR_POINT_STYLE = 'rgba(122, 106, 38, 0.8)';
const TIED_STYLE = '#2f9e2f';

describe('Drop-time rope tying (DragDropManager._snapRopeEndpoints)', () => {
    let ddm;

    beforeEach(() => {
        ddm = new DragDropManager();
    });

    it('pins each endpoint on an attachment point that lands within the snap radius', () => {
        const balloon = new Balloon(300, 100);
        const bucket = new Bucket(500, 400);
        ddm._objects = [balloon, bucket];

        const knot = balloon.getAttachmentWorldPoint('knot');
        const rim = bucket.getAttachmentWorldPoint('rim');
        // Rope layout fact (Rope constructor): the free-end knot body is the
        // last segment's center, laid (5.5/6) of the span from the anchor —
        // so span the rope so THAT body lands on the rim, anchor on the knot.
        const d = Math.hypot(rim.x - knot.x, rim.y - knot.y);
        const span = (d * 6) / 5.5;
        const rope = new Rope(knot.x, knot.y, {
            length: span,
            endPoint: { x: knot.x + ((rim.x - knot.x) / d) * span, y: knot.y + ((rim.y - knot.y) / d) * span },
        });

        ddm._snapRopeEndpoints(rope);

        expect(rope.getAttachmentRefs()).toHaveLength(2);
        expect(rope.getAttachmentRefs()).toContainEqual({ endpoint: 0, target: balloon, pointId: 'knot' });
        expect(rope.getAttachmentRefs()).toContainEqual({ endpoint: 1, target: bucket, pointId: 'rim' });
        // The matched anchor re-lays exactly onto the point
        expect(rope.bodies[0].position).toEqual({ x: knot.x, y: knot.y });
        rope.dispose();
    });

    it('re-lays a near-miss endpoint exactly onto the attachment point', () => {
        const balloon = new Balloon(300, 100);
        ddm._objects = [balloon];

        const knot = balloon.getAttachmentWorldPoint('knot');
        const rope = new Rope(knot.x + 6, knot.y - 4, { length: 30 }); // 7.2px miss

        ddm._snapRopeEndpoints(rope);

        // The near-miss anchor re-lays onto the point and records the knot;
        // the free end's re-lay position is the rope-chain layout's business
        // (pinned by rope-connector.test.js), not the snap seam's.
        expect(rope.bodies[0].position).toEqual({ x: knot.x, y: knot.y });
        expect(rope.getAttachmentRefs()).toEqual([
            { endpoint: 0, target: balloon, pointId: 'knot' },
        ]);
        rope.dispose();
    });

    it('leaves endpoints farther than the snap radius unattached and unmoving', () => {
        const balloon = new Balloon(300, 100);
        ddm._objects = [balloon];

        const knot = balloon.getAttachmentWorldPoint('knot');
        const ax = knot.x + ROPE_SNAP_RADIUS + 10;
        const rope = new Rope(ax, knot.y, { length: 40 });

        ddm._snapRopeEndpoints(rope);

        expect(rope.getAttachmentRefs()).toEqual([]);
        expect(rope.bodies[0].position.x).toBe(ax); // stayed where dropped
        rope.dispose();
    });

    it('prefers the nearest attachment point when several are in range', () => {
        const near = new Balloon(300, 100);
        const far = new Balloon(340, 100); // its knot sits 40px right of `near`'s
        ddm._objects = [near, far];

        const knot = near.getAttachmentWorldPoint('knot'); // (300, 125.6)
        const rope = new Rope(knot.x + 18, knot.y, { length: 30 }); // 18px / 22px misses

        ddm._snapRopeEndpoints(rope);

        expect(rope.getAttachmentRefs()).toEqual([
            { endpoint: 0, target: near, pointId: 'knot' },
        ]);
        rope.dispose();
    });
});
describe('Rope placement hints (Renderer._drawRopeSnapHints)', () => {
    it('marks a would-be tie bright with a tie-line while the rope hangs on the cursor', () => {
        const balloon = new Balloon(300, 100);
        const knot = balloon.getAttachmentWorldPoint('knot');
        const ghost = new Rope(knot.x, knot.y, { length: 40 });
        const ctx = makeRecordingCtx();

        new Renderer()._drawRopeSnapHints(ctx, [balloon], ghost);

        expect(ctx.strokeStyles).toContain(TIED_STYLE);   // tied: bright green
        expect(ctx.strokeStyles).not.toContain(FAR_POINT_STYLE);
        ghost.dispose();
    });

    it('keeps out-of-range attachment points faint dashed with no tie-line', () => {
        const balloon = new Balloon(300, 100);
        const ghost = new Rope(300, 400, { length: 40 }); // hangs 300px below the knot
        const ctx = makeRecordingCtx();

        new Renderer()._drawRopeSnapHints(ctx, [balloon], ghost);

        expect(ctx.strokeStyles).toContain(FAR_POINT_STYLE);
        expect(ctx.strokeStyles).not.toContain(TIED_STYLE);
        expect(ctx.setLineDash).toHaveBeenCalledWith([3, 3]);
        ghost.dispose();
    });

    it('shows both styles at once when one point is reachable and another is not', () => {
        const near = new Balloon(300, 100);
        const far = new Balloon(300, 500);
        const knot = near.getAttachmentWorldPoint('knot');
        const ghost = new Rope(knot.x, knot.y, { length: 40 });
        const ctx = makeRecordingCtx();

        new Renderer()._drawRopeSnapHints(ctx, [near, far], ghost);

        expect(ctx.strokeStyles).toContain(TIED_STYLE);
        expect(ctx.strokeStyles).toContain(FAR_POINT_STYLE);
        ghost.dispose();
    });
});

describe('Post-drop knot ring (Renderer._drawRopeKnots)', () => {
    it('draws the strengthened ring + solid core on every tied point', () => {
        const balloon = new Balloon(300, 100);
        const rope = new Rope(300, 100, { length: 40 });
        rope.attachEndpoint(1, balloon, 'knot');
        const knot = balloon.getAttachmentWorldPoint('knot');
        const ctx = makeRecordingCtx();

        _renderer._drawRopeKnots(ctx, [rope, balloon]);

        expect(ctx.strokeStyles).toContain('#8a6508');
        const arcs = ctx.arc.mock.calls.map(([x, y, r]) => ({ x, y, r }));
        expect(arcs).toContainEqual({ x: knot.x, y: knot.y, r: 7 });  // ring
        expect(arcs).toContainEqual({ x: knot.x, y: knot.y, r: 2 });  // solid core
        rope.dispose();
    });

    it('skips attachment points nothing is tied to', () => {
        const balloon = new Balloon(300, 100);
        const rope = new Rope(300, 100, { length: 40 }); // no knots
        const ctx = makeRecordingCtx();

        _renderer._drawRopeKnots(ctx, [rope, balloon]);

        expect(ctx.arc).not.toHaveBeenCalled();
        rope.dispose();
    });
});

describe('Object-side placement tying (DragDropManager._snapObjectToRopes)', () => {
    // A balloon's knot rides (0, r · 1.2 + 4) below its body (r = 18 → 25.6):
    // this helper positions a balloon whose knot lands exactly on (x, y).
    const balloonKnotAt = (x, y) => new Balloon(x, y - 25.6);

    let ddm;

    beforeEach(() => {
        ddm = new DragDropManager();
    });

    it('ties a dropped balloon to the free end of an already-placed rope', () => {
        const rope = new Rope(300, 100, { length: 40 });
        const end = rope.bodies[rope.bodies.length - 1].position;
        const balloon = balloonKnotAt(end.x, end.y); // rope placed first, balloon lands on its end
        ddm._objects = [rope, balloon];

        ddm._snapObjectToRopes(balloon);

        expect(rope.getAttachmentRefs()).toEqual([
            { endpoint: 1, target: balloon, pointId: 'knot' },
        ]);
        // The drop does not re-lay the laid rope (the length-0 knot link
        // closes the ≤ ROPE_SNAP_RADIUS residual at the first play step):
        // balloon and rope end stay exactly where they were laid. The knot
        // lands dead-on, so they are coincident here.
        expect(balloon.bodies[0].position).toEqual({
            x: end.x, y: end.y - 25.6,
        });
        rope.dispose();
    });

    it('ties a dropped balloon to the anchor end of an already-placed rope', () => {
        const rope = new Rope(300, 100, { length: 40 });
        const anchor = rope.bodies[0].position;
        const balloon = balloonKnotAt(anchor.x, anchor.y);
        ddm._objects = [rope, balloon];

        ddm._snapObjectToRopes(balloon);

        expect(rope.getAttachmentRefs()).toEqual([
            { endpoint: 0, target: balloon, pointId: 'knot' },
        ]);
        rope.dispose();
    });

    it('works the other way round for a dropped bucket rim too', () => {
        const rope = new Rope(300, 100, { length: 40 });
        const end = rope.bodies[rope.bodies.length - 1].position;
        const probe = new Bucket(0, 0);
        const rimOff = probe.getAttachmentWorldPoint('rim');
        probe.dispose();
        const bucket = new Bucket(end.x - rimOff.x, end.y - rimOff.y); // rim lands on the rope end
        ddm._objects = [rope, bucket];

        ddm._snapObjectToRopes(bucket);

        expect(rope.getAttachmentRefs()).toEqual([
            { endpoint: 1, target: bucket, pointId: 'rim' },
        ]);
        rope.dispose();
    });

    it('leaves rope ends beyond the snap radius untouched', () => {
        const rope = new Rope(300, 100, { length: 40 });
        const anchor = rope.bodies[0].position;
        // Well below the span's midpoint: out of range of BOTH the anchor
        // and the free end (a rope's ends sit within its own length of each
        // other, so a near-miss of one end can still graze the other).
        const balloon = balloonKnotAt(anchor.x + 20, anchor.y + 60);
        ddm._objects = [rope, balloon];

        ddm._snapObjectToRopes(balloon);

        expect(rope.getAttachmentRefs()).toEqual([]);
        rope.dispose();
    });

    it('skips severed ropes — they cannot hold a payload', () => {
        const rope = new Rope(300, 100, { severed: true });
        const anchor = rope.bodies[0].position;
        const balloon = balloonKnotAt(anchor.x, anchor.y);
        ddm._objects = [rope, balloon];

        ddm._snapObjectToRopes(balloon);

        expect(rope.isSevered).toBe(true);
        expect(rope.getAttachmentRefs()).toEqual([]);
        rope.dispose();
    });
    it('knots every in-range rope endpoint — one attachment point holds several ropes', () => {
        const ropeA = new Rope(300, 100, { length: 40 });
        const endA = ropeA.bodies[ropeA.bodies.length - 1].position;
        // Lay ropeB so its free-end body sits 10px right of ropeA's free end
        // (same (6/5.5) span math the drop-time tests pin down).
        const from = { x: endA.x - 60, y: endA.y };
        const target = { x: endA.x + 10, y: endA.y };
        const d = Math.hypot(target.x - from.x, target.y - from.y);
        const span = (d * 6) / 5.5;
        const ropeB = new Rope(from.x, from.y, {
            length: span,
            endPoint: {
                x: from.x + ((target.x - from.x) / d) * span,
                y: from.y + ((target.y - from.y) / d) * span,
            },
        });
        const balloon = balloonKnotAt(endA.x, endA.y); // 0px from ropeA's end, 10px from ropeB's
        ddm._objects = [ropeA, ropeB, balloon];

        ddm._snapObjectToRopes(balloon);

        expect(ropeA.getAttachmentRefs()).toEqual([
            { endpoint: 1, target: balloon, pointId: 'knot' },
        ]);
        expect(ropeB.getAttachmentRefs()).toEqual([
            { endpoint: 1, target: balloon, pointId: 'knot' },
        ]);
        ropeA.dispose();
        ropeB.dispose();
    });

    it('re-ties a rope when the dropped balloon replaces a deleted payload', () => {
        const rope = new Rope(300, 100, { length: 40 });
        const end = rope.bodies[rope.bodies.length - 1].position;
        const first = balloonKnotAt(end.x, end.y);
        ddm._objects = [rope, first];
        ddm._snapObjectToRopes(first);
        expect(rope.getAttachmentRefs()).toEqual([
            { endpoint: 1, target: first, pointId: 'knot' },
        ]);

        // The player deletes that balloon and drops a fresh one at the same spot
        first.dispose();
        const second = balloonKnotAt(end.x, end.y);
        ddm._objects = [rope, second];
        ddm._snapObjectToRopes(second);

        const refs = rope.getAttachmentRefs();
        expect(refs).toContainEqual({ endpoint: 1, target: second, pointId: 'knot' });
        expect(refs).toHaveLength(2); // the dead ref to the disposed balloon lingers in edit
                                      // mode (guarded render/serialize; pruned by the first
                                      // play step) and cannot block the new tie
        rope.dispose();
        second.dispose();
    });
    it('the object-side tie realizes as an engine link on the first play step', async () => {
        const { PhysicsEngine } = await import('../js/engine/PhysicsEngine.js');
        const physics = new PhysicsEngine(800, 600);
        const rope = new Rope(300, 100, { length: 40 });
        const end = rope.bodies[rope.bodies.length - 1].position;
        const balloon = balloonKnotAt(end.x, end.y);
        ddm._objects = [rope, balloon];
        ddm._snapObjectToRopes(balloon);

        physics.addObject(rope);
        physics.addObject(balloon); // addObject adds the rope's own chain constraints too
        physics.step(16.67);

        expect(physics.getAttachedConstraints()).toHaveLength(1);
        const link = physics.getAttachedConstraints()[0];
        expect(link.bodyA).toBe(rope.bodies[rope.bodies.length - 1]);
        expect(link.bodyB).toBe(balloon.bodies[0]);
        expect(link.length).toBe(0);
        expect(link.stiffness).toBe(0.9);
        physics.dispose();
    });
});

describe('Object-side tie hints (Renderer._drawRopeEndpointHints)', () => {
    const balloonKnotAt = (x, y) => new Balloon(x, y - 25.6);

    it('marks a rope end bright with a tie-line while a knot-bearing ghost hangs in reach', () => {
        const rope = new Rope(300, 100, { length: 40 });
        const anchor = rope.bodies[0].position;
        const end = rope.bodies[rope.bodies.length - 1].position;
        const ghost = balloonKnotAt(end.x, end.y); // would tie endpoint 1; the anchor is 40px away
        const knot = ghost.getAttachmentWorldPoint('knot');
        const ctx = makeRecordingCtx();

        new Renderer()._drawRopeEndpointHints(ctx, [rope, ghost], ghost);

        expect(ctx.strokeStyles).toContain(TIED_STYLE);
        const arcs = ctx.arc.mock.calls.map(([x, y, r]) => ({ x, y, r }));
        expect(arcs).toContainEqual({ x: end.x, y: end.y, r: 7 });       // bright on the reachable end
        expect(arcs).toContainEqual({ x: anchor.x, y: anchor.y, r: 4 }); // faint on the far end
        // tie-line runs from the rope end to the ghost's knot
        expect(ctx.moveTo.mock.calls).toContainEqual([end.x, end.y]);
        expect(ctx.lineTo.mock.calls).toContainEqual([knot.x, knot.y]);
        rope.dispose();
    });

    it('marks out-of-reach rope ends faint dashed', () => {
        const rope = new Rope(300, 100, { length: 40 });
        const anchor = rope.bodies[0].position;
        const ghost = balloonKnotAt(anchor.x + 20, anchor.y + 60); // well below the span
        const ctx = makeRecordingCtx();

        new Renderer()._drawRopeEndpointHints(ctx, [rope, ghost], ghost);

        expect(ctx.strokeStyles).toContain(FAR_POINT_STYLE);
        expect(ctx.strokeStyles).not.toContain(TIED_STYLE);
        expect(ctx.setLineDash).toHaveBeenCalledWith([3, 3]);
        rope.dispose();
    });
    it('shows both styles at once when one rope end is reachable and the other is not', () => {
        const rope = new Rope(300, 100, { length: 40 });
        const end = rope.bodies[rope.bodies.length - 1].position;
        const ghost = balloonKnotAt(end.x, end.y); // endpoint 1 in reach, anchor far
        const ctx = makeRecordingCtx();

        new Renderer()._drawRopeEndpointHints(ctx, [rope, ghost], ghost);

        expect(ctx.strokeStyles).toContain(TIED_STYLE);
        expect(ctx.strokeStyles).toContain(FAR_POINT_STYLE);
        rope.dispose();
    });

    it('skips a severed rope entirely', () => {
        const rope = new Rope(300, 100, { severed: true });
        const anchor = rope.bodies[0].position;
        const ghost = balloonKnotAt(anchor.x, anchor.y);
        const ctx = makeRecordingCtx();

        new Renderer()._drawRopeEndpointHints(ctx, [rope, ghost], ghost);

        expect(ctx.arc).not.toHaveBeenCalled();
        rope.dispose();
    });
});

/** Minimal canvas 2D-context stub that records calls (no DOM/canvas in Node). */
function makeRecordingCtx() {
    const ctx = {};
    const strokeStyleLog = [];
    for (const fn of [
        'save', 'restore', 'beginPath', 'moveTo', 'lineTo',
        'arc', 'fill', 'stroke', 'setLineDash',
    ]) {
        ctx[fn] = vi.fn();
    }
    // Rendering code assigns strokeStyle as it goes; keep the whole history
    Object.defineProperty(ctx, 'strokeStyle', {
        set(v) { strokeStyleLog.push(v); },
        get() { return strokeStyleLog[strokeStyleLog.length - 1]; },
    });
    ctx.strokeStyles = strokeStyleLog;
    return ctx;
}