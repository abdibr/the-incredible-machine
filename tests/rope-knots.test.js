/**
 * Post-tie knot visibility (Renderer._drawRopeKnots).
 *
 * The knot ring is how an existing rope tie stays visible on the board. It
 * lives through issue #53's proximity-tying removal (ADR 0007 decision 2):
 * the snap/attract *prediction* hints die, the ring marking ties that
 * actually exist stays.
 *
 * Seam under test (private but behavior-pinned):
 * - Renderer._drawRopeKnots — a live knot draws its strengthened ring on the
 *   attachment point; points nothing is tied to draw nothing.
 *
 * (Contracts moved from tests/rope-snap-hints.test.js when every other
 * proximity contract in it was retired together with the tying itself.)
 */

import { describe, it, expect, vi } from 'vitest';
import { renderer as _renderer } from '../js/render/Renderer.js';
import Rope from '../js/objects/Rope.js';
import Balloon from '../js/objects/Balloon.js';

describe('Post-tie knot ring (Renderer._drawRopeKnots)', () => {
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
        balloon.dispose();
    });

    it('skips attachment points nothing is tied to', () => {
        const balloon = new Balloon(300, 100);
        const rope = new Rope(300, 100, { length: 40 }); // no knots
        const ctx = makeRecordingCtx();

        _renderer._drawRopeKnots(ctx, [rope, balloon]);

        expect(ctx.arc).not.toHaveBeenCalled();
        rope.dispose();
        balloon.dispose();
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