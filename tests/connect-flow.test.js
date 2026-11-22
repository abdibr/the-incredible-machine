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
import { objectRegistry } from '../js/objects/ObjectRegistry.js';
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
        expect(flow.seek).toEqual({ rope, role: 'end' });
        expect(flow.preview).toEqual({ x: end.x + 2, y: end.y + 2 });
        rope.dispose();
    });

    it('both tie points seek — the anchored start and the free end alike', () => {
        const rope = new Rope(300, 100, { length: 40 });
        const anchor = rope.bodies[0].position;

        expect(flow.handlePointerDown(anchor.x, anchor.y, [rope])).toBe(true);
        expect(flow.seek).toEqual({ rope, role: 'anchor' });
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
        // The seat is the chain end END'S ROLE, not an index (issue #90):
        // the reel above re-derived the chain from the span it laid
        // (setPreview → relayFreeEnd → setEndpoints → segmentsForSpan) and
        // the tie landed on whatever body the end seat names now — the tie
        // never re-grew, because the tail square's capacity already covered
        // the knot.
        expect(rope.getAttachmentRefs()).toContainEqual({ seat: 'end', target: balloon, pointId: 'knot' });
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

        expect(rope.getAttachmentRefs()).toContainEqual({ seat: 'anchor', target: balloon, pointId: 'knot' });

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

        expect(rope.getAttachmentRefs()).toContainEqual({ seat: 'anchor', target: balloon, pointId: 'knot' });
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
        expect(flow.seek).toEqual({ rope, role: 'end' });
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
        // The tie covers its own knot … through the two-pass seal of
        // issue #99: the reel's provisional grown span (tied times the
        // 6/5.5 chain-rest factor = 328.9) names count 9, and the hand's
        // span re-divides by THAT count's own end fraction (8.5/9); the
        // click's tie re-seals the same span, so the length rests at the
        // post-re-lay seal, not the single-pass one.
        expect(rope._length).toBeCloseTo(Math.hypot(200, 225.6) * 9 / 8.5, 3);

        physics.dispose();
        rope.dispose();
        balloon.dispose();
    });

    it('SANDBOX seeks exactly like EDITING (both edit stages)', () => {
        const rope = new Rope(300, 100, { length: 40 });
        flow._mode = 'SANDBOX';
        const end = rope.bodies[rope.bodies.length - 1].position;

        expect(flow.handlePointerDown(end.x, end.y, [rope])).toBe(true);
        expect(flow.seek).toEqual({ rope, role: 'end' });
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
        expect(flow.seek).toEqual({ rope, role: 'end' });

        eventBus.emit('mode:changed', { oldMode: 'EDITING', newMode: 'PLAYING' });

        expect(flow.seek).toBe(null);
        expect(flow.preview).toBe(null);
        expect(rope.getAttachmentRefs()).toEqual([]); // a seek tied nothing

        rope.dispose();
        flow._unsubscribeMode?.(); // keep the shared bus clean for later tests
    });

    it('clicking a tied square unties exactly that seat\u2019s knot; other seats keep theirs (one knot per seat)', () => {
        const rope = new Rope(300, 100, { length: 100 });
        const anchorBalloon = new Balloon(300, 74.4); // knot (300, 100): the anchor square
        const endBalloon = new Balloon(300, 154.4); // knot (300, 180): inside the end square
        const anchor = rope.bodies[0].position;
        const end = rope.bodies[rope.bodies.length - 1].position;
        rope.attachEndpoint('anchor', anchorBalloon, 'knot');
        rope.attachEndpoint('end', endBalloon, 'knot');

        // The first click unties the knot the clicked seat holds (issue #85:
        // one knot per seat — the per-knot untie of ADR 0007 decision 8,
        // one seat at a time).
        expect(flow.handlePointerDown(end.x, end.y, [rope, anchorBalloon, endBalloon])).toBe(true);
        expect(flow.seek).toBe(null); // untie is not a seek
        expect(rope.getAttachmentRefs()).toEqual([{ seat: 'anchor', target: anchorBalloon, pointId: 'knot' }]);

        // The second click frees the remaining knot.
        expect(flow.handlePointerDown(anchor.x, anchor.y, [rope, anchorBalloon])).toBe(true);
        expect(rope.getAttachmentRefs()).toEqual([]);
        rope.dispose();
        anchorBalloon.dispose();
        endBalloon.dispose();
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
        expect(flow.getRopeSquares([rope], null)).toEqual([]);
        rope.dispose();

        // A piece-cut rope (issue #58) is still a severed rope: no squares.
        const cutRope = new Rope(400, 100);
        cutRope.sever(2);
        const cutAnchor = cutRope.bodies[0].position;
        expect(flow.handlePointerDown(cutAnchor.x, cutAnchor.y, [cutRope])).toBe(false);
        expect(flow.getRopeSquares([cutRope], null)).toEqual([]);
        cutRope.dispose();
    });

    it('hover reveals a free square; tied and seeking squares stay visible unhovered', () => {
        const rope = new Rope(300, 100, { length: 40 });
        const balloon = new Balloon(700, 300);
        rope.attachEndpoint('anchor', balloon, 'knot'); // the anchor square is born tied
        const end = rope.bodies[rope.bodies.length - 1].position;

        let squares = flow.getRopeSquares([rope], null);
        expect(squares).toHaveLength(3); // exactly the tie seats (issue #85): anchor, mid, end
        expect(squares[0].tied).toBe(true);
        expect(squares[0].visible).toBe(true); // tieable structure stays visible
        expect(squares[1].role).toBe('mid');
        expect(squares[2].role).toBe('end'); // the free end squares as the chain's tail
        for (let i = 1; i < squares.length; i++) {
            expect(squares[i].tied).toBe(false);
            expect(squares[i].visible).toBe(false); // free squares are hover-revealed
        }

        squares = flow.getRopeSquares([rope], { x: end.x + 3, y: end.y + 3 });
        expect(squares[2].visible).toBe(true);
        expect(squares[2].hovered).toBe(true);

        flow.handlePointerDown(end.x + 3, end.y + 3, [rope]);
        squares = flow.getRopeSquares([rope], null);
        expect(squares[2].visible).toBe(true); // the seeking square holds its seat
        expect(squares[2].seeking).toBe(true);

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
        // The rope's two endpoint squares joined the target list (issue
        // #57); the balloon knot and the bucket rim are still there. Hover
        // at the knot shows only that square of the rope's targets.
        const targetsFor = (obj) => targets.filter((t) => t.target === obj);
        expect(targetsFor(balloon)).toHaveLength(1);
        expect(targetsFor(bucket)).toHaveLength(1);
        expect(targetsFor(balloon)[0].visible).toBe(true); // hover shows the faint square
        expect(targetsFor(balloon)[0].glows).toBe(false); // no seek in flight yet
        expect(targetsFor(rope).every((t) => !t.visible)).toBe(true);

        const end = rope.bodies[rope.bodies.length - 1].position;
        flow.handlePointerDown(end.x, end.y, [rope]);
        targets = flow.getTieSquares([rope, balloon, bucket], null);
        // The seeking rope is never its own tie target.
        expect(targetsFor(rope)).toHaveLength(0);
        expect(targetsFor(balloon)[0].glows).toBe(true); // in reach: click one to tie
        expect(targetsFor(balloon)[0].visible).toBe(true);
        expect(targetsFor(bucket)[0].glows).toBe(false); // beyond reach: a tie click would refuse
        expect(targetsFor(bucket)[0].visible).toBe(true); // still shown, faint, during the seek

        // The hand reels the rope out toward the rim: reach follows the
        // drag, and the far target becomes tieable mid-seek.
        flow.setPreview(rim.x, rim.y);
        targets = flow.getTieSquares([rope, balloon, bucket], null);
        expect(targetsFor(bucket)[0].glows).toBe(true);
        expect(targetsFor(balloon)[0].glows).toBe(true);

        flow.cancel();
        rope.dispose();
        balloon.dispose();
        bucket.dispose();
    });
    it('an anchor-square seek aims without re-laying (the pin does not follow the hand)', () => {
        const rope = new Rope(300, 100, { length: 40 });

        flow.handlePointerDown(300, 100, [rope]); // anchor-square seek
        flow.setPreview(640, 360);

        expect(flow.seek).toEqual({ rope, role: 'anchor' });
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

        // A refused click re-lays nothing, so the seek is still at the end
        // seat of the six segments the seek captured.
        expect(flow.seek).toEqual({ rope, role: 'end' }); // the seek survives the refusal
        expect(rope.getAttachmentRefs()).toEqual([]); // no knot was created
        expect(rope.lengthFrozen).toBe(false);
        expect(flow.refusal).toMatchObject({ x: knot.x, y: knot.y });
        const squares = flow.getRopeSquares([rope], null);
        expect(squares[2].refused).toBe(true); // the handle flashes red

        // The hand reels the rope out to the target: the SAME click now ties.
        flow.setPreview(knot.x, knot.y);
        expect(flow.handlePointerDown(knot.x, knot.y, [rope, balloon])).toBe(true);
        // The tie lands on the END seat (issue #90: the seek is a role) —
        // and it covers its own knot through the two-pass seal of issue #99:
        // the reel's provisional span (tied · 6/5.5 = 501.0) names count 13,
        // the reel re-divides by THAT count's end fraction (12.5/13) and
        // lays 12 bodies whose tail rides 457.7 - 1.5px shy of the knot,
        // which sits in the end seat's uncoverable 12/13-band gap; the
        // click's tie-grow then re-seals against the laid count's OWN
        // fraction (12/11.5) - a fixed point - and the tail square lands
        // exactly on the knot (the tie covers its own seat 1:1).
        expect(rope.getAttachmentRefs()).toContainEqual({ seat: 'end', target: balloon, pointId: 'knot' });
        expect(flow.seek).toBe(null);
        expect(flow.refusal).toBe(null); // a settled tie sweeps the flash
        expect(rope._length).toBeCloseTo(Math.hypot(400, 225.6) * 12 / 11.5, 3);
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
        let squares = flow.getRopeSquares([rope], null);
        expect(squares[2].refused).toBe(true);

        flow._refusal.until = 0; // the flash expired
        expect(flow.refusal).toBe(null);
        squares = flow.getRopeSquares([rope], null);
        expect(squares[2].refused).toBe(false);

        flow._refuse(knot.x, knot.y); // a fresh refusal repaints
        expect(flow.refusal).not.toBe(null);
        flow.cancel(); // any seek exit sweeps it
        expect(flow.refusal).toBe(null);
        rope.dispose();
        balloon.dispose();
    });

    // The 100px rope's seat circles from the anchor at (300, 100): the mid
    // seat (2 of 6) covers 41.67px, the end seat (5 of 6) the 91.67px
    // capacity — the aim slack band extends either by the 14px tolerance.
    describe('the reach follows the seat (issue #86)', () => {
        const MID_CIRCLE = 100 * 2.5 / 6;  // 41.67px
        const END_CIRCLE = 100 * 5.5 / 6;  // 91.67px: today's chain-end measure

        it('a mid tie beyond the mid seat\'s reach refuses — no knot, the seek stays in flight, the refusal paints', () => {
            const rope = new Rope(300, 100, { length: 100 });
            const balloon = new Balloon(300, 144.4); // knot (300, 170): 70px out — inside the END circle + slack, past the mid band
            expect(70).toBeGreaterThan(MID_CIRCLE + 14);
            expect(70).toBeLessThan(END_CIRCLE + 14);
            const mid = rope.getTieSeats()[1];

            flow.handlePointerDown(mid.worldPoint.x, mid.worldPoint.y, [rope]);
            expect(flow.seek).toEqual({ rope, role: 'mid' });

            // Glow follows the seat: the far target stays faint under a
            // mid seek (it would glow under an end seek).
            const targets = flow.getTieSquares([rope, balloon], null);
            expect(targets).toHaveLength(1);
            expect(targets[0].glows).toBe(false);

            const knot = balloon.getAttachmentWorldPoint('knot');
            expect(flow.handlePointerDown(knot.x, knot.y, [rope, balloon])).toBe(true); // consumed
            expect(flow.seek).toEqual({ rope, role: 'mid' }); // the seek survives
            expect(rope.getAttachmentRefs()).toEqual([]); // no knot was created
            expect(rope._length).toBe(100); // a refused tie re-lays and grows nothing
            expect(rope.lengthFrozen).toBe(false);
            expect(flow.refusal).toMatchObject({ x: knot.x, y: knot.y });
            const squares = flow.getRopeSquares([rope], null);
            expect(squares.find((s) => s.role === 'mid').refused).toBe(true); // the handle flashes red
            rope.dispose();
            balloon.dispose();
        });

        it('a mid tie in the slack band grows the span so the chain rests under the mid knot', () => {
            const rope = new Rope(300, 100, { length: 100 });
            const balloon = new Balloon(300, 120.4); // knot (300, 146): 46px — past the mid circle, inside its aim band
            expect(46).toBeGreaterThan(MID_CIRCLE);
            expect(46).toBeLessThan(MID_CIRCLE + 14);
            const mid = rope.getTieSeats()[1];
            flow.handlePointerDown(mid.worldPoint.x, mid.worldPoint.y, [rope]);

            // Glow follows the seat: the in-band target ties (grows to cover).
            const targets = flow.getTieSquares([rope, balloon], null);
            expect(targets[0].glows).toBe(true);

            const knot = balloon.getAttachmentWorldPoint('knot');
            expect(flow.handlePointerDown(knot.x, knot.y, [rope, balloon])).toBe(true);
            expect(flow.seek).toBe(null); // a pinned tie ends the seek settled
            expect(rope.getAttachmentRefs()).toEqual([{ seat: 'mid', target: balloon, pointId: 'knot' }]);
            expect(rope.lengthFrozen).toBe(true);
            // The covering grow answers the MID seat's own fraction: the
            // chain re-lays so the mid seat's body rests exactly at the knot —
            // just enough (tied · 6/2.5), never hauling the target inboard.
            expect(rope._length).toBeCloseTo(46 * 6 / 2.5, 5);
            const midBody = rope.bodies[3]; // bodies[0] = anchor, i+1 per seat
            expect(midBody.position.x).toBeCloseTo(300, 3);
            expect(midBody.position.y).toBeCloseTo(146, 3);
            // Rest lengths still sum to the grown chain's capacity — slack
            // sags beyond the knot, never a rigid rod (max length plus slack).
            const restSum = rope.constraints.reduce((sum, c) => sum + c.length, 0);
            expect(restSum).toBeCloseTo((46 * 6 / 2.5) * 5.5 / 6, 5);
            rope.dispose();
            balloon.dispose();
        });

        it('the same aim ties as an end tie and refuses as a mid tie — the seat picks the reach', () => {
            const rope = new Rope(300, 100, { length: 100 });
            const balloon = new Balloon(300, 144.4); // knot (300, 170): 70px out
            const knot = balloon.getAttachmentWorldPoint('knot');

            // The END seat ties the 70px aim with today's own covering: well
            // inside the capacity, no grow, the seek closes settled.
            const end = rope.getTieSeats()[2].worldPoint;
            expect(70).toBeLessThan(END_CIRCLE);
            flow.handlePointerDown(end.x, end.y, [rope, balloon]);
            expect(flow.handlePointerDown(knot.x, knot.y, [rope, balloon])).toBe(true);
            expect(rope.getAttachmentRefs()).toEqual([{ seat: 'end', target: balloon, pointId: 'knot' }]);
            expect(rope._length).toBe(100); // in-capacity tie: no grow (today's behaviour)
            expect(flow.seek).toBe(null);

            // The MID seat aims at the same 70px and refuses: a mid knot
            // would sit beyond the seat's own circle, so the reach is the
            // MID number — with the identical refusal feedback.
            const mid = rope.getTieSeats()[1].worldPoint;
            flow.handlePointerDown(mid.x, mid.y, [rope, balloon]);
            expect(flow.handlePointerDown(knot.x, knot.y, [rope, balloon])).toBe(true);
            expect(flow.seek).toEqual({ rope, role: 'mid' });
            expect(rope.getAttachmentRefs()).toHaveLength(1); // no second knot
            expect(flow.refusal).toMatchObject({ x: knot.x, y: knot.y });
            rope.dispose();
            balloon.dispose();
        });

        it('a free rope refuses nothing at any distance, mid seat included', () => {
            if (!objectRegistry.has('free-rope')) registerAllObjects();
            const rope = objectRegistry.create('free-rope', 260, 300, { length: 60 });
            const balloon = new Balloon(300, 100); // the anchor tie spawns the chain
            rope.attachEndpoint('anchor', balloon, 'knot');
            expect(rope.bodies.length).toBe(7); // 1 anchor + the fresh-drop six
            const mid = rope.getTieSeats()[1]; // the middle of the spawned chain
            const bucket = new Bucket(700, 120); // the rim, ~400px out from the mid square
            const rim = bucket.getAttachmentWorldPoint('rim');

            flow.handlePointerDown(mid.worldPoint.x, mid.worldPoint.y, [rope, bucket, balloon]);
            expect(flow.seek).toEqual({ rope, role: 'mid' });
            expect(flow.handlePointerDown(rim.x, rim.y, [rope, balloon, bucket])).toBe(true);

            expect(flow.refusal).toBe(null); // no reach refusal for the free family
            // The tie covered its knot 400+px out, re-layed the chain and
            // re-counted it (the free family's unlimited span): the knot
            // IS the mid seat's (issue #90), so it rides to the re-counted
            // chain's middle (issue #87 by the roles themselves), and the
            // armed seek MOVED past it — the flow armed the next free seat
            // (issue #103, the group spec's decision 7): a seek parked on
            // the seat it just tied bounced every later click with "seat
            // already tied".
            expect(rope.getAttachmentRefs()).toContainEqual({ seat: 'mid', target: bucket, pointId: 'rim' });
            // The free family's seek stays armed after a tie (ADR 0007
            // amendment 3 / issue #56), armed on the NEXT free seat: the
            // end seat of the re-counted chain aims next (anchor, then
            // mid, then end).
            expect(flow.seek).toEqual({ rope, role: 'end' });
            rope.dispose();
            balloon.dispose();
            bucket.dispose();
        });
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
        // Tokens name the seats by role (issue #88): the end tie is the
        // chain's end; the anchor knot's seat is the anchor.
        expect(snapshot[2].attachments).toContainEqual({
            seat: 'end', targetType: 'balloon', targetOrdinal: 0, pointId: 'knot',
        });
        expect(snapshot[2].attachments).toContainEqual({
            seat: 'anchor', targetType: 'bucket', targetOrdinal: 1, pointId: 'rim',
        });

        const board2 = [];
        restorePlacedFromSnapshot(board2, snapshot);
        const balloon2 = board2.find((o) => o.type === 'balloon');
        const bucket2 = board2.find((o) => o.type === 'bucket');
        const rope2 = board2.find((o) => o.type === 'rope');
        expect(rope2.getAttachmentRefs()).toContainEqual({ seat: 'end', target: balloon2, pointId: 'knot' });
        expect(rope2.getAttachmentRefs()).toContainEqual({ seat: 'anchor', target: bucket2, pointId: 'rim' });
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

        expect(ddm._connectFlow.seek).toEqual({ rope, role: 'end' });
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
        expect(ddm._connectFlow.seek).toEqual({ rope, role: 'end' });

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

        expect(ddm._connectFlow.seek).toEqual({ rope, role: 'end' }); // seek intact
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
        rope.attachEndpoint('anchor', balloon, 'knot');
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
        // One paint per square the flow reports visible (issue #56: every
        // body squares, so hovered middle squares add paints); the unhovered
        // balloon knot paints nothing.
        const visible = flow
            .getRopeSquares([rope, balloon], r.hoverPoint)
            .filter((s) => s.visible).length;
        // The hovered rope end also paints its tie-target square (issue
        // #57): target squares join the rope squares' paint count.
        const visibleTargets = flow
            .getTieSquares([rope, balloon], r.hoverPoint)
            .filter((t) => t.visible).length;
        expect(ctx.fillRect).toHaveBeenCalledTimes(visible + visibleTargets);
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

    it('an occupied-seat refusal paints its seat-already-tied badge (issue #85)', () => {
        if (!objectRegistry.has('free-rope')) registerAllObjects(); // single-test runs
        const rope = objectRegistry.create('free-rope', 300, 300); // bodyless coil
        const bucket = new Bucket(360, 240);
        flow.handlePointerDown(300, 300, [rope, bucket]); // coil seat seek
        const rim = bucket.getAttachmentWorldPoint('rim');
        flow.handlePointerDown(rim.x, rim.y, [rope, bucket]); // first tie — the seek ADVANCED (issue #103)
        // The seat the flow armed after the advance (the mid square) gets
        // tied OUT OF BAND — the restore path binds its tokens straight
        // into the rope — so the armed seek sits on an occupied seat and
        // the seat gate answers the next tie aim there.
        const balloon = new Balloon(320, 340);
        rope.attachEndpoint('mid', balloon, 'knot');
        const knot = balloon.getAttachmentWorldPoint('knot');
        flow.handlePointerDown(knot.x, knot.y, [rope, bucket, balloon]); // its second tie → refused: seat tied

        const r = new Renderer();
        r._mode = 'EDITING';
        r.setConnectFlow(flow);
        r.hoverPoint = null;
        const ctx = makeDrawCtx();
        r._drawConnectSquares(ctx, [rope, bucket, balloon]);

        // Its own badge: the refused aim was an occupied seat, not a short rope.
        expect(ctx.fillText).toHaveBeenCalledWith('seat already tied', knot.x, knot.y + 23);
        const rects = ctx.fillRect.mock.calls.map(([x, y, w, h]) => ({ x, y, w, h }));
        expect(rects).toContainEqual({ x: knot.x - 60, y: knot.y + 10, w: 120, h: 18 });
        rope.dispose();
        bucket.dispose();
        balloon.dispose();
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

    it('a rope-side refused tie paints a tie-refused badge instead of vanishing (issue #93)', () => {
        const rope = new Rope(300, 100, { length: 40 });
        const balloon = new Balloon(300, 118); // knot in reach (43.6px ≤ 50.7): the tie would land
        const end = rope.bodies[rope.bodies.length - 1].position;
        const knot = balloon.getAttachmentWorldPoint('knot');
        flow.handlePointerDown(end.x, end.y, [rope]); // seek
        // The rope's own seat gate refuses what the aim checks enumerated —
        // the flow paints the refusal instead of swallowing the throw.
        vi.spyOn(rope, 'attachEndpoint').mockImplementation(() => {
            throw new Error('[Rope] attachEndpoint: the anchor seat already holds a knot — one knot per seat');
        });
        flow.handlePointerDown(knot.x, knot.y, [rope, balloon]);

        const r = new Renderer();
        r._mode = 'EDITING';
        r.setConnectFlow(flow);
        r.hoverPoint = null;
        const ctx = makeDrawCtx();
        r._drawConnectSquares(ctx, [rope, balloon]);

        expect(ctx.fillText).toHaveBeenCalledWith('tie refused', knot.x, knot.y + 23);
        expect(flow.refusal).toMatchObject({ x: knot.x, y: knot.y, reason: 'refused' });
        expect(rope.getAttachmentRefs()).toEqual([]); // nothing landed
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

describe('ConnectFlow — free-rope reach gates stay open across the board (issue #56)', () => {
    let flow;

    beforeEach(() => {
        // The free-rope factory, registered here rather than borrowed from an
        // earlier test in this file: this describe must run green on its own
        // (single-test runs included). `has` keeps the double registration
        // silent when the file's restore test already registered the types.
        if (!objectRegistry.has('free-rope')) registerAllObjects();
        flow = new ConnectFlow();
        flow._mode = 'EDITING'; // the stage gate under test
    });

    it('the first tie from the coil ties as far as anything else on the board', () => {
        const rope = objectRegistry.create('free-rope', 220, 200, { length: 60 });
        const bucket = new Bucket(700, 120);
        const [coil] = flow.getRopeSquares([rope], null);
        expect(coil.role).toBe('anchor');
        flow.handlePointerDown(coil.x, coil.y, [rope, bucket]); // seek the bundle
        const rim = bucket.getAttachmentWorldPoint('rim'); // ~430px away
        expect(flow.seek.role).toBe('anchor');

        // The free rope takes ANY first tie: the reach gate answers the
        // free family for anything on the board and the chain spawns
        // straight from the contact point (a pinned rope refuses this
        // same click — see the flow gate refusal above).
        flow.handlePointerDown(rim.x, rim.y, [rope, bucket]);
        expect(rope.getAttachmentRefs()).toEqual([{ seat: 'anchor', target: bucket, pointId: 'rim' }]);
        expect(rope.bodies.length).toBeGreaterThan(0);
        const head = rope.bodies[0].position;
        expect(Math.hypot(head.x - rim.x, head.y - rim.y)).toBeLessThan(2); // straight to the click
        expect(rope.bodies.length).toBe(7); // count-honest: 1 anchor + the fresh-drop six
        rope.dispose();
        bucket.dispose();
    });

    it('a spawned free rope re-ties far: the tail-square seek ties the ~440px rim', () => {
        const rope = objectRegistry.create('free-rope', 260, 300, { length: 60 });
        const balloon = new Balloon(300, 100);
        const bucket = new Bucket(700, 120);
        rope.attachEndpoint('anchor', balloon, 'knot'); // direct spawn at the knot

        // Seek from the tail square…
        const end = rope.bodies[rope.bodies.length - 1].position;
        flow.handlePointerDown(end.x, end.y, [rope, balloon, bucket]);
        expect(flow.seek.role).toBe('end');

        // …and the ~440px rim ties: no reach refusal for the free rope.
        const rim = bucket.getAttachmentWorldPoint('rim');
        flow.handlePointerDown(rim.x, rim.y, [rope, balloon, bucket]);
        expect(rope.getAttachmentRefs()).toHaveLength(2);

        // The tie landed on the END seat — the rope's LAST seat. No seat
        // follows it, so the flow closes (issue #103, the group spec's
        // decision 7): the seek and its aim are gone, and no square lies
        // live-armed where nothing can tie.
        expect(flow.seek).toBe(null);
        expect(flow.preview).toBe(null);
        // The dead live-aim is gone with the seek: no hover, so the far
        // square paints nothing and no glow claims it is tieable.
        const r = new Renderer();
        r._mode = 'EDITING';
        r.setConnectFlow(flow);
        r.hoverPoint = null;
        const ctx = makeDrawCtx();
        r._drawConnectSquares(ctx, [rope, balloon, bucket]);
        const rects = ctx.fillRect.mock.calls.map(([x, y]) => ({ x, y }));
        expect(rects).not.toContainEqual({ x: rim.x - 9, y: rim.y - 9 });
        expect(ctx.fillStyles).not.toContainEqual('rgba(64, 192, 64, 0.25)');
        rope.dispose();
        balloon.dispose();
        bucket.dispose();
    });
});

describe('ConnectFlow — the tie seat is a role, not a raw index (issue #56)', () => {
    let flow;

    beforeEach(() => {
        if (!objectRegistry.has('free-rope')) registerAllObjects();
        flow = new ConnectFlow();
        flow._mode = 'EDITING';
    });

    it('a mid-seat knot rides a re-count onto the new middle; the flow seat follows (issue #87)', () => {
        // A free rope is the family that re-counts (its span IS its chain,
        // ADR 0007 decision 4), so it is the one that can move a seat body:
        // the first anchor tie spawns the six-segment chain hanging from the
        // knot.
        const physics = new PhysicsEngine(800, 600);
        const rope = objectRegistry.create('free-rope', 260, 300);
        const balloon = new Balloon(300, 100);
        physics.addObject(balloon);
        physics.addObject(rope);
        rope.attachEndpoint('anchor', balloon, 'knot');
        expect(rope._segments).toHaveLength(6);
        const midBody = rope._segments[2]; // the spawned chain's middle

        // Seek the mid seat. Only the chain END reels (the hand's span is
        // the end seat's own), so a mid seek aims without re-laying: the
        // seek's seat is the ROLE 'mid' (issue #90).
        const mid = midBody.position;
        expect(flow.handlePointerDown(mid.x, mid.y, [rope, balloon])).toBe(true);
        expect(flow.seek).toEqual({ rope, role: 'mid' });

        // A far aim cannot reel a mid seat: no re-lay, no re-count.
        const far = new Balloon(700, 300);
        physics.addObject(far);
        const knot = far.getAttachmentWorldPoint('knot');
        flow.setPreview(knot.x, knot.y);
        expect(flow.seek).toEqual({ rope, role: 'mid' });
        expect(rope._segments).toHaveLength(6); // mid seats aim, they don't drag the span

        // The tie covers its own knot — and covering a mid-seat knot ~447.7px
        // out re-lays the chain far past six segments. That re-count is the
        // seat surface: the knot IS the mid seat's (issue #90), so it rides
        // onto the re-counted chain's own middle (issue #87 kept by the
        // roles themselves — nothing written at re-count time).
        expect(flow.handlePointerDown(knot.x, knot.y, [rope, balloon, far])).toBe(true);
        expect(rope._segments.length).toBeGreaterThan(6); // the free chain re-counted
        expect(rope._segments).toHaveLength(Rope.segmentsForSpan(rope._length)); // …count-honest
        const newMid = rope.getTieSeats()[1]; // the NEW middle seat
        expect(newMid.body).not.toBe(midBody); // the re-count drew the middle outboard
        expect(rope.getAttachmentRefs()).toContainEqual({ seat: 'mid', target: far, pointId: 'knot' });
        // …and the armed seek MOVED with the tie (issue #103, the group
        // spec's decision 7): the flow armed the next free seat — the end
        // seat of the re-counted chain — instead of parking on the seat it
        // just tied. The knot itself keeps riding the role (issue #87, kept
        // by the roles).
        expect(flow.seek).toEqual({ rope, role: 'end' });

        // …and it realizes from the NEW middle's body — not the old mid-body
        // (which survives the count but is mid-chain no more).
        physics.step(16.67);
        const link = physics.getAttachedConstraints().find((c) => c.bodyB === far.bodies[0]);
        expect(link).toBeTruthy();
        expect(link.bodyA).toBe(newMid.body);
        expect(link.bodyA).not.toBe(midBody);

        physics.dispose();
        rope.dispose();
        balloon.dispose();
        far.dispose();
    });
});

describe('ConnectFlow — the armed free-rope seek lives on the next free seat (issue #103)', () => {
    let flow;

    beforeEach(() => {
        if (!objectRegistry.has('free-rope')) registerAllObjects();
        flow = new ConnectFlow();
        flow._mode = 'EDITING';
    });

    it('a free-rope tie arms the NEXT free seat — the coil tie advances anchor → mid (spec decision 7)', () => {
        const rope = objectRegistry.create('free-rope', 300, 300); // bodyless coil: one anchor seat
        const bucket = new Bucket(360, 240);
        const [coil] = flow.getRopeSquares([rope], null);
        expect(coil.role).toBe('anchor');

        flow.handlePointerDown(coil.x, coil.y, [rope, bucket]); // the coil square seeks
        expect(flow.seek).toEqual({ rope, role: 'anchor' });
        const rim = bucket.getAttachmentWorldPoint('rim');
        expect(flow.handlePointerDown(rim.x, rim.y, [rope, bucket])).toBe(true); // the spawn tie lands

        expect(rope.getAttachmentRefs()).toEqual([{ seat: 'anchor', target: bucket, pointId: 'rim' }]);
        // The seek did NOT die with the tie (ADR 0007 amendment 3 / issue
        // #56's one-handed multi-tie flow kept) — and it did NOT sit down
        // on the seat it just tied either (issue #103): every click at the
        // tied square used to bounce "seat already tied". The flow re-armed
        // on the NEXT free seat — the mid seat of the chain the spawn laid.
        // That seat exists only because the tie laid the chain, so the
        // advance had to re-read getTieSeats(): the mid seat is role-derived
        // (issue #90), never a cached body or a cached index.
        expect(flow.seek).toEqual({ rope, role: 'mid' });
        // The advanced seat is a LIVE aim: its square reports tieable glow
        // the way a seek entry does (the free family refuses no distance).
        const targets = flow.getTieSquares([rope, bucket], null);
        expect(targets).toHaveLength(1);
        expect(targets[0].glows).toBe(true);

        rope.dispose();
        bucket.dispose();
    });

    it('the advanced seek dismisses through the same paths — a re-click at its square cancels', () => {
        const rope = objectRegistry.create('free-rope', 300, 300);
        const bucket = new Bucket(360, 240);
        flow.handlePointerDown(300, 300, [rope, bucket]); // the coil square seeks
        const rim = bucket.getAttachmentWorldPoint('rim');
        flow.handlePointerDown(rim.x, rim.y, [rope, bucket]); // the spawn tie; the flow advanced to 'mid'
        expect(flow.seek).toEqual({ rope, role: 'mid' });

        // The armed square moved with the advance; its dismissal paths move
        // with it: a re-click at the NEW armed square's world point cancels
        // (the mid seat's body is read fresh from getTieSeats() by role).
        const mid = rope.getTieSeats().find((s) => s.role === 'mid').worldPoint;
        expect(flow.handlePointerDown(mid.x + 2, mid.y + 2, [rope, bucket])).toBe(true);
        expect(flow.seek).toBe(null);
        expect(flow.preview).toBe(null);

        rope.dispose();
        bucket.dispose();
    });

    it('tying the end seat ends the multi-tie flow — the seek cancels when no free seat remains', () => {
        const rope = objectRegistry.create('free-rope', 300, 300);
        const bucketA = new Bucket(360, 240);   // the coil's first tie (the anchor seat)
        const balloonB = new Balloon(700, 120); // the advanced mid seat's tie
        const bucketC = new Bucket(100, 100);   // the end seat's tie

        flow.handlePointerDown(300, 300, [rope, bucketA]); // the coil square seeks
        const rimA = bucketA.getAttachmentWorldPoint('rim');
        flow.handlePointerDown(rimA.x, rimA.y, [rope, bucketA]); // the anchor tie (spawn)
        expect(flow.seek).toEqual({ rope, role: 'mid' }); // anchor → mid (spec decision 7)

        const knotB = balloonB.getAttachmentWorldPoint('knot');
        expect(flow.handlePointerDown(knotB.x, knotB.y, [rope, bucketA, balloonB])).toBe(true);
        expect(rope.getAttachmentRefs()).toContainEqual({ seat: 'mid', target: balloonB, pointId: 'knot' });
        expect(flow.seek).toEqual({ rope, role: 'end' }); // mid → end: the advance rides the seat roles

        // The end seat is the LAST seat: its tie has no next free seat, so
        // the armed seek closes instead of pretending at a dead square —
        // the one-handed multi-tie flow (anchor, then mid, then end) ends
        // where it must: no free seat remains.
        const rimC = bucketC.getAttachmentWorldPoint('rim');
        expect(flow.handlePointerDown(rimC.x, rimC.y, [rope, bucketA, balloonB, bucketC])).toBe(true);
        expect(rope.getAttachmentRefs().map((r) => r.seat)).toEqual(['anchor', 'mid', 'end']);
        expect(flow.seek).toBe(null);
        expect(flow.preview).toBe(null);

        rope.dispose();
        bucketA.dispose();
        balloonB.dispose();
        bucketC.dispose();
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