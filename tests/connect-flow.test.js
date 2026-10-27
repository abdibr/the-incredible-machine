/**
 * Click-to-connect tying via squares — GitHub issue #52, the first slice of
 * the rope connection redesign (ADR 0007 decision 2), plus issue #54's
 * pinned-rope fixed length and beyond-reach refusal (ADR 0007 decision 4).
 *
 * #54 seams under test:
 * - ConnectFlow.setPreview — a free-end seek reels the rope to the cursor
 *   (rope.relayFreeEnd: the tie square rides the cursor, clamped); an
 *   anchor-square seek only aims (the pin does not follow the hand).
 * - ConnectFlow.getTieSquares — glow = tieable: a target glows while a
 *   seek aims at it only within the rope's reach (Rope.isPointWithinReach).
 * - ConnectFlow.handlePointerDown — a tie click beyond reach is refused:
 *   no knot, the seek survives, refusal feedback paints via the flow's
 *   refusal record (red handle flash + "rope too short" badge, painted by
 *   Renderer._drawConnectSquares).
 * - Rope.lengthFrozen — derived from the knots; the first tie freezes the
 *   hand-set length; the snapshot carries it (serialize option
 *   lengthFrozen) and restore re-derives it through the two-phase bind.
 * - DragDropManager delegation — a refused tie click is still consumed by
 *   the seek (no selection fall-through).
 *
 * #52 seams under test:
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
import ConnectFlow, { CONNECT_HIT_RADIUS, REACH_AIM_TOLERANCE } from '../js/ui/ConnectFlow.js';
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

    it('one number, one meaning: the click hit radius and the reach aim tolerance are separate constants', () => {
        expect(CONNECT_HIT_RADIUS).toBe(14);
        expect(REACH_AIM_TOLERANCE).toBe(14);
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
        // ADR 0007 decision 4: the hand reels the free end out to the
        // target first — the seek's move re-lays the rope beneath the aim,
        // putting the tie click inside the seeking square's own radius:
        // the tie wins the seat over the re-click cancel.
        flow.setPreview(knot.x, knot.y);
        const consumed = flow.handlePointerDown(knot.x, knot.y, [rope, balloon]);

        expect(consumed).toBe(true);
        expect(flow.seek).toBe(null);
        expect(rope.getAttachmentRefs()).toContainEqual({ endpoint: 1, target: balloon, pointId: 'knot' });
        rope.dispose();
        balloon.dispose();
    });

    it('an anchor-side tie pulls the target to the anchor so the pin realizes with zero gap', () => {
        const rope = new Rope(300, 100, { length: 40 });
        const balloon = new Balloon(320, 74.4); // knot at (320, 100), on the anchor's reach
        const anchor = rope.bodies[0].position;

        // The anchored start only aims (no re-lay): the knot click must
        // already sit within reach of the anchor (per-segment reach covers
        // both endpoints with the same anchor-centered measure).
        flow.handlePointerDown(anchor.x, anchor.y, [rope, balloon]); // seek endpoint 0
        const knot = balloon.getAttachmentWorldPoint('knot');
        flow.handlePointerDown(knot.x, knot.y, [rope, balloon]); // tie the knot to it

        expect(rope.getAttachmentRefs()).toContainEqual({ endpoint: 0, target: balloon, pointId: 'knot' });

        // The pull: the knot realizes at the anchor itself (zero gap) — the
        // first play step does not slam the tied balloon across a residual.
        const pinned = balloon.getAttachmentWorldPoint('knot');
        expect(pinned.x).toBeCloseTo(anchor.x, 5);
        expect(pinned.y).toBeCloseTo(anchor.y, 5);

        rope.dispose();
        balloon.dispose();
    });

    it('an anchor-side tie pull never parks the target inside a boundary wall', () => {
        flow.setPlayfield(800, 600);
        const rope = new Rope(15, 300, { length: 80 });
        const balloon = new Balloon(50, 274.4); // knot at (50, 300); the pull would push the hull past the left wall
        const anchor = rope.bodies[0].position; // (15, 300)

        flow.handlePointerDown(anchor.x, anchor.y, [rope, balloon]);
        const knot = balloon.getAttachmentWorldPoint('knot');
        flow.handlePointerDown(knot.x, knot.y, [rope, balloon]);

        expect(rope.getAttachmentRefs()).toContainEqual({ endpoint: 0, target: balloon, pointId: 'knot' });
        // Pulled toward the wall, but clamped: the balloon's painted bounds
        // (the envelope ± the knot's sway) stay inside the playfield it was
        // given, and the pull moved the target toward the anchor.
        const b = balloon.bounds;
        expect(b.x).toBeGreaterThanOrEqual(0);
        expect(b.y).toBeGreaterThanOrEqual(0);
        expect(b.x + b.width).toBeLessThanOrEqual(800);
        expect(b.y + b.height).toBeLessThanOrEqual(600);
        expect(balloon.x).toBeLessThan(50);

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
        // The hand reels the free end to the target first (issue #54: the
        // seek's move re-lays the rope, so the tie lands within reach).
        flow.setPreview(knot.x, knot.y);
        flow.handlePointerDown(knot.x, knot.y, [rope, balloon]);

        physics.step(16.67); // the lazy per-step reconcile (ADR 0004 seam)
        expect(physics.getAttachedConstraints()).toHaveLength(1);
        // The tie covers its own knot: the length grew from 40 to the
        // tied span times the 6/5.5 chain-rest factor.
        expect(rope._length).toBeCloseTo(Math.hypot(200, 225.6) * 6 / 5.5, 3);

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
        // (decision 8: untie stays per-knot). The covering grow re-lays the
        // chain so the rope's end square rides onto the last-tied knot's
        // target — far — so the click at `end` lands nearest far, and far
        // unties first.
        expect(flow.handlePointerDown(end.x, end.y, [rope, near, far])).toBe(true);
        expect(flow.seek).toBe(null); // untie is not a seek
        expect(rope.getAttachmentRefs()).toContainEqual({ endpoint: 1, target: near, pointId: 'knot' });
        expect(rope.getAttachmentRefs()).not.toContainEqual({ endpoint: 1, target: far, pointId: 'knot' });

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
        flow.setPreview(knot.x, knot.y); // reel the free end to the target (issue #54)
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

    it('glow = tieable: in-reach targets glow during a seek; out-of-reach ones stay faint', () => {
        const rope = new Rope(300, 100, { length: 40 });
        const balloon = new Balloon(320, 104);  // in reach: knot 35.8px from the anchor
        const bucket = new Bucket(200, 500);    // beyond reach: rim 393px out
        const knot = balloon.getAttachmentWorldPoint('knot');
        const rim = bucket.getAttachmentWorldPoint('rim');

        let targets = flow.getTieSquares([rope, balloon, bucket], { x: knot.x, y: knot.y });
        expect(targets).toHaveLength(2); // balloon knot + bucket rim
        expect(targets[0].visible).toBe(true); // hover shows the faint square
        expect(targets[0].glows).toBe(false); // no seek in flight yet

        const end = rope.bodies[rope.bodies.length - 1].position;
        flow.handlePointerDown(end.x, end.y, [rope]);
        targets = flow.getTieSquares([rope, balloon, bucket], null);
        expect(targets).toHaveLength(2);
        expect(targets[0].glows).toBe(true); // in reach: click one to tie
        expect(targets[0].visible).toBe(true);
        expect(targets[1].glows).toBe(false); // beyond reach: a tie click would refuse
        expect(targets[1].visible).toBe(true); // still shown, faint, during the seek

        // The hand reels the rope out toward the rim: reach follows the
        // drag, and the far target becomes tieable mid-seek.
        flow.setPreview(rim.x, rim.y);
        targets = flow.getTieSquares([rope, balloon, bucket], null);
        expect(targets[1].glows).toBe(true);
        expect(targets[0].glows).toBe(true);

        flow.cancel();
        rope.dispose();
        balloon.dispose();
        bucket.dispose();
    });
    it('an anchor-square seek aims without re-laying (the pin does not follow the hand)', () => {
        const rope = new Rope(300, 100, { length: 40 });

        flow.handlePointerDown(300, 100, [rope]); // anchor-square seek
        flow.setPreview(640, 360);

        expect(flow.seek).toEqual({ rope, endpoint: 0 });
        expect(flow.preview).toEqual({ x: 640, y: 360 });
        expect(rope._length).toBe(40); // untouched: the pin is not re-laid
        const end = rope.bodies[rope.bodies.length - 1].position;
        expect(end.y).toBeCloseTo(100 + (40 * 5.5) / 6, 5); // the square stayed laid
        rope.dispose();
    });

    it("a frozen rope's free-end drag rides the frozen reach circle — never beyond length", () => {
        const rope = new Rope(300, 100);
        const balloon = new Balloon(320, 74.4); // knot at (320, 100): ties the anchor
        const end = rope.bodies[rope.bodies.length - 1].position;

        flow.handlePointerDown(300, 100, [rope, balloon]); // anchor-square seek
        expect(flow.handlePointerDown(320, 100, [rope, balloon])).toBe(true); // tie: frozen at 100
        expect(rope.lengthFrozen).toBe(true);
        expect(rope._length).toBe(100);

        flow.handlePointerDown(end.x, end.y, [rope, balloon]); // free-end seek on the tied rope
        flow.setPreview(300, 700); // a far demand clamps at the frozen span
        expect(rope._length).toBe(100);
        expect(rope._endPoint).toEqual({ x: 300, y: 200 });
        flow.setPreview(303, 106); // an inward demand rides the same frozen circle
        expect(rope._length).toBe(100);
        const d = Math.hypot(3, 6);
        expect(rope._endPoint.x).toBeCloseTo(300 + (3 / d) * 100, 5);
        expect(rope._endPoint.y).toBeCloseTo(100 + (6 / d) * 100, 5);
        rope.dispose();
        balloon.dispose();
    });

    it('a tie click beyond the reach is refused — no knot, seek intact, feedback armed', () => {
        const rope = new Rope(300, 100, { length: 40 });
        const balloon = new Balloon(700, 300); // knot 459px out: far beyond the 40px rope
        const end = rope.bodies[rope.bodies.length - 1].position;
        const knot = balloon.getAttachmentWorldPoint('knot');

        flow.handlePointerDown(end.x, end.y, [rope, balloon]); // seek
        expect(flow.handlePointerDown(knot.x, knot.y, [rope, balloon])).toBe(true);

        expect(flow.seek).toEqual({ rope, endpoint: 1 }); // the seek survives the refusal
        expect(rope.getAttachmentRefs()).toEqual([]); // no knot was created
        expect(rope.lengthFrozen).toBe(false);
        expect(flow.refusal).toMatchObject({ x: knot.x, y: knot.y });
        const squares = flow.getEndpointSquares([rope], null);
        expect(squares[1].refused).toBe(true); // the handle flashes red

        // The hand reels the rope out to the target: the SAME click now ties.
        flow.setPreview(knot.x, knot.y);
        expect(flow.handlePointerDown(knot.x, knot.y, [rope, balloon])).toBe(true);
        expect(rope.getAttachmentRefs()).toContainEqual({ endpoint: 1, target: balloon, pointId: 'knot' });
        expect(flow.seek).toBe(null);
        expect(flow.refusal).toBe(null); // a settled tie sweeps the flash
        expect(rope._length).toBeCloseTo(Math.hypot(400, 225.6) * 6 / 5.5, 3);
        rope.dispose();
        balloon.dispose();
    });

    it('the refusal feedback decays on its own and a cancel sweeps it', () => {
        const rope = new Rope(300, 100, { length: 40 });
        const balloon = new Balloon(700, 300);
        const end = rope.bodies[rope.bodies.length - 1].position;
        const knot = balloon.getAttachmentWorldPoint('knot');
        flow.handlePointerDown(end.x, end.y, [rope, balloon]);
        flow.handlePointerDown(knot.x, knot.y, [rope, balloon]); // refused
        expect(flow.refusal).not.toBe(null);
        let squares = flow.getEndpointSquares([rope], null);
        expect(squares[1].refused).toBe(true);

        flow._refusal.until = 0; // the flash expired
        expect(flow.refusal).toBe(null);
        squares = flow.getEndpointSquares([rope], null);
        expect(squares[1].refused).toBe(false);

        flow._refuse(knot.x, knot.y); // a fresh refusal repaints
        expect(flow.refusal).not.toBe(null);
        flow.cancel(); // any seek exit sweeps it
        expect(flow.refusal).toBe(null);
        rope.dispose();
        balloon.dispose();
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
        const balloon = new Balloon(320, 104);  // board ordinal 0 — knot 35.8px from the rope's anchor: in reach
        const bucket = new Bucket(280, 132);    // board ordinal 1 — rim 23.3px from the anchor: in reach
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
        // The first tie froze the length: it and the flag ride the row.
        expect(snapshot[2].options.length).toBe(40);
        expect(snapshot[2].options.lengthFrozen).toBe(true);
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
        expect(rope2._length).toBe(40);
        expect(rope2.lengthFrozen).toBe(true); // the bind refroze it

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

    it('a refused tie click is still consumed by the seek (no selection fall-through)', () => {
        const rope = new Rope(300, 100, { length: 40 });
        const balloon = new Balloon(700, 300);
        ddm._objects = [rope, balloon];
        const end = rope.bodies[rope.bodies.length - 1].position;
        const knot = balloon.getAttachmentWorldPoint('knot');

        ddm._onCanvasPointerDown(end.x, end.y);
        ddm._onCanvasPointerDown(knot.x, knot.y); // beyond reach → refused

        expect(ddm._connectFlow.seek).toEqual({ rope, endpoint: 1 }); // seek intact
        expect(ddm._selectedObject).toBe(null);
        rope.dispose();
        balloon.dispose();
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

    it('a seek draws the preview line to the cursor and in-reach targets glow', () => {
        const rope = new Rope(300, 100, { length: 40 });
        const balloon = new Balloon(320, 104); // knot 35.8px from the anchor: in reach
        const bucket = new Bucket(280, 132);   // rim 23.3px from the anchor: in reach
        const knot = balloon.getAttachmentWorldPoint('knot');
        // An anchor-square seek: the pin is not re-layed, so the preview
        // line stays the meaningful seek affordance here.
        flow.handlePointerDown(300, 100, [rope, balloon, bucket]);
        flow.setPreview(500, 400);
        const r = new Renderer();
        r._mode = 'EDITING';
        r.setConnectFlow(flow);
        r.hoverPoint = null;
        const ctx = makeDrawCtx();

        r._drawConnectSquares(ctx, [rope, balloon, bucket]);

        // Preview line: from the seeking square to the cursor
        expect(ctx.moveTo).toHaveBeenCalledWith(300, 100);
        expect(ctx.lineTo).toHaveBeenCalledWith(500, 400);
        // Both in-reach targets glow (click one to tie) at their world points
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

    it('a refused tie paints the seeking handle red with a rope-too-short badge', () => {
        const rope = new Rope(300, 100, { length: 40 });
        const balloon = new Balloon(700, 300); // knot 459px out: beyond reach
        const end = rope.bodies[rope.bodies.length - 1].position;
        const knot = balloon.getAttachmentWorldPoint('knot');
        flow.handlePointerDown(end.x, end.y, [rope]); // seek
        flow.handlePointerDown(knot.x, knot.y, [rope, balloon]); // refused

        const r = new Renderer();
        r._mode = 'EDITING';
        r.setConnectFlow(flow);
        r.hoverPoint = null;
        const ctx = makeDrawCtx();

        r._drawConnectSquares(ctx, [rope, balloon]);

        // The seeking handle flashes red while the refusal lives...
        expect(ctx.fillStyles).toContainEqual('rgba(232, 76, 76, 0.9)');
        // ...and the badge marks the refused aim.
        expect(ctx.fillText).toHaveBeenCalledWith('rope too short', knot.x, knot.y + 23);
        expect(ctx.fillStyles).toContainEqual('#ffd9d9'); // the badge's text
        const rects = ctx.fillRect.mock.calls.map(([x, y, w, h]) => ({ x, y, w, h }));
        expect(rects).toContainEqual({ x: knot.x - 52, y: knot.y + 10, w: 104, h: 18 });

        // Expired refusal: no flash, no badge; the handle is back to blue.
        flow._refusal.until = 0;
        const ctx2 = makeDrawCtx();
        r._drawConnectSquares(ctx2, [rope, balloon]);
        expect(ctx2.fillText).not.toHaveBeenCalled();
        expect(ctx2.fillStyles).not.toContainEqual('rgba(232, 76, 76, 0.9)');
        expect(ctx2.fillStyles).toContainEqual('rgba(64, 128, 255, 0.9)');
        rope.dispose();
        balloon.dispose();
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
    const fontLog = [];
    for (const fn of [
        'save', 'restore', 'beginPath', 'moveTo', 'lineTo',
        'arc', 'fillRect', 'strokeRect', 'fill', 'stroke', 'setLineDash',
        'fillText',
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
    Object.defineProperty(ctx, 'font', {
        set(v) { fontLog.push(v); },
        get() { return fontLog[fontLog.length - 1]; },
    });
    ctx.strokeStyles = strokeStyleLog;
    ctx.fillStyles = fillStyleLog;
    ctx.fonts = fontLog;
    return ctx;
}