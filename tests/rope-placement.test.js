/**
 * Rope placement — drops simply place (issue #53, ADR 0007 decision 2).
 *
 * A rope or knot-bearing part lands exactly where the hand releases it:
 * nothing ties, nothing is re-layed, nothing is pulled. Ties live only in
 * the explicit click-to-connect flow (tests/connect-flow.test.js). The
 * proximity surface itself — the ROPE_SNAP_RADIUS / ROPE_ATTRACT_RADIUS
 * constants, the DragDropManager placement snap methods, and the snap/attract
 * hint renderers — is gone from the public surface.
 *
 * Seams under test:
 * - DragDropManager._placeObject — the real drop seam: a drop only constructs,
 *   clamps (playfield), and places.
 * - Rope / Renderer / DragDropManager — the removed proximity members stay
 *   removed (and the surviving members were not swept away with them).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import DragDropManager from '../js/ui/DragDropManager.js';
import { eventBus } from '../js/EventBus.js';
import { renderer as _renderer } from '../js/render/Renderer.js';
import * as RopeModule from '../js/objects/Rope.js';
import Rope from '../js/objects/Rope.js';
import Balloon from '../js/objects/Balloon.js';
import Bucket from '../js/objects/Bucket.js';
import { objectRegistry } from '../js/objects/ObjectRegistry.js';
import { toolbox } from '../js/ui/Toolbox.js';

// _placeObject goes through the registry; register just what this file creates.
const ensure = (type, cls) => {
    if (!objectRegistry.has(type)) objectRegistry.register(type, cls, { displayName: type });
};
ensure('rope', Rope);
ensure('balloon', Balloon);
ensure('bucket', Bucket);

/** Fresh drag-drop handler over a stubbed playfield canvas and seeded inventory. */
function makeDropSeam() {
    const ddm = new DragDropManager();
    ddm._enabled = true;
    _renderer.canvas = { width: 800, height: 600 };
    toolbox._inventory = { rope: 6, balloon: 6, bucket: 6 };
    return ddm;
}
function releaseDropSeam() {
    _renderer.canvas = null;
    toolbox._inventory = {};
}

/** Rim offset of a Bucket (same class ⇒ same offset) without guessing coordinates. */
function bucketRimOffset(bucket) {
    const rim = bucket.getAttachmentWorldPoint('rim');
    return { x: rim.x - bucket.x, y: rim.y - bucket.y };
}

describe('A dropped rope simply places (no drop-time tying)', () => {
    let ddm;
    beforeEach(() => {
        ddm = makeDropSeam();
    });
    afterEach(releaseDropSeam);

    it('an endpoint dropped onto an attachment point stays laid-out and untied', () => {
        const balloon = new Balloon(300, 100);
        ddm._objects = [balloon];
        const knot = balloon.getAttachmentWorldPoint('knot');
        // Default-length rope dropped with its anchor landing exactly on the
        // balloon's knot (0px — well inside the old ROPE_SNAP_RADIUS): the
        // spot the old drop matched, snapping the anchor, re-laying the rope
        // onto the point, and tying it (issues 03/04). The drop now simply
        // places: the rope keeps its laid spot (100px straight down from
        // where the hand released it) and ties nothing.
        const drop = { x: knot.x, y: knot.y };

        ddm._placeObject('rope', drop.x, drop.y);

        const rope = ddm._objects.find((o) => o.type === 'rope');
        expect(rope).toBeDefined();
        expect(rope.getAttachmentRefs()).toEqual([]); // the drop ties nothing
        expect(rope.bodies[0].position).toEqual({ x: drop.x, y: drop.y }); // anchor unmoved, still 0px from the knot
        const last = rope.bodies[rope.bodies.length - 1].position;
        expect(last.x).toBeCloseTo(drop.x, 3); // free end kept its laid spot
        expect(last.y).toBeCloseTo(drop.y + (5.5 / 6) * 100, 3);
        balloon.dispose();
        rope.dispose();
    });
    it('a rope dropped across two attachment points ties nothing and re-lays nothing', () => {
        const balloon = new Balloon(300, 100);
        const knot = balloon.getAttachmentWorldPoint('knot');
        // Anchor 10px above the balloon knot; free end (91.67px lower) exactly
        // on a bucket rim — both endpoints inside the old snap radius. The old
        // drop re-layed the rope onto both points and tied both ends.
        const probe = new Bucket(500, 500);
        const rimOffset = bucketRimOffset(probe);
        probe.dispose();
        const drop = { x: knot.x, y: knot.y - 10 };
        const freeEnd = { x: drop.x, y: drop.y + (5.5 / 6) * 100 };
        const bucket = new Bucket(freeEnd.x - rimOffset.x, freeEnd.y - rimOffset.y);
        ddm._objects = [balloon, bucket];

        ddm._placeObject('rope', drop.x, drop.y);

        const rope = ddm._objects.find((o) => o.type === 'rope');
        expect(rope).toBeDefined();
        expect(rope.getAttachmentRefs()).toEqual([]); // neither end ties
        expect(rope.bodies[0].position).toEqual({ x: drop.x, y: drop.y }); // anchor unmoved
        const last = rope.bodies[rope.bodies.length - 1].position;
        expect(last.x).toBeCloseTo(freeEnd.x, 3);
        expect(last.y).toBeCloseTo(freeEnd.y, 3); // free end kept its laid spot
        balloon.dispose();
        bucket.dispose();
        rope.dispose();
    });
    it('placement itself is unchanged: the part joins the board and announces itself', () => {
        const placed = [];
        const stop = eventBus.on('object:placed', (e) => placed.push(e));

        ddm._placeObject('rope', 200, 300);

        stop();
        expect(placed).toHaveLength(1);
        expect(placed[0].type).toBe('rope');
        const rope = ddm._objects.find((o) => o.type === 'rope');
        expect(rope).toBeDefined();
        rope.dispose();
    });
});

describe('A dropped knot-bearing part is never pulled, never tied (no pull-to-tie)', () => {
    let ddm;
    beforeEach(() => {
        ddm = makeDropSeam();
    });
    afterEach(releaseDropSeam);

    it('a balloon dropped within the old attract reach keeps its drop spot and stays untied', () => {
        const rope = new Rope(300, 100, { length: 40 });
        ddm._objects = [rope];
        const end = rope.bodies[rope.bodies.length - 1].position;
        // 40px right of the rope's free end: the knot lands ~47.5px from it —
        // inside the old ROPE_ATTRACT_RADIUS (64), which used to pull the
        // whole drop onto the end and tie it exactly there.
        const drop = { x: end.x + 40, y: end.y };

        ddm._placeObject('balloon', drop.x, drop.y);

        const balloon = ddm._objects.find((o) => o.type === 'balloon');
        expect(balloon).toBeDefined();
        const knot = balloon.getAttachmentWorldPoint('knot');
        expect(Math.hypot(knot.x - end.x, knot.y - end.y)).toBeGreaterThan(0); // nothing pulled it
        expect(rope.getAttachmentRefs()).toEqual([]); // and it ties nothing
        rope.dispose();
        balloon.dispose();
    });
    it('a bucket dropped with its rim on a rope endpoint is not pulled and not tied', () => {
        const rope = new Rope(300, 100, { length: 40 });
        ddm._objects = [rope];
        const end = rope.bodies[rope.bodies.length - 1].position;
        const probe = new Bucket(500, 500);
        const rimOffset = bucketRimOffset(probe);
        probe.dispose();
        // Rim dropped exactly on the rope's free end — the old in-place tie.
        const drop = { x: end.x - rimOffset.x, y: end.y - rimOffset.y };

        ddm._placeObject('bucket', drop.x, drop.y);

        const bucket = ddm._objects.find((o) => o.type === 'bucket');
        expect(bucket).toBeDefined();
        const rim = bucket.getAttachmentWorldPoint('rim');
        expect(Math.hypot(rim.x - end.x, rim.y - end.y)).toBeCloseTo(0, 3); // stayed where dropped
        expect(rope.getAttachmentRefs()).toEqual([]); // tied nothing in place
        rope.dispose();
        bucket.dispose();
    });
});

describe('The proximity surface leaves the code (issue #53, ADR 0007)', () => {
    it('the rope radius constants are gone from the public rope API', () => {
        expect(RopeModule.ROPE_SNAP_RADIUS).toBeUndefined();
        expect(RopeModule.ROPE_ATTRACT_RADIUS).toBeUndefined();
        expect(RopeModule.MIN_ROPE_SPAN).toBeDefined(); // the kept constant was not swept away
    });

    it('the snap/attract hint renderers are gone', () => {
        expect(_renderer._drawRopeSnapHints).toBeUndefined();
        expect(_renderer._drawRopeEndpointHints).toBeUndefined();
        expect(_renderer._drawRopeKnots).toBeDefined(); // knot rings stay (tie visibility)
    });

    it('the placement snapping methods are gone from the drag-drop handler', () => {
        const ddm = new DragDropManager();
        expect(ddm._snapRopeEndpoints).toBeUndefined();
        expect(ddm._snapObjectToRopes).toBeUndefined();
        expect(ddm._readAttachmentPoints).toBeUndefined();
    });
});