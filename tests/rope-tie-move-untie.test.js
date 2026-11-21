/**
 * Moving a tied target unties, symmetrically - GitHub issue #98
 * (Implementation Decision 3 of the rope-ties group spec).
 *
 * The drop-release untie covered dragged ROPES only: the move-release in
 * js/ui/DragDropManager called clearAttachments on a rope-family part. A
 * dragged TARGET that bears a knot stranded its rope - the headless probe
 * carried a tied bucket 300px and measured knot move 300.0px against rope
 * move 0.0px - and the play-start yank repeated at 300px. Decision 3
 * extends the same policy to the target side: releasing a move-drag of a
 * knot-bearing part clears exactly the knots that bear on it, through the
 * rope's own per-knot untie seam (detachEndpoint - the same feedback path
 * the reconcile's link release already answers), and the rope's other
 * knots - other seats, other targets - are unmoved by the clear. Rope
 * targets keep their current handling (a dragged rope-family part is the
 * shipped rope-drag case; rope-to-rope policy is out of scope here).
 *
 * Seams under test:
 * - DragDropManager._endDrag - the release the global mouseup listener
 *   delegates to (the same seam drag-release.test.js drives).
 * - Rope.getAttachmentRefs / detachEndpoint - the per-knot untie the
 *   release rides; the physical link drops on the next reconcile step.
 *
 * Companion suites: drag-release (the rope-side release contract),
 * rope-ties (per-knot untie, ADR 0007 decision 8), rope-tie-reseat (the
 * tie-side half of issue #98).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eventBus } from '../js/EventBus.js';
import DragDropManager from '../js/ui/DragDropManager.js';
import { renderer as _renderer } from '../js/render/Renderer.js';
import Rope from '../js/objects/Rope.js';
import Bucket from '../js/objects/Bucket.js';
import Balloon from '../js/objects/Balloon.js';
import { PhysicsEngine } from '../js/engine/PhysicsEngine.js';
import { registerAllObjects } from '../js/objects/registerAllObjects.js';

registerAllObjects();

const DT = 1000 / 60;
const engines = [];

/** Playfield canvas stub: page coordinates map 1:1 onto canvas coordinates. */
const CANVAS = {
    width: 800,
    height: 600,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
};

/** The two-knot rig the release policy reads: a rope pinned mid to bucket
 * A (the dragged target) with its end knot carried by the balloon. */
function makeTwoKnotRig({ fixedTarget = false } = {}) {
    const rope = new Rope(100, 100, { length: 420 }); // 11 segments
    const bucketA = new Bucket(200, 180, fixedTarget ? { isFixed: true } : {});
    const balloon = new Balloon(300, 280);
    rope.attachEndpoint('mid', bucketA, 'rim');
    rope.attachEndpoint('end', balloon, 'knot');
    return { rope, bucketA, balloon };
}

function makeReleaseSeam(objects, mode = 'EDITING') {
    const ddm = new DragDropManager();
    ddm._enabled = true;
    ddm._mode = mode;
    _renderer.canvas = CANVAS;
    ddm._objects = [...objects];
    return ddm;
}

/** Take the dragged part into a move drag, as a canvas press does. */
function grabForMove(ddm, part) {
    ddm._selectObject(part);
    ddm._startMoveObject(part.x, part.y);
    expect(ddm._dragging).toBe(true);
    expect(ddm._dragType).toBe('move');
}

describe('Moving a tied target unties, symmetrically (issue #98)', () => {
    let savedCanvas;

    beforeEach(() => {
        eventBus.clear();
        savedCanvas = _renderer.canvas;
    });

    afterEach(() => {
        for (const engine of engines) engine.dispose();
        engines.length = 0;
        _renderer.canvas = savedCanvas;
        _renderer.selectedObject = null;
    });

    it('releasing a move-drag of a tied target clears the knots it bears via the rope-side per-knot untie, and the other knots are unmoved', () => {
        const { rope, bucketA, balloon } = makeTwoKnotRig(); // the ticket's case: a movable target
        try {
            expect(rope.getAttachmentRefs().map((r) => r.seat)).toEqual(['mid', 'end']);
            const endSeat = rope.getTieSeats().find((s) => s.role === 'end');
            const endSquare = { x: endSeat.worldPoint.x, y: endSeat.worldPoint.y };

            const ddm = makeReleaseSeam([rope, bucketA, balloon]);
            grabForMove(ddm, bucketA);
            bucketA.setPosition(360, 420); // what the mousemove branch does
            ddm._endDrag(360, 420);

            // Exactly the knots INTO the dragged target cleared - the end
            // knot (another target, another seat) survives in place.
            expect(rope.getAttachmentRefs()).toEqual([{ seat: 'end', target: balloon, pointId: 'knot' }]);
            const endSquareAfter = rope.getTieSeats().find((s) => s.role === 'end').worldPoint;
            expect(endSquareAfter.x).toBe(endSquare.x); // the clear moved nothing
            expect(endSquareAfter.y).toBe(endSquare.y);
        } finally {
            rope.dispose();
            bucketA.dispose();
            balloon.dispose();
        }
    });

    it('the release rides the reconcile: the dragged knot link drops on the next step, the surviving knot keeps its realized link', () => {
        const engine = new PhysicsEngine(800, 600);
        engines.push(engine);
        // The probe's scenario: a fixed target, dragged in sandbox
        // authoring - the same policy line must answer it.
        const { rope, bucketA, balloon } = makeTwoKnotRig({ fixedTarget: true });
        try {
            engine.addObject(rope);
            engine.addObject(bucketA);
            engine.addObject(balloon);
            engine.step(DT);
            expect(engine.getAttachedConstraints()).toHaveLength(2); // both knots realized

            const ddm = makeReleaseSeam([rope, bucketA, balloon], 'SANDBOX');
            grabForMove(ddm, bucketA);
            bucketA.setPosition(360, 420);
            ddm._endDrag(360, 420);
            engine.step(DT); // the drop-scan reconcile

            expect(engine.getAttachedConstraints()).toHaveLength(1); // one knot left
            const link = engine.getAttachedConstraints()[0];
            expect(link.bodyB).toBe(balloon.bodies[0]); // the end knot's payload side
            expect(link.bodyA).toBe(rope.bodies[rope.bodies.length - 1]); // the end seat's own body
        } finally {
            rope.dispose();
            bucketA.dispose();
            balloon.dispose();
        }
    });
});