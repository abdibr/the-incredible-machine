/**
 * Editor goal honesty (GitHub issue #66): the Goal Type control was a silent
 * no-op — every type selectable, nothing reflected it, and Save hard-coded
 * the goal. #66 seams under test:
 *
 * - resolveGoalZoneObject: the single goal-zone truth used by readout,
 *   marker and save.
 * - Select honesty: only goal types GoalChecker implements are selectable;
 *   the rest stay visible but disabled and marked "(not implemented)".
 * - Goal readout: entering SANDBOX shows immediately that the live session
 *   is goal-less (#63 posture) and what the selection means for saved
 *   levels; loading a custom level updates the readout with its live goal;
 *   board changes (object:placed) refresh the zone warning.
 * - Save round-trip parity: Save writes exactly the goal the UI showed —
 *   a loaded level keeps its targetType/zoneId (when the zone still
 *   resolves), a fresh sandbox writes object_in_zone + the stamped bucket.
 * - Goal-zone marker: Renderer highlights the resolved zone object in edit
 *   modes (loaded level's zoneId bucket; sandbox's would-be-stamped bucket)
 *   and draws nothing in PLAY or when nothing resolves.
 *
 * EditorPanel is not importable without a DOM boot guard — the same
 * stubbing house style as editor-overlay-structure.test.js.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eventBus } from '../js/EventBus.js';
import { objectRegistry } from '../js/objects/ObjectRegistry.js';
import { registerAllObjects } from '../js/objects/registerAllObjects.js';
import {
    DEFAULT_GOAL_ZONE_ID,
    IMPLEMENTED_GOAL_TYPES,
    KNOWN_GOAL_TYPES,
    ZONE_GOAL_TYPE,
    resolveGoalZoneObject,
} from '../js/goals/GoalChecker.js';
import Renderer from '../js/render/Renderer.js';

/**
 * Minimal DOM fake with children, listeners and attribute storage so the
 * panel can be built and its controls driven directly from tests.
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
        /** Fire the fake node's captured listeners directly (select change etc.). */
        emit(type, ev = {}) {
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

/** A fixed bucket via the registry — the way sandbox placement/load builds them. */
function mkBucket(x, y, customId = null) {
    return objectRegistry.create('bucket', x, y, { isFixed: true, customId });
}

/** Level JSON the editor load path expects (the shape Save Level writes). */
function mkLevelData(goal, fixedObjects = []) {
    return {
        id: 'custom-roundtrip',
        name: 'Custom Level',
        description: 'A custom puzzle created in the editor',
        difficulty: 1,
        goal,
        fixedObjects,
        availableParts: {},
        hints: [],
    };
}

function disposeAll(objects) {
    for (const obj of objects) obj.dispose();
}

// ── resolveGoalZoneObject — the single goal-zone truth ───────────

describe('resolveGoalZoneObject semantics (issue #66)', () => {
    beforeEach(() => {
        eventBus.clear();
        registerAllObjects();
    });

    it('an explicit goal.zoneId match wins over the stamp fallback', () => {
        const named = mkBucket(500, 500, 'left-bucket');
        const unnamed = mkBucket(800, 500);
        const goal = { type: ZONE_GOAL_TYPE, targetType: 'ball', zoneId: 'left-bucket' };
        expect(resolveGoalZoneObject([unnamed, named], goal, { stampFallback: true })).toBe(named);
        disposeAll([named, unnamed]);
    });

    it('sandbox fallback marks only the FIRST unnamed fixed bucket (the one Save stamps)', () => {
        const first = mkBucket(300, 300);
        const second = mkBucket(600, 300);
        expect(resolveGoalZoneObject([first, second], null, { stampFallback: true })).toBe(first);
        expect(resolveGoalZoneObject([second, first], null, { stampFallback: true })).toBe(second);
        disposeAll([first, second]);
    });

    it('fallback skips named buckets, non-buckets and non-fixed objects', () => {
        const named = mkBucket(300, 300, 'already-named');
        const ball = objectRegistry.create('ball', 200, 200);
        const loose = objectRegistry.create('bucket', 400, 400); // not fixed
        expect(resolveGoalZoneObject([named, ball, loose], null, { stampFallback: true })).toBe(null);
        disposeAll([named, ball, loose]);
    });

    it('no fallback outside the sandbox gate: unresolvable zone or foreign goal type → null', () => {
        const unnamed = mkBucket(300, 300);
        const goal = { type: ZONE_GOAL_TYPE, targetType: 'ball', zoneId: 'nowhere' };
        expect(resolveGoalZoneObject([unnamed], goal, { stampFallback: false })).toBe(null);
        // The fallback is gated to implemented zone goals only.
        expect(resolveGoalZoneObject([unnamed], { type: 'pop_all_balloons' }, { stampFallback: true })).toBe(null);
        disposeAll([unnamed]);
    });

    it('a null goal with the sandbox gate resolves to the implied default zone bucket', () => {
        const unnamed = mkBucket(300, 300);
        expect(resolveGoalZoneObject([unnamed], null, { stampFallback: true })).toBe(unnamed);
        expect(resolveGoalZoneObject([unnamed], null, { stampFallback: false })).toBe(null);
        disposeAll([unnamed]);
    });

    it('implemented goal types: exactly the zone goal today (GoalChecker contract)', () => {
        expect(IMPLEMENTED_GOAL_TYPES).toEqual([ZONE_GOAL_TYPE]);
        expect(ZONE_GOAL_TYPE).toBe('object_in_zone');
        expect(DEFAULT_GOAL_ZONE_ID).toBe('bucket-goal');
    });

    it('one universe of goal types: the select list and the checker contract agree', () => {
        expect(KNOWN_GOAL_TYPES.map((t) => t.type)).toEqual([
            'object_in_zone', 'pop_all_balloons', 'chain_complete', 'mouse_in_zone', 'custom',
        ]);
        expect(KNOWN_GOAL_TYPES.filter((t) => t.implemented).map((t) => t.type))
            .toEqual([...IMPLEMENTED_GOAL_TYPES]);
    });
});

// ── EditorPanel: select honesty + readout (fake DOM) ─────────────

describe('EditorPanel Goal Type honesty + readout (issue #66)', () => {
    let panel;
    let dragDropManager;

    beforeEach(async () => {
        eventBus.clear();
        registerAllObjects();
        panel = await makeFreshPanel();
        ({ dragDropManager } = await import('../js/ui/DragDropManager.js'));
    });

    afterEach(() => {
        dragDropManager._objects = [];
        vi.unstubAllGlobals();
    });

    it('offers only implemented goal types selectable; the rest visible but marked unavailable', () => {
        const select = panel._goalSelect;
        const opts = select.children;
        expect(opts.map((o) => o.value)).toEqual([
            'object_in_zone', 'pop_all_balloons', 'chain_complete', 'mouse_in_zone', 'custom',
        ]);
        expect(opts[0].disabled).toBe(false);
        for (const opt of opts.slice(1)) {
            expect(opt.disabled).toBe(true); // a user cannot silently select these
            expect(opt.textContent).toContain('not implemented');
        }
        expect(select.value).toBe('object_in_zone');
    });

    it('fresh sandbox readout: live session goal-less, selection matters at save time', () => {
        // No bucket on the board → the zone warning is part of the story.
        const text = panel._goalReadout.textContent;
        expect(text).toContain('no active goal'); // live session is goal-less (#63 posture)
        expect(text).toContain('Save Level will use'); // selection only matters for saved levels
        expect(text).toContain('ball'); // plain-language target
        expect(text).toContain('cannot be won'); // nothing on the board can carry the zone
    });

    it('a placed bucket immediately resolves the goal description (readout refresh on object:placed)', () => {
        dragDropManager._objects = [];
        expect(panel._goalReadout.textContent).toContain('cannot be won');

        const bucket = mkBucket(500, 500);
        dragDropManager._objects = [bucket];
        eventBus.emit('object:placed', { type: 'bucket', id: bucket.id, object: bucket });

        expect(panel._goalReadout.textContent).not.toContain('cannot be won');
        expect(panel._goalReadout.textContent).toContain('GOAL');
        bucket.dispose();
    });

    it('loading a custom level updates the readout with the live goal at once', () => {
        dragDropManager._objects = [];
        panel._applyLoadedLevel(mkLevelData(
            { type: ZONE_GOAL_TYPE, targetType: 'ball', zoneId: 'left' },
            [{ type: 'bucket', x: 500, y: 500, isFixed: true, id: 'left', options: {} }],
        ));
        const text = panel._goalReadout.textContent;
        expect(text).toContain('Custom Level');
        expect(text).toContain('active'); // a loaded level DOES carry a live goal
        expect(text).toContain('ball');
        expect(text).not.toContain('no active goal');
    });

    it('a loaded level with an unimplemented goal type is honest: imported option, not-implemented warning', () => {
        dragDropManager._objects = [];
        panel._applyLoadedLevel(mkLevelData(
            { type: 'mouse_in_zone', targetType: 'mouse', zoneId: 'mouse-zone' },
            [],
        ));
        expect(panel._goalSelect.value).toBe('mouse_in_zone');
        // The imported type shows as an unavailable option, never a silent choice.
        const imported = panel._importedGoalOption;
        expect(imported.disabled).toBe(true);
        expect(imported.textContent).toContain('not implemented');
        const text = panel._goalReadout.textContent;
        expect(text).toContain('not implemented');
        expect(text).toContain('cannot be won');
    });

    it('a select change refreshes the readout (wiring to the change listener)', () => {
        const select = panel._goalSelect;
        select.value = 'object_in_zone';
        select.emit('change');
        expect(panel._goalReadout.textContent).toContain('Save Level will use');
        expect(panel._goalReadout.textContent).toContain('ball');
    });

    it('loaded level with a vanished zone: live line warns the session, save line describes the repair', () => {
        // Live view is explicit-only: goal zoneId "left" matches nothing, so
        // the session cannot reach the goal — even though Save would stamp
        // a fresh zone bucket and repair the level on the next save.
        dragDropManager._objects = [];
        panel._applyLoadedLevel(mkLevelData(
            { type: ZONE_GOAL_TYPE, targetType: 'ball', zoneId: 'left' },
            [],
        ));
        // The load replaced the board; the user then builds on top of it —
        // exactly the bucket the next save would stamp (the placement event
        // is what refreshes the readout).
        dragDropManager._objects = [mkBucket(500, 500)];
        eventBus.emit('object:placed', { type: 'bucket', id: dragDropManager._objects[0].id, object: dragDropManager._objects[0] });
        const text = panel._goalReadout.textContent;
        expect(text).toContain('goal from "Custom Level" is active');
        expect(text).toContain('"left"');
        expect(text).toContain('that zone matches nothing on the board');
        expect(text).toContain('this session cannot reach the goal');
        // The next-save view (sandbox fallback) still names the stamped bucket.
        expect(text).toContain('Save Level will use: get the ball into the bucket marked GOAL');
        disposeAll(dragDropManager._objects);
    });
});

// ── EditorPanel: save round-trip parity ──────────────────────────

describe('EditorPanel save round-trip parity (issue #66)', () => {
    let panel;
    let dragDropManager;

    beforeEach(async () => {
        eventBus.clear();
        registerAllObjects();
        panel = await makeFreshPanel();
        ({ dragDropManager } = await import('../js/ui/DragDropManager.js'));
    });

    afterEach(() => {
        dragDropManager._objects = [];
        vi.unstubAllGlobals();
    });

    /** Save Level's single download as parsed JSON (Blob/URL stubs captured). */
    async function saveOnce() {
        vi.stubGlobal('URL', {
            createObjectURL: vi.fn(() => 'blob:test'),
            revokeObjectURL: vi.fn(),
        });
        panel._saveLevel();
        const blob = URL.createObjectURL.mock.calls[0][0];
        vi.unstubAllGlobals();
        return JSON.parse(await blob.text());
    }

    it('a fresh sandbox save is winnable: selected type + the stamped goal bucket', async () => {
        dragDropManager._objects = [mkBucket(500, 500), mkBucket(700, 500)];
        const saved = await saveOnce();
        expect(saved.goal).toEqual({
            type: 'object_in_zone',
            targetType: 'ball',
            zoneId: 'bucket-goal',
        });
        expect(saved.fixedObjects[0].id).toBe('bucket-goal'); // first unnamed stamped
        expect(saved.fixedObjects[1].id).toBeUndefined();     // decoy stays unnamed
        disposeAll(dragDropManager._objects);
    });

    it('loading then saving preserves the goal the UI showed (named zone + targetType)', async () => {
        dragDropManager._objects = [];
        panel._applyLoadedLevel(mkLevelData(
            { type: ZONE_GOAL_TYPE, targetType: 'mouse', zoneId: 'left' },
            [{ type: 'bucket', x: 500, y: 500, isFixed: true, id: 'left', options: {} }],
        ));
        const saved = await saveOnce();
        expect(saved.goal).toEqual({
            type: 'object_in_zone',
            targetType: 'mouse',
            zoneId: 'left',
        });
        expect(saved.fixedObjects[0].id).toBe('left'); // named bucket never renamed
        disposeAll(dragDropManager._objects);
    });

    it('an imported unimplemented goal is preserved for round-trip fidelity', async () => {
        dragDropManager._objects = [];
        panel._applyLoadedLevel(mkLevelData(
            { type: 'mouse_in_zone', targetType: 'mouse', zoneId: 'mouse-zone' },
            [],
        ));
        const saved = await saveOnce();
        expect(saved.goal.type).toBe('mouse_in_zone');   // not silently rewritten
        expect(saved.goal.targetType).toBe('mouse');
    });

    it('switching away from an imported unimplemented type saves a fresh winnable goal', async () => {
        dragDropManager._objects = [];
        panel._applyLoadedLevel(mkLevelData(
            { type: 'mouse_in_zone', targetType: 'mouse', zoneId: 'mouse-zone' },
            [],
        ));
        // The load replaced the board; the user builds on top of it — the
        // unnamed bucket is what Save will stamp as the goal zone.
        dragDropManager._objects = [mkBucket(500, 500)];
        panel._goalSelect.value = 'object_in_zone'; // the user picks the implemented type
        const saved = await saveOnce();
        expect(saved.goal).toEqual({
            type: 'object_in_zone',
            targetType: 'ball',
            zoneId: 'bucket-goal',
        });
        expect(saved.fixedObjects[0].id).toBe('bucket-goal');
        disposeAll(dragDropManager._objects);
    });
});

// ── Renderer: goal-zone marker ───────────────────────────────────

describe('Renderer goal-zone marker (issue #66)', () => {
    beforeEach(() => {
        eventBus.clear();
        registerAllObjects();
    });

    /** A renderer whose init() has subscribed it to the bus (canvas unused). */
    function makeSubscribedRenderer(mode) {
        const r = new Renderer();
        r.init({ getContext: () => null });
        r._mode = mode;
        return r;
    }

    it('sandbox: marks the bucket Save would stamp — the FIRST unnamed one only', () => {
        const first = mkBucket(300, 300);
        const second = mkBucket(600, 300);
        const r = makeSubscribedRenderer('SANDBOX');
        const ctx = makeDrawCtx();

        r._drawGoalZoneMarker(ctx, [first, second]);

        expect(ctx.fillText).toHaveBeenCalledWith(
            'GOAL', first.bounds.x + first.bounds.width / 2, first.bounds.y - 8,
        );
        const goalCalls = ctx.fillText.mock.calls.filter((c) => c[0] === 'GOAL');
        expect(goalCalls).toHaveLength(1); // the second unnamed bucket stays clean
        const rects = ctx.strokeRect.mock.calls.map(([x, y, w, h]) => ({ x, y, w, h }));
        expect(rects).toContainEqual({
            x: first.bounds.x - 4, y: first.bounds.y - 4,
            w: first.bounds.width + 8, h: first.bounds.height + 8,
        });
        disposeAll([first, second]);
    });

    it('a loaded level marks the bucket matching goal.zoneId (EDITING, no stamp fallback)', () => {
        const left = mkBucket(800, 500, 'left');
        const decoy = mkBucket(300, 300); // would be stamped on save — NOT the loaded zone
        const r = makeSubscribedRenderer('EDITING');
        eventBus.emit('level:loaded', mkLevelData({ type: ZONE_GOAL_TYPE, targetType: 'ball', zoneId: 'left' }));
        const ctx = makeDrawCtx();

        r._drawGoalZoneMarker(ctx, [decoy, left]);

        expect(ctx.fillText).toHaveBeenCalledWith(
            'GOAL', left.bounds.x + left.bounds.width / 2, left.bounds.y - 8,
        );
        const goalCalls = ctx.fillText.mock.calls.filter((c) => c[0] === 'GOAL');
        expect(goalCalls).toHaveLength(1);
        disposeAll([left, decoy]);
    });

    it('nothing resolves → no marker, even in edit modes', () => {
        const r = makeSubscribedRenderer('SANDBOX');
        eventBus.emit('level:loaded', mkLevelData({ type: ZONE_GOAL_TYPE, targetType: 'ball', zoneId: 'nowhere' }));
        const ctx = makeDrawCtx();

        r._drawGoalZoneMarker(ctx, []);

        expect(ctx.fillText).not.toHaveBeenCalled();
        expect(ctx.strokeRect).not.toHaveBeenCalled();
    });

    it('a loaded level whose zone bucket vanished marks nothing — even with a stampable bucket on the board', () => {
        // The unnamed bucket is what the NEXT save would stamp, but the live
        // session (goal zoneId "left") can win on nothing — the marker must
        // not point at it (live-view semantics, issue #66).
        const unnamed = mkBucket(300, 300);
        const r = makeSubscribedRenderer('SANDBOX');
        eventBus.emit('level:loaded', mkLevelData({ type: ZONE_GOAL_TYPE, targetType: 'ball', zoneId: 'left' }));
        const ctx = makeDrawCtx();

        r._drawGoalZoneMarker(ctx, [unnamed]);

        expect(ctx.fillText).not.toHaveBeenCalled();
        expect(ctx.strokeRect).not.toHaveBeenCalled();
        disposeAll([unnamed]);
    });

    it('PLAY boards draw nothing', () => {
        const bucket = mkBucket(300, 300);
        const r = makeSubscribedRenderer('PLAYING');
        const ctx = makeDrawCtx();

        r._drawGoalZoneMarker(ctx, [bucket]);

        expect(ctx.fillText).not.toHaveBeenCalled();
        expect(ctx.strokeRect).not.toHaveBeenCalled();
        disposeAll([bucket]);
    });

    it('entering SANDBOX drops a stale level goal — the marker falls back to the stamp bucket', () => {
        const stale = mkBucket(800, 500, 'left');
        const fresh = mkBucket(300, 300); // unnamed: what Save would stamp next visit
        const r = makeSubscribedRenderer('SANDBOX');
        eventBus.emit('level:loaded', mkLevelData({ type: ZONE_GOAL_TYPE, targetType: 'ball', zoneId: 'left' }));
        eventBus.emit('mode:changed', { oldMode: 'EDITING', newMode: 'SANDBOX' });
        const ctx = makeDrawCtx();

        r._drawGoalZoneMarker(ctx, [fresh, stale]);

        expect(ctx.fillText).toHaveBeenCalledWith(
            'GOAL', fresh.bounds.x + fresh.bounds.width / 2, fresh.bounds.y - 8,
        );
        const goalCalls = ctx.fillText.mock.calls.filter((c) => c[0] === 'GOAL');
        expect(goalCalls).toHaveLength(1);
        disposeAll([fresh, stale]);
    });
});

// ── ctx mock (connect-flow.test.js house style) ──────────────────

function makeDrawCtx() {
    const ctx = {};
    const strokeStyleLog = [];
    const fillStyleLog = [];
    for (const fn of [
        'save', 'restore', 'beginPath', 'moveTo', 'lineTo',
        'arc', 'fillRect', 'strokeRect', 'fill', 'stroke', 'setLineDash',
        'fillText',
    ]) {
        ctx[fn] = vi.fn();
    }
    Object.defineProperty(ctx, 'strokeStyle', {
        set(v) { strokeStyleLog.push(v); },
        get() { return strokeStyleLog[strokeStyleLog.length - 1]; },
    });
    Object.defineProperty(ctx, 'fillStyle', {
        set(v) { fillStyleLog.push(v); },
        get() { return fillStyleLog[fillStyleLog.length - 1]; },
    });
    ctx.strokeStyles = strokeStyleLog;
    ctx.fillStyles = fillStyleLog;
    return ctx;
}