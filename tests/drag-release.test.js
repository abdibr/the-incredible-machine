/**
 * Drag release — the drop half of a drag that starts on the canvas.
 *
 * Bug (regression from c066611, the C1/issue #75 rope-family refactor): the
 * release handler asked the rope module's `isRopeFamily` without importing
 * it, so every move-drag release threw `ReferenceError` before it could
 * clear the drag state. The part stayed `_dragging` with `_dragType ===
 * 'move'` — glued to the cursor, and clicking to put it down did nothing
 * (only right-click delete got rid of it). A toolbox placement never
 * reached that branch, which is why dropping *new* parts kept working.
 * Nothing caught it: no test drove the release path at all, and at runtime
 * the throw surfaced only as a console error.
 *
 * Seams under test (house styles: rope-placement.test.js's stubbed playfield
 * canvas and seeded inventory, sandbox-fixed-edit.test.js's private-seam
 * driving): DragDropManager._endDrag — the release the global `mouseup`
 * listener delegates to, covering all three drag kinds, the "nothing in
 * flight" no-op, and the always-clear contract that makes a stuck drag
 * impossible.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eventBus } from '../js/EventBus.js';
import { objectRegistry } from '../js/objects/ObjectRegistry.js';
import { registerAllObjects } from '../js/objects/registerAllObjects.js';
import DragDropManager from '../js/ui/DragDropManager.js';
import { renderer as _renderer } from '../js/render/Renderer.js';
import { toolbox } from '../js/ui/Toolbox.js';

registerAllObjects();

/** Playfield canvas stub: page coordinates map 1:1 onto canvas coordinates. */
const CANVAS = {
    width: 800,
    height: 600,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
};

/** Fresh drag-drop handler over the stubbed playfield, in the edit stage. */
function makeReleaseSeam() {
    const ddm = new DragDropManager();
    ddm._enabled = true;
    ddm._mode = 'EDITING';
    _renderer.canvas = CANVAS;
    return ddm;
}

/** Put a part on the board and take it into a move drag, as a canvas press does. */
function grabForMove(ddm, part, x = 300, y = 300) {
    ddm._objects = [part];
    ddm._selectObject(part);
    ddm._startMoveObject(x, y);
    expect(ddm._dragging).toBe(true);
    expect(ddm._dragType).toBe('move');
}

/** A rope tied to a balloon, held in a move drag — the rope-family release case. */
function grabTiedRope(ddm) {
    const rope = objectRegistry.create('rope', 300, 100);
    const balloon = objectRegistry.create('balloon', 420, 260);
    rope.attachEndpoint(2, balloon, 'knot');
    grabForMove(ddm, rope, 300, 100);
    return { rope, balloon };
}

/**
 * The contract every release must leave behind: nothing held, no stale kind,
 * no borrowed reference to the part. A drag that survives a release is the
 * bug this suite exists for.
 */
function expectDragCleared(ddm) {
    expect(ddm._dragging).toBe(false);
    expect(ddm._dragType).toBeNull();
    expect(ddm._dragObjType).toBeNull();
    expect(ddm._dragObject).toBeNull();
}

describe('Drag release — the drop half of a drag', () => {
    /** @type {Array<{dispose: () => void}>} */
    let parts;
    let savedCanvas;
    let savedInventory;
    let savedSandbox;

    beforeEach(() => {
        eventBus.clear();
        parts = [];
        savedCanvas = _renderer.canvas;
        savedInventory = toolbox._inventory;
        savedSandbox = toolbox._isSandbox;
    });

    afterEach(() => {
        for (const part of parts) part.dispose();
        parts.length = 0;
        _renderer.canvas = savedCanvas;
        _renderer.selectedObject = null;
        toolbox._inventory = savedInventory;
        toolbox._isSandbox = savedSandbox;
    });

    it('releases a moved part: the pose is announced and the drag state clears', () => {
        const ddm = makeReleaseSeam();
        const bucket = objectRegistry.create('bucket', 300, 300);
        parts.push(bucket);
        grabForMove(ddm, bucket);

        bucket.setPosition(420, 200); // what the mousemove branch does
        const moved = [];
        const stop = eventBus.on('object:moved', (e) => moved.push(e));

        ddm._endDrag(420, 200);
        stop();

        expect(moved).toEqual([{ id: bucket.id, x: 420, y: 200 }]);
        expectDragCleared(ddm);
    });

    it('releases a moved rope-family part without throwing, and unties its knots', () => {
        const ddm = makeReleaseSeam();
        const { rope, balloon } = grabTiedRope(ddm);
        parts.push(rope, balloon);
        expect(rope.getAttachmentRefs()).toHaveLength(1); // a tied knot to drag off its point

        // The regression: this used to throw `ReferenceError: isRopeFamily is
        // not defined` (no import), aborting the release before the state
        // reset — the rope then tracked the cursor forever.
        expect(() => ddm._endDrag(360, 180)).not.toThrow();

        expect(rope.getAttachmentRefs()).toEqual([]); // untied at release (issue 04)
        expectDragCleared(ddm);
    });

    it('releases a rotated part: the final angle is announced and the drag state clears', () => {
        const ddm = makeReleaseSeam();
        const bucket = objectRegistry.create('bucket', 300, 300);
        parts.push(bucket);
        ddm._objects = [bucket];
        ddm._selectObject(bucket);
        ddm._startRotateObject(300, 300);
        expect(ddm._dragType).toBe('rotate');

        bucket.setAngle(Math.PI / 4);
        const rotated = [];
        const stop = eventBus.on('object:rotated', (e) => rotated.push(e));

        ddm._endDrag(400, 300);
        stop();

        expect(rotated).toEqual([{ id: bucket.id, angle: bucket.angle }]);
        expectDragCleared(ddm);
    });

    it('releases a toolbox drag by placing the part at the release point, then clears', () => {
        const ddm = makeReleaseSeam();
        toolbox._isSandbox = false; // player posture: a counted inventory
        toolbox._inventory = { bucket: 6 };
        ddm._dragging = true;
        ddm._dragType = 'toolbox';
        ddm._dragObjType = 'bucket';

        const placed = [];
        const ghostCleared = [];
        const stopPlaced = eventBus.on('object:placed', (e) => placed.push(e));
        const stopGhost = eventBus.on('drag:ghost-clear', () => ghostCleared.push(true));

        ddm._endDrag(420, 200);
        stopPlaced();
        stopGhost();

        expect(placed).toHaveLength(1);
        expect(placed[0].type).toBe('bucket');
        expect(ddm._objects).toHaveLength(1);
        parts.push(ddm._objects[0]);
        expect(ddm._objects[0].x).toBeCloseTo(420, 6);
        expect(ddm._objects[0].y).toBeCloseTo(200, 6);
        expect(ghostCleared).toHaveLength(1);
        expectDragCleared(ddm);
    });

    it('a release with nothing in flight is a no-op', () => {
        const ddm = makeReleaseSeam();

        expect(() => ddm._endDrag(420, 200)).not.toThrow();
        expectDragCleared(ddm);
        expect(ddm._objects).toHaveLength(0);
    });

    it('clears the drag state even when the release body throws — no stuck drag', () => {
        const ddm = makeReleaseSeam();
        const { rope, balloon } = grabTiedRope(ddm);
        parts.push(rope, balloon);
        rope.clearAttachments = () => {
            throw new Error('boom');
        };

        expect(() => ddm._endDrag(360, 180)).toThrow('boom');

        // The failure still surfaces, but the release lets go: the part can be
        // picked up again instead of following the cursor with no way to drop it.
        expectDragCleared(ddm);
    });
});
