/**
 * Placement-time rope tying — the visible, drop-based half of issue 04.
 *
 * Seams under test (private but behavior-pinned):
 * - DragDropManager._snapRopeEndpoints — a dropped rope ties each endpoint
 *   to the nearest attachment point within ROPE_SNAP_RADIUS (re-laying it
 *   exactly onto the point); farther endpoints stay unattached and unmoving.
 * - Renderer._drawRopeSnapHints — while a rope hangs on the cursor, every
 *   board attachment point is marked: bright + tie-line when a clamped drop
 *   would tie it, faint dashed otherwise.
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