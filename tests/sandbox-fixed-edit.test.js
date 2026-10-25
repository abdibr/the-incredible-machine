/**
 * The state-driven selection handle set (issue #68) — sandbox authoring
 * edits fixed scenery in place.
 *
 * Before: the offered handles and the move/rotate/delete verbs were two
 * parallel hardwired rules — the renderer drew pin-only handles for
 * isFixed parts, while the DragDropManager refused isFixed internally in
 * three separate spots. They had drifted from each other: sandbox
 * authoring could not drag the pinned goal bucket around at all.
 *
 * After: which handles a part offers — and which verbs are accepted — come
 * from one shared table in js/ui/selectionHandles.js (part state × stage
 * posture, issue #67's integration surface): the drawn set = the hit-test
 * set = the accepted verb set, everywhere. Sandbox authoring keeps the
 * full handle set on fixed scenery (dragging a pinned bucket IS the
 * goal-zone authoring move, #66); every other stage leaves a pinned part
 * only its pin handle — the unpin escape hatch.
 *
 * Seams under test (house styles: editor-pin.test.js's fresh seam over the
 * singleton renderer, rope-placement.test.js's private-seam driving):
 * - selectionHandles (policy): classification × posture rows for movable
 *   and pinned parts, including the mode-independent pin escape hatch.
 * - Renderer._getHandlePositions / getHandleAtPoint: drawn + hit-test sets
 *   come from the same policy (slot geometry unchanged: move above, rotate
 *   right, delete left, pin below).
 * - DragDropManager: in SANDBOX a pinned bucket drag-starts on body click
 *   (and via the move/rotate/delete seams), the pose moves while bodies
 *   stay static, and Delete-key / right-click delete it; in EDITING the
 *   same three verbs refuse exactly as they did before the refactor.
 * - The dragged pinned bucket round-trips: serialize() keeps isFixed and
 *   the new pose, Save-shaped rows get stamped as the goal zone by
 *   stampGoalZoneIds, and the shared resolver agrees on the live board.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eventBus } from '../js/EventBus.js';
import { objectRegistry } from '../js/objects/ObjectRegistry.js';
import { registerAllObjects } from '../js/objects/registerAllObjects.js';
import DragDropManager from '../js/ui/DragDropManager.js';
import { renderer as _renderer } from '../js/render/Renderer.js';
import Renderer from '../js/render/Renderer.js';
import {
    DEFAULT_GOAL_ZONE_ID,
    resolveGoalZoneObject,
    stampGoalZoneIds,
} from '../js/goals/GoalChecker.js';
import { SELECTION_HANDLES, partHandleState, selectionHandleSet } from '../js/ui/selectionHandles.js';

registerAllObjects();

/** A placed bucket — the shape `_placeObject` actually creates (not fixed). */
function mkPlacedBucket(x = 300, y = 300) {
    return objectRegistry.create('bucket', x, y);
}

/** Fresh drag-drop seam in a given stage posture (stubbed playfield canvas). */
function makeFixedEditSeam(mode) {
    const ddm = new DragDropManager();
    ddm._enabled = true;
    ddm._mode = mode;
    _renderer.canvas = { width: 800, height: 600 };
    return ddm;
}

describe('The state-driven selection handle set (selectionHandles policy)', () => {
    let bucket;

    beforeEach(() => {
        eventBus.clear();
    });

    afterEach(() => {
        if (bucket) bucket.dispose();
        bucket = null;
    });

    it('classifies part state into handle-table rows', () => {
        bucket = mkPlacedBucket();
        expect(partHandleState(bucket)).toBe('movable');
        bucket.isFixed = true;
        expect(partHandleState(bucket)).toBe('pinned');
    });

    it('a movable part offers the full handle set in every posture', () => {
        bucket = mkPlacedBucket();
        for (const mode of ['SANDBOX', 'EDITING', 'MENU', null]) {
            expect(selectionHandleSet(bucket, mode)).toEqual(SELECTION_HANDLES);
        }
    });

    it('a pinned part keeps everything in sandbox authoring, only pin elsewhere', () => {
        bucket = mkPlacedBucket();
        bucket.isFixed = true;

        expect(selectionHandleSet(bucket, 'SANDBOX')).toEqual(SELECTION_HANDLES);
        for (const mode of ['EDITING', 'MENU', null]) {
            expect(selectionHandleSet(bucket, mode)).toEqual(['pin']);
        }
    });

    it('no selection offers nothing', () => {
        expect(selectionHandleSet(null, 'SANDBOX')).toEqual([]);
    });
});

describe('Renderer: the drawn + hit-tested set comes from the state-driven policy', () => {
    let r;
    let bucket;

    beforeEach(() => {
        eventBus.clear();
        r = new Renderer();
        r.canvas = { width: 800, height: 600 };
        r.hoverPoint = null;
    });

    afterEach(() => {
        if (bucket) bucket.dispose();
        bucket = null;
    });

    it('a movable part draws all four handles at their slots — in any posture', () => {
        bucket = mkPlacedBucket(300, 300);
        const b = bucket.bounds;
        for (const mode of ['SANDBOX', 'EDITING', 'MENU']) {
            r._mode = mode;
            r.selectedObject = bucket;
            expect(r._getHandlePositions(bucket)).toEqual([
                ['move', b.x + b.width / 2, b.y - 14],
                ['rotate', b.x + b.width + 14, b.y + b.height / 2],
                ['delete', b.x - 14, b.y + b.height / 2],
                ['pin', b.x + b.width / 2, b.y + b.height + 14],
            ]);
        }
    });

    it('a pinned bucket keeps its full set while sandbox authoring — and the hit test agrees', () => {
        bucket = mkPlacedBucket(300, 300);
        bucket.isFixed = true;
        r._mode = 'SANDBOX';
        r.selectedObject = bucket;

        const b = bucket.bounds;
        const handles = r._getHandlePositions(bucket);
        expect(handles).toEqual([
            ['move', b.x + b.width / 2, b.y - 14],
            ['rotate', b.x + b.width + 14, b.y + b.height / 2],
            ['delete', b.x - 14, b.y + b.height / 2],
            ['pin', b.x + b.width / 2, b.y + b.height + 14],
        ]);

        // Every offered slot resolves to its own handle under the cursor...
        for (const [name, hx, hy] of handles) {
            expect(r.getHandleAtPoint(hx, hy)).toBe(name);
        }
        // ...and far-away dead air resolves to nothing.
        expect(r.getHandleAtPoint(1e6, 1e6)).toBeNull();
    });

    it('outside sandbox authoring a pinned part keeps only the pin handle', () => {
        bucket = mkPlacedBucket(300, 300);
        bucket.isFixed = true;
        r._mode = 'EDITING';
        r.selectedObject = bucket;

        const b = bucket.bounds;
        const handles = r._getHandlePositions(bucket);
        expect(handles).toEqual([['pin', b.x + b.width / 2, b.y + b.height + 14]]);

        // The refusal is real, not cosmetic: the old move/delete slots are
        // dead air now, the unpin escape hatch stays hit-testable.
        expect(r.getHandleAtPoint(b.x - 14, b.y + b.height / 2)).toBeNull();
        expect(r.getHandleAtPoint(b.x + b.width + 14, b.y + b.height / 2)).toBeNull();
        expect(r.getHandleAtPoint(b.x + b.width / 2, b.y - 14)).toBeNull();
        expect(r.getHandleAtPoint(b.x + b.width / 2, b.y + b.height + 14)).toBe('pin');
    });
});

describe('DragDropManager: sandbox authoring edits fixed scenery, other stages refuse', () => {
    let bucket;

    beforeEach(() => {
        eventBus.clear();
    });

    afterEach(() => {
        if (bucket) bucket.dispose();
        bucket = null;
    });

    /** A pinned bucket selected in the given posture — the #68 subject. */
    function pinnedSelection(mode) {
        const ddm = makeFixedEditSeam(mode);
        bucket = mkPlacedBucket(300, 300);
        ddm._objects = [bucket];
        ddm._selectObject(bucket);
        ddm._togglePinSelected(); // isFixed → true, announces object:pinned
        return ddm;
    }

    it('sandbox authoring drag-starts a pinned bucket on a body click', () => {
        const ddm = pinnedSelection('SANDBOX');

        // The click seam: clicking the body selects AND starts the move —
        // exactly what #66's selectable-but-never-dragged behavior denied.
        const original = _renderer.getObjectAtPoint;
        _renderer.getObjectAtPoint = () => bucket;
        try {
            ddm._onCanvasPointerDown(302, 304);
        } finally {
            _renderer.getObjectAtPoint = original;
        }

        expect(ddm._dragging).toBe(true);
        expect(ddm._dragType).toBe('move');
        expect(ddm._dragObject).toBe(bucket);
    });

    it('the dragged pinned part stays static — its bodies follow the pose', () => {
        const ddm = pinnedSelection('SANDBOX');

        ddm._startMoveObject(300, 300);
        expect(ddm._dragging).toBe(true);
        ddm._dragObject.setPosition(400, 210); // what mousemove would apply

        expect(bucket.isFixed).toBe(true); // the pose moved, not the pinning
        expect(bucket.x).toBe(400);
        expect(bucket.y).toBe(210);
        expect(bucket.bodies.length).toBeGreaterThan(0);
        for (const body of bucket.bodies) {
            expect(body.isStatic).toBe(true); // play-safe: still play-static
        }
    });

    it('sandbox delete accepts a pinned part and announces object:removed', () => {
        const ddm = pinnedSelection('SANDBOX');
        const removed = [];
        const stop = eventBus.on('object:removed', (e) => removed.push({ type: e.type, id: e.id }));

        ddm._deleteSelected();
        stop();

        expect(ddm._objects).not.toContain(bucket);
        expect(removed).toEqual([{ type: 'bucket', id: bucket.id }]);
        expect(ddm._selectedObject).toBeNull();
        bucket = null; // disposed by the delete itself
    });

    it('outside sandbox authoring the same three verbs still refuse', () => {
        const ddm = pinnedSelection('EDITING');

        ddm._onCanvasContextMenu(300, 300); // stubbed hit-test below
        ddm._startMoveObject(300, 300);
        ddm._startRotateObject(300, 300);
        expect(ddm._dragging).toBe(false);
        expect(ddm._dragType).toBeNull();

        keyDelete(ddm);
        expect(ddm._objects).toContain(bucket); // Delete never deletes it here
        expect(ddm._selectedObject).toBe(bucket); // selection survives; only pin remains offered
    });

    it('the Delete key path goes through the same state-driven policy', () => {
        const ddm = pinnedSelection('SANDBOX');

        keyDelete(ddm);

        expect(ddm._objects).not.toContain(bucket);
        bucket = null; // disposed by the delete itself
    });

    it('right-click deletes a pinned part in sandbox authoring alone', () => {
        const ddm = pinnedSelection('SANDBOX');
        const original = _renderer.getObjectAtPoint;
        _renderer.getObjectAtPoint = () => bucket;
        try {
            ddm._onCanvasContextMenu(300, 300);
        } finally {
            _renderer.getObjectAtPoint = original;
        }

        expect(ddm._objects).not.toContain(bucket);
        bucket = null; // disposed by the delete itself
    });

    it('sandbox rotate accepts a pinned selection as a drag', () => {
        const ddm = pinnedSelection('SANDBOX');

        ddm._startRotateObject(300, 300);

        expect(ddm._dragging).toBe(true);
        expect(ddm._dragType).toBe('rotate');
        expect(ddm._dragObject).toBe(bucket);
        // The draggable goal zone never lost its isFixed stamp to begin
        // with — the drag moves the pose, not the pinning.
        expect(bucket.isFixed).toBe(true);
    });

    it('the dragged pinned bucket round-trips: pose + pin survive serialize and the resolver agrees', () => {
        const ddm = pinnedSelection('SANDBOX');

        ddm._startMoveObject(300, 300);
        ddm._dragObject.setPosition(430, 180);
        expect(bucket.x).toBe(430);
        expect(bucket.y).toBe(180);

        // serialize() carries the pin and the new pose — unnamed, so Save
        // names it; the live board resolves to the same object (stamp
        // fallback), exactly what editor-pin.test.js locked for Save.
        const data = bucket.serialize();
        expect(data.isFixed).toBe(true);
        expect(data.x).toBe(430);
        expect(data.y).toBe(180);
        expect(data.id).toBeUndefined();
        stampGoalZoneIds([data]);
        expect(data.id).toBe(DEFAULT_GOAL_ZONE_ID);
        expect(resolveGoalZoneObject(ddm.getObjects(), null, { stampFallback: true })).toBe(bucket);
    });
});

/** Press Delete at the keyboard seam (house style: editor-pin.test.js). */
function keyDelete(ddm) {
    ddm._onKeyDown({ code: 'Delete', target: { tagName: 'CANVAS' }, preventDefault() {} });
}