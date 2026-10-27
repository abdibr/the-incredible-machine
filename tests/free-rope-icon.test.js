/**
 * Free Rope toolbox icon (issue #55 follow-up): the free-rope toolbox entry
 * must not reuse the pinned rope's icon (nail + hanging strand) — it draws
 * the inert coil instead: three concentric rings like the on-board bundle
 * glyph, plus a loose end, and never the gray nail dot.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { registerAllObjects } from '../js/objects/registerAllObjects.js';
import { objectRegistry } from '../js/objects/ObjectRegistry.js';
import Rope from '../js/objects/Rope.js';

function recordingCtx() {
    const calls = { arc: [], stroke: 0, fill: 0, beginPath: 0 };
    return {
        calls,
        beginPath() { calls.beginPath++; },
        arc(...args) { calls.arc.push(args); },
        stroke() { calls.stroke++; },
        fill() { calls.fill++; },
        moveTo() {},
        quadraticCurveTo() {},
    };
}

beforeAll(() => {
    registerAllObjects();
});

describe('Free Rope toolbox icon', () => {
    it('overrides the pinned rope icon with its own drawing', () => {
        const free = objectRegistry.create('free-rope', 0, 0);
        expect(Object.getPrototypeOf(free).drawToolboxIcon).not.toBe(Rope.prototype.drawToolboxIcon);
        free.dispose();
    });

    it('draws the three-ring coil and a loose end — no nail dot', () => {
        const free = objectRegistry.create('free-rope', 0, 0);
        const ctx = recordingCtx();
        free.drawToolboxIcon(ctx, 36, 36);
        free.dispose();

        expect(ctx.calls.arc).toHaveLength(3); // three concentric rings
        expect(ctx.calls.fill).toBe(0);        // never the gray nail dot
        expect(ctx.calls.stroke).toBeGreaterThanOrEqual(4);
        expect(ctx.calls.stroke).toBe(ctx.calls.beginPath);
    });

    it('pinned rope icon still draws its nail dot (baseline sanity)', () => {
        const pinned = objectRegistry.create('rope', 0, 0);
        const ctx = recordingCtx();
        pinned.drawToolboxIcon(ctx, 36, 36);
        pinned.dispose();
        expect(ctx.calls.fill).toBe(1);
    });
});