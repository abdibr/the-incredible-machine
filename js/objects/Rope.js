/**
 * Rope — Flexible connector between two points
 *
 * Connects two objects or an object to a fixed point.
 * Can be burned by candle flame (severs the constraint).
 *
 * Pinned-rope fixed length (ADR 0007 decision 4, issue #54): the length is
 * the hand's while the rope is untied (relayFreeEnd reels the free-end tie
 * square to the cursor, clamped at MIN_ROPE_SPAN); the first tie freezes it
 * (lengthFrozen, derived from the knots — never drifts from the tie state),
 * beyond-reach ties are refused by the connect flow, and a tie always
 * covers its own knot (max length with slack — never shrunk, never a rod).
 * The reach follows the seat (issue #86): a chain seat's tie gates on that
 * seat's own covering circle, so a mid tie beyond the mid seat's reach is
 * refused while the end seat's circle stays the chain capacity; the anchor
 * seat keeps the whole-rope circle (its knot consumes no chain) and a tie
 * inside the slack band still grows the span just enough for the chain to
 * rest under its knot.
 *
 * Tie seats (issue #90, on #84/#85): a knot is addressed by its seat ROLE
 * and nothing else — attachEndpoint/detachEndpoint take 'anchor' | 'mid'
 * | 'end', live refs carry their seat, saved tokens name it, and no
 * public rope API accepts or returns a segment index as a seat (the old
 * −1…MAX_SEGMENTS−1 schema range, the seat→fraction index arithmetic and
 * the legacy numeric tokens are all gone). A seat accepts its first knot
 * and refuses a second (one knot per seat, three per rope through the
 * flow's three squares); an unknown seat name is refused with a clear
 * error.
 *
 * Span-derived chain counts (ADR 0007 decision 3, issue #56): a rope lays
 * its chain at ~40px per segment — `ceil(span / SEGMENT_DENSITY_PX)`,
 * floored at SEGMENTS (the fresh-drop count every short span keeps) and
 * capped at MAX_SEGMENTS — instead of always six. The count re-derives on
 * every re-lay (setEndpoints), tail segments are appended/dropped while
 * the knots keep riding their seat roles (the anchor never moves, the mid
 * knot the new middle, the end knot the new tail — issue #87 through #90's
 * roles), and the re-segmentation trades
 * only in-world through rope:chain-converge (added/dropped in the packet).
 *
 * Tie-grow (issue #56, one covering rule since #89): a tie that needs more
 * reach grows the span to cover its knot, re-lays the chain along the tie
 * direction, and the count re-derives from the grown span — the same
 * segmentsForSpan rule as birth and every re-lay, for BOTH families. The
 * pinned/free distinction narrows to where it still earns itself: the
 * length freeze (relayFreeEnd's frozen circle) and the reach refusal
 * (isPointWithinReach). The pinned family's old frozen-count tie-grow and
 * the persisted row count that replayed it on load are retired: a restore
 * re-derives the chain from its span, and the seats keep every knot on its
 * role (issue #87).
 *
 * Free-rope span (issue #56, ADR 0007 decision 4): a free rope has no
 * length property of its own — it ties as far as anything is laid, the
 * hand re-lays it to any span (tied or not), and each tie covers itself by
 * re-laying to the demanded span. The pinned rope's frozen circle and
 * refusal are untouched.
 *
 * Named tie seats (issue #84; the only surface since #90): the rope
 * ANSWERS its three tie seats — anchor, mid, end — through getTieSeats():
 * each seat's role, tie body, world point at ask time, and reach as a
 * fraction of the span. No seat answers an index — a knot is addressed by
 * its role and nothing else (issue #90).
 *
 * Seats across growth and re-lay (issue #87, automatic since #90): when
 * the chain's count changes — a tie-grow re-count, the hand re-laying a
 * rope whose knots already live on it — every knot keeps its seat with
 * nothing written at re-count time: a knot's address IS the role (issue
 * #90), the 'end' seat is whatever the tail now is, the 'mid' seat the
 * live middle, the anchor the anchor in every count, and the reconcile
 * realizes each knot's link from whatever body its seat names after the
 * change.
 *
 * Free-rope birth (issue #55 + issue #56): the free family splits on the
 * LENGTH option. A length-less free rope is issue #55's inert coil — no
 * anchor, no segments, nothing in the world — and its first tie births the
 * chain `_spawnChain`. A free rope created WITH a length is an authored
 * span: `PhysicsEngine.addObject` lays its chain on the way into the world
 * (`birthAuthoredChain`, count-honest through segmentsForSpan, laid along
 * the rope's own drop), and its first anchor tie re-roots that chain at
 * the clicked knot over the span it already has (`_reRootChain`) instead
 * of birthing a second one. Both births share `_layChainFrom`, so a
 * chain's shape never depends on which way it was born.
 */

import Matter from 'matter-js';
import BaseObject from './BaseObject.js';
import { eventBus } from '../EventBus.js';

const { Bodies, Body, Constraint } = Matter;

const ROPE_COLOR = '#8B6914';
/**
 * The chain segment count a short span lays (ADR 0007 decision 3, issue
 * #56): the floor of the span-derived count and the fresh-drop/fresh-spawn
 * chain — every span at or below SEGMENTS × SEGMENT_DENSITY_PX keeps the
 * six-segment chain the rope has always laid, so MIN_ROPE_SPAN's 8px
 * pitch and every short-span board keep behaving identically.
 * @type {number}
 */
const SEGMENTS = 6;
const SEGMENT_RADIUS = 3;

/**
 * The seats a rope names (issue #84; THE seat address since #90): knots,
 * tokens, gates and squares address a tie seat by ROLE and nothing else —
 * no public rope API accepts or returns a segment index as a seat.
 * @type {string[]}
 */
const SEAT_ROLES = Object.freeze(['anchor', 'mid', 'end']);

/**
 * Shortest span a rope chain re-lays to (issue #54, ADR 0007 decision 4):
 * six segments of radius 3 need ≥ 8 px pitch each to stay a chain instead
 * of collapsing to a point — a hand re-lay demanding less clamps here
 * instead of breaking the chain. One number, one meaning for every caller.
 * @type {number}
 */
export const MIN_ROPE_SPAN = SEGMENTS * (SEGMENT_RADIUS * 2 + 2);

/**
 * Span budget per chain segment (ADR 0007 decision 3, issue #56): the
 * density the span-derived count derives from — `ceil(span /
 * SEGMENT_DENSITY_PX)` segments span `span` at that pitch, so a rope's
 * rest pitch stays in the ballpark of 40px however far the hand or a tie
 * stretches it.
 * @type {number}
 */
const SEGMENT_DENSITY_PX = 40;

/**
 * Largest chain segment count (ADR 0007 decision 3, issue #56): the
 * "sensibly capped" half of the density rule — beyond the cap a longer
 * span stretches rest lengths instead of multiplying segments, keeping
 * the simulation cost bounded.
 * @type {number}
 */
const MAX_SEGMENTS = 16;

/**
 * The rope family (C1, ADR 0007 decision 1, issue #75): the type keys the
 * rope module treats as rope-family toolbox parts. This list is THE
 * membership fact for the sites that ask family membership — the
 * connect-flow tying squares, the drop-release untie, the snap-trigger
 * exclusion, the cut rows of the interaction matrix, and the anchor
 * refusal — so a new family member is one append here (plus its registry
 * prose), never a hunt for hand-rolled string pairs.
 *
 * The knot-walking consumers (bug-file narrator, knot renderer,
 * placed-board annotator) deliberately do NOT ask this list: they gate
 * capability-first on "offers attachment refs", because knots are what
 * they walk and narration/render/annotation must treat every family member
 * by the same rule. Those gates cannot drift from a roster they never read.
 *
 * Predicates (string-keyed, no registry awareness):
 * - `isRopeFamilyType(type)` — membership by type key;
 * - `isRopeFamily(obj)` — membership by object (safe on shapeless rows).
 *
 * @type {string[]}
 */
export const ROPE_FAMILY_TYPES = Object.freeze(['rope', 'free-rope']);

/**
 * Whether `type` names a rope-family part (C1, issue #75).
 * @param {string|null|undefined} type
 * @returns {boolean}
 */
export function isRopeFamilyType(type) {
    return ROPE_FAMILY_TYPES.includes(type);
}

/**
 * Whether `obj` is a rope-family part (C1, issue #75). Safe on null and on
 * shapeless board rows (boundary-wall plain bodies and other non-parts).
 * @param {{type?: string}|null|undefined} obj
 * @returns {boolean}
 */
export function isRopeFamily(obj) {
    return !!obj && isRopeFamilyType(obj.type);
}

/**
 * Whether `obj` names a severed rope-family member (issue #57): the
 * "a severed rope holds no knots" family truth as one predicate — the
 * tie-side refusal (`attachEndpoint`), the reconcile prune, the bind
 * deferral and the connect flow's target-square filter all ask this one
 * fact instead of hand-rolled family+severed pairs. Safe on null and on
 * shapeless board rows (non-parts, boundary walls).
 * @param {{type?: string, isSevered?: boolean}|null|undefined} obj
 * @returns {boolean}
 */
export function isSeveredRope(obj) {
    return isRopeFamily(obj) && obj.isSevered === true;
}

/**
 * Where a tie seat sits as a fraction of the rope's span (issue #56, the
 * one spelling of the seat arithmetic; role-keyed since #90 — no seat
 * answers an index): the chain END seat covers (count − 0.5)/count — the
 * same fraction that is the pinned reach limit, the tie-grow's covering
 * rule and the hand's inverse; the MID seat covers
 * (midSeatSegment(count) + 0.5)/count — strictly inboard of the end for
 * every count ≥ 2; the ANCHOR seat's answer is 0 (its tie consumes no
 * chain — the glossary's own "0 of the span"; its AIM still gates on the
 * whole-rope capacity, see isPointWithinReach). Kept in one place so the
 * gate that refuses and the grow that covers can never drift apart.
 * @param {'anchor'|'mid'|'end'} seat - the seat's ROLE
 * @param {number} count - the chain's segment count
 * @returns {number} the seat's span fraction
 */
function seatFraction(seat, count) {
    if (seat === 'anchor') return 0;
    if (seat === 'mid') return (midSeatSegment(count) + 0.5) / count;
    return (count - 0.5) / count; // the end seat — the chain capacity
}

/**
 * The chain's middle seat (issue #84): of a `count`-body chain the one body
 * whose seat centre sits nearest the span midpoint — exact for odd counts,
 * tied anchor-ward (the lower index) on even counts, which keeps the mid
 * seat strictly inboard of the end seat for every count ≥ 2 (the SEGMENTS
 * floor keeps every laid count there). Module-private arithmetic behind
 * the seat fractions: it is asked through seatFraction/getTieSeats and
 * never stored, so a re-lay or tie-grow moves it by itself.
 * @param {number} count - the chain's segment count
 * @returns {number} the mid seat's chain index
 */
function midSeatSegment(count) {
    return Math.floor((count - 1) / 2);
}

/**
 * One named-seat answer (issue #84): the shape every body-bearing seat
 * answers — role, tie body, world point at ask time (a fresh snapshot:
 * Matter mutates `position` in place), and the seat's reach as a fraction
 * of the span. One factory, so the three seats answer identical shapes by
 * construction rather than by copies, the way makeSegmentBody mints bodies
 * and _buildChainConstraints builds chains. The reach is THE seat
 * arithmetic's one spelling (seatFraction): the anchor seat 0 (its tie
 * consumes no chain), every chain seat its own fraction — the end seat's
 * covering limit.
 * @param {'anchor'|'mid'|'end'} role
 * @param {Matter.Body} body - the seat's tie body (non-null here; the
 *   bodyless bundle's coil seat builds its own literal in getTieSeats)
 * @param {number} count - the chain's segment count (the reach's denominator)
 * @returns {{role: string, body: Matter.Body,
 *   worldPoint: {x: number, y: number}, reach: number}}
 */
function makeSeatAnswer(role, body, count) {
    return {
        role,
        body,
        worldPoint: { x: body.position.x, y: body.position.y },
        reach: seatFraction(role, count),
    };
}

/**
 * Build one chain segment body (issue #56): THE segment shape, so every
 * path that mints a segment — the pinned ctor's drop, a free chain's
 * `_layChainFrom` birth, and a re-lay's appended tail (`_resizeChain`) —
 * is identical by construction rather than by three copies of the same
 * options. Labels stay `rope-seg-<seat>`; the negative collision group is
 * what lets a rope's own segments pass through each other.
 * @param {number} x
 * @param {number} y
 * @param {number} i - chain index (0…MAX_SEGMENTS-1), for the label
 * @returns {Matter.Body}
 */
function makeSegmentBody(x, y, i) {
    return Bodies.circle(x, y, SEGMENT_RADIUS, {
        density: 0.001,
        friction: 0.8,
        frictionAir: 0.02,
        label: `rope-seg-${i}`,
        collisionFilter: {
            group: -1, // rope segments don't collide with each other
        },
    });
}

export default class Rope extends BaseObject {
    /**
     * @param {number} x - Start anchor x
     * @param {number} y - Start anchor y
     * @param {object} [options={}]
     * @param {number} [options.length=100] - Rope length. On a free rope a
     *   SUPPLIED length is an authored span — the chain lays as the rope
     *   enters a world (issue #56) — while the default keeps issue #55's
     *   bodyless coil until the first tie.
     * @param {boolean} [options.authoredSpan] - Restore override for the
     *   above (a row's answer travels separately from `length`, which
     *   serialize always writes)
     * @param {{x:number, y:number}} [options.endPoint] - End anchor point (default: straight down)
     */
    constructor(x, y, options = {}) {
        // Attachment tokens (issue 04) are consumed here and never land in
        // _options: they are relational restore data (target ordinals into
        // the board snapshot) injected by the annotator — serialize never
        // emits them. Same for the restore hint (issue #56): the row's
        // authored answer travels separately from `length`, which serialize
        // always writes. (The chain count that once rode beside it is
        // retired, issue #89 — the count is the span's rule.)
        const { attachments, authoredSpan, ...behaviorOptions } = options;
        super(x, y, behaviorOptions);
        this._length = options.length || 100;
        // Authored span (issue #56, ADR 0007 decision 3): whether the
        // author supplied this length. `_length`'s `|| 100` default makes
        // the number itself useless as a test (a supplied 100 and a
        // defaulted 100 are the same number), so the fact is recorded once
        // here and only ever read (`hasExplicitSpan`). It is the free
        // family's chain-vs-coil discriminator: an authored free rope lays
        // its chain the moment it enters a world, a length-less one stays
        // issue #55's inert coil until its first tie. A restored row passes
        // `authoredSpan` because Rope.serialize always writes `length`.
        this._authoredSpan = options.authoredSpan ?? (options.length !== undefined);
        this._endPoint = options.endPoint || { x, y: y + this._length };
        this._severed = options.severed ?? false;

        // Free-rope mode (issue #55): the FreeRope registry variant sets
        // `free: true` and the rope is born an inert, bodyless coiled bundle
        // at (x, y) — no anchor, no segments, no constraints. Its first tie
        // gives birth to the hanging chain (attachEndpoint → _spawnChain);
        // its last untie collapses it back (→ _maybeRevertToBundle).
        // Bundled-vs-spawned stays derived state — a bundle is a free rope
        // with zero segments (isFreeBundle), so knots, snapshots and the
        // serializers never manage a second flag.
        this._isFree = options.free ?? false;
        if (this._isFree) this._anchor = null;

        this._segments = [];
        this._constraints = [];

        // Live knots (issue 04), one flat tie list — one knot per seat
        // since #85, and since #90 each knot addresses its seat by ROLE
        // ('anchor' | 'mid' | 'end'): no segment index, no schema range.
        // Tokens live in serialized data only and bind through bindAttachment().
        this._attachments = [];
        this._pendingAttachments = [];

        if (!this._isFree) {
            // Span-derived birth (ADR 0007 decision 3, issue #56): the laid
            // chain sizes to its span through segmentsForSpan (~40px per
            // segment, floored at SEGMENTS — the fresh-drop chain every
            // short span keeps — capped at MAX_SEGMENTS), the same rule a
            // setEndpoints re-lay derives; the constructor rope is just the
            // drop path with the rope's own span. A restore re-derives the
            // count from the saved span the same way (issue #89): the count
            // is a pure function of the span, so save → load → save keeps
            // the chain, the seats and the covering gate exactly as they
            // were — no hint, no creep.
            const count = Rope.segmentsForSpan(this._length);
            const dx = (this._endPoint.x - x) / count;
            const dy = (this._endPoint.y - y) / count;

            for (let i = 0; i < count; i++) {
                const sx = x + dx * (i + 0.5);
                const sy = y + dy * (i + 0.5);

                this._segments.push(makeSegmentBody(sx, sy, i));
            }

            // Static anchor at start
            this._anchor = Bodies.circle(x, y, 4, {
                isStatic: true,
                label: 'rope-anchor',
                collisionFilter: { group: -1 },
            });

            this._constraints = this._severed ? [] : this._buildChainConstraints(this._length);
        }

        // Passive restore tokens (issue 04): a severed rope cannot hold a
        // payload, so it binds nothing.
        this._pendingAttachments = this._severed ? [] : (attachments ?? []);
    }

    get type() { return 'rope'; }

    get bodies() {
        // filter(Boolean) (issue #55): a free bundle has no anchor and a
        // disposed rope may already report released nulls — both must read
        // as zero bodies so every world/snapshot pass stays null-safe.
        return [this._anchor, ...this._segments].filter(Boolean);
    }

    get constraints() {
        return this._constraints;
    }

    /**
     * Free-rope family state (issue #55, ADR 0007 decision 5): true for
     * both the inert bundle and the spawned chain — the state that makes
     * the rope's span unlimited and its anchor a dynamic knot. A laid base
     * rope is never free.
     * @returns {boolean}
     */
    get isFree() {
        return this._isFree === true;
    }

    /**
     * Free-rope COIL state (issue #55): true while a `free` rope is its
     * inert, bodyless bundle. Derived, never stored — the ctor, _spawnChain
     * and _maybeRevertToBundle are the only writers of the members this
     * reads, so it can never drift from reality. A laid base Rope is never
     * a bundle.
     * @returns {boolean}
     */
    get isFreeBundle() {
        return this._isFree === true && this._segments.length === 0;
    }

    /**
     * Authored span (issue #56, ADR 0007 decision 3): true when this rope's
     * length came from its author — a level row, the hand, a test — rather
     * than the bodyless-coil default. The free family's chain-vs-coil
     * discriminator: an authored free rope lays its chain as it enters a
     * world (`birthAuthoredChain`), a length-less one stays issue #55's
     * inert coil until its first tie. Written once by the ctor and read
     * everywhere else, so it can never drift from the rope's own history.
     * @returns {boolean}
     */
    get hasExplicitSpan() {
        return this._authoredSpan === true;
    }

    /**
     * Build the chain constraints along the current layout (anchor→first
     * segment, then consecutive segments). Each link's rest length equals
     * that pair's laid distance — anchor→seg-0 half of segLength, seg↔seg
     * the full segLength — so the intact chain rests at the laid span
     * (shorter lengths yank the rope violently inboard on the first play
     * steps and leave it permanently over-tensioned; ADR 0005 decision 12).
     * Extracted so construction, the severed→intact rewind and setEndpoints
     * re-lays all build identical chains for a given span.
     * @param {number} [spanLength] - end-to-end span the chain is built for
     * @returns {Matter.Constraint[]}
     * @private
     */
    _buildChainConstraints(spanLength = this._length) {
        const segLength = spanLength / this._segments.length;
        const chain = [Constraint.create({
            bodyA: this._anchor,
            bodyB: this._segments[0],
            stiffness: 0.8,
            damping: 0.1,
            length: segLength * 0.5,
        })];
        for (let i = 0; i < this._segments.length - 1; i++) {
            chain.push(Constraint.create({
                bodyA: this._segments[i],
                bodyB: this._segments[i + 1],
                stiffness: 0.8,
                damping: 0.1,
                length: segLength,
            }));
        }
        return chain;
    }

    /**
     * The chain segment count for a span (ADR 0007 decision 3, issue #56):
     * a ~40px-per-segment density — `ceil(span / SEGMENT_DENSITY_PX)` —
     * floored at SEGMENTS (the fresh-drop count: short spans never thin
     * below the six-segment chain the min-span pitch implies) and capped
     * at MAX_SEGMENTS (longer spans stretch rest lengths instead of
     * multiplying segments, keeping simulation cost and tie-token ranges
     * bounded). The one rule every chain birth and every re-lay goes
     * through — the constructor, _spawnChain, setEndpoints and both
     * families' tie-grows (issue #89 retired the frozen-count exception,
     * whose persisted row count replayed it).
     * @param {number} span - end-to-end span in px
     * @returns {number} a count in SEGMENTS…MAX_SEGMENTS
     */
    static segmentsForSpan(span) {
        if (!Number.isFinite(span) || span <= 0) return SEGMENTS;
        return Math.min(MAX_SEGMENTS, Math.max(SEGMENTS, Math.ceil(span / SEGMENT_DENSITY_PX)));
    }

    /**
     * The body a knot tied at seat `seat` hangs its engine link from (issue
     * 04, generalized to named seats in issue #84; role-keyed since #90):
     * the ANCHOR seat's anchor body, the MID seat the live chain's middle,
     * the END seat the live tail. An unknown seat name — or a rope without
     * the body (a chain-less rope's mid/end, a disposed anchor) — resolves
     * null, the shape reconcile's staleness scan's prune signal.
     * @param {'anchor'|'mid'|'end'} seat
     * @returns {Matter.Body|null}
     * @private
     */
    _tieBody(seat) {
        if (seat === 'anchor') return this._anchor ?? null;
        const count = this._segments.length;
        if (count === 0) return null;
        if (seat === 'mid') return this._segments[midSeatSegment(count)];
        if (seat === 'end') return this._segments[count - 1];
        return null;
    }

    // ── Named tie seats (issue #84: anchor, mid, end) ────────

    /**
     * The rope's three named tie seats — anchor, mid, end (issue #84), in
     * that order. Each seat answers:
     * - `role` — 'anchor' | 'mid' | 'end' (issue #90: the seat's own
     *   address — the way attachEndpoint/detachEndpoint, live refs, tokens
     *   and the squares all speak; no seat answers an index);
     * - `body` — the seat's tie body (a live Matter body, or null where
     *   no body exists — a bodyless free bundle's coil seat);
     * - `worldPoint` — where the seat ties at ask time (the rope body's
     *   centre: where a square draws and a knot link pins, length 0). A
     *   fresh snapshot per ask — Matter mutates `position` in place, so
     *   per-frame consumers re-ask each frame instead of holding the point;
     * - `reach` — where the seat's tie body sits as a fraction of the span
     *   (seatFraction): the anchor seat 0 (its tie consumes no chain), the
     *   end seat (count − 0.5)/count — the same number the reach gate and
     *   the tie-grow's covering rule use today.
     *
     * The mid seat is a ROLE, never stored (issue #84): it resolves on
     * every ask against the live chain — the chain's middle body (ties
     * anchor-ward on an even count) — so after any re-lay or tie-grow, of
     * either family, it is still the middle, and no tie write can ever
     * move it.
     *
     * Seat presence follows the live structure: a laid rope answers three;
     * a bodyless free bundle answers only its anchor seat (no chain yet —
     * body null, the coil point stands in, exactly the square ConnectFlow
     * already draws there); a disposed rope answers nothing (parity with
     * `bodies`, which reads empty). A severed rope keeps its chain, so its
     * seats still answer — ConnectFlow is what withholds squares.
     * @returns {Array<{role: 'anchor'|'mid'|'end',
     *   body: Matter.Body|null, worldPoint: {x: number, y: number}|null,
     *   reach: number}>}
     */
    getTieSeats() {
        const seats = [];
        const count = this._segments.length;
        // The anchor seat: the nail (pinned rope), the spawned chain's
        // moving knot (free rope, issue #55) — or, on a bodyless bundle,
        // the coil square's seat with no body and the coil centre for a
        // point (the same answer ConnectFlow's bundle branch draws).
        if (this._anchor) {
            seats.push(makeSeatAnswer('anchor', this._anchor, count));
        } else if (this.isFreeBundle) {
            seats.push({
                role: 'anchor',
                body: null,
                worldPoint: { x: this._x, y: this._y },
                reach: 0,
            });
        }
        // The chain seats: mid resolves against the LIVE count (never
        // stored, issue #84), end is whatever the tail currently is.
        if (count > 0) {
            seats.push(makeSeatAnswer('mid', this._segments[midSeatSegment(count)], count));
            seats.push(makeSeatAnswer('end', this._segments[count - 1], count));
        }
        return seats;
    }

    // ── Rope as a tie target (issue #57) ─────────────────────

    /**
     * The rope's endpoint bodies as attachment points (issue #57, the
     * rope-as-tie-target half of ADR 0007 decision 6): a rope offers the
     * bodies other ropes' knots tie INTO — the anchor body (the pinned
     * nail, or a spawned free chain's moving knot) and the tail segment —
     * named by the seat roles the body bears ('anchor', 'end'), offset 0
     * (the body's center is the tie point: where a square draws and a
     * knot link pins, length 0). The mid seat is deliberately not an
     * attachment point: the acceptance scope is the endpoint squares.
     *
     * A bodyless free bundle answers none (its one coil square is a seek
     * entry only — no body to bear a knot link, and the flow's bundle
     * spawn is the bundle's own tie); a severed rope still answers —
     * its chain bodies exist — and the ties-into-a-severed-rope refusal
     * (`attachEndpoint`'s target gate) and the reconcile's prune hold the
     * "a severed rope holds no knots" family truth from the tie side.
     * A disposed rope answers nothing (parity with `bodies`).
     *
     * One knot per seat still governs the seeking rope; the TARGET side
     * keeps the attachment-point rule — one point serves every rope that
     * ties it (issue 04).
     * @returns {Array<{id: 'anchor'|'end', body: Matter.Body, offset: {x: number, y: number}}>}
     */
    get attachmentPoints() {
        const points = [];
        if (this._anchor) {
            points.push({ id: 'anchor', body: this._anchor, offset: { x: 0, y: 0 } });
        }
        const tail = this._segments[this._segments.length - 1];
        if (tail) {
            points.push({ id: 'end', body: tail, offset: { x: 0, y: 0 } });
        }
        return points;
    }

    // ── Attachments (issue 04: rope as a connector) ────────

    /**
     * Tie the seat named `seat` to a named attachment point on a live
     * target (issue #90: the seat is a ROLE — 'anchor' | 'mid' | 'end' —
     * and nothing else; an unknown name is refused with a clear error).
     * A rope answers three seats (getTieSeats), each accepting its first
     * knot and refusing a second — one knot per seat, three per rope
     * through the flow's three squares (issue #85; the seat gate throws
     * before anything re-lays or grows). The rope stores only live refs —
     * the physical engine link is realized on the next step (see
     * onBeforeUpdate). A bodyless free bundle answers only its anchor
     * seat: its first tie is the birth of the chain (issue #55). An
     * authored free rope already has its chain, so that same first anchor
     * tie re-roots it at the clicked knot (issue #56) before the coverage
     * rules below run.
     * @param {'anchor'|'mid'|'end'} seat
     * @param {import('./BaseObject.js').default} target
     * @param {string} pointId
     */
    attachEndpoint(seat, target, pointId) {
        if (!SEAT_ROLES.includes(seat)) {
            throw new Error(`[Rope] attachEndpoint: seat must be 'anchor', 'mid' or 'end', got ${String(seat)}`);
        }
        const known = target?.attachmentPoints?.some((p) => p.id === pointId);
        if (!known) {
            throw new Error(`[Rope] attachEndpoint: target ${target?.type ?? target} offers no attachment point "${pointId}"`);
        }
        // Rope-to-rope targets (issue #57): a severed rope holds no knots
        // — the family truth, from the tie side. Its chain bodies still
        // answer attachment points, but they are falling apart; the
        // reconcile prunes any into-knots that predate the cut, so this
        // refusal keeps new ones from ever landing (a restore token binds
        // through here and drops with its warning, as any refused tie).
        if (isSeveredRope(target)) {
            throw new Error(`[Rope] attachEndpoint: the severed ${target.type} holds no knots — its chain is cut`);
        }
        // One knot per seat (issue #85): a seat that already holds a knot
        // refuses a second tie — no knot is created, nothing re-lays, no
        // grow runs. The connect flow squares only the three named seats
        // and can only start a seek from a free one, so a click-tied rope
        // holds at most three knots; this gate is the rope-side guard for
        // every path (the armed free-rope seek's second tie click included,
        // a restore's double-seat token included), and untie stays
        // per-knot: a tied square's click unties exactly the seat's own
        // knot. Every knot the API ties sits on a named role (issue #90) —
        // there is no other address left to arrive through.
        if (this._attachments.some((ref) => ref.seat === seat)) {
            throw new Error(`[Rope] attachEndpoint: the ${seat} seat already holds a knot — one knot per seat`);
        }
        if (this.isFreeBundle && seat !== 'anchor') {
            throw new Error(`[Rope] attachEndpoint: a bodyless bundle has no ${seat} seat to tie`);
        }
        // First tie on a free bundle (issue #55) is the birth of the chain:
        // spawn it hanging straight down from the tie point at the rope's
        // length, then tie exactly like a laid rope below. Later ties hit a
        // spawned chain and follow the normal span rules (reach refusals
        // included) — the spawn freezes the length via the knot this push
        // creates, and the engine's 'rope:chain-spawned' consumer puts the
        // newborn chain into the world.
        if (this.isFreeBundle) {
            this._spawnChain(target, pointId);
        } else if (this._isFree && seat === 'anchor') {
            // An authored free rope laid its chain as it entered the world
            // (issue #56, birthAuthoredChain), so its FIRST anchor tie
            // re-roots that chain at the clicked knot instead of birthing a
            // second one — the tie hangs from exactly the knot that was
            // clicked, over the span the chain already has. No knot-empty
            // check here: the one-knot-per-seat gate above (issue #85) has
            // already refused any second anchor tie, so a run past this
            // line IS the anchor seat's first tie.
            const world = target.getAttachmentWorldPoint?.(pointId) ?? null;
            if (world) this._reRootChain(world.x, world.y);
        }
        // Seat gate vs the chain actually laid: a rope answers a chain seat
        // only with the chain to hold it — a chain-less rope (a coil that
        // restored, say) refuses its mid/end names here. A fresh spawn
        // always births SEGMENTS, so a first anchor tie never refuses
        // anywhere.
        if (seat !== 'anchor' && this._segments.length === 0) {
            throw new Error(`[Rope] attachEndpoint: this rope has laid no chain — no ${seat} seat to tie`);
        }
        this._attachments.push({ seat, target, pointId });
        // Fixed length covers its own knots (ADR 0007 decision 4, issues
        // #54/#56): a tie that reaches past the chain's laid capacity grows
        // the length so the chain's rest lengths span the tied distance —
        // the chain is never over-tensioned by its own knot, and no tie
        // ever shrinks the rope. The tied seat's tie body sits
        // seatFraction(seat, count) of the span inboard of the layout end,
        // so the tied distance's capacity limit is tied <= _length ×
        // seatFraction(seat, count) and the covering span grows to tied /
        // seatFraction(seat, count) — the same one spelling the seat's
        // reach answers (issue #90's role arithmetic).
        // The coverage is the LIVE chain's, not just the accounting: a
        // bump-only grow left the laid (shorter) constraints stepping into
        // play, and the length-0 knot link then resolved the deficit by
        // hauling the tied target inboard / stretching the chain taut — the
        // "silently snapping or stretching" ADR 0007 decision 4 refuses.
        // So the grow re-lays the chain along the tie direction through
        // setEndpoints (bodies re-line, the chain rebuilds for the grown
        // span, and rope:chain-converge lets an in-world rope swap its
        // chain — the registration guard keeps the event a no-op out of
        // world), then seals _length exact against setEndpoints'
        // float-dust re-derivation, the same seal relayFreeEnd uses. Grown
        // capacity = tied span / seat inboard-ness.
        // The grow's count re-derives from the grown span (issue #89 — ONE
        // covering rule for both families): the tie that needs more reach
        // re-lays the chain, and setEndpoints re-counts it exactly the way
        // birth and every other re-lay do. The families' pinned/free split
        // narrows to where it still earns itself — the length freeze (a
        // pinned rope's relayFreeEnd holds the span) and the reach refusal
        // (isPointWithinReach) — never the counting; the frozen-count
        // exception and the persisted row count that replayed it on load
        // are retired. Every seat the API ties is one of the three named
        // roles (issue #90), so every knot rides the re-count onto its
        // role's own seat — the equal-or-greater fraction of issue #87 —
        // and a flow-tied knot's cover holds through it.
        // Severed ropes keep accounting-only growth (nothing lays or
        // reconciles for them); a spawned bundle never reaches here past
        // capacity (its first tie sits at the anchor, tied = 0).
        // Measured from the anchor; the anchor knot realizes at the anchor
        // itself and consumes no chain.
        if (seat !== 'anchor' && this._anchor) {
            const world = target.getAttachmentWorldPoint?.(pointId) ?? null;
            if (world) {
                const tied = Math.hypot(
                    world.x - this._anchor.position.x,
                    world.y - this._anchor.position.y
                );
                const oldCount = this._segments.length;
                const frac = seatFraction(seat, oldCount);
                if (tied > this._length * frac) {
                    const grown = tied / frac;
                    if (!this._severed && oldCount) {
                        const anchor = this._anchor.position;
                        const ux = (world.x - anchor.x) / tied;
                        const uy = (world.y - anchor.y) / tied;
                        this.setEndpoints(
                            { x: anchor.x, y: anchor.y },
                            { x: anchor.x + ux * grown, y: anchor.y + uy * grown },
                        );
                        this._length = grown; // exact seal (setEndpoints re-derived with float dust)
                        // No ride needed here (issue #87): setEndpoints already
                        // re-seated every named-seat knot — this tie included.
                    } else {
                        this._length = grown; // severed: reconcile skips it — accounting only
                    }
                }
            }
        }
    }

    /**
     * Untie one knot (ADR 0007 decision 8 — untie stays per-knot) identified
     * by its live ref — the rope side frees, the target keeps its attachment
     * point. The physical link drops on the next reconcile step (an emptied
     * tie's body releases its former links, see _reconcileAttachments).
     * @param {'anchor'|'mid'|'end'} seat
     * @param {import('./BaseObject.js').default} target
     * @param {string} pointId
     * @returns {boolean} true when a matching knot was removed
     */
    detachEndpoint(seat, target, pointId) {
        if (!SEAT_ROLES.includes(seat)) {
            throw new Error(`[Rope] detachEndpoint: seat must be 'anchor', 'mid' or 'end', got ${String(seat)}`);
        }
        const idx = this._attachments.findIndex(
            (knot) => knot.seat === seat && knot.target === target && knot.pointId === pointId
        );
        if (idx === -1) return false;
        this._attachments.splice(idx, 1);
        // Last knot gone (issue #55): a spawned free rope with nothing left
        // tied collapses back into its inert bundle (the engine consumer
        // pulls the chain out of the world).
        this._maybeRevertToBundle();
        return true;
    }

    /**
     * Live knots in ref form for serialization (issue 04): the board
     * annotator (levelReset.serializePlacedBoard) maps each target to its
     * board ordinal and writes `attachments` onto the rope's serialized
     * entry — every ref carries its seat ROLE (issue #90: the only seat
     * address, so the token simply re-uses it); rope.serialize() itself
     * intentionally emits no tokens. Order: anchor, mid, end (the seats'
     * own order).
     * @returns {Array<{seat: 'anchor'|'mid'|'end', target: import('./BaseObject.js').default, pointId: string}>}
     */
    getAttachmentRefs() {
        const order = (seat) => SEAT_ROLES.indexOf(seat);
        return [...this._attachments]
            .sort((a, b) => order(a.seat) - order(b.seat))
            .map(({ seat, target, pointId }) => ({ seat, target, pointId }));
    }

    /**
     * Untie every knot of this rope (edit-time: the player moved the rope
     * or a target left the board). The physical links are dropped by the
     * next reconcile step — or earlier by the engine's co-termination on
     * removal.
     */
    clearAttachments() {
        this._attachments = [];
        // Wholesale untie (issue #55 — the edit-time move untie): an
        // emptied spawned free rope collapses back into its inert bundle.
        this._maybeRevertToBundle();
    }

    /**
     * Resolve pending attachment tokens (from deserialize) against a board
     * array — the full beginPlay snapshot whose order the tokens'
     * `targetOrdinal`s index into. Tokens name their seat by role (issue
     * #88's schema; the only form since #90) and bind through
     * attachEndpoint: the anchor tie of a restored free bundle births the
     * chain, so the later mid/end names resolve against the birthed count
     * (rows save anchor-first). Unresolvable tokens are dropped with a
     * warning; the pending list ends empty when this call binds strictly.
     * A severed rope binds nothing.
     *
     * Issue #57 (the rope-to-rope bind-order seam): a token whose TARGET
     * is a rope family member that has laid no chain yet is DEFERRED —
     * kept in `_pendingAttachments` and retried at the next
     * bindAttachment call — instead of dropping, when the caller allows
     * deferrals (`deferUnlaidRopeTargets`). The target rope's chain can
     * birth during ITS own bind pass (the spawned free rope's anchor
     * token, issue #55), so a token processed earlier in the board order
     * would otherwise drop on a chain that arrives a pass later. The
     * caller drives the retry passes (levelReset.bindPlacedTokens); a
     * plain call (no options) is strict and behaves exactly as before.
     *
     * @param {import('./BaseObject.js').default[]|null} board
     * @param {{deferUnlaidRopeTargets?: boolean}} [opts]
     * @returns {boolean} whether this call BOUND at least one token (a
     *   deferral neither binds nor drops — the retry-pass driver senses
     *   progress through it)
     */
    bindAttachment(board, opts = {}) {
        const { deferUnlaidRopeTargets = false } = opts;
        const pendingTokens = this._pendingAttachments;
        this._pendingAttachments = [];
        if (this._severed) return false;
        let bound = false;
        for (const raw of pendingTokens) {
            const token = this._migrateTieToken(raw);
            if (!token) continue;
            const target = board?.[token.targetOrdinal];
            if (!target || target.type !== token.targetType) {
                console.warn(`[Rope] Dropping attachment token: no ${token.targetType} at board ordinal ${token.targetOrdinal}`);
                continue;
            }
            try {
                this.attachEndpoint(token.seat, target, token.pointId);
                bound = true;
            } catch (e) {
                // The rope-target deferral (issue #57): a target rope whose
                // chain has not been laid YET still may — at its own bind
                // pass (the spawned bundle births there, issue #55). A
                // severed target is done laying forever and a non-rope
                // target always has the bodies it will have: neither
                // defers; the token drops with its warning as before.
                if (deferUnlaidRopeTargets && isRopeFamily(target)
                    && !isSeveredRope(target) && target.bodies.length === 0) {
                    this._pendingAttachments.push(raw);
                    continue;
                }
                console.warn(`[Rope] Dropping attachment token: ${e.message}`);
            }
        }
        return bound;
    }

    /**
     * Tie-token restore shapes (issue #88; the only form since #90): the
     * token names its seat by role — `{ seat: 'anchor'|'mid'|'end',
     * targetType, targetOrdinal, pointId }` — and binds at whatever seat
     * of the chain this rope holds AT BIND that role holds (the anchor
     * seat in every count, the mid the live middle, the end the live
     * tail), so restoring re-binds the knot to the same seat whatever the
     * chain's count. A 'mid'/'end' name on a rope that restored without a
     * chain has no seat to hold — dropped with a warning. Anything else —
     * null, garbage values, a non-role seat name, and the legacy numeric
     * keys (issue #56's `segment`, issue 04's `endpoint`) — is refused
     * with a clear warning apiece: nothing addresses a seat by index any
     * more (issue #90), so a pre-#90 knot drops instead of migrating.
     * Nothing throws.
     * @param {object} raw
     * @returns {{seat: 'anchor'|'mid'|'end', targetType: string, targetOrdinal: number, pointId: string}|null}
     * @private
     */
    _migrateTieToken(raw) {
        if (!raw || typeof raw !== 'object') return null;
        // Named-seat form (issue #88): bind by ROLE — the anchor is the
        // anchor in every count, including a bodyless bundle's, whose
        // anchor-seat tie is the first tie that births the chain (issue
        // #55); a chain role on a bundle-bound rope without a chain has no
        // body to hold and drops.
        if (SEAT_ROLES.includes(raw.seat)) {
            if (raw.seat !== 'anchor' && this._segments.length === 0) {
                console.warn(`[Rope] Dropping seat token (${raw.seat}) — this rope restored without a chain, no seat to hold`);
                return null;
            }
            return {
                seat: raw.seat,
                targetType: raw.targetType,
                targetOrdinal: raw.targetOrdinal,
                pointId: raw.pointId,
            };
        }
        // Anything else is refused with a clear warning: a non-role seat
        // name, or the legacy numeric forms (issue #56's `segment` key,
        // issue 04's `endpoint`) — segment indices are no longer seats
        // (issue #90), so such a knot drops instead of migrating.
        const seatName = raw.seat === undefined ? 'no seat name' : `seat ${JSON.stringify(raw.seat)}`;
        console.warn(`[Rope] Dropping attachment token — ${seatName} is not a seat role ('anchor'|'mid'|'end'): segment-index tokens are retired (issue #90); re-tie the knot and re-save the board`);
        return null;
    }

    /**
     * Issue 04: realize/reconcile knot links each step before the world
     * updates (BaseObject lifecycle seam — PhysicsEngine.step calls this).
     * @param {import('../engine/PhysicsEngine.js').PhysicsEngine} engine
     */
    onBeforeUpdate(engine) {
        if (this._severed) return;
        this._reconcileAttachments(engine);
    }

    /**
     * Converge the engine's link set to this rope's knot state: one link
     * per live knot (realized lazily on the first step after attach/bind,
     * and re-realized after each snapshot rewind), stale links dropped,
     * dead targets (popped/disposed/no longer registered) pruned from the
     * knot refs. Every rope body — the anchor and each chain segment,
     * issue #56 — joins the scan, so a knot untied last step releases its
     * former link on this one. A severed rope realizes nothing (its
     * payload links were already co-terminated by the sever consumer).
     *
     * The desired set also names the INBOUND pairs (issue #57, the
     * rope-to-rope half): the pairs other live ropes' knots tie into this
     * rope's attachment points. The scan would otherwise read such a pair
     * as a stale link at this rope's own body (the bearer is one of mine;
     * it is wanted by the other rope's ref, not mine) and kill it every
     * step — the inbound pairs stand while the target ref lives, and die
     * with it (the holder untied / disposed / removed from the engine,
     * or severed: its reconcile realizes nothing, and its refs are the
     * only thing keeping the pairs here).
     * @param {import('../engine/PhysicsEngine.js').PhysicsEngine} engine
     * @private
     */
    _reconcileAttachments(engine) {
        const desired = new Map();
        // Every rope body joins the stale-link drop scan regardless of
        // whether any knot remains on it (an untied or shrunken segment
        // must still release its former links on the next step).
        const linkBodies = this.bodies;
        // Keep only knots whose target is still a live, registered object —
        // and whose tie seat resolves to a rope body (issue #90: the seat
        // is the role; an unknown role or a bodyless seat prunes).
        this._attachments = this._attachments.filter((knot) =>
            this._tieBody(knot.seat) !== null
            && knot.target
            && engine.getObjects().has(knot.target)
            && knot.target.bodies.some(Boolean)
            && knot.target.attachmentPoints.some((p) => p.id === knot.pointId)
            // The severed-target prune (issue #57, the pre-piece-severing
            // policy): a cut rope holds no knots from either side — the
            // sever consumer co-terminates the engine links; this prunes
            // the live refs that would otherwise re-realize them on the
            // next step.
            && !isSeveredRope(knot.target)
        );
        for (const knot of this._attachments) {
            const linkBody = this._tieBody(knot.seat);
            const ap = knot.target.attachmentPoints.find((p) => p.id === knot.pointId);
            const targetBody = ap?.body ?? null;
            if (!targetBody) continue; // the point's body is currently unavailable
            desired.set(`${linkBody.id}|${targetBody.id}`, {
                linkBody,
                targetBody,
                offset: { x: ap.offset.x, y: ap.offset.y },
            });
        }

        // The inbound pairs (issue #57): for every LIVE, REGISTERED rope
        // (the getAttachmentRefs duck check — only the rope family walks
        // knots) whose ref ties INTO one of this rope's attachment points,
        // the pair (its seat body ↔ the bearer body here) is wanted by
        // that ref. A severed holder counts for nothing (its reconcile
        // realizes nothing); a holder removed from the engine stops
        // counting at the registration gate, and a disposed holder's refs
        // are already gone. Same unordered pair the out-knots use —
        // whichever rope reconciles first realizes it once (the exists
        // check), and the holder's untie is what drops it.
        for (const obj of engine.getObjects()) {
            if (obj === this || typeof obj.getAttachmentRefs !== 'function') continue;
            if (obj.isSevered) continue;
            for (const ref of obj.getAttachmentRefs()) {
                if (ref.target !== this) continue;
                const seatBody = obj.getTieSeats().find((s) => s.role === ref.seat)?.body ?? null;
                const ap = this.attachmentPoints.find((p) => p.id === ref.pointId);
                const bearer = ap?.body ?? null;
                if (!seatBody || !bearer || !engine.getObjectForBody(seatBody)) continue;
                desired.set(`${seatBody.id}|${bearer.id}`, {
                    linkBody: seatBody,
                    targetBody: bearer,
                    offset: { x: ap.offset.x, y: ap.offset.y },
                });
            }
        }

        // Drop engine-attached links at this rope's endpoints that no longer
        // match a live knot (untied, moved, or dead target).
        if (linkBodies.length > 0) {
            for (const link of engine.getAttachedConstraints()) {
                const touches = linkBodies.includes(link.bodyA) || linkBodies.includes(link.bodyB);
                if (!touches) continue;
                const keyForward = `${link.bodyA.id}|${link.bodyB.id}`;
                const keyReverse = `${link.bodyB.id}|${link.bodyA.id}`;
                if (!desired.has(keyForward) && !desired.has(keyReverse)) {
                    engine.detachConstraint(link);
                }
            }
        }

        // Realize missing links (length 0: the knot point is pinned at the
        // rope body's center with a soft link, so the knot follows strain).
        for (const { linkBody, targetBody, offset } of desired.values()) {
            const exists = engine.getAttachedConstraints().some((link) =>
                (link.bodyA === linkBody || link.bodyB === linkBody)
                && (link.bodyA === targetBody || link.bodyB === targetBody)
            );
            if (!exists) {
                engine.attachConstraint(linkBody, targetBody, {
                    pointB: { x: offset.x, y: offset.y },
                    length: 0,
                    stiffness: 0.9,
                    damping: 0.1,
                });
            }
        }

        // Every knot died with its target during play (issue #55): a fully
        // orphaned spawned free rope collapses back into its bundle.
        this._maybeRevertToBundle();
    }

    get bounds() {
        // Bodyless free bundle (issue #55): a small static box centered on
        // the coil — the same footprint the coil glyph draws, so drag
        // hit-testing matches the visual. (A laid rope bounds its segments.)
        if (this.isFreeBundle) {
            return { x: this._x - 14, y: this._y - 14, width: 28, height: 28 };
        }
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const seg of this._segments) {
            const p = seg.position;
            if (p.x < minX) minX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.x > maxX) maxX = p.x;
            if (p.y > maxY) maxY = p.y;
        }
        return { x: minX - 5, y: minY - 5, width: maxX - minX + 10, height: maxY - minY + 10 };
    }

    setPosition(x, y) {
        const dx = x - this._x;
        const dy = y - this._y;
        super.setPosition(x, y);
        // Bodyless free bundle (issue #55): nothing exists in the world yet
        // — only the coil center tracks (x, y); it becomes the spawn anchor.
        if (this._anchor) Body.setPosition(this._anchor, { x, y });
        for (const seg of this._segments) {
            Body.translate(seg, { x: dx, y: dy });
        }
    }

    /**
     * The unit direction this rope's chain lies along (issue #56): from its
     * own (x, y) toward its stored `_endPoint` — the ctor's straight-down
     * drop for a fresh rope, the author's angle when a level supplied one.
     * Falls back to straight down while the rope has no usable end point (a
     * collapsed bundle nulls it). Both births read it, so a chain born at
     * `addObject` lies the way its rope says.
     * @returns {{x: number, y: number}}
     * @private
     */
    _spanDirection() {
        const dx = Number.isFinite(this._endPoint?.x) ? this._endPoint.x - this._x : 0;
        const dy = Number.isFinite(this._endPoint?.y) ? this._endPoint.y - this._y : 0;
        const span = Math.hypot(dx, dy);
        if (!span) return { x: 0, y: 1 };
        return { x: dx / span, y: dy / span };
    }

    /**
     * Lay a newborn chain from (anchorX, anchorY) along the unit direction
     * (ux, uy) (issue #56): `Rope.segmentsForSpan(this._length)` segments
     * spread over the rope's length, the free rope's anchor as a dynamic
     * knot, and the shared chain build. The one body/constraint builder both
     * births go through — `_spawnChain` (a tie births the chain, issue #55)
     * and `birthAuthoredChain` (an authored span births it at `addObject`,
     * issue #56) — so a chain's shape never depends on how it was born:
     * knots, reach and snapshots all read the same thing.
     * @param {number} anchorX - where the chain's anchor knot sits
     * @param {number} anchorY
     * @param {number} [ux=0] - unit direction the chain lies along
     * @param {number} [uy=1]
     * @private
     */
    _layChainFrom(anchorX, anchorY, ux = 0, uy = 1) {
        this.setPosition(anchorX, anchorY); // bundle: only re-centers the coil
        const span = this._length;
        // Count-honest birth (issue #56, ADR 0007 decision 3): the chain
        // births what its length demands (segmentsForSpan), the same density
        // rule a setEndpoints re-lay derives — the fresh-drop floor keeps
        // short spans at the six-segment chain a drop lays. There is no
        // saved-count hint to honor (issue #89): the count is the span's
        // rule, so a restored row re-births the chain its span derives and
        // a save/load cycle is idempotent by arithmetic.
        const count = Rope.segmentsForSpan(span);
        const pitch = span / count;
        this._endPoint = { x: anchorX + ux * span, y: anchorY + uy * span };

        for (let i = 0; i < count; i++) {
            this._segments.push(makeSegmentBody(
                anchorX + ux * pitch * (i + 0.5),
                anchorY + uy * pitch * (i + 0.5),
                i,
            ));
        }

        // The free rope's "anchor" is a dynamic KNOT, not a nail (issue #55,
        // ADR 0007 decision 5): the chain hangs FROM its tie target, so this
        // body is hauled along by the anchor knot's link (segment −1)
        // realized on the next step. A static body here froze the tie (the
        // bugfile: the first
        // balloon swinging 25.6px around a pinned end). The knot must never
        // auto-sleep while hauling (this Matter build does not wake sleeping
        // bodies through constraints), and it rides its tie without
        // colliding with it — a knot, not a bumper.
        this._anchor = Bodies.circle(anchorX, anchorY, 4, {
            isStatic: false,
            label: 'rope-anchor',
            collisionFilter: { group: -1, mask: 0 },
            sleepThreshold: Infinity,
        });

        this._constraints = this._buildChainConstraints(span);
    }

    /**
     * Birth the chain of an AUTHORED-span free rope (issue #56, ADR 0007
     * decision 3) — the birth path for a bundle with no tie target, and the
     * counterpart of `_spawnChain`. A free rope created WITH a length lays
     * its chain as it enters a world, so the count is honest from the first
     * frame instead of only after a tie; a length-less free rope keeps issue
     * #55's inert coil and births at its first tie instead. The chain lies
     * along the rope's own stored direction with the free family's dynamic
     * anchor knot (decision 5), exactly like a tie-born chain, and the first
     * anchor tie then RE-ROOTS it at the clicked knot (`_reRootChain`)
     * instead of birthing a second one.
     *
     * Addressed by `PhysicsEngine.addObject` (capability-first, so every
     * other part is a no-op): the engine lays the chain before its body loop
     * runs, so the newborn bodies and constraints join the world in that
     * same pass. No event is emitted — the world-add is already happening;
     * `rope:chain-spawned` stays the tie-born path's "add this chain" seam.
     * @returns {boolean} whether a chain was laid
     */
    birthAuthoredChain() {
        if (!this._isFree || this._severed) return false;
        if (this._segments.length > 0) return false; // already laid or spawned
        if (!this._authoredSpan) return false; // issue #55's coil
        const { x: ux, y: uy } = this._spanDirection();
        this._layChainFrom(this._x, this._y, ux, uy);
        return true;
    }

    /**
     * Re-root a pre-laid chain at its first tie (issue #56): the chain was
     * born on the rope's own drop, so the first anchor tie (−1) moves the
     * dynamic anchor knot onto the clicked attachment point and re-lays the
     * chain from there over the SAME span — same bodies, same seats, same
     * count: a re-root is not a re-count, and no knot can hang on the
     * newborn chain's seats yet. The re-lay re-derives the count the
     * unchanged span answers — the same number the chain birthed (issue
     * #89: the count is the span's rule at every seam, so there is no
     * saved-chain contract to protect and no frozen re-lay needed; band
     * -edge float dust aside, the packet would report any trade honestly).
     * setEndpoints re-lines the segments and rebuilds the chain, and its
     * `rope:chain-converge` consumer swaps the rebuilt constraints into a
     * world that already holds the old ones.
     *
     * This is the free family's reach promise made physical: a tie hangs
     * from exactly the knot that was clicked, wherever the coil happened to
     * be lying.
     * @param {number} x - the clicked attachment point, world space
     * @param {number} y
     * @private
     */
    _reRootChain(x, y) {
        const span = this._length;
        const { x: ux, y: uy } = this._spanDirection(); // before the re-lay rewrites it
        // A re-root is not a re-count: the tie changes no span, so the
        // re-lay re-derives the count the unchanged span already answers —
        // the same number the chain birthed (issue #89: the count is the
        // span's rule at every seam, there is no saved-chain contract to
        // protect). Float dust on either side of a segmentsForSpan band
        // edge could still trade a body; the converge packet reports it
        // like any re-lay.
        this.setEndpoints(
            { x, y },
            { x: x + ux * span, y: y + uy * span },
        );
        this._length = span; // exact seal (setEndpoints re-derived with float dust)
    }

    /**
     * Give birth to the free chain from a tie (issue #55): the first tie on
     * a bodyless bundle spawns the chain from the tie point at the rope's
     * current length. The laying itself is the shared `_layChainFrom` both
     * births go through — `_spawnChain` (a tie births the chain) and
     * `birthAuthoredChain` (an authored span births it at `addObject`) —
     * so a spawned chain and a laid rope are indistinguishable downstream
     * (knots, reach, snapshots), and so is an authored chain born at
     * `addObject`. The engine's 'rope:chain-spawned' consumer (registration-
     * guarded) owns the world add — addObject long ran for the bodyless
     * rope and will not run again.
     *
     * The lay DIRECTION follows the span's own answer (issue #93, the
     * bugfile's divergence verdict): a restored spawned row carries its
     * recorded span as real state (`_authoredSpan` — FreeRope.deserialize
     * rides the row's `spawned` veto), and the chain must re-derive from
     * the row exactly as the live world held it, endPoint included — the
     * fresh-coil straight-down birth teleported a restored lay across the
     * board (bug-20261114T021258Z-ufzs: the recorded event-count vs 0). A
     * fresh LIVE coil (no span of its own) keeps issue #55's documented
     * straight-down birth; a collapsed bundle's nulled endPoint falls back
     * to it through `_spanDirection()`.
     *
     * @param {import('./BaseObject.js').default} target
     * @param {string} pointId
     * @private
     */
    _spawnChain(target, pointId) {
        const world = target.getAttachmentWorldPoint?.(pointId) ?? null;
        const { x: ux, y: uy } = this._authoredSpan
            ? this._spanDirection()
            : { x: 0, y: 1 }; // a fresh coil hangs straight down (issue #55)
        this._layChainFrom(world?.x ?? this._x, world?.y ?? this._y, ux, uy);
        eventBus.emit('rope:chain-spawned', { rope: this });
    }

    /**
     * Collapse back into the bundle (issue #55): a spawned free rope whose
     * last knot is gone — per-knot untie, the wholesale move untie, knots
     * dying with their targets in reconcile, or a snapshot rewind (force).
     * Emits 'rope:unbundled' with the dying refs so ONLY the engine
     * consumer touches the world; the rope itself never does. A laid rope
     * (not free) and an already-collapsed rope (no segments) no-op; a
     * severed chain keeps its segments, so severing and collapsing never
     * interact.
     * @param {boolean} [force] - ignore live knots (snapshot rewind)
     * @private
     */
    _maybeRevertToBundle(force = false) {
        if (!this._isFree || this._segments.length === 0) return;
        if (!force && this._attachments.length > 0) return;

        // Collect the dying refs BEFORE clearing: the packet must carry what
        // the engine removes — the getters are already empty once we emit.
        const dyingConstraints = this._constraints;
        const dyingBodies = [this._anchor, ...this._segments].filter(Boolean);
        this._attachments = [];
        this._anchor = null;
        this._segments = [];
        this._constraints = [];
        this._endPoint = null;
        eventBus.emit('rope:unbundled', {
            rope: this, previous: dyingConstraints, bodies: dyingBodies,
        });
    }

    /** Sever the rope (e.g., by candle flame or closed scissors blades). */
    sever() {
        if (this._severed) return;
        // A bodyless bundle cannot burn or be cut (issue #55): there is no
        // chain in the world to part (and its zero bodies never collide).
        // A spawned chain severs exactly like a laid rope.
        if (this.isFreeBundle) return;
        this._severed = true;
        // Synchronous emit: the physics engine consumes this and removes
        // the constraints from the world. Then drop the dead references so
        // re-adding the rope never resurrects them (isSevered/draw agree).
        eventBus.emit('rope:severed', { rope: this });
        this._constraints = [];
    }

    get isSevered() {
        return this._severed;
    }

    /**
     * ADR 0007 decision 4 (issue #54): a rope's first tie freezes its
     * length — the hand can no longer reel the free end out or in, only
     * re-orient it around the frozen reach circle (relayFreeEnd clamps
     * there). Derived from the knot lists, so it can never drift from the
     * tie state; the last untie (per-knot or the wholesale move untie)
     * hands length back to the hand.
     * @returns {boolean}
     */
    get lengthFrozen() {
        return this._attachments.length > 0;
    }

    /**
     * Whether a world point lies within this rope's reach from its anchor
     * for the seat asking (issue #86, ADR 0007 decision 4; issue #54
     * founded the gate, #56 re-ringed it; role-keyed since #90): a tie
     * aimed at a chain seat measures that seat's OWN covering circle —
     * seatFraction(seat, count) of the fixed length, the same number
     * getTieSeats answers for that seat — because a knot past it would sit
     * beyond where the seat's tie body rests and the slack band (the
     * click's aim tolerance) is all that may still tie and grow. The end
     * seat's circle is the chain capacity, so its tie gates exactly as it
     * always did. The anchor seat and callers asking with no seat keep the
     * whole-rope capacity circle: the anchor knot realizes AT the anchor
     * itself and consumes no chain, so its aim is gated by the rope's full
     * reach, the pre-seat measure unchanged. A free rope (issue #56, ADR
     * 0007 decision 4) has no length property of its own: it answers true
     * unconditionally — first tie, spawned re-tie, any distance — and the
     * tie re-lays the chain to span the demand instead of refusing. The
     * connect flow gates both its tie clicks and its glow with this one
     * predicate, passing the seeking seat's role, so what glows is exactly
     * what ties.
     * @param {number} x
     * @param {number} y
     * @param {number} [slack=0] - extra px allowed (a tie click's aim tolerance)
     * @param {'anchor'|'mid'|'end'|null} [seat=null] - the asking seat's
     *   ROLE; null keeps the chain-end measure (the seatless capacity ask).
     *   An unknown name is refused with a clear error (issue #90).
     * @returns {boolean}
     */
    isPointWithinReach(x, y, slack = 0, seat = null) {
        if (seat != null && !SEAT_ROLES.includes(seat)) {
            throw new Error(`[Rope] isPointWithinReach: seat must be 'anchor', 'mid' or 'end' (or null), got ${String(seat)}`);
        }
        if (this._isFree) return true; // no length property — any tie re-lays (issue #56)
        const anchor = this._anchor?.position;
        if (!anchor) return false;
        const count = this._segments.length;
        if (count === 0) return false; // no chain laid: nothing covers
        // A tie aimed at a CHAIN seat (mid) measures that seat's own
        // covering circle; the anchor seat, seatless callers and the end
        // seat keep the capacity circle — the end seat's own covering
        // fraction IS the chain capacity (one number).
        const reach = seat === 'mid'
            ? seatFraction('mid', count)
            : seatFraction('end', count);
        return Math.hypot(x - anchor.x, y - anchor.y) <= this._length * reach + slack;
    }

    /**
     * The hand re-lay (ADR 0007 decision 4, issues #54/#56): lay the chain
     * so its free-end tie square (the last segment's center) rides to
     * (x, y). A pinned rope takes the demanded square distance as a chain
     * span of demand · (count/(count − 0.5)), floored at MIN_ROPE_SPAN —
     * while untied; once knots freeze the length, the re-lay keeps the
     * frozen reach circle and the length never moves. A FREE rope owns no
     * length accounting (decision 4, issue #56): it takes the demanded
     * span whenever the hand moves — tied or not, no freeze — and each
     * span re-lays earlier knots' seats along (their bodies re-line after
     * the sweep; a span crossing SEGMENTS × SEGMENT_DENSITY_PX re-counts
     * the chain through setEndpoints). The anchor stays exactly where it
     * is. Delegates the re-lay to setEndpoints, which announces
     * rope:chain-converge so an in-world rope swaps its constraints
     * instead of keeping stale members.
     * @param {number} x - demanded tie-square x
     * @param {number} y - demanded tie-square y
     */
    relayFreeEnd(x, y) {
        const anchor = this._anchor?.position;
        if (!anchor) return;
        const demanded = Math.hypot(x - anchor.x, y - anchor.y);
        if (demanded === 0) return; // nothing to follow yet
        const ux = (x - anchor.x) / demanded;
        const uy = (y - anchor.y) / demanded;
        const count = this._segments.length;
        // A free rope's span is the hand's at all times (issue #56): the
        // frozen-circle clamp is pinned-rope bookkeeping only.
        const frozen = !this._isFree && this.lengthFrozen;
        const span = frozen
            ? this._length
            : Math.max(demanded / seatFraction('end', count), MIN_ROPE_SPAN);
        this.setEndpoints(
            { x: anchor.x, y: anchor.y },
            { x: anchor.x + ux * span, y: anchor.y + uy * span }
        );
        // A frozen rope's length is sealed: setEndpoints re-derived it from
        // the re-laid layout (float dust off the frozen value possible) —
        // restore the exact frozen length so the accounting never drifts.
        if (frozen) this._length = span;
    }

    /**
     * Re-lay the rope between two points (edit-time placement seam, issue
     * 04; issue #56 makes it the span/count seam): the anchor lands on
     * `start`, the segments re-line up along the straight line to `end`,
     * and the chain is rebuilt for the new span.
     *
     * One mode (issue #89 — the counting strategy no longer splits by
     * family or by caller): the chain's segment count re-derives from the
     * span (ADR 0007 decision 3), so a longer re-lay grows the tail and a
     * shorter one prunes it; the knots keep their seats by themselves
     * (issue #87 through #90's roles — every knot addresses a ROLE, and
     * each role re-derives its body from the live chain: an 'end' knot IS
     * the tail's knot, a 'mid' knot the middle's, the anchor the anchor in
     * every count, so nothing re-seats and nothing prunes off the scan —
     * the reconcile realizes each knot's link from whatever body its seat
     * names after the change). Appended/dropped tail bodies ride in the
     * converge packet so the world swaps them too; a same-count re-lay
     * trades nothing and merely re-lines the bodies it has.
     *
     * Call while the rope is OUT of the physics world (before/at
     * placement) — the recreated constraint objects must not be stale
     * members of any world.
     * @param {{x: number, y: number}} start
     * @param {{x: number, y: number}} end
     */
    setEndpoints(start, end) {
        this._x = start.x;
        this._y = start.y;
        this._endPoint = { x: end.x, y: end.y };
        this._length = Math.hypot(end.x - start.x, end.y - start.y);
        Body.setPosition(this._anchor, { x: start.x, y: start.y });
        if (!this._severed) {
            // Span-derived count (issue #56; one counting strategy since
            // #89 — there is no frozen variant left): a re-lay re-derives
            // the chain size, the tie-grow's covering re-lay included.
            // Earlier segments keep their indices; appended/dropped tail
            // segments ride in the packet so the world swaps bodies too.
            const targetCount = Rope.segmentsForSpan(this._length);
            const { added, dropped } = this._resizeChain(targetCount);
            // The seats keep themselves across a re-count (issue #87 kept
            // by #90's roles): knots address roles, and the roles re-derive
            // their bodies from the live chain — nothing to re-seat, no
            // knot can land on a traded-away body.
            // The appended tail lands ON the end point (issue #56, handoff
            // fix 4): a re-lay that GREW the chain puts its new last body
            // exactly where the endpoints say, instead of half a pitch
            // inboard like a centre-laid seat. Every other re-lay — a
            // same-count re-lay, a prune — keeps the centre lay, so every
            // seat that already had a body keeps today's geometry.
            const laid = added.length > 0;
            const pitch = this._length / targetCount;
            const dx = (end.x - start.x) / targetCount;
            const dy = (end.y - start.y) / targetCount;
            for (let i = 0; i < targetCount; i++) {
                Body.setPosition(this._segments[i], {
                    x: start.x + dx * (i + 0.5),
                    y: start.y + dy * (i + 0.5),
                });
            }
            if (laid) {
                Body.setPosition(this._segments[targetCount - 1], { x: end.x, y: end.y });
            }
            const previous = this._constraints;
            this._constraints = this._buildChainConstraints(this._length);
            // …and the last link's rest length follows the laid distance (1½
            // pitches: centred seat count−1 out to the tail on `end`), or the
            // chain would be half a pitch over-stretched and the first step
            // would snap the tail back to the centre. Rest lengths still
            // equal laid distances, so the grown chain rests taut at `end`.
            if (laid && targetCount > 1) {
                this._constraints[this._constraints.length - 1].length = pitch * 1.5;
            }
            // The re-lay replaced the chain: announce the swap so the
            // physics engine drops the old chain for the rebuilt one when
            // this rope lives in a world (the usual edit-stage case is
            // out-of-world, where the engine's registration guard makes the
            // event a no-op; after a play→reset rewind the board does live
            // in the world). added/dropped carry the re-segmentation
            // (issue #56) — the consumer puts the tail bodies in / takes
            // them out of the world alongside the constraint swap; both are
            // empty for a same-count re-lay, which re-lines the bodies it
            // has. A severed rope rebuilt no chain — see above.
            eventBus.emit('rope:chain-converge', { rope: this, previous, added, dropped });
        }
    }

    /**
     * Resize the chain's tail to `targetCount` bodies (issue #56, the
     * setEndpoints seam of the span-derived count): appended segments are
     * built by `makeSegmentBody` — the same one factory the ctor and
     * `_layChainFrom` use, so there is one chain shape across every spawn
     * path, by construction rather than by convention; dropped tail
     * segments exit the list, and the packet's `dropped` lets the engine's
     * chain-swap consumer pull them out of the world on the next step. The
     * anchor and every earlier body keep their index; knots hold ROLES
     * (issue #90), so none of them can sit on a traded-away tail body.
     * @param {number} targetCount - SEGMENTS…MAX_SEGMENTS
     * @returns {{added: Matter.Body[], dropped: Matter.Body[]}}
     * @private
     */
    _resizeChain(targetCount) {
        const added = [];
        const dropped = [];
        while (this._segments.length < targetCount) {
            const i = this._segments.length;
            const seg = makeSegmentBody(0, 0, i);
            this._segments.push(seg);
            added.push(seg);
        }
        while (this._segments.length > targetCount) {
            dropped.push(this._segments.pop());
        }
        return { added, dropped };
    }

    /**
     * Snapshot-restore seam (BaseObject lifecycle, ADR 0003 + issue 04):
     * converge this rope to the snapshot-time severed state.
     *
     * Intact-at-snapshot + severed-live  → rebuild the chain and announce
     *   `rope:chain-converge { rope, previous }` (the physics engine
     *   re-adds the chain to the world; the rewind revives it).
     * Severed-at-snapshot + intact-live → sever() (drops the live chain
     *   and co-terminates its payload links).
     * Matching states → no-op (the chain keeps its identity).
     *
     * @param {object} [data] - serialized snapshot entry (serialize() shape)
     */
    restoreState(data) {
        super.restoreState(data);
        const snapshotSevered = data?.options?.severed ?? false;
        if (snapshotSevered === this._severed) return;

        if (snapshotSevered) {
            this.sever();
            return;
        }

        const previous = this._constraints;
        this._severed = false;
        this._constraints = this._buildChainConstraints(this._length);
        eventBus.emit('rope:chain-converge', { rope: this, previous });
    }

    draw(ctx) {
        ctx.save();

        // Bodyless free bundle (issue #55): draw a small coiled rope glyph
        // centered on the bundle — three concentric arcs, the footprint the
        // bundle bounds expose for drag pick.
        if (this.isFreeBundle) {
            ctx.strokeStyle = ROPE_COLOR;
            ctx.lineWidth = 3;
            ctx.lineCap = 'round';
            for (let i = 0; i < 3; i++) {
                ctx.beginPath();
                ctx.arc(this._x, this._y, 6 + i * 3, 0, Math.PI * 2);
                ctx.stroke();
            }
            ctx.restore();
            return;
        }

        // Draw the rope as a smooth curve through segment positions.
        // After severing, no constraint connects the rope to the anchor
        // (they were removed from the physics world) — so the polyline is
        // drawn through the free segments only; the anchor stays as a nail.
        const points = this._severed
            ? this._segments.map(s => s.position)
            : [this._anchor.position, ...this._segments.map(s => s.position)];

        ctx.strokeStyle = this._severed ? '#aaa' : ROPE_COLOR;
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) {
            const prev = points[i - 1];
            const curr = points[i];
            const midX = (prev.x + curr.x) / 2;
            const midY = (prev.y + curr.y) / 2;
            ctx.quadraticCurveTo(prev.x, prev.y, midX, midY);
        }
        const last = points[points.length - 1];
        ctx.lineTo(last.x, last.y);
        ctx.stroke();

        // Anchor point. Pinned ropes keep the gray nail; a free rope's
        // anchor is a moving knot (issue #55), drawn in rope color while
        // intact. When a free rope severs, its anchor knot link (segment −1)
        // dies with the cut and the loose body stays invisible.
        const pinnedRope = this.type === 'rope';
        if (pinnedRope || !this._severed) {
            ctx.fillStyle = pinnedRope ? '#555' : ROPE_COLOR;
            ctx.beginPath();
            ctx.arc(this._anchor.position.x, this._anchor.position.y, 4, 0, Math.PI * 2);
            ctx.fill();
            if (pinnedRope) {
                ctx.strokeStyle = '#333';
                ctx.lineWidth = 1;
                ctx.stroke();
            }
        }

        ctx.restore();
    }

    drawToolboxIcon(ctx, w, h) {
        ctx.strokeStyle = ROPE_COLOR;
        ctx.lineWidth = 2;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(w * 0.3, h * 0.2);
        ctx.quadraticCurveTo(w * 0.6, h * 0.5, w * 0.4, h * 0.8);
        ctx.stroke();

        ctx.fillStyle = '#555';
        ctx.beginPath();
        ctx.arc(w * 0.3, h * 0.2, 3, 0, Math.PI * 2);
        ctx.fill();
    }

    serialize() {
        return {
            ...super.serialize(),
            options: {
                ...this._options,
                length: this._length,
                lengthFrozen: this.lengthFrozen,
                // No chain count rides the row (issue #89): the count is
                // the span's rule at every seam, so a restore re-derives
                // the chain from `length` — save → load → save is
                // idempotent by arithmetic, no hint to replay.
                endPoint: this._endPoint,
                severed: this._severed,
            },
        };
    }

    static deserialize(data) {
        return new Rope(data.x, data.y, {
            angle: data.angle,
            isFixed: data.isFixed,
            customId: data.id,
            length: data.options?.length || 100,
            endPoint: data.options?.endPoint,
            severed: data.options?.severed ?? false,
            attachments: data.attachments ?? [],
        });
    }

    dispose() {
        this._attachments = [];
        this._pendingAttachments = [];
        this._anchor = null;
        this._segments = [];
        this._constraints = [];
    }
}
