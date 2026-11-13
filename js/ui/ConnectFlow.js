/**
 * ConnectFlow — the click-to-connect tying state machine (ADR 0007 decision 2).
 *
 * Tying is explicit: a rope renders square handles at its tie points; objects
 * that offer attachment points (balloon knot, bucket rim) show target squares
 * when relevant. DragDropManager delegates pointer events here; the renderer
 * draws whatever this flow reports (squares, seek preview, glow).
 *
 * Flow: clicking a free rope tie square enters a seek — the preview
 * line follows the cursor and target squares within the seeking seat's
 * reach glow (reach follows the seat, issue #86: the end seat's reach is
 * the chain capacity, the anchor seat keeps it too, a mid seat's is its
 * own covering circle). A seek at the FREE end reels the rope to the
 * cursor (Rope.relayFreeEnd —
 * the hand sets the length while the rope is untied; the tie square rides
 * the cursor, so a further tie click lands inside the seeking square's own
 * hit radius and wins the seat over the re-click cancel). The anchored
 * seat is pinned: an anchor seek (role 'anchor', issue #90 — the seat is
 * a role and nothing else) only aims. Clicking an
 * in-reach target creates the knot (engine link realized lazily on the
 * next physics
 * step, the issue 04 seam) and freezes the length; a tie click beyond the
 * seeking seat's reach is REFUSED (ADR 0007 decision 4, issue #54, per
 * seat since #86): no knot, the
 * seek survives, and the refusal paints for REFUSAL_FLASH_MS — the handle
 * flashes red, a reason badge marks the refused aim ("rope too short";
 * "seat already tied" since #85). The slack band past a seat's circle
 * (the aim tolerance) still reaches — the tie it allows grows the span
 * just enough to cover the knot. Esc or re-clicking the seeking square
 * cancels; clicking an already-tied square unties one knot (the target
 * stays, the rope side frees). One knot per seat (issue #85): the squares
 * are the rope's three named tie seats (issue #84) — anchor, mid, end —
 * plus a bodyless bundle's single coil square, and a tie aim into a seat
 * that already holds its knot refuses before any pull, so a click-tied
 * rope holds at most three knots, one per seat.
 *
 * Edit-only (ADR 0007 decision 9): squares, preview and seek exist only in
 * EDITING/SANDBOX. Any stage change cancels an in-flight seek cleanly — a
 * seek mutates nothing but the hand's re-lay, which is a placement edit
 * (its effect is always the last settled state).
 *
 * No re-lay on tie (unlike the drop-time snap): the knot holds the rope end
 * at the target through the length-0 engine link, realized on the next step.
 */

import { eventBus } from '../EventBus.js';
import { clampObjectToPlayfield } from '../objects/BaseObject.js';
import { isRopeFamily } from '../objects/Rope.js';

/**
 * How close (px) a click must land to a square for the flow to consume it,
 * and the hover-reveal reach the renderer shows squares at. Click hit-testing
 * only — the reach gate's aim slack is REACH_AIM_TOLERANCE below (one
 * number, one meaning).
 * @type {number}
 */
export const CONNECT_HIT_RADIUS = 14;

/**
 * How far (px) past a rope's laid reach a tie aim may sit and still glow and
 * tie — the slack passed to Rope.isPointWithinReach at both the tie gate and
 * the glow; a tie inside the band grows the rope to cover its knot exactly
 * (Rope.attachEndpoint). Deliberately its own number: the click hit radius
 * above is a UX affordance and must never retune this physics band.
 * @type {number}
 */
export const REACH_AIM_TOLERANCE = 14;

/**
 * How long (ms) a refused tie keeps painting its feedback — the red handle
 * flash and the "rope too short" badge (ADR 0007 decision 4, issue #54).
 * The refusal itself is a rejected click: no knot is created and the seek
 * stays in flight; only the paint is timed.
 * @type {number}
 */
export const REFUSAL_FLASH_MS = 600;

/** The refused-tie badge texts (ADR 0007 decision 4, issue #54; the seat
 * reason is #85's one-knot-per-seat refusal). */
export const ROPE_TOO_SHORT = 'rope too short';
export const SEAT_TIED = 'seat already tied';

class ConnectFlow {
    constructor() {
        /** Current application mode — updated via init()'s mode:changed bus. */
        this._mode = 'MENU';

        /** @type {{rope: import('../objects/Rope.js').default, role: string}|null} */
        this._seek = null;

        /** @type {{x: number, y: number}|null} cursor canvas position while seeking */
        this._preview = null;

        /** @type {{x: number, y: number, until: number}|null} most recent refused tie (paints feedback) */
        this._refusal = null;

        /** @type {Function|null} unsubscribe for the mode:changed subscription */
        this._unsubscribeMode = null;
        /** @type {{width: number, height: number}|null} playfield bounds for fixed-end tie pulls (setPlayfield) */
        this._playfield = null;
    }

    /**
     * Record the playfield bounds clamping fixed-end tie pulls live in
     * (same world as the physics engine's boundary walls; wired once in
     * main.js from PhysicsEngine's width/height). No resize path exists
     * (the canvas rescales via CSS only), so wiring once at boot is
     * enough. An absent playfield (tests, earlier constructions) skips
     * the clamp.
     * @param {number} width
     * @param {number} height
     */
    setPlayfield(width, height) {
        this._playfield = { width, height };
    }

    /**
     * Subscribe to stage changes. Safe to call again: the previous
     * subscription is dropped first.
     */
    init() {
        this._unsubscribeMode?.();
        this._unsubscribeMode = eventBus.on('mode:changed', ({ newMode }) => {
            this._mode = newMode;
            // Decision 9: any stage change ends the seek cleanly.
            this.cancel();
        });
    }

    /** Edit stages only — squares, preview and seek exist nowhere else. */
    get editStage() {
        return this._mode === 'EDITING' || this._mode === 'SANDBOX';
    }

    /** @returns {{rope: import('../objects/Rope.js').default, role: string}|null} */
    get seek() {
        return this._seek;
    }

    /** @returns {{x: number, y: number}|null} */
    get preview() {
        return this._preview;
    }

    /**
     * The most recent refused tie while its feedback still paints
     * ({ x, y } at the refused aim), or null. Reading it past its expiry
     * clears it (ADR 0007 decision 4, issue #54).
     * @returns {{x: number, y: number}|null}
     */
    get refusal() {
        if (!this._refusal) return null;
        if (performance.now() >= this._refusal.until) {
            this._refusal = null;
            return null;
        }
        return this._refusal;
    }

    /**
     * Consume (or not) an edit-mode click. Returns true when the click was
     * a square interaction (seek entry/untie) so the drag-drop handler skips
     * its selection path; false leaves the click to normal selection.
     * @param {number} x - canvas x
     * @param {number} y - canvas y
     * @param {import('../objects/BaseObject.js').default[]} objects — the live board
     */
    handlePointerDown(x, y, objects) {
        if (!this.editStage) return false;

        // Seek in flight — modal: ties, cancels, swallowed clicks only.
        if (this._seek) {
            // Tie aim first: the free end re-lays beneath the cursor (the
            // tie square rides the seek's move), so the aim can sit inside
            // the seeking square's own hit radius — an intentional tie
            // click wins the seat over the re-click cancel.
            const target = this._tieTargetAt(x, y, objects);
            if (target) {
                // One knot per seat (issue #85): a tie aim into a seat that
                // already holds a knot refuses before reach or any pull —
                // no knot is created, the seek stays alive, and the
                // "seat already tied" flash marks the refused aim. This is
                // the armed free-rope seek's second-tie click (the free
                // family's seek stays armed after a tie, ADR 0007
                // amendment 3): the rope's own seat gate would refuse it
                // with a throw (Rope.attachEndpoint), the flow adds the
                // feedback so the refusal explains itself.
                if (this._seek.rope.getAttachmentRefs().some((ref) => ref.seat === this._seek.role)) {
                    this._refuse(x, y, 'occupied');
                    return true;
                }
                const world = target.target.getAttachmentWorldPoint(target.pointId);
                // Fixed-length reach (ADR 0007 decision 4, issue #54), now
                // following the seat (issue #86): a tie beyond the seeking
                // seat's own reach is REFUSED — no knot, the seek stays
                // alive, and the refusal feedback paints (red handle flash
                // + "rope too short" badge) until it expires. A chain seat
                // measures its own covering circle (the end seat's is the
                // chain capacity, so its number answers exactly as before;
                // the anchor seat keeps the whole-rope capacity circle — its
                // knot consumes no chain and realizes at the anchor itself);
                // the slack band past a seat's circle (the aim tolerance)
                // still reaches, and the tie it allows grows the span just
                // enough to cover the knot (Rope.attachEndpoint's per-seat
                // covering grow). Free rope (issue #55 spawn, #56 span):
                // isPointWithinReach answers true for the whole free family
                // — a bodyless coil has no reach circle, and a spawned free
                // rope keeps it that way: no length property of its own, so
                // every tie (first or later, any distance) ties and re-lays
                // the chain to span the demand instead of refusing.
                if (world && this._seek.rope.isPointWithinReach(world.x, world.y, REACH_AIM_TOLERANCE, this._seek.role)) {
                    // A fixed-end tie realizes as a length-0 pin between
                    // the rope's anchor and the tied attachment point (the
                    // zero-length engine link of ADR 0007 decision 6,
                    // wired by Rope.attachEndpoint). The anchor stays
                    // pinned to the board, so the target is the only free
                    // point — pull it to the anchor BEFORE the knot so the
                    // pin realizes with zero gap; otherwise the first play
                    // step displaces the target hard over the residual
                    // (the historic slam). The pull is rigid: a translate
                    // by (anchor − attachment world point), which lands the
                    // attachment point exactly on the anchor. Level-fixed
                    // targets are immovable and never pulled; the direct
                    // rope API and restore paths keep their contract of not
                    // moving targets (ADR 0006 divergence). Reach was
                    // evaluated on the pre-pull aim, unchanged.
                    // Free bundle (issue #55): no anchor body exists yet —
                    // skip the pull; the spawn hangs the chain from the aim.
                    if (this._seek.role === 'anchor' && !target.target.isFixed && !this._seek.rope.isFreeBundle) {
                        const anchor = this._seek.rope.bodies[0].position;
                        const dx = anchor.x - world.x;
                        const dy = anchor.y - world.y;
                        const pulled = target.target;
                        let px = pulled.x + dx;
                        let py = pulled.y + dy;
                        // Same inside-the-walls invariant as every other
                        // placement surface (clampObjectToPlayfield): the
                        // pull must not park the tied body inside a
                        // boundary wall, where the engine would violently
                        // displace it at play start. In that edge case the
                        // knot accepts a small residual gap (a gentle
                        // settle, like the near-wall placement case).
                        if (this._playfield) {
                            ({ x: px, y: py } = clampObjectToPlayfield(pulled, px, py, this._playfield.width, this._playfield.height));
                        }
                        pulled.setPosition(px, py);
                    }
                    // Capture the seek BEFORE the tie: a free rope's tie
                    // keeps the flow armed on this same rope (issue #56).
                    const rope = this._seek.rope;
                    try {
                        this._seek.rope.attachEndpoint(this._seek.role, target.target, target.pointId);
                    } catch (e) {
                        // The reach was just verified and the target is
                        // enumerated from the live board — a throw here is a
                        // safety net only, but it must not crash the app
                        // mid-seek: keep the seek alive.
                        console.warn(`[ConnectFlow] Tie refused: ${e.message}`);
                        return true;
                    }
                    // Tie exit per family (issue #56): a pinned rope's first
                    // knot closes the seek at a settled state; a free rope's
                    // tie keeps the seek — its span is the aim's property,
                    // every later target ties as far as anything on the
                    // board, so the flow stays armed for the next tie. The
                    // seek's seat is a ROLE (issue #90): it needs no
                    // re-resolution when a tie-grow re-counts the chain
                    // — the role names the seat wherever the live count
                    // puts it (issue #87's keeps, kept by the roles).
                    if (!rope.isFree) this.cancel(); // the tie ends the seek at a settled state
                    return true;
                }
                this._refuse(x, y);
                return true;
            }
            const spot = this._seekBody(this._seek.rope, this._seek.role);
            if (spot && Math.hypot(x - spot.position.x, y - spot.position.y) <= CONNECT_HIT_RADIUS) {
                this.cancel(); // re-clicking the seeking square cancels
                return true;
            }
            this._preview = { x, y }; // swallowed clicks still aim the preview
            return true;
        }

        const square = this._ropeSquareAt(x, y, objects);
        if (!square) return false;
        if (square.knots.length > 0) {
            this._untie(square, x, y);
            return true;
        }
        this._refusal = null; // a fresh seek sweeps any stale flash
        this._seek = { rope: square.rope, role: square.role };
        this._preview = { x, y };
        return true;
    }

    /**
     * Track the cursor while a seek is in flight (the renderer's line
     * target). ADR 0007 decision 4 (issue #54): a seek at the FREE end
     * reels the rope to the cursor — the hand sets the length while the
     * rope is untied, and rope.relayFreeEnd clamps the demand (minimum
     * span; the frozen reach circle once a tie exists). The END seat's
     * seek is the only one that reels (a tied square click unties instead
     * of seeking); the anchor and the mid seat (issue #56) aim without
     * re-laying.
     */
    setPreview(x, y) {
        if (!this._seek) return;
        this._preview = { x, y };
        const rope = this._seek.rope;
        if (this._seek.role === 'end'
            && rope.getAttachmentRefs().every((ref) => ref.seat !== 'end')) {
            rope.relayFreeEnd(x, y);
            // The reel re-derives the chain's count from the grown span
            // (segmentsForSpan — ADR 0007 decision 3, issue #56): with the
            // seat a ROLE (issue #90) the seek needs no re-resolve — 'end'
            // IS the rebuilt chain's tail, whatever index it now has.
        }
    }

    /** End the seek (Esc, re-click, target tie, stage change). Leaves the board untouched. */
    cancel() {
        this._seek = null;
        this._preview = null;
        this._refusal = null;
    }

    /**
     * Record a refused tie: the click aimed somewhere the rope cannot tie —
     * beyond its reach (ADR 0007 decision 4, issue #54) or into a seat that
     * already holds a knot (issue #85) — so no knot is created and the seek
     * survives; the handle flashes red and a reason badge paints at the
     * refused aim until the flash expires ("rope too short", or "seat
     * already tied" for the occupied-seat refusal).
     * @param {number} x - refused aim x
     * @param {number} y - refused aim y
     * @param {'short'|'occupied'} [reason='short'] - why the tie refused
     * @private
     */
    _refuse(x, y, reason = 'short') {
        this._refusal = { x, y, until: performance.now() + REFUSAL_FLASH_MS, reason };
    }

    /** The Matter body a rope tie seat ties through — the seat role's own
     * body, from the rope's own seat answer (a bodyless bundle's coil seat
     * answers no body, so its seek never mis-aims at a world body). */
    _seekBody(rope, role) {
        return rope?.getTieSeats().find((s) => s.role === role)?.body ?? null;
    }

    /**
     * The nearest attachment-point square within the hit radius, or null —
     * what a seeking click ties to. The truth is getTieSquares(): every
     * attachment-bearing object qualifies, dead targets resolve no world
     * point, the seeking rope never offers itself.
     * @private
     */
    _tieTargetAt(x, y, objects) {
        const best = this._nearestSquare(this.getTieSquares(objects, null), x, y);
        return best
            ? { target: best.square.target, pointId: best.square.pointId, dist: best.dist }
            : null;
    }

    /**
     * The nearest rope tie square within the hit radius, or null —
     * what a click hit-tests against (severed and disposed ropes expose
     * nothing; a square carries the knots holding its seat's ROLE (issue
     * #90) so the click router can tell a seek entry (free) from an untie
     * (tied)).
     * @private
     */
    _ropeSquareAt(x, y, objects) {
        const best = this._nearestSquare(this.getRopeSquares(objects, null), x, y);
        return best
            ? { rope: best.square.rope, role: best.square.role, dist: best.dist, knots: best.square.knots }
            : null;
    }

    /**
     * The nearest square of a flow square list within the hit radius, or
     * null — the one shared scan behind the rope-square and tie-target
     * click hit tests (clicks and pixels draw from the same square lists).
     * @param {Array<{x: number, y: number}>} squares
     * @param {number} x - click canvas x
     * @param {number} y - click canvas y
     * @returns {{square: object, dist: number}|null}
     * @private
     */
    _nearestSquare(squares, x, y) {
        let best = null;
        for (const square of squares) {
            const dist = Math.hypot(x - square.x, y - square.y);
            if (dist > CONNECT_HIT_RADIUS) continue;
            if (!best || dist < best.dist) best = { square, dist };
        }
        return best;
    }

    /**
     * Every rope tie square — the rope's TIE SEATS rendered (issue #85),
     * with the visibility flags the renderer draws from: a tied square is
     * persistent machine structure, a seeking square holds its seat (and
     * flashes red while its last tie click was refused, issue #54), a free
     * square is hover-revealed. The squares answer exactly the seats the
     * rope names through getTieSeats() (issue #84) — anchor, mid and end on
     * a laid rope, however long the span (never one per chain body); the
     * single coil square of a bodyless free bundle — its one tie seat, the
     * anchor tie that births the chain (issue #55); nothing for a disposed
     * rope. A square carries the knots holding its seat (a seat ROLE is the
     * knot's own address, issue #90) so the click router can tell a seek
     * entry (free) from an untie (tied). Severed ropes expose nothing.
     * Geometry source for clicks AND pixels (render/Renderer.js), one
     * source of truth.
     * @param {import('../objects/BaseObject.js').default[]} objects — the live board
     * @param {{x: number, y: number}|null} hover — cursor canvas position or null
     * @returns {Array<{rope: import('../objects/Rope.js').default, role: string, bodyIndex: number, x: number, y: number, knots: object[], tied: boolean, seeking: boolean, hovered: boolean, visible: boolean}>}
     */
    getRopeSquares(objects, hover) {
        const squares = [];
        const refusal = this.refusal; // the most recent refused tie, while it paints
        for (const rope of objects ?? []) {
            // Family membership is the rope module's fact (C1, issue #75).
            if (!isRopeFamily(rope) || rope.isSevered) continue;

            // One square per tie seat (issue #85): the seats follow the live
            // structure — a bundle answers its coil seat (no body: the
            // bodies-list index reads −1), a laid rope its anchor/mid/end,
            // a disposed rope nothing (parity with `bodies`).
            const bodies = rope.bodies; // null-safe: a disposed rope reads empty
            for (const seat of rope.getTieSeats()) {
                const x = seat.worldPoint.x;
                const y = seat.worldPoint.y;
                const knots = rope.getAttachmentRefs()
                    .filter((ref) => ref.seat === seat.role);
                const tied = knots.length > 0;
                const seeking = !!this._seek
                    && this._seek.rope === rope && this._seek.role === seat.role;
                const hovered = hover
                    ? Math.hypot(hover.x - x, hover.y - y) <= CONNECT_HIT_RADIUS
                    : false;
                squares.push({
                    rope, role: seat.role,
                    bodyIndex: bodies.indexOf(seat.body),
                    x, y, knots, tied, seeking, hovered,
                    refused: !!refusal && seeking, // the refused handle flashes red
                    visible: tied || seeking || hovered,
                });
            }
        }
        return squares;
    }

    /**
     * Every attachment-point square on the board: during a seek the ones
     * within the seeking seat's reach glow (glow = tieable, ADR 0007
     * decision 4, issue #54, per seat since #86 — the same predicate the
     * tie click accepts, passed the seek's seat, with the click's aim
     * tolerance); outside a seek, hover shows the faint square.
     * Out-of-reach targets stay visible while seeking but faint — clicking
     * them is refused with feedback. Dead targets (popped, disposed)
     * resolve no world point and drop out; the seeking rope never offers
     * itself a target.
     * @param {import('../objects/BaseObject.js').default[]} objects — the live board
     * @param {{x: number, y: number}|null} hover — cursor canvas position or null
     * @returns {Array<{target: import('../objects/BaseObject.js').default, pointId: string, x: number, y: number, glows: boolean, hovered: boolean, visible: boolean}>}
     */
    getTieSquares(objects, hover) {
        const seek = this._seek;
        const squares = [];
        for (const obj of objects ?? []) {
            if (seek && obj === seek.rope) continue;
            for (const point of obj.attachmentPoints ?? []) {
                const world = obj.getAttachmentWorldPoint(point.id);
                if (!world) continue;
                const hovered = hover
                    ? Math.hypot(hover.x - world.x, hover.y - world.y) <= CONNECT_HIT_RADIUS
                    : false;
                squares.push({
                    target: obj, pointId: point.id, x: world.x, y: world.y,
                    glows: !!seek
                        && seek.rope.isPointWithinReach(world.x, world.y, REACH_AIM_TOLERANCE, seek.role),
                    hovered,
                    visible: !!seek || hovered,
                });
            }
        }
        return squares;
    }

    /**
     * Untie the knot of a tied square — exactly that seat's knot (issue
     * #85: one knot per seat, so the square's knot list holds one). The
     * nearest-victim tiebreak below only ever fires on the degenerate square
     * an older multi-knot seat could still report: the knot whose target
     * sits nearest the click wins (ties broken by knot order — the oldest
     * first); dead targets (no world point) untie first, priming them for
     * reconcile-pruning. The remaining knots — and the target's attachment
     * point — stay.
     * @private
     */
    _untie(square, x, y) {
        let victim = null;
        for (const knot of square.knots) {
            const world = knot.target?.getAttachmentWorldPoint?.(knot.pointId) ?? null;
            const dist = world ? Math.hypot(x - world.x, y - world.y) : -1;
            if (!victim || dist < victim.dist) victim = { knot, dist };
        }
        square.rope.detachEndpoint(square.role, victim.knot.target, victim.knot.pointId);
    }
}

/** The ConnectFlow class. DragDropManager owns the live instance; main.js
 * hands that one to the renderer. */
export default ConnectFlow;