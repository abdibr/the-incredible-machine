/**
 * Click-to-connect tying via squares — GitHub issue #52, the first slice of
 * the rope connection redesign (ADR 0007 decision 2).
 *
 * Seams under test:
 * - ConnectFlow (js/ui/ConnectFlow.js) — the state machine the drag-drop
 *   handler delegates to: clicking a free rope endpoint square seeks; the
 *   preview line follows the cursor; clicking a glowing target square ties;
 *   Esc-style cancel(), re-clicking the seeking square, and entering PLAY
 *   cancel cleanly at the last settled state; clicking a tied square unties
 *   one knot, keeping the rest (per-knot untie, ADR 0007 decision 8).
 * - Rope.detachEndpoint — the per-knot untie seam; the freed physical link
 *   drops on the next reconcile step.
 * - DragDropManager._onCanvasPointerDown / _onKeyDown — the delegation
 *   seams: squares consume clicks before selection, Esc cancels the seek.
 * - Renderer._drawConnectSquares — square handles, seek preview and glow;
 *   edit modes (EDITING/SANDBOX) only, nothing in PLAY.
 * - Snapshot round-trip — ties made via the click flow restore through
 *   serializePlacedBoard/restorePlacedFromSnapshot's two-phase ordinal bind.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { eventBus } from '../js/EventBus.js';
import ConnectFlow from '../js/ui/ConnectFlow.js';
import Rope from '../js/objects/Rope.js';
import Balloon from '../js/objects/Balloon.js';
import Bucket from '../js/objects/Bucket.js';
import { PhysicsEngine } from '../js/engine/PhysicsEngine.js';
import { serializePlacedBoard, restorePlacedFromSnapshot } from '../js/reset/levelReset.js';
import { registerAllObjects } from '../js/objects/registerAllObjects.js';
import DragDropManager from '../js/ui/DragDropManager.js';
import Renderer from '../js/render/Renderer.js';

describe('ConnectFlow — the click-to-connect state machine', () => {
    let flow;

    beforeEach(() => {
        flow = new ConnectFlow();
        flow._mode = 'EDITING'; // the stage gate under test; PLAY rejections pinned below
    });

    it('a click on a free rope endpoint square enters a seek, preview anchored at the cursor', () => {
        const rope = new Rope(300, 100, { length: 40 });
        const end = rope.bodies[rope.bodies.length - 1].position;

        const consumed = flow.handlePointerDown(end.x + 2, end.y + 2, [rope]);

        expect(consumed).toBe(true);
        expect(flow.seek).toEqual({ rope, endpoint: 1 });
        expect(flow.preview).toEqual({ x: end.x + 2, y: end.y + 2 });
        rope.dispose();
    });

    it('both tie points seek — the anchored start and the free end alike', () => {
        const rope = new Rope(300, 100, { length: 40 });
        const anchor = rope.bodies[0].position;

        expect(flow.handlePointerDown(anchor.x, anchor.y, [rope])).toBe(true);
        expect(flow.seek).toEqual({ rope, endpoint: 0 });
        rope.dispose();
    });

    it('the preview follows the cursor while seeking; cancel clears it and it stays cleared', () => {
        const rope = new Rope(300, 100, { length: 40 });
        const end = rope.bodies[rope.bodies.length - 1].position;
        flow.handlePointerDown(end.x, end.y, [rope]);

        flow.setPreview(420, 250);
        expect(flow.preview).toEqual({ x: 420, y: 250 });

        flow.cancel();
        expect(flow.seek).toBe(null);
        expect(flow.preview).toBe(null);

        flow.setPreview(1, 1); // no seek in flight → nothing to preview
        expect(flow.preview).toBe(null);
        rope.dispose();
    });

    it('clicking a target square while seeking ties the knot and ends the seek', () => {
        const rope = new Rope(300, 100, { length: 40 });
        const balloon = new Balloon(500, 300);
        const end = rope.bodies[rope.bodies.length - 1].position;
        const knot = balloon.getAttachmentWorldPoint('knot');

        flow.handlePointerDown(end.x, end.y, [rope, balloon]); // seek
        const consumed = flow.handlePointerDown(knot.x, knot.y, [rope, balloon]);

        expect(consumed).toBe(true);
        expect(flow.seek).toBe(null);
        expect(rope.getAttachmentRefs()).toContainEqual({ endpoint: 1, target: balloon, pointId: 'knot' });
        rope.dispose();
        balloon.dispose();
    });

    it('a click that ties nothing is swallowed while the seek holds the pointer', () => {
        const rope = new Rope(300, 100, { length: 40 });
        const end = rope.bodies[rope.bodies.length - 1].position;
        flow.handlePointerDown(end.x, end.y, [rope]);

        // Seek is modal (AC: Esc / re-click the square are the exits): a
        // click that is neither a tie nor a cancel does nothing but belongs
        // to the seek — it must not fall through to selection/move.
        expect(flow.handlePointerDown(500, 300, [rope])).toBe(true);
        expect(flow.seek).toEqual({ rope, endpoint: 1 });
        expect(flow.preview).toEqual({ x: 500, y: 300 });
        expect(rope.getAttachmentRefs()).toEqual([]);
        rope.dispose();
    });

    it('a click-tied knot realizes as an engine constraint link on the next physics step', () => {
        const physics = new PhysicsEngine(800, 600);
        const rope = new Rope(300, 100, { length: 40 });
        const balloon = new Balloon(500, 300);
        physics.addObject(rope);
        physics.addObject(balloon);

        const end = rope.bodies[rope.bodies.length - 1].position;
        const knot = balloon.getAttachmentWorldPoint('knot');
        flow.handlePointerDown(end.x, end.y, [rope, balloon]);
        flow.handlePointerDown(knot.x, knot.y, [rope, balloon]);

        physics.step(16.67); // the lazy per-step reconcile (ADR 0004 seam)
        expect(physics.getAttachedConstraints()).toHaveLength(1);

        physics.dispose();
        rope.dispose();
        balloon.dispose();
    });

    it('SANDBOX seeks exactly like EDITING (both edit stages)', () => {
        const rope = new Rope(300, 100, { length: 40 });
        flow._mode = 'SANDBOX';
        const end = rope.bodies[rope.bodies.length - 1].position;

        expect(flow.handlePointerDown(end.x, end.y, [rope])).toBe(true);
        expect(flow.seek).toEqual({ rope, endpoint: 1 });
        rope.dispose();
    });

    it('PLAY boards tie nothing — a square click is left to the drag-drop handler', () => {
        const rope = new Rope(300, 100, { length: 40 });
        flow._mode = 'PLAYING';
        const end = rope.bodies[rope.bodies.length - 1].position;

        expect(flow.handlePointerDown(end.x, end.y, [rope])).toBe(false);
        expect(flow.seek).toBe(null);
        expect(rope.getAttachmentRefs()).toEqual([]);
        rope.dispose();
    });

    it('a stage change cancels an in-flight seek at the last settled state', () => {
        const rope = new Rope(300, 100, { length: 40 });
        const end = rope.bodies[rope.bodies.length - 1].position;
        flow.init();
        flow.handlePointerDown(end.x, end.y, [rope]);
        expect(flow.seek).toEqual({ rope, endpoint: 1 });

        eventBus.emit('mode:changed', { oldMode: 'EDITING', newMode: 'PLAYING' });

        expect(flow.seek).toBe(null);
        expect(flow.preview).toBe(null);
        expect(rope.getAttachmentRefs()).toEqual([]); // a seek tied nothing

        rope.dispose();
        flow._unsubscribeMode?.(); // keep the shared bus clean for later tests
    });

    it('clicking a tied square unties one knot and keeps the rest (per-knot untie)', () => {
        const rope = new Rope(300, 100, { length: 40 });
        const near = new Balloon(500, 300);
        const far = new Balloon(700, 300);
        const end = rope.bodies[rope.bodies.length - 1].position;
        rope.attachEndpoint(1, near, 'knot');
        rope.attachEndpoint(1, far, 'knot');

        // The first click unties the knot whose target sits nearest the click
        // (the far knot stays — decision 8: untie stays per-knot).
        expect(flow.handlePointerDown(end.x, end.y, [rope, near, far])).toBe(true);
        expect(flow.seek).toBe(null); // untie is not a seek
        expect(rope.getAttachmentRefs()).toContainEqual({ endpoint: 1, target: far, pointId: 'knot' });
        expect(rope.getAttachmentRefs()).not.toContainEqual({ endpoint: 1, target: near, pointId: 'knot' });

        // The second click frees the remaining knot.
        expect(flow.handlePointerDown(end.x, end.y, [rope, near, far])).toBe(true);
        expect(rope.getAttachmentRefs()).toEqual([]);
        rope.dispose();
        near.dispose();
        far.dispose();
    });

    it('a click-tied knot realizes as an engine link, and its untie drops that link on the next step', () => {
        const physics = new PhysicsEngine(800, 600);
        const rope = new Rope(300, 100, { length: 40 });
        const balloon = new Balloon(500, 300);
        physics.addObject(rope);
        physics.addObject(balloon);
        const end = rope.bodies[rope.bodies.length - 1].position;
        const knot = balloon.getAttachmentWorldPoint('knot');

        flow.handlePointerDown(end.x, end.y, [rope, balloon]);
        flow.handlePointerDown(knot.x, knot.y, [rope, balloon]);
        physics.step(16.67); // the lazy per-step reconcile (ADR 0004 seam)
        expect(physics.getAttachedConstraints()).toHaveLength(1);

        // The realized link pinned the end onto the knot — untie clicks aim
        // at wherever the square lives NOW.
        const endNow = rope.bodies[rope.bodies.length - 1].position;
        flow.handlePointerDown(endNow.x, endNow.y, [rope, balloon]); // tied square click → untie
        expect(rope.getAttachmentRefs()).toEqual([]);
        physics.step(16.67);
        expect(physics.getAttachedConstraints()).toHaveLength(0);

        physics.dispose();
        rope.dispose();
        balloon.dispose();
    });

    it('severed ropes expose no squares — nothing to tie, nothing to untie', () => {
        const rope = new Rope(300, 100, { severed: true });
        const anchor = rope.bodies[0].position;

        expect(flow.handlePointerDown(anchor.x, anchor.y, [rope])).toBe(false);
        expect(flow.getEndpointSquares([rope], null)).toEqual([]);
        rope.dispose();
    });

    it('hover reveals a free square; tied and seeking squares stay visible unhovered', () => {
        const rope = new Rope(300, 100, { length: 40 });
        const balloon = new Balloon(700, 300);
        rope.attachEndpoint(0, balloon, 'knot'); // the anchor square is born tied
        const end = rope.bodies[rope.bodies.length - 1].position;

        let squares = flow.getEndpointSquares([rope], null);
        expect(squares).toHaveLength(2);
        expect(squares[0].tied).toBe(true);
        expect(squares[0].visible).toBe(true); // tieable structure stays visible
        expect(squares[1].tied).toBe(false);
        expect(squares[1].visible).toBe(false); // free squares are hover-revealed

        squares = flow.getEndpointSquares([rope], { x: end.x + 3, y: end.y + 3 });
        expect(squares[1].visible).toBe(true);
        expect(squares[1].hovered).toBe(true);

        flow.handlePointerDown(end.x + 3, end.y + 3, [rope]);
        squares = flow.getEndpointSquares([rope], null);
        expect(squares[1].visible).toBe(true); // the seeking square holds its seat
        expect(squares[1].seeking).toBe(true);

        flow.cancel();
        rope.dispose();
        balloon.dispose();
    });

    it('every attachment point glows during a seek; hover matters only outside one', () => {
        const rope = new Rope(300, 100, { length: 40 });
        const balloon = new Balloon(700, 300);
        const bucket = new Bucket(200, 500);
        const knot = balloon.getAttachmentWorldPoint('knot');

        let targets = flow.getTieSquares([rope, balloon, bucket], { x: knot.x, y: knot.y });
        expect(targets).toHaveLength(2); // balloon knot + bucket rim
        expect(targets[0].visible).toBe(true); // hover shows the faint square
        expect(targets[0].glows).toBe(false); // no seek in flight yet

        const end = rope.bodies[rope.bodies.length - 1].position;
        flow.handlePointerDown(end.x, end.y, [rope]);
        targets = flow.getTieSquares([rope, balloon, bucket], null);
        expect(targets).toHaveLength(2);
        expect(targets[0].glows).toBe(true); // valid targets glow: click one to tie
        expect(targets[0].visible).toBe(true);

        flow.cancel();
        rope.dispose();
        balloon.dispose();
        bucket.dispose();
    });
});

describe('Click-flow ties survive the snapshot round-trip (AC)', () => {
    let flow;

    beforeEach(() => {
        registerAllObjects(); // registry deserialize for the restore phase
        flow = new ConnectFlow();
        flow._mode = 'EDITING';
    });

    it('ties made via the flow serialize to ordinal tokens and rebind on restore', () => {
        const balloon = new Balloon(700, 300);  // board ordinal 0
        const bucket = new Bucket(200, 500);    // board ordinal 1
        const rope = new Rope(300, 100, { length: 40 }); // board ordinal 2
        const board = [balloon, bucket, rope];
        const end = rope.bodies[rope.bodies.length - 1].position;
        const anchor = rope.bodies[0].position;
        const knot = balloon.getAttachmentWorldPoint('knot');
        const rim = bucket.getAttachmentWorldPoint('rim');

        flow.handlePointerDown(end.x, end.y, board);
        flow.handlePointerDown(knot.x, knot.y, board);
        flow.handlePointerDown(anchor.x, anchor.y, board);
        flow.handlePointerDown(rim.x, rim.y, board);
        expect(rope.getAttachmentRefs()).toHaveLength(2);

        const snapshot = serializePlacedBoard(board);
        expect(snapshot[2].attachments).toContainEqual({
            endpoint: 1, targetType: 'balloon', targetOrdinal: 0, pointId: 'knot',
        });
        expect(snapshot[2].attachments).toContainEqual({
            endpoint: 0, targetType: 'bucket', targetOrdinal: 1, pointId: 'rim',
        });

        const board2 = [];
        restorePlacedFromSnapshot(board2, snapshot);
        const balloon2 = board2.find((o) => o.type === 'balloon');
        const bucket2 = board2.find((o) => o.type === 'bucket');
        const rope2 = board2.find((o) => o.type === 'rope');
        expect(rope2.getAttachmentRefs()).toContainEqual({ endpoint: 1, target: balloon2, pointId: 'knot' });
        expect(rope2.getAttachmentRefs()).toContainEqual({ endpoint: 0, target: bucket2, pointId: 'rim' });

        for (const obj of board) obj.dispose();
        for (const obj of board2) obj.dispose();
    });
});

describe('DragDropManager delegates pointer handling to the connect flow', () => {
    let ddm;

    beforeEach(() => {
        ddm = new DragDropManager();
        ddm._enabled = true;
        ddm._connectFlow._mode = 'EDITING';
    });

    it('a square click is consumed before selection can claim it', () => {
        const rope = new Rope(300, 100, { length: 40 });
        const balloon = new Balloon(700, 300);
        ddm._objects = [rope, balloon];
        const end = rope.bodies[rope.bodies.length - 1].position;

        ddm._onCanvasPointerDown(end.x, end.y);

        expect(ddm._connectFlow.seek).toEqual({ rope, endpoint: 1 });
        expect(ddm._selectedObject).toBe(null); // the seek ate the click
        rope.dispose();
        balloon.dispose();
    });

    it('a click that misses every square falls through to normal selection', () => {
        const rope = new Rope(300, 100, { length: 40 });
        const balloon = new Balloon(700, 300);
        ddm._objects = [rope, balloon];

        ddm._onCanvasPointerDown(60, 60); // empty space: no squares, no selection
        expect(ddm._connectFlow.seek).toBe(null);
        expect(ddm._selectedObject).toBe(null);

        ddm._onCanvasPointerDown(700, 300); // the balloon itself
        expect(ddm._connectFlow.seek).toBe(null);
        expect(ddm._selectedObject).toBe(balloon);
        rope.dispose();
        balloon.dispose();
    });

    it('Escape cancels an in-flight seek', () => {
        const rope = new Rope(300, 100, { length: 40 });
        ddm._objects = [rope];
        const end = rope.bodies[rope.bodies.length - 1].position;

        ddm._onCanvasPointerDown(end.x, end.y);
        expect(ddm._connectFlow.seek).toEqual({ rope, endpoint: 1 });

        ddm._onKeyDown({ code: 'Escape', target: { tagName: 'DIV' }, preventDefault() {} });

        expect(ddm._connectFlow.seek).toBe(null);
        expect(ddm._connectFlow.preview).toBe(null);
        expect(rope.getAttachmentRefs()).toEqual([]);
        rope.dispose();
    });
});

describe('Renderer draws the connect-flow squares (edit modes only)', () => {
    let flow;

    beforeEach(() => {
        flow = new ConnectFlow();
        flow._mode = 'EDITING';
    });

    it('hover reveals a free square; tied squares persist without hover; squares sit on the tie points', () => {
        const rope = new Rope(300, 100, { length: 40 });
        const balloon = new Balloon(700, 300); // no hover there, no seek → its knot square hides
        rope.attachEndpoint(0, balloon, 'knot');
        const end = rope.bodies[rope.bodies.length - 1].position;
        const r = new Renderer();
        r._mode = 'EDITING';
        r.setConnectFlow(flow);
        r.hoverPoint = { x: end.x, y: end.y };
        const ctx = makeDrawCtx();

        r._drawConnectSquares(ctx, [rope, balloon]);

        const rects = ctx.fillRect.mock.calls.map(([x, y, w]) => ({ x, y, w }));
        expect(rects).toContainEqual({ x: 300 - 7, y: 100 - 7, w: 14 }); // tied anchor square
        expect(rects).toContainEqual({ x: end.x - 7, y: end.y - 7, w: 14 }); // hover-revealed free end
        expect(ctx.fillRect).toHaveBeenCalledTimes(2); // nothing for the unhovered balloon knot
        expect(ctx.fillStyles).toContainEqual('rgba(184, 134, 11, 0.85)'); // tied gold
        rope.dispose();
        balloon.dispose();
    });

    it('a seek draws the preview line to the cursor and every target square glows', () => {
        const rope = new Rope(300, 100, { length: 40 });
        const balloon = new Balloon(700, 300);
        const bucket = new Bucket(200, 500);
        const end = rope.bodies[rope.bodies.length - 1].position;
        const knot = balloon.getAttachmentWorldPoint('knot');
        flow.handlePointerDown(end.x, end.y, [rope, balloon, bucket]);
        flow.setPreview(500, 400);
        const r = new Renderer();
        r._mode = 'EDITING';
        r.setConnectFlow(flow);
        r.hoverPoint = null;
        const ctx = makeDrawCtx();

        r._drawConnectSquares(ctx, [rope, balloon, bucket]);

        // Preview line: from the seeking square to the cursor
        expect(ctx.moveTo).toHaveBeenCalledWith(end.x, end.y);
        expect(ctx.lineTo).toHaveBeenCalledWith(500, 400);
        // Both targets glow (click one to tie) at their world points
        const rects = ctx.fillRect.mock.calls.map(([x, y]) => ({ x, y }));
        expect(rects).toContainEqual({ x: knot.x - 9, y: knot.y - 9 });
        const rim = bucket.getAttachmentWorldPoint('rim');
        expect(rects).toContainEqual({ x: rim.x - 9, y: rim.y - 9 });
        expect(ctx.fillStyles).toContainEqual('rgba(64, 192, 64, 0.25)'); // glow green
        expect(ctx.strokeStyles).toContainEqual('#2f9e2f'); // preview + glow outline
        rope.dispose();
        balloon.dispose();
        bucket.dispose();
    });

    it('PLAY boards draw nothing — squares, preview and glow are edit-only', () => {
        const rope = new Rope(300, 100, { length: 40 });
        const end = rope.bodies[rope.bodies.length - 1].position;
        flow.handlePointerDown(end.x, end.y, [rope]); // a seek in flight
        flow.setPreview(500, 400);
        const r = new Renderer();
        r.setConnectFlow(flow);
        r._mode = 'PLAYING';
        r.hoverPoint = { x: end.x, y: end.y };
        const ctx = makeDrawCtx();

        r._drawConnectSquares(ctx, [rope]);

        expect(ctx.fillRect).not.toHaveBeenCalled();
        expect(ctx.strokeRect).not.toHaveBeenCalled();
        expect(ctx.lineTo).not.toHaveBeenCalled();
        rope.dispose();
    });
});

function makeDrawCtx() {
    const ctx = {};
    const strokeStyleLog = [];
    const fillStyleLog = [];
    for (const fn of [
        'save', 'restore', 'beginPath', 'moveTo', 'lineTo',
        'arc', 'fillRect', 'strokeRect', 'fill', 'stroke', 'setLineDash',
    ]) {
        ctx[fn] = vi.fn();
    }
    // Rendering code assigns styles as it goes; keep the whole history.
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