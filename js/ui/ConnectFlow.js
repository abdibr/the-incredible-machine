/**
 * ConnectFlow — the click-to-connect tying state machine (ADR 0007 decision 2).
 *
 * Tying is explicit: a rope renders square handles at its tie points; objects
 * that offer attachment points (balloon knot, bucket rim) show target squares
 * when relevant. DragDropManager delegates pointer events here; the renderer
 * draws whatever this flow reports (squares, seek preview, glow).
 *
 * Flow: clicking a free rope endpoint square enters a seek — the preview
 * line follows the cursor and target squares within the rope's reach glow.
 * A seek at the FREE end reels the rope to the cursor (Rope.relayFreeEnd —
 * the hand sets the length while the rope is untied; the tie square rides
 * the cursor, so a further tie click lands inside the seeking square's own
 * hit radius and wins the seat over the re-click cancel). The anchored
 * start is pinned: an endpoint-0 seek only aims. Clicking an in-reach
 * target creates the knot (engine link realized lazily on the next physics
 * step, the issue 04 seam) and freezes the length; a tie click beyond the
 * rope's reach is REFUSED (ADR 0007 decision 4, issue #54): no knot, the
 * seek survives, and the refusal paints for REFUSAL_FLASH_MS — the handle
 * flashes red, a "rope too short" badge marks the refused aim. Esc or
 * re-clicking the seeking square cancels; clicking an already-tied square
 * unties one knot (the target stays, the rope side frees).
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

/**
 * How close (px) a click must land to a square for the flow to consume it —
 * also the hover-reveal reach the renderer shows squares at.
 * @type {number}
 */
export const CONNECT_HIT_RADIUS = 14;

/**
 * How long (ms) a refused tie keeps painting its feedback — the red handle
 * flash and the "rope too short" badge (ADR 0007 decision 4, issue #54).
 * The refusal itself is a rejected click: no knot is created and the seek
 * stays in flight; only the paint is timed.
 * @type {number}
 */
export const REFUSAL_FLASH_MS = 600;

/** The refused-tie badge text (ADR 0007 decision 4, issue #54). */
export const ROPE_TOO_SHORT = 'rope too short';

class ConnectFlow {
    constructor() {
        /** Current application mode — updated via init()'s mode:changed bus. */
        this._mode = 'MENU';

        /** @type {{rope: import('../objects/Rope.js').default, endpoint: number}|null} */
        this._seek = null;

        /** @type {{x: number, y: number}|null} cursor canvas position while seeking */
        this._preview = null;

        /** @type {{x: number, y: number, until: number}|null} most recent refused tie (paints feedback) */
        this._refusal = null;

        /** @type {Function|null} unsubscribe for the mode:changed subscription */
        this._unsubscribeMode = null;
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

    /** @returns {{rope: import('../objects/Rope.js').default, endpoint: number}|null} */
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
                const world = target.target.getAttachmentWorldPoint(target.pointId);
                // Fixed-length reach (ADR 0007 decision 4, issue #54): a
                // tie beyond the rope's reach is REFUSED — no knot, the
                // seek stays alive, and the refusal feedback paints (red
                // handle flash + "rope too short" badge) until it expires.
                if (world && this._seek.rope.isPointWithinReach(world.x, world.y, CONNECT_HIT_RADIUS)) {
                    try {
                        this._seek.rope.attachEndpoint(this._seek.endpoint, target.target, target.pointId);
                    } catch (e) {
                        // The reach was just verified and the target is
                        // enumerated from the live board — a throw here is a
                        // safety net only, but it must not crash the app
                        // mid-seek: keep the seek alive.
                        console.warn(`[ConnectFlow] Tie refused: ${e.message}`);
                        return true;
                    }
                    this.cancel(); // the tie ends the seek at a settled state
                    return true;
                }
                this._refuse(x, y);
                return true;
            }
            const spot = this._endpointBody(this._seek.rope, this._seek.endpoint);
            if (spot && Math.hypot(x - spot.position.x, y - spot.position.y) <= CONNECT_HIT_RADIUS) {
                this.cancel(); // re-clicking the seeking square cancels
                return true;
            }
            this._preview = { x, y }; // swallowed clicks still aim the preview
            return true;
        }

        const square = this._endpointSquareAt(x, y, objects);
        if (!square) return false;
        if (square.knots.length > 0) {
            this._untie(square, x, y);
            return true;
        }
        this._refusal = null; // a fresh seek sweeps any stale flash
        this._seek = { rope: square.rope, endpoint: square.endpoint };
        this._preview = { x, y };
        return true;
    }

    /**
     * Track the cursor while a seek is in flight (the renderer's line
     * target). ADR 0007 decision 4 (issue #54): a seek at the FREE end
     * reels the rope to the cursor — the hand sets the length while the
     * rope is untied, and rope.relayFreeEnd clamps the demand (minimum
     * span; the frozen reach circle once a tie exists). Endpoint-1 seeks
     * exist only on knot-free ends (a tied square click unties instead of
     * seeking); the anchored start is pinned — endpoint-0 seeks aim
     * without re-laying.
     */
    setPreview(x, y) {
        if (!this._seek) return;
        this._preview = { x, y };
        const rope = this._seek.rope;
        if (this._seek.endpoint === 1
            && rope.getAttachmentRefs().every((ref) => ref.endpoint !== 1)) {
            rope.relayFreeEnd(x, y);
        }
    }

    /** End the seek (Esc, re-click, target tie, stage change). Leaves the board untouched. */
    cancel() {
        this._seek = null;
        this._preview = null;
        this._refusal = null;
    }

    /**
     * Record a refused tie: the click aimed beyond the rope's reach, so no
     * knot is created and the seek survives; the handle flashes red and
     * the "rope too short" badge paints at the refused aim until the flash
     * expires (ADR 0007 decision 4, issue #54).
     * @param {number} x - refused aim x
     * @param {number} y - refused aim y
     * @private
     */
    _refuse(x, y) {
        this._refusal = { x, y, until: performance.now() + REFUSAL_FLASH_MS };
    }

    /** The Matter body a rope endpoint ties through (0 = anchor, 1 = free end). */
    _endpointBody(rope, endpoint) {
        const bodies = rope?.bodies;
        if (!bodies || !bodies[0]) return null;
        return endpoint === 0 ? bodies[0] : bodies[bodies.length - 1];
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
     * The nearest rope endpoint square within the hit radius, or null —
     * what a click hit-tests against (severed and disposed ropes expose
     * nothing; a square carries the knots sharing its endpoint so the click
     * router can tell a seek entry (free) from an untie (tied)).
     * @private
     */
    _endpointSquareAt(x, y, objects) {
        const best = this._nearestSquare(this.getEndpointSquares(objects, null), x, y);
        return best
            ? { rope: best.square.rope, endpoint: best.square.endpoint, dist: best.dist, knots: best.square.knots }
            : null;
    }

    /**
     * The nearest square of a flow square list within the hit radius, or
     * null — the one shared scan behind the endpoint-square and tie-target
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
     * Every rope endpoint square, with the visibility flags the renderer
     * draws from: a tied square is persistent machine structure, a seeking
     * square holds its seat (and flashes red while its last tie click was
     * refused, issue #54), a free square is hover-revealed.
     * @param {import('../objects/BaseObject.js').default[]} objects — the live board
     * @param {{x: number, y: number}|null} hover — cursor canvas position or null
     * @returns {Array<{rope: import('../objects/Rope.js').default, endpoint: number, x: number, y: number, knots: object[], tied: boolean, seeking: boolean, hovered: boolean, visible: boolean}>}
     */
    getEndpointSquares(objects, hover) {
        const squares = [];
        const refusal = this.refusal; // the most recent refused tie, while it paints
        for (const rope of objects ?? []) {
            if (rope.type !== 'rope' || rope.isSevered) continue;
            const bodies = rope.bodies;
            if (!bodies || !bodies[0]) continue; // disposed rope
            for (const endpoint of [0, 1]) {
                const body = endpoint === 0 ? bodies[0] : bodies[bodies.length - 1];
                const x = body.position.x;
                const y = body.position.y;
                const knots = rope.getAttachmentRefs()
                    .filter((ref) => ref.endpoint === endpoint);
                const tied = knots.length > 0;
                const seeking = !!this._seek
                    && this._seek.rope === rope && this._seek.endpoint === endpoint;
                const hovered = hover
                    ? Math.hypot(hover.x - x, hover.y - y) <= CONNECT_HIT_RADIUS
                    : false;
                squares.push({
                    rope, endpoint, x, y, knots, tied, seeking, hovered,
                    refused: !!refusal && seeking, // the refused handle flashes red
                    visible: tied || seeking || hovered,
                });
            }
        }
        return squares;
    }

    /**
     * Every attachment-point square on the board: during a seek the ones
     * within the seeking rope's reach glow (glow = tieable, ADR 0007
     * decision 4, issue #54 — the same isPointWithinReach predicate the tie
     * click accepts, with the click's aim tolerance); outside a seek, hover
     * shows the faint square. Out-of-reach targets stay visible while
     * seeking but faint — clicking them is refused with feedback. Dead
     * targets (popped, disposed) resolve no world point and drop out; the
     * seeking rope never offers itself a target.
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
                        && seek.rope.isPointWithinReach(world.x, world.y, CONNECT_HIT_RADIUS),
                    hovered,
                    visible: !!seek || hovered,
                });
            }
        }
        return squares;
    }

    /**
     * Untie one knot of a tied square: the knot whose target sits nearest the
     * click wins (ties broken by knot order — the oldest first); dead targets
     * (no world point) untie first, priming them for reconcile-pruning. The
     * remaining knots — and the target's attachment point — stay.
     * @private
     */
    _untie(square, x, y) {
        let victim = null;
        for (const knot of square.knots) {
            const world = knot.target?.getAttachmentWorldPoint?.(knot.pointId) ?? null;
            const dist = world ? Math.hypot(x - world.x, y - world.y) : -1;
            if (!victim || dist < victim.dist) victim = { knot, dist };
        }
        square.rope.detachEndpoint(square.endpoint, victim.knot.target, victim.knot.pointId);
    }
}

/** The ConnectFlow class. DragDropManager owns the live instance; main.js
 * hands that one to the renderer. */
export default ConnectFlow;