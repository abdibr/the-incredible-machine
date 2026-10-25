/**
 * Anchored part (issue #67): the third part state — pre-placed by the
 * author, immovable to the player in the edit stage, yet physically dynamic
 * at play (gravity applies; it can fall, roll, be hit). Distinct from pinned
 * scenery (play-static): an anchored bucket cannot be the goal zone, and an
 * anchored ball still wins levels by falling in.
 *
 * Seams under test (pre-agreed):
 * - js/ui/selectionHandles.js — the #68-integration surface: the anchored
 *   row lands in the shared policy table (partHandleState × HANDLE_SETS),
 *   ropes refuse the anchor handle by capability.
 * - js/objects/BaseObject.js — `isAnchored` as a lifecycle key: a plain
 *   state flag that never touches bodies (anchored parts play dynamic),
 *   mutually exclusive with isFixed through the accessors, round-tripping
 *   through serialize() as an opt-in `isAnchored` key.
 * - js/ui/DragDropManager.js — the anchor affordance: ⚓ handle, Key A, the
 *   `object:anchored` announcement, rope refusal, and the EDITING refusal
 *   set (selection allowed, move/rotate/delete never start).
 * - js/render/Renderer.js — the anchor handle slot/glyph/color, and the ⚓
 *   badge marking anchored parts on the field (edit modes only).
 * - rebuild paths — levelReset restore, EditorPanel load/save, sandbox
 *   rewind: the anchor survives every serialize/restore cycle.
 * - js/levels/puzzles/level-06.json — the campaign fixture: an anchored
 *   ball over a ramp into the goal bucket, winnable at play.
 *
 * Harnesses follow the repo's house styles: editor-pin.test.js for the
 * drag-drop seam and the fake-DOM panel, sandbox-fixed-edit.test.js for the
 * state-driven refusals.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eventBus } from '../js/EventBus.js';
import { objectRegistry } from '../js/objects/ObjectRegistry.js';
import { registerAllObjects } from '../js/objects/registerAllObjects.js';
import { partHandleState, selectionHandleSet, isAnchorCapable, isAnchorCapableType } from '../js/ui/selectionHandles.js';
import DragDropManager from '../js/ui/DragDropManager.js';
import { renderer as _renderer } from '../js/render/Renderer.js';
import Renderer from '../js/render/Renderer.js';
import { beginPlay, resetSandboxBoard, restorePlacedFromSnapshot } from '../js/reset/levelReset.js';
import { levelObjectOptions } from '../js/ui/selectionHandles.js';
import { PhysicsEngine } from '../js/engine/PhysicsEngine.js';
import { dragDropManager } from '../js/ui/DragDropManager.js';
import { SessionRecorder } from '../js/recorder/SessionRecorder.js';
import { levelManager } from '../js/levels/LevelManager.js';
import { AgentSession } from '../agent/session.js';
import level06 from '../js/levels/puzzles/level-06.json';

registerAllObjects();

// ── The anchored part state & policy (selectionHandles + BaseObject) ──

describe('the anchored part state & handle policy (issue #67)', () => {
    let ball;
    let rope;

    beforeEach(() => {
        eventBus.clear();
        ball = objectRegistry.create('ball', 300, 300);
        rope = objectRegistry.create('rope', 100, 100);
    });

    afterEach(() => {
        ball.dispose();
        rope.dispose();
    });
    it('partHandleState classifies the three part states — pinned wins on disagreement', () => {
        expect(partHandleState(ball)).toBe('movable');
        ball.isFixed = true;
        expect(partHandleState(ball)).toBe('pinned');
        ball.isFixed = false;
        ball.isAnchored = true;
        expect(partHandleState(ball)).toBe('anchored');
        // Defensive precedence, not a state the affordances produce: a
        // hand-written row with both flags acts pinned (play-static).
        ball.isFixed = true;
        expect(partHandleState(ball)).toBe('pinned');
    });

    it('the anchored handle set mirrors the pinned boundary: full set in sandbox, anchor-only elsewhere', () => {
        ball.isAnchored = true;

        expect(selectionHandleSet(ball, 'SANDBOX'))
            .toEqual(['move', 'rotate', 'delete', 'pin', 'anchor']);
        expect(selectionHandleSet(ball, 'EDITING')).toEqual(['anchor']);
        // Movable and pinned parts keep their sets; anchor joins the full set.
        ball.isAnchored = false;
        expect(selectionHandleSet(ball, 'EDITING'))
            .toEqual(['move', 'rotate', 'delete', 'pin', 'anchor']);
        ball.isFixed = true;
        expect(selectionHandleSet(ball, 'SANDBOX'))
            .toEqual(['move', 'rotate', 'delete', 'pin', 'anchor']);
        expect(selectionHandleSet(ball, 'EDITING')).toEqual(['pin']);
    });

    it('ropes are out of scope: no anchor handle anywhere, capability says so', () => {
        expect(isAnchorCapableType('ball')).toBe(true);
        expect(isAnchorCapableType('rope')).toBe(false);
        expect(isAnchorCapableType('free-rope')).toBe(false);
        expect(isAnchorCapable(rope)).toBe(false);
        expect(isAnchorCapable(ball)).toBe(true);

        for (const mode of ['SANDBOX', 'EDITING']) {
            expect(selectionHandleSet(rope, mode)).not.toContain('anchor');
        }
    });

    it('isAnchored is a plain state flag — anchoring never statics the bodies', () => {
        expect(ball.isAnchored).toBe(false);
        ball.isAnchored = true;
        expect(ball.isAnchored).toBe(true);
        for (const body of ball.bodies) {
            expect(body.isStatic).toBe(false); // play-dynamic by construction
        }
    });

    it('anchoring a pinned part un-pins it; pinning an anchored part clears the anchor', () => {
        ball.isFixed = true;
        expect(ball.bodies.every((b) => b.isStatic)).toBe(true);

        ball.isAnchored = true;
        expect(ball.isFixed).toBe(false); // the states are exclusive
        expect(ball.isAnchored).toBe(true);
        expect(ball.bodies.every((b) => !b.isStatic)).toBe(true); // dynamic again

        ball.isFixed = true;
        expect(ball.isAnchored).toBe(false); // pinning absorbs the anchor
        expect(ball.bodies.every((b) => b.isStatic)).toBe(true);
    });

    it('isAnchored is a lifecycle key: registry.create honors it like isFixed', () => {
        const anchored = objectRegistry.create('ball', 300, 300, { isAnchored: true });
        expect(anchored.isAnchored).toBe(true);
        expect(anchored.isFixed).toBe(false);
        anchored.dispose();
    });

    it('serialize emits isAnchored only when set — the old shape stays stable', () => {
        const plain = ball.serialize();
        expect('isAnchored' in plain).toBe(false);

        ball.isAnchored = true;
        const data = ball.serialize();
        expect(data.isAnchored).toBe(true);
        expect(data.isFixed).toBe(false); // anchored rows play dynamic after reload
    });
});

// ── The anchor affordance (DragDropManager seam) ─────────────────────

describe('the anchor affordance (DragDropManager, issue #67)', () => {
    let ddm;
    let ball;

    beforeEach(() => {
        eventBus.clear();
        ddm = makeAnchorSeam();
        ball = mkPlacedBall();
        ddm._objects = [ball];
        ddm._selectObject(ball);
    });

    afterEach(() => {
        ball.dispose();
        _renderer.canvas = null;
        _renderer.selectedObject = null;
    });

    it('anchors a placed ball: isAnchored flips and object:anchored announces it', () => {
        const anchored = [];
        const stop = eventBus.on('object:anchored', (e) => anchored.push(e));

        ddm._toggleAnchorSelected();

        expect(ball.isAnchored).toBe(true);
        expect(ball.isFixed).toBe(false); // anchored, not pinned
        expect(anchored).toEqual([{ type: 'ball', id: ball.id, isAnchored: true, object: ball }]);
        expect(ddm._selectedObject).toBe(ball); // stays selected for further edits
        stop();
    });

    it('the same affordance un-anchors — the ball is an ordinary part again', () => {
        ddm._toggleAnchorSelected();
        expect(ball.isAnchored).toBe(true);

        const events = [];
        const stop = eventBus.on('object:anchored', (e) => events.push({ isAnchored: e.isAnchored, id: e.id }));
        ddm._toggleAnchorSelected();
        stop();

        expect(events[0]).toEqual({ isAnchored: false, id: ball.id });
        expect(ball.isAnchored).toBe(false);
        expect(selectionHandleSet(ball, 'EDITING')).toEqual(['move', 'rotate', 'delete', 'pin', 'anchor']);
    });

    it('clicking the anchor handle toggles through the pointer-down seam', () => {
        const original = _renderer.getHandleAtPoint;
        _renderer.getHandleAtPoint = () => 'anchor';
        try {
            ddm._onCanvasPointerDown(300, 340);
            expect(ball.isAnchored).toBe(true);
            ddm._onCanvasPointerDown(300, 340);
            expect(ball.isAnchored).toBe(false);
        } finally {
            _renderer.getHandleAtPoint = original;
        }
    });

    it('Key A toggles like the handle', () => {
        const key = (code) => ddm._onKeyDown({ code, target: { tagName: 'CANVAS' }, preventDefault() {} });

        key('KeyA');
        expect(ball.isAnchored).toBe(true);
        key('KeyA');
        expect(ball.isAnchored).toBe(false);
    });

    it('ropes refuse the anchor — the quiet no-op boundary', () => {
        const rope = objectRegistry.create('rope', 100, 100);
        ddm._objects = [rope, ball];
        ddm._selectObject(rope);

        expect(selectionHandleSet(rope, 'SANDBOX')).not.toContain('anchor');

        const original = _renderer.getHandleAtPoint;
        _renderer.getHandleAtPoint = () => 'anchor'; // even a phantom hit refuses
        try {
            expect(() => ddm._toggleAnchorSelected()).not.toThrow();
            expect(rope.isAnchored).toBe(false);
            ddm._onCanvasPointerDown(100, 100);
            expect(rope.isAnchored).toBe(false);
        } finally {
            _renderer.getHandleAtPoint = original;
            rope.dispose();
        }
    });

    it('an anchor toggle with no selection is a quiet no-op', () => {
        ddm._selectObject(null);
        expect(() => ddm._toggleAnchorSelected()).not.toThrow();
        expect(() => ddm._onKeyDown({ code: 'KeyA', target: { tagName: 'CANVAS' }, preventDefault() {} })).not.toThrow();
    });
});

// ── Anchored parts refuse the edit verbs outside sandbox authoring ───

describe('anchored parts refuse the edit verbs outside sandbox authoring (issue #67)', () => {
    let ddm;
    let ball;

    beforeEach(() => {
        eventBus.clear();
        ball = mkPlacedBall(300, 300);
    });

    afterEach(() => {
        ball.dispose();
        _renderer.canvas = null;
        _renderer.selectedObject = null;
    });

    /** An anchored ball selected in the given posture — the #67 refusal subject. */
    function anchoredSelection(mode) {
        const seam = makeAnchorSeam(mode);
        ddm = seam;
        ddm._objects = [ball];
        ddm._selectObject(ball);
        ddm._toggleAnchorSelected();
        expect(ball.isAnchored).toBe(true);
        return seam;
    }

    it('EDITING: clicking an anchored part selects it — a drag never starts', () => {
        anchoredSelection('EDITING');

        const original = _renderer.getObjectAtPoint;
        _renderer.getObjectAtPoint = () => ball;
        try {
            ddm._onCanvasPointerDown(302, 304);
        } finally {
            _renderer.getObjectAtPoint = original;
        }

        expect(ddm._selectedObject).toBe(ball); // selection works
        expect(ddm._dragging).toBe(false); // the drag never starts
        expect(ddm._dragType).toBeNull();
    });

    it('EDITING: move/rotate verbs, Delete key and right-click all refuse — selection survives', () => {
        anchoredSelection('EDITING');

        const original = _renderer.getObjectAtPoint;
        _renderer.getObjectAtPoint = () => ball;
        try {
            ddm._onCanvasContextMenu(300, 300); // right-click delete path
        } finally {
            _renderer.getObjectAtPoint = original;
        }
        ddm._startMoveObject(300, 300);
        ddm._startRotateObject(300, 300);
        ddm._onKeyDown({ code: 'Delete', target: { tagName: 'CANVAS' }, preventDefault() {} });

        expect(ddm._dragging).toBe(false);
        expect(ddm._objects).toContain(ball); // never deleted
        expect(ddm._selectedObject).toBe(ball); // only the anchor handle remains
    });

    it('EDITING: the anchor handle is the escape hatch — un-anchor, then the part edits freely', () => {
        anchoredSelection('EDITING');

        const handleHit = _renderer.getHandleAtPoint;
        const objectHit = _renderer.getObjectAtPoint;
        _renderer.getHandleAtPoint = () => 'anchor';
        ddm._onCanvasPointerDown(300, 340);
        expect(ball.isAnchored).toBe(false);
        _renderer.getHandleAtPoint = handleHit;

        _renderer.getObjectAtPoint = () => ball;
        try {
            ddm._onCanvasPointerDown(300, 300);
        } finally {
            _renderer.getObjectAtPoint = objectHit;
        }
        expect(ddm._dragging).toBe(true);
        expect(ddm._dragType).toBe('move');
    });

    it('SANDBOX authoring: the anchored ball is draggable in place — the pose moves, the bodies stay dynamic', () => {
        anchoredSelection('SANDBOX');

        ddm._startMoveObject(300, 300);
        expect(ddm._dragging).toBe(true);
        ddm._dragObject.setPosition(420, 180); // what mousemove would apply

        expect(ball.x).toBe(420);
        expect(ball.y).toBe(180);
        expect(ball.isAnchored).toBe(true); // the anchor follows the pose
        expect(ball.bodies.every((b) => !b.isStatic)).toBe(true); // never pinned
    });
});

// ── The anchor handle & field badge (Renderer) ───────────────────────

describe('the anchor handle and field badge (Renderer, issue #67)', () => {
    let ball;

    beforeEach(() => {
        eventBus.clear();
        ball = mkPlacedBall(400, 300);
    });

    afterEach(() => ball.dispose());

    it('the anchor handle sits below the pin slot and hit-tests', () => {
        ball.isAnchored = true;
        const r = new Renderer();
        r._mode = 'SANDBOX'; // authoring posture: the anchored part offers the full set
        r.selectedObject = ball;

        const handles = r._getHandlePositions(ball);
        expect(handles.map(([name]) => name)).toEqual(['move', 'rotate', 'delete', 'pin', 'anchor']);
        const [pinX, pinY] = handles[3].slice(1);
        const [anchorX, anchorY] = handles[4].slice(1);
        const b = ball.bounds;
        expect(pinX).toBe(b.x + b.width / 2);
        expect(pinY).toBe(b.y + b.height + 14);
        expect(anchorX).toBe(b.x + b.width / 2);
        expect(anchorY).toBe(b.y + b.height + 32); // stacked below the pin
        expect(r.getHandleAtPoint(anchorX, anchorY)).toBe('anchor');
        expect(r.getHandleAtPoint(pinX, pinY)).toBe('pin');
    });

    it('the anchor handle draws with its own color and the ⚓ glyph', () => {
        ball.isAnchored = true;
        const r = new Renderer();
        r.selectedObject = ball;
        const ctx = makeDrawCtx();

        r._drawSelectionHandles(ctx, ball);

        expect(r.HANDLE_COLORS.anchor).toBeDefined();
        expect(r.HANDLE_COLORS.anchor).not.toBe(r.HANDLE_COLORS.pin);
        expect(r.HANDLE_COLORS.anchor).not.toBe(r.HANDLE_COLORS.move);
        const glyph = ctx.fillText.mock.calls.find((c) => c[0] === '⚓');
        expect(glyph).toBeDefined();
    });

    it('anchored parts draw the ⚓ badge in edit modes — nothing in PLAY', () => {
        ball.isAnchored = true;
        const r = new Renderer();
        const ctx = makeDrawCtx();

        r._mode = 'EDITING';
        r._drawAnchorBadges(ctx, [ball]);
        expect(ctx.fillText.mock.calls.some((c) => c[0] === '⚓')).toBe(true);

        const playing = makeDrawCtx();
        r._mode = 'PLAYING';
        r._drawAnchorBadges(playing, [ball]);
        expect(playing.fillText.mock.calls).toHaveLength(0);

        // Un-anchored parts: no badge in any mode
        ball.isAnchored = false;
        r._mode = 'SANDBOX';
        const fresh = makeDrawCtx();
        r._drawAnchorBadges(fresh, [ball]);
        expect(fresh.fillText.mock.calls).toHaveLength(0);
    });
});

// ── Rebuild paths: the anchor survives every serialize/restore cycle ─

describe('the anchor survives every rebuild path (issue #67)', () => {
    beforeEach(() => {
        eventBus.clear();
    });

    it('every anchor-capable type round-trips the anchor through serialize → deserialize; ropes drop it', () => {
        for (const { type } of objectRegistry.getAll()) {
            const obj = objectRegistry.create(type, 120, 120, { isAnchored: true });
            const data = obj.serialize();
            const rebuilt = objectRegistry.deserialize(data);
            if (isAnchorCapableType(type)) {
                expect(rebuilt.isAnchored, `${type}: anchor must round-trip`).toBe(true);
                expect(rebuilt.isFixed, `${type}: anchored rows stay play-dynamic`).toBe(false);
            } else {
                expect(rebuilt.isAnchored, `${type}: ropes are out of anchor scope`).toBe(false);
                obj.dispose();
            }
            rebuilt.dispose();
        }
    });

    it('the rebuild-row rule: legacy rows stay forced-fixed, anchored rows keep dynamic, rope anchors drop', () => {
        expect(levelObjectOptions({ type: 'ramp', x: 1, y: 2 })).toEqual({
            angle: 0, isFixed: true, isAnchored: false, customId: undefined,
        });
        expect(levelObjectOptions({ type: 'ball', x: 1, y: 2, angle: 0.2, id: 'b1', isFixed: false, isAnchored: true }))
            .toEqual({ angle: 0.2, isFixed: false, isAnchored: true, customId: 'b1' });
        // Pinned absorbs the anchor; rope rows lose it (scope)
        expect(levelObjectOptions({ type: 'bucket', x: 1, y: 2, isFixed: true, isAnchored: true }).isAnchored).toBe(false);
        expect(levelObjectOptions({ type: 'rope', x: 1, y: 2, isAnchored: true }).isAnchored).toBe(false);
    });

    it('a sandbox rewind restores anchored parts with their anchor intact', () => {
        const physics = new PhysicsEngine(800, 600);
        const ball = mkPlacedBall(320, 280);
        ball.isAnchored = true;
        const placed = [ball];

        const snapshot = beginPlay(physics, placed);
        const restored = resetSandboxBoard(physics, placed, snapshot);

        expect(restored).toHaveLength(1);
        expect(restored[0].isAnchored).toBe(true);
        expect(restored[0].isFixed).toBe(false);
        expect(restored[0].x).toBe(320);
        expect(restored[0].y).toBe(280);
        physics.dispose();
        restored[0].dispose();
    });

    it('the default snapshot restore skips anchored rows — the level rebuild covers them', () => {
        // The reload path rebuilds fixedObjects from level JSON (anchored rows
        // included), so a default placed-snapshot restore must not double-restore.
        const snapshot = [
            { type: 'ball', x: 100, y: 100, angle: 0, isFixed: false, isAnchored: true, options: {} },
            { type: 'ball', x: 200, y: 200, angle: 0, isFixed: false, options: {} },
        ];
        const board = [];
        restorePlacedFromSnapshot(board, snapshot);
        expect(board).toHaveLength(1);
        expect(board[0].isAnchored).toBe(false);
        expect(board[0].x).toBe(200);
        board[0].dispose();
    });

    it('clearPlacedObjects keeps anchored scene content — it is not a placed part', () => {
        const ddm = makeAnchorSeam();
        const anchored = mkPlacedBall(300, 300);
        anchored.isAnchored = true;
        const plain = mkPlacedBall(500, 300);
        ddm._objects = [anchored, plain];

        ddm.clearPlacedObjects();

        expect(ddm._objects).toEqual([anchored]); // the anchored ball survives like fixed scenery
        expect(ddm._objects[0].isAnchored).toBe(true);
        anchored.dispose();
        _renderer.canvas = null;
        _renderer.selectedObject = null;
    });
});

// ── The editor panel: save routing, load honoring, notice & readout ──

describe('EditorPanel anchored copy and save routing (issue #67)', () => {
    let panel;

    beforeEach(async () => {
        eventBus.clear();
        dragDropManager._objects = [];
        dragDropManager._mode = 'SANDBOX'; // the live panel drives the sandbox singleton
        panel = await makeFreshPanel();
    });

    afterEach(() => {
        disposeAnchoredBoard();
        dragDropManager._objects = [];
        dragDropManager._mode = 'MENU';
        vi.unstubAllGlobals();
        // The palette panel is a module singleton (issue #69) — reset so the
        // next boot rebuilds its rows and starts unauthored.
        if (palettePanel) {
            palettePanel._authoredPalette = null;
            palettePanel._built = false;
            palettePanel._paletteRows = [];
            palettePanel._paletteReadout = null;
            palettePanel._unlimitedBtn = null;
            palettePanel.container = null;
            palettePanel._minimized = false;
        }
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

    it('Save routes anchored parts into fixedObjects — beside the pinned one', async () => {
        const bucket = objectRegistry.create('bucket', 700, 480, { isFixed: true });
        const ball = mkPlacedBall(500, 300);
        ball.isAnchored = true;
        dragDropManager._objects = [bucket, ball];

        const saved = await saveOnce();

        expect(saved.fixedObjects).toHaveLength(2);
        expect(saved.fixedObjects[0].type).toBe('bucket');
        expect(saved.fixedObjects[0].isFixed).toBe(true);
        expect(saved.fixedObjects[1]).toMatchObject({ type: 'ball', isFixed: false, isAnchored: true });
        bucket.dispose();
        ball.dispose();
    });

    it('loading a level honors anchored rows — legacy scenery stays forced-fixed', () => {
        panel._applyLoadedLevel(mkAnchoredLevelData());

        const board = dragDropManager.getObjects();
        expect(board).toHaveLength(2);
        const ramp = board.find((o) => o.type === 'ramp');
        const ball = board.find((o) => o.type === 'ball');
        expect(ramp.isFixed).toBe(true); // legacy row (no isFixed key) — forced scenery
        expect(ball.isFixed).toBe(false); // anchored row keeps its play-dynamic body state
        expect(ball.isAnchored).toBe(true);
    });

    it('the anchor notice says what anchoring did; a bucket gets the goal-zone caution', () => {
        const ramp = objectRegistry.create('ramp', 300, 200);
        dragDropManager._objects = [ramp];
        dragDropManager._selectObject(ramp);

        dragDropManager._toggleAnchorSelected();

        expect(panel._pinNotice.textContent).toContain('⚓ Ramp anchored');
        expect(panel._pinNotice.textContent).toContain('Save Level will include it');
        expect(panel._pinNotice.textContent).not.toContain('goal zone');

        const bucket = objectRegistry.create('bucket', 700, 480, { isFixed: true });
        dragDropManager._objects = [bucket];
        dragDropManager._selectObject(bucket);
        dragDropManager._toggleAnchorSelected(); // un-pins and anchors

        expect(panel._pinNotice.textContent).toContain('⚓ Bucket anchored');
        expect(panel._pinNotice.textContent).toContain('anchored bucket cannot be the goal zone');
    });

    it('un-anchoring gets a plain, neutral notice', () => {
        const ball = mkPlacedBall(300, 300);
        dragDropManager._objects = [ball];
        dragDropManager._selectObject(ball);
        dragDropManager._toggleAnchorSelected();
        dragDropManager._toggleAnchorSelected();

        expect(panel._pinNotice.textContent).toContain('Ball un-anchored');
        expect(panel._pinNotice.textContent).toContain('ordinary movable part');
    });

    it('the readout explains the palette distinction when an anchored type is also offered', () => {
        const ball = mkPlacedBall(300, 300);
        ball.isAnchored = true;
        dragDropManager._objects = [ball];

        panel._updateGoalReadout(); // sandbox: every registered type is offered

        expect(panel._goalReadout.textContent).toContain('anchored scene content');
        expect(panel._goalReadout.textContent).toContain('does not use any palette parts');
    });

    it('the standing tip now explains the anchor affordance', () => {
        expect(panel._pinNotice.textContent).toContain('⚓');
        expect(panel._pinNotice.textContent).toContain('anchors');
    });
});

describe('object:anchored in the bug-file build trace (ADR 0006)', () => {
    beforeEach(() => {
        eventBus.clear();
    });

    afterEach(() => {
        vi.useRealTimers();
        _renderer.canvas = null;
        _renderer.selectedObject = null;
    });

    it('an anchor toggle records a narrative build row with the new snapshot', () => {
        const recorder = new SessionRecorder();
        recorder.init({
            getBoard: () => [],
            getPlayfield: () => ({ width: 1000, height: 600 }),
            getEngineInfo: () => ({ gravityX: 0, gravityY: 1, enableSleeping: true }),
        });
        eventBus.emit('mode:changed', { oldMode: 'MENU', newMode: 'SANDBOX' });

        const ddm = makeAnchorSeam();
        const ball = mkPlacedBall(300, 300);
        ddm._objects = [ball];
        ddm._selectObject(ball);
        ddm._toggleAnchorSelected();

        const doc = recorder.toJSON();
        expect(doc.build[0].topic).toBe('mode:changed'); // visit-start row
        expect(doc.build[1].topic).toBe('object:anchored');
        expect(doc.build[1].data.ref).toBe(`ball#${ball.id}`);
        expect(doc.build[1].data.type).toBe('ball');
        expect(doc.build[1].data.isAnchored).toBe(true);
        expect(doc.build[1].data.snapshot.isAnchored).toBe(true);
        ball.dispose();
        ddm._objects = [];

        eventBus.emit('mode:changed', { oldMode: 'SANDBOX', newMode: 'MENU' });
    });
});

// ── Dynamics at play: anchored parts are physically alive ────────────

describe('dynamics at play (issue #67)', () => {
    let physics;

    beforeEach(() => {
        eventBus.clear();
    });

    afterEach(() => {
        if (physics) physics.dispose();
        physics = null;
    });

    it('an anchored ball falls under gravity — its pinned twin stays put', () => {
        physics = new PhysicsEngine(800, 600);
        const anchored = objectRegistry.create('ball', 400, 200);
        anchored.isAnchored = true;
        const pinned = objectRegistry.create('ball', 600, 200);
        pinned.isFixed = true; // the affordance shape, not the constructor gap (born-fixed bodies stay dynamic)
        physics.addObject(anchored);
        physics.addObject(pinned);
        const anchoredBody = anchored.bodies[0];
        const pinnedBody = pinned.bodies[0];
        expect(anchoredBody.isStatic).toBe(false);
        expect(pinnedBody.isStatic).toBe(true);

        for (let i = 0; i < 60; i++) physics.step(1000 / 60);

        expect(anchoredBody.position.y).toBeGreaterThan(260); // it fell
        expect(pinnedBody.position.y).toBe(200); // the pinned twin never moved
        anchored.dispose();
        pinned.dispose();
    });

    it('a play/reset cycle restores the anchored ball at its edit pose, anchor intact', () => {
        physics = new PhysicsEngine(800, 600);
        const ball = mkPlacedBall(500, 200);
        ball.isAnchored = true;
        const board = [ball];

        const snapshot = beginPlay(physics, board);
        for (let i = 0; i < 120; i++) physics.step(1000 / 60); // the ball fell somewhere
        expect(ball.bodies[0].position.y).toBeGreaterThan(260);

        resetSandboxBoard(physics, board, snapshot);
        expect(board).toHaveLength(1);
        expect(board[0].isAnchored).toBe(true);
        expect(board[0].isFixed).toBe(false);
        expect(board[0].x).toBe(500); // edit pose restored
        expect(board[0].y).toBe(200);
        board[0].dispose();
    });
});

// ── The campaign fixture: level-06 demonstrates the flow end-to-end ──

describe('level-06: the anchored-part campaign fixture (issue #67)', () => {
    it('the level order ships the fixture after level-05', () => {
        const order = levelManager.getLevelOrder();
        expect(order[order.length - 1]).toBe('level-06');
    });

    it('the fixture JSON is level-shaped: an anchored ball row, a bucket-goal zone, a palette', () => {
        expect(level06.id).toBe('level-06');
        expect(level06.goal).toEqual({ type: 'object_in_zone', targetType: 'ball', zoneId: 'bucket-goal' });
        const anchoredRows = level06.fixedObjects.filter((row) => row.isAnchored === true);
        expect(anchoredRows).toHaveLength(1);
        expect(anchoredRows[0]).toMatchObject({ type: 'ball', isFixed: false });
        expect(level06.fixedObjects.some((row) => row.type === 'bucket' && row.id === 'bucket-goal')).toBe(true);
        expect(typeof level06.availableParts).toBe('object');
    });

    it('the anchored ball cannot win via the palette — it never consumes availableParts', async () => {
        // 3 fixed rows on the board, palette untouched: ball 1 + ramp 1 remain.
        const session = new AgentSession();
        await session.loadLevel('level-06');
        expect(session.budget()).toEqual({ ball: 1, ramp: 1 }); // anchored scenery consumed nothing
    });

    it('is winnable in play, through the same rebuild seam main.js uses', async () => {
        const session = new AgentSession();
        await session.loadLevel('level-06');

        // The board rebuild honors the row rule: legacy scenery forced-fixed,
        // the anchored ball play-dynamic.
        const ball = [...(session.engine._objects ?? [])].find((o) => o.type === 'ball');
        expect(ball.isAnchored).toBe(true);
        expect(ball.bodies[0].isStatic).toBe(false);

        const result = session.trial({ seconds: 12 });
        expect(result.outcome).toBe('reached');
        expect(result.snapshot.some((row) => row.type === 'ball')).toBe(true);
    });
});

// ── Panel/fixture helpers ────────────────────────────────────────────

/** Level JSON with one legacy scenery row and one anchored row. */
function mkAnchoredLevelData() {
    return {
        id: 'anchored-roundtrip',
        name: 'Anchored Roundtrip',
        description: '',
        difficulty: 1,
        goal: { type: 'object_in_zone', targetType: 'ball', zoneId: 'bucket-goal' },
        fixedObjects: [
            { type: 'ramp', x: 400, y: 300, angle: 0.2, options: {} },
            { type: 'ball', x: 420, y: 250, angle: 0, isFixed: false, isAnchored: true, options: {} },
        ],
        availableParts: {},
        hints: [],
    };
}

/** Drain the board without leaking Matter bodies across tests. */
function disposeAnchoredBoard() {
    for (const obj of dragDropManager.getObjects()) obj.dispose();
}

/** Minimal DOM fake with children, listeners and attribute storage (editor-goal house style). */
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
        click() {
            for (const fn of handlers.click ?? []) fn({});
        },
        focus() {},
        set innerHTML(_v) { children.length = 0; },
        get innerHTML() { return ''; },
    };
    return node;
}

/** The palette panel singleton — booted beside the editor panel (issue #69). */
let palettePanel = null;

/** Stub the boot-guard DOM globals, then return a fresh EditorPanel instance. */
async function makeFreshPanel() {
    const container = fakeNode('div', 'editor-overlay');
    vi.stubGlobal('document', {
        readyState: 'loading',
        addEventListener: vi.fn(),
        getElementById: (id) => {
            if (id === 'editor-overlay') return container;
            if (id === 'palette-overlay') return fakeNode('div', 'palette-overlay');
            return null;
        },
        createElement: (tag) => fakeNode(tag),
        createTextNode: (t) => ({ textContent: t, children: [] }),
    });
    vi.stubGlobal('window', { addEventListener: vi.fn() });
    vi.stubGlobal('requestAnimationFrame', vi.fn());
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    const { default: EditorPanel } = await import('../js/ui/EditorPanel.js');
    ({ palettePanel } = await import('../js/ui/PalettePanel.js'));
    const panel = new EditorPanel();
    panel.init();
    // The palette is its own floating panel now (issue #69): init it next to
    // the editor panel, mirroring main.js — its SANDBOX-entry reset then
    // clears the singleton's palette state between tests.
    palettePanel.init();
    eventBus.emit('mode:changed', { oldMode: 'MENU', newMode: 'SANDBOX' });
    return panel;
}

// ── Harness ──────────────────────────────────────────────────────────

/** A placed ball — the shape _placeObject actually creates (not fixed). */
const mkPlacedBall = (x = 300, y = 300) => objectRegistry.create('ball', x, y);

/** Fresh drag-drop seam over a stubbed playfield canvas (editor-pin style). */
function makeAnchorSeam(mode = 'SANDBOX') {
    const ddm = new DragDropManager();
    ddm._enabled = true;
    ddm._mode = mode;
    _renderer.canvas = { width: 800, height: 600 };
    return ddm;
}

/** ctx mock (editor-goal.test.js house style). */
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