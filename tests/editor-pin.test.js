/**
 * Editor pin affordance (issue #66 follow-up): a from-scratch sandbox level
 * could not be winnable because nothing ever created a fixed bucket —
 * `_placeObject` builds movable parts, and the goal-zone warning ("no bucket
 * on the board can be the goal zone, so the saved level cannot be won")
 * could therefore never clear. The fix ships an explicit pin affordance —
 * a 📌 selection handle / P key toggling the object's isFixed — plus a
 * plain-language notice that says what the pin did to the goal, decided by
 * the shared resolver (resolveGoalZoneObject) so the notice, the readout,
 * the field's GOAL marker and Save can never disagree.
 *
 * Seams under test:
 * - DragDropManager._togglePinSelected: a placement-shaped (non-fixed, the
 *   live `object:placed` path) object pins and unpins, announcing
 *   `object:pinned`; the pinned bucket ends up exactly what Save stamps;
 *   pinned objects stay selectable (the unpin path), Delete still refuses.
 * - Renderer: a movable part offers move/rotate/delete + pin handles, a
 *   pinned one only pin (the others would be isFixed-refused no-ops).
 * - EditorPanel: pinning the zone bucket says "this is the goal zone" and
 *   clears the readout warning; a decoy pin never claims the zone;
 *   unimplemented goal types get no zone claim; sandbox entry resets to
 *   the standing tip.
 * - SessionRecorder: `object:pinned` is a narrative build row.
 *
 * Harnesses follow the repo's house styles: rope-placement.test.js for the
 * DragDropManager seam (fresh manager over the singleton renderer) and
 * editor-goal.test.js for the fake-DOM EditorPanel.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eventBus } from '../js/EventBus.js';
import { objectRegistry } from '../js/objects/ObjectRegistry.js';
import { registerAllObjects } from '../js/objects/registerAllObjects.js';
import DragDropManager from '../js/ui/DragDropManager.js';
import { dragDropManager } from '../js/ui/DragDropManager.js';
import { renderer as _renderer } from '../js/render/Renderer.js';
import Renderer from '../js/render/Renderer.js';
import {
    DEFAULT_GOAL_ZONE_ID,
    resolveGoalZoneObject,
    stampGoalZoneIds,
} from '../js/goals/GoalChecker.js';
import { SessionRecorder } from '../js/recorder/SessionRecorder.js';

registerAllObjects();

/** A placed bucket — the shape `_placeObject` actually creates (not fixed). */
function mkPlacedBucket(x = 300, y = 300) {
    return objectRegistry.create('bucket', x, y);
}

/** Fresh drag-drop seam over a stubbed playfield canvas (rope-placement style). */
function makePinSeam() {
    const ddm = new DragDropManager();
    ddm._enabled = true;
    _renderer.canvas = { width: 800, height: 600 };
    return ddm;
}

// ── The pin affordance (DragDropManager seam) ─────────────────────

describe('The pin affordance (issue #66 follow-up)', () => {
    let ddm;
    let bucket;

    beforeEach(() => {
        eventBus.clear();
        ddm = makePinSeam();
        bucket = mkPlacedBucket();
        ddm._objects = [bucket];
        ddm._selectObject(bucket);
    });

    afterEach(() => {
        bucket.dispose();
        _renderer.canvas = null;
        _renderer.selectedObject = null;
    });

    it('pins a placed bucket: isFixed flips and object:pinned announces it', () => {
        const pinned = [];
        const stop = eventBus.on('object:pinned', (e) => pinned.push(e));

        ddm._togglePinSelected();

        expect(bucket.isFixed).toBe(true);
        expect(pinned).toHaveLength(1);
        expect(pinned[0]).toEqual({ type: 'bucket', id: bucket.id, isFixed: true, object: bucket });
        expect(ddm._selectedObject).toBe(bucket); // stays selected for further edits
        stop();
    });

    it('the pinned bucket is exactly what Save stamps as the goal zone', () => {
        ddm._togglePinSelected();

        // The shared resolver (readout, GOAL marker, Save) now resolves to it.
        expect(resolveGoalZoneObject(ddm.getObjects(), null, { stampFallback: true })).toBe(bucket);
        // serialize() carries the pin — it lands in _saveLevel's fixedObjects.
        const data = bucket.serialize();
        expect(data.isFixed).toBe(true);
        expect(data.id).toBeUndefined(); // unnamed → the stamp names it
        stampGoalZoneIds([data]);
        expect(data.id).toBe(DEFAULT_GOAL_ZONE_ID);
    });
    it('the same affordance unpins — the zone resolves to nothing again', () => {
        ddm._togglePinSelected();
        expect(bucket.isFixed).toBe(true);

        const pins = [];
        const stop = eventBus.on('object:pinned', (e) => pins.push({ isFixed: e.isFixed, id: e.id }));
        ddm._togglePinSelected();
        stop();

        expect(pins[0]).toEqual({ isFixed: false, id: bucket.id });
        expect(bucket.isFixed).toBe(false);
        expect(resolveGoalZoneObject(ddm.getObjects(), null, { stampFallback: true })).toBeNull();
    });

    it('non-bucket parts pin too — and never offer a goal zone', () => {
        const ramp = objectRegistry.create('ramp', 300, 200);
        ddm._objects = [bucket, ramp];
        ddm._selectObject(ramp);

        ddm._togglePinSelected();

        expect(ramp.isFixed).toBe(true);
        expect(resolveGoalZoneObject(ddm.getObjects(), null, { stampFallback: true })).toBeNull();
        ramp.dispose();
    });

    it('clicking the pin handle toggles the selection through the pointer-down seam', () => {
        const original = _renderer.getHandleAtPoint;
        _renderer.getHandleAtPoint = () => 'pin';
        try {
            ddm._onCanvasPointerDown(400, 200);
            expect(bucket.isFixed).toBe(true);

            ddm._onCanvasPointerDown(400, 200);
            expect(bucket.isFixed).toBe(false);
        } finally {
            _renderer.getHandleAtPoint = original;
        }
    });

    it('a pinned bucket stays selectable — clicking it selects, never drags', () => {
        ddm._togglePinSelected();

        const original = _renderer.getObjectAtPoint;
        _renderer.getObjectAtPoint = () => bucket;
        try {
            ddm._selectObject(null);
            ddm._onCanvasPointerDown(300, 300);
        } finally {
            _renderer.getObjectAtPoint = original;
        }

        expect(ddm._selectedObject).toBe(bucket); // no longer kicked off
        expect(ddm._dragging).toBe(false); // and no move started
        ddm._togglePinSelected();
        expect(bucket.isFixed).toBe(false);
    });

    it('Key P pins and unpins; Delete never deletes a pinned part', () => {
        const key = (code) => ddm._onKeyDown({ code, target: { tagName: 'CANVAS' }, preventDefault() {} });

        key('KeyP');
        expect(bucket.isFixed).toBe(true);
        key('KeyP');
        expect(bucket.isFixed).toBe(false);

        key('KeyP');
        key('Delete');
        expect(ddm._objects).toContain(bucket); // unpin first, then delete
        expect(bucket.isFixed).toBe(true);
    });

    it('a pin with no selection is a quiet no-op', () => {
        ddm._selectObject(null);

        expect(() => ddm._togglePinSelected()).not.toThrow();
        expect(bucket.isFixed).toBe(false);
    });
});

// ── The pin selection handle (Renderer) ───────────────────────────

describe('The pin selection handle (Renderer)', () => {
    let bucket;

    beforeEach(() => {
        eventBus.clear();
        bucket = mkPlacedBucket(400, 300);
    });

    afterEach(() => bucket.dispose());

    it('a movable part offers move/rotate/delete plus pin — pin at the bottom-center', () => {
        const r = new Renderer();
        r.selectedObject = bucket;

        const handles = r._getHandlePositions(bucket);
        expect(handles.map(([name]) => name)).toEqual(['move', 'rotate', 'delete', 'pin']);
        const [pinX, pinY] = handles[3].slice(1);
        expect(pinX).toBe(bucket.bounds.x + bucket.bounds.width / 2);
        expect(pinY).toBe(bucket.bounds.y + bucket.bounds.height + 14);
        expect(r.getHandleAtPoint(pinX, pinY)).toBe('pin');
    });

    it('a pinned part offers ONLY the pin handle — the others would be no-ops', () => {
        bucket.isFixed = true;
        const r = new Renderer();
        r.selectedObject = bucket;

        const handles = r._getHandlePositions(bucket);
        expect(handles.map(([name]) => name)).toEqual(['pin']);
        expect(r.getHandleAtPoint(handles[0][1], handles[0][2])).toBe('pin');
    });

    it('the pin handle draws with its own color and the 📌 glyph', () => {
        bucket.isFixed = true;
        const r = new Renderer();
        r.selectedObject = bucket;
        const ctx = makeDrawCtx();

        r._drawSelectionHandles(ctx, bucket);

        expect(r.HANDLE_COLORS.pin).toBeDefined();
        expect(r.HANDLE_COLORS.pin).not.toBe(r.HANDLE_COLORS.move);
        const glyph = ctx.fillText.mock.calls.find((c) => c[0] === '📌');
        expect(glyph).toBeDefined();
    });
});

// ── ctx mock (editor-goal.test.js house style) ────────────────────

function makeDrawCtx() {
    const ctx = {};
    for (const fn of [
        'save', 'restore', 'beginPath', 'moveTo', 'lineTo',
        'arc', 'fillRect', 'strokeRect', 'fill', 'stroke', 'setLineDash',
        'fillText',
    ]) {
        ctx[fn] = vi.fn();
    }
    ctx.fillStyle = undefined;
    ctx.strokeStyle = undefined;
    return ctx;
}

// ── The pin notice (EditorPanel) ──────────────────────────────────

/**
 * Minimal DOM fake with children, listeners and attribute storage so the
 * panel can be built and its controls driven directly from tests
 * (editor-goal.test.js house style).
 */
function fakeNode(tag, id = '') {
    const classes = new Set();
    const children = [];
    const handlers = {};
    const node = {
        tagName: String(tag).toUpperCase(),
        id,
        textContent: '',
        className: '',
        type: '',
        value: '',
        checked: false,
        disabled: false,
        placeholder: '',
        title: '',
        attrs: {},
        style: {},
        parentNode: null,
        classList: {
            add: (...c) => c.forEach((x) => classes.add(x)),
            remove: (...c) => c.forEach((x) => classes.delete(x)),
            contains: (c) => classes.has(c),
            toggle: (c, force) => {
                const on = force === undefined ? !classes.has(c) : !!force;
                if (on) classes.add(c); else classes.delete(c);
                return on;
            },
        },
        children,
        appendChild(child) {
            child.parentNode = node;
            children.push(child);
            return child;
        },
        remove() {
            if (node.parentNode) {
                const idx = node.parentNode.children.indexOf(node);
                if (idx !== -1) node.parentNode.children.splice(idx, 1);
            }
        },
        setAttribute(k, v) { node.attrs[k] = String(v); },
        getAttribute(k) { return node.attrs[k] ?? null; },
        addEventListener(type, fn) { (handlers[type] ??= []).push(fn); },
        removeEventListener() {},
        /** Fire the fake node's captured listeners directly. */
        emit(type, ev) {
            for (const fn of handlers[type] ?? []) fn(ev);
        },
        click() { node.emit('click'); },
        focus() {},
        set innerHTML(_v) { children.length = 0; },
        get innerHTML() { return ''; },
    };
    return node;
}

/** Stub the boot-guard DOM globals, then return a fresh EditorPanel instance. */
async function makeFreshPanel() {
    const container = fakeNode('div', 'editor-overlay');
    vi.stubGlobal('document', {
        readyState: 'loading',
        addEventListener: vi.fn(),
        getElementById: (id) => (id === 'editor-overlay' ? container : null),
        createElement: (tag) => fakeNode(tag),
        createTextNode: (t) => ({ textContent: t, children: [] }),
    });
    vi.stubGlobal('window', { addEventListener: vi.fn() });
    vi.stubGlobal('requestAnimationFrame', vi.fn());
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    const { default: EditorPanel } = await import('../js/ui/EditorPanel.js');
    const panel = new EditorPanel();
    panel.init();
    eventBus.emit('mode:changed', { oldMode: 'MENU', newMode: 'SANDBOX' });
    return panel;
}

describe('The pin notice (EditorPanel, issue #66 follow-up)', () => {
    let panel;

    beforeEach(async () => {
        eventBus.clear();
        dragDropManager._objects = [];
        panel = await makeFreshPanel();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('pinning a bucket says it is the goal zone — the readout warning clears', () => {
        const bucket = mkPlacedBucket(500, 500);
        dragDropManager._objects = [bucket];
        dragDropManager._selectObject(bucket);

        dragDropManager._togglePinSelected(); // the real seam → event → panel

        expect(panel._pinNotice.textContent).toContain('This bucket is the goal zone');
        expect(panel._pinNotice.textContent).toContain('GOAL');
        const readout = panel._goalReadout.textContent;
        expect(readout).toContain('Save Level will use');
        expect(readout).toContain('bucket marked GOAL');
        expect(readout).not.toContain('cannot be won');
        bucket.dispose();
    });

    it('unpinning the only bucket flips the readout back to the warning', () => {
        const bucket = mkPlacedBucket(500, 500);
        dragDropManager._objects = [bucket];
        dragDropManager._selectObject(bucket);
        dragDropManager._togglePinSelected();
        dragDropManager._togglePinSelected();

        expect(panel._pinNotice.textContent).toContain('unpinned');
        expect(panel._pinNotice.textContent).toContain('Pin a bucket to make it the goal');
        expect(panel._goalReadout.textContent).toContain('cannot be won');
        bucket.dispose();
    });

    it('a decoy pin never claims the zone — the first pinned bucket keeps it', () => {
        const first = mkPlacedBucket(200, 200);
        const decoy = mkPlacedBucket(700, 200);
        dragDropManager._objects = [first, decoy];

        dragDropManager._selectObject(first);
        dragDropManager._togglePinSelected(); // first board row → the zone
        dragDropManager._selectObject(decoy);
        dragDropManager._togglePinSelected(); // decoy → NOT the zone

        expect(panel._pinNotice.textContent).toContain('Bucket pinned');
        expect(panel._pinNotice.textContent).toContain('but the goal zone is the bucket marked GOAL');
        expect(panel._pinNotice.textContent).not.toContain('This bucket is the goal zone');
        first.dispose();
        decoy.dispose();
    });

    it('pinning a non-bucket part is play-static news — the warning stays honest', () => {
        const ramp = objectRegistry.create('ramp', 300, 200);
        dragDropManager._objects = [ramp];
        dragDropManager._selectObject(ramp);

        dragDropManager._togglePinSelected();

        expect(panel._pinNotice.textContent).toContain('Ramp pinned');
        expect(panel._pinNotice.textContent).toContain('Save Level will include it');
        expect(panel._goalReadout.textContent).toContain('cannot be won'); // still no bucket
        ramp.dispose();
    });

    it('a bucket pinned under an imported unimplemented goal makes no zone claim', () => {
        panel._applyLoadedLevel({
            id: 'imported', name: 'Imported', description: '', difficulty: 1,
            goal: { type: 'mouse_in_zone', targetType: 'mouse', zoneId: 'mouse-zone' },
            fixedObjects: [], availableParts: {}, hints: [],
        });
        const bucket = mkPlacedBucket(500, 500);
        dragDropManager._objects = [bucket];
        dragDropManager._selectObject(bucket);

        dragDropManager._togglePinSelected();

        expect(panel._pinNotice.textContent).toContain('Bucket pinned');
        expect(panel._pinNotice.textContent).not.toContain('goal zone');
        bucket.dispose();
    });

    it('sandbox re-entry resets the notice to the standing pin tip', () => {
        const bucket = mkPlacedBucket(500, 500);
        dragDropManager._objects = [bucket];
        dragDropManager._selectObject(bucket);
        dragDropManager._togglePinSelected();
        expect(panel._pinNotice.textContent).toContain('This bucket is the goal zone');

        eventBus.emit('mode:changed', { oldMode: 'SANDBOX', newMode: 'EDITING' });
        eventBus.emit('mode:changed', { oldMode: 'EDITING', newMode: 'SANDBOX' });

        expect(panel._pinNotice.textContent).toContain('Tip:');
        expect(panel._pinNotice.textContent).toContain('📌');
        bucket.dispose();
    });
});

// ── object:pinned in the bug-file build trace (ADR 0006) ──────────

describe('object:pinned in the bug-file build trace', () => {
    beforeEach(() => {
        eventBus.clear();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('a pin toggle records a narrative build row with the new snapshot', () => {
        const recorder = new SessionRecorder();
        recorder.init({
            getBoard: () => [],
            getPlayfield: () => ({ width: 1000, height: 600 }),
            getEngineInfo: () => ({ gravityX: 0, gravityY: 1, enableSleeping: true }),
        });
        eventBus.emit('mode:changed', { oldMode: 'MENU', newMode: 'SANDBOX' });

        // The real pin seam while the recorder is armed — exactly what a
        // sandbox visit produces.
        const ddm = makePinSeam();
        const bucket = mkPlacedBucket(300, 300);
        ddm._objects = [bucket];
        ddm._selectObject(bucket);
        ddm._togglePinSelected();

        const doc = recorder.toJSON();
        expect(doc.build[0].topic).toBe('mode:changed'); // visit-start row
        expect(doc.build[1].topic).toBe('object:pinned');
        expect(doc.build[1].data.ref).toBe(`bucket#${bucket.id}`);
        expect(doc.build[1].data.type).toBe('bucket');
        expect(doc.build[1].data.isFixed).toBe(true);
        expect(doc.build[1].data.snapshot.type).toBe('bucket');
        expect(doc.build[1].data.snapshot.isFixed).toBe(true);
        bucket.dispose();
        ddm._objects = [];
        _renderer.canvas = null;
        _renderer.selectedObject = null;

        eventBus.emit('mode:changed', { oldMode: 'SANDBOX', newMode: 'MENU' });
    });
});

// ___APPEND___