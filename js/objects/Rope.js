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
 */

import Matter from 'matter-js';
import BaseObject from './BaseObject.js';
import { eventBus } from '../EventBus.js';

const { Bodies, Body, Constraint } = Matter;

const ROPE_COLOR = '#8B6914';
const SEGMENTS = 6;
const SEGMENT_RADIUS = 3;

/**
 * Shortest span a rope chain re-lays to (issue #54, ADR 0007 decision 4):
 * six segments of radius 3 need ≥ 8 px pitch each to stay a chain instead
 * of collapsing to a point — a hand re-lay demanding less clamps here
 * instead of breaking the chain. One number, one meaning for every caller.
 * @type {number}
 */
export const MIN_ROPE_SPAN = SEGMENTS * (SEGMENT_RADIUS * 2 + 2);

export default class Rope extends BaseObject {
    /**
     * @param {number} x - Start anchor x
     * @param {number} y - Start anchor y
     * @param {object} [options={}]
     * @param {number} [options.length=100] - Rope length
     * @param {{x:number, y:number}} [options.endPoint] - End anchor point (default: straight down)
     */
    constructor(x, y, options = {}) {
        // Attachment tokens (issue 04) are consumed here and never land in
        // _options: they are relational restore data (target ordinals into
        // the board snapshot) injected by the annotator — serialize never
        // emits them.
        const { attachments, ...behaviorOptions } = options;
        super(x, y, behaviorOptions);
        this._length = options.length || 100;
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

        // Rope→payload knots (issue 04): live refs only, one list per
        // endpoint (several knots may share an endpoint). Tokens live in
        // serialized data only and bind through bindAttachment().
        this._attachments = [[], []];
        this._pendingAttachments = [];

        if (!this._isFree) {
            // Build rope as chain of small circle segments
            const segLength = this._length / SEGMENTS;
            const dx = (this._endPoint.x - x) / SEGMENTS;
            const dy = (this._endPoint.y - y) / SEGMENTS;

            for (let i = 0; i < SEGMENTS; i++) {
                const sx = x + dx * (i + 0.5);
                const sy = y + dy * (i + 0.5);

                const seg = Bodies.circle(sx, sy, SEGMENT_RADIUS, {
                    density: 0.001,
                    friction: 0.8,
                    frictionAir: 0.02,
                    label: `rope-seg-${i}`,
                    collisionFilter: {
                        group: -1, // rope segments don't collide with each other
                    },
                });
                this._segments.push(seg);
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
     * Free-rope mode (issue #55): true while a `free` rope is its inert,
     * bodyless coil. Derived, never stored — the ctor, _spawnChain and
     * _maybeRevertToBundle are the only writers of the members this reads,
     * so it can never drift from reality. A laid base Rope is never a
     * bundle.
     * @returns {boolean}
     */
    get isFreeBundle() {
        return this._isFree === true && this._segments.length === 0;
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
        const segLength = spanLength / SEGMENTS;
        const chain = [Constraint.create({
            bodyA: this._anchor,
            bodyB: this._segments[0],
            stiffness: 0.8,
            damping: 0.1,
            length: segLength * 0.5,
        })];
        for (let i = 0; i < SEGMENTS - 1; i++) {
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
     * The body a given endpoint ties through (issue 04): 0 = the start's
     * anchor (the static nail for a pinned rope; the dynamic knot a free
     * rope spawns with, issue #55), 1 = the free-chain last segment.
     * @param {number} endpoint
     * @returns {Matter.Body|null}
     * @private
     */
    _endpointBody(endpoint) {
        if (endpoint !== 0 && endpoint !== 1) return null;
        return endpoint === 0 ? (this._anchor ?? null) : (this._segments[this._segments.length - 1] ?? null);
    }

    // ── Attachments (issue 04: rope as a connector) ────────

    /**
     * Tie endpoint `endpoint` (0 = anchored start, 1 = free end) to a named
     * attachment point on a live target. Several knots may share an
     * endpoint. The rope stores only live refs — the physical engine link
     * is realized on the next step (see onBeforeUpdate).
     * @param {number} endpoint
     * @param {import('./BaseObject.js').default} target
     * @param {string} pointId
     */
    attachEndpoint(endpoint, target, pointId) {
        if (endpoint !== 0 && endpoint !== 1) {
            throw new Error(`[Rope] attachEndpoint: endpoint must be 0 or 1, got ${endpoint}`);
        }
        const known = target?.attachmentPoints?.some((p) => p.id === pointId);
        if (!known) {
            throw new Error(`[Rope] attachEndpoint: target ${target?.type ?? target} offers no attachment point "${pointId}"`);
        }
        // First tie on a free bundle (issue #55) is the birth of the chain:
        // spawn it hanging straight down from the tie point at the rope's
        // length, then tie exactly like a laid rope below. Later ties hit a
        // spawned chain and follow the normal span rules (reach refusals
        // included) — the spawn freezes the length via the knot this push
        // creates, and the engine's 'rope:chain-spawned' consumer puts the
        // newborn chain into the world.
        if (this.isFreeBundle) this._spawnChain(target, pointId);
        this._attachments[endpoint].push({ target, pointId });
        // Fixed length covers its own knots (ADR 0007 decision 4, issue
        // #54): a free-end tie that reaches past the chain's laid capacity
        // grows the length so the chain's rest lengths span the tied
        // distance (the tie body is the last segment's center, a half
        // segment inboard of the layout end) — the chain is never
        // over-tensioned by its own knot, and no tie ever shrinks the rope.
        // Measured from the anchor; the endpoint-0 knot realizes at the
        // anchor itself and consumes no chain.
        if (endpoint === 1 && this._anchor) {
            const world = target.getAttachmentWorldPoint?.(pointId) ?? null;
            if (world) {
                const tied = Math.hypot(
                    world.x - this._anchor.position.x,
                    world.y - this._anchor.position.y
                );
                if (tied > this._length * (SEGMENTS - 0.5) / SEGMENTS) {
                    this._length = tied * SEGMENTS / (SEGMENTS - 0.5);
                }
            }
        }
    }

    /**
     * Untie one knot (ADR 0007 decision 8 — untie stays per-knot) identified
     * by its live ref — the rope side frees, the target keeps its attachment
     * point. The physical link drops on the next reconcile step (an emptied
     * or shrunk slot releases its former links, see _reconcileAttachments).
     * @param {number} endpoint
     * @param {import('./BaseObject.js').default} target
     * @param {string} pointId
     * @returns {boolean} true when a matching knot was removed
     */
    detachEndpoint(endpoint, target, pointId) {
        if (endpoint !== 0 && endpoint !== 1) {
            throw new Error(`[Rope] detachEndpoint: endpoint must be 0 or 1, got ${endpoint}`);
        }
        const knots = this._attachments[endpoint];
        const idx = knots.findIndex((knot) => knot.target === target && knot.pointId === pointId);
        if (idx === -1) return false;
        knots.splice(idx, 1);
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
     * entry — rope.serialize() itself intentionally emits no tokens.
     * @returns {Array<{endpoint: number, target: import('./BaseObject.js').default, pointId: string}>}
     */
    getAttachmentRefs() {
        return [
            ...this._attachments[0].map((knot) => ({ endpoint: 0, ...knot })),
            ...this._attachments[1].map((knot) => ({ endpoint: 1, ...knot })),
        ];
    }

    /**
     * Untie every knot of this rope (edit-time: the player moved the rope
     * or a target left the board). The physical links are dropped by the
     * next reconcile step — or earlier by the engine's co-termination on
     * removal.
     */
    clearAttachments() {
        this._attachments = [[], []];
        // Wholesale untie (issue #55 — the edit-time move untie): an
        // emptied spawned free rope collapses back into its inert bundle.
        this._maybeRevertToBundle();
    }

    /**
     * Resolve pending attachment tokens (from deserialize) against a board
     * array — the full beginPlay snapshot whose order the tokens'
     * `targetOrdinal`s index into. Unresolvable tokens are dropped with a
     * warning; the pending list always ends empty. A severed rope binds
     * nothing.
     * @param {import('./BaseObject.js').default[]|null} board
     */
    bindAttachment(board) {
        const pending = this._pendingAttachments;
        this._pendingAttachments = [];
        if (this._severed) return;
        for (const token of pending) {
            const target = board?.[token.targetOrdinal];
            if (!target || target.type !== token.targetType) {
                console.warn(`[Rope] Dropping attachment token: no ${token.targetType} at board ordinal ${token.targetOrdinal}`);
                continue;
            }
            try {
                this.attachEndpoint(token.endpoint, target, token.pointId);
            } catch (e) {
                console.warn(`[Rope] Dropping attachment token: ${e.message}`);
            }
        }
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
     * knot refs. A severed rope realizes nothing (its payload links were
     * already co-terminated by the sever consumer).
     * @param {import('../engine/PhysicsEngine.js').PhysicsEngine} engine
     * @private
     */
    _reconcileAttachments(engine) {
        const desired = new Map();
        const linkBodies = [];
        for (let endpoint = 0; endpoint < 2; endpoint++) {
            // Endpoint bodies feed the stale-link drop scan regardless of
            // whether any knot remains (an emptied slot must still release
            // its former links on the next step).
            const linkBody = this._endpointBody(endpoint);
            if (linkBody) linkBodies.push(linkBody);
            const knots = this._attachments[endpoint];
            if (!knots || knots.length === 0) continue;
            if (!linkBody) {
                this._attachments[endpoint] = [];
                continue;
            }
            // Keep only knots whose target is still a live, registered object
            const alive = knots.filter((knot) =>
                knot.target
                && engine.getObjects().has(knot.target)
                && knot.target.bodies.some(Boolean)
                && knot.target.attachmentPoints.some((p) => p.id === knot.pointId)
            );
            this._attachments[endpoint] = alive;
            for (const knot of alive) {
                const ap = knot.target.attachmentPoints.find((p) => p.id === knot.pointId);
                const targetBody = ap?.body ?? null;
                if (!targetBody) continue; // the point's body is currently unavailable
                desired.set(`${linkBody.id}|${targetBody.id}`, {
                    linkBody,
                    targetBody,
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
     * Give birth to the free chain (issue #55): the first tie on a bundle
     * spawns the chain hanging straight down from the tie point at the
     * rope's current length (the pinned default — a spawned free rope never
     * gets hand-laid). Mirrors the constructor build exactly (same labels,
     * radii, filters and constraint builder) so a spawned chain and a laid
     * rope are indistinguishable downstream (knots, reach, snapshots). The
     * engine's 'rope:chain-spawned' consumer (registration-guarded) owns
     * the world add — addObject long ran for the bodyless rope and will
     * not run again.
     * @param {import('./BaseObject.js').default} target
     * @param {string} pointId
     * @private
     */
    _spawnChain(target, pointId) {
        const world = target.getAttachmentWorldPoint?.(pointId) ?? null;
        const anchorX = world?.x ?? this._x;
        const anchorY = world?.y ?? this._y;
        this.setPosition(anchorX, anchorY); // bundle: only re-centers the coil
        this._endPoint = { x: anchorX, y: anchorY + this._length };
        const dx = 0;
        const dy = this._length / SEGMENTS;

        for (let i = 0; i < SEGMENTS; i++) {
            const seg = Bodies.circle(anchorX + dx * (i + 0.5), anchorY + dy * (i + 0.5), SEGMENT_RADIUS, {
                density: 0.001,
                friction: 0.8,
                frictionAir: 0.02,
                label: `rope-seg-${i}`,
                collisionFilter: {
                    group: -1, // rope segments don't collide with each other
                },
            });
            this._segments.push(seg);
        }

        // The free rope's "anchor" is a dynamic KNOT, not a nail (issue #55,
        // ADR 0007 decision 5): the chain hangs FROM its tie target, so this
        // body is hauled along by the endpoint-0 knot link realized on the
        // next step. A static body here froze the tie (the bugfile: the first
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

        this._constraints = this._buildChainConstraints(this._length);
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
        if (!force && this._attachments[0].length + this._attachments[1].length > 0) return;

        // Collect the dying refs BEFORE clearing: the packet must carry what
        // the engine removes — the getters are already empty once we emit.
        const dyingConstraints = this._constraints;
        const dyingBodies = [this._anchor, ...this._segments].filter(Boolean);
        this._attachments = [[], []];
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
        return this._attachments[0].length > 0 || this._attachments[1].length > 0;
    }

    /**
     * Whether a world point lies within this rope's reach from its static
     * anchor (issue #54, ADR 0007 decision 4): a slack chain can span any
     * distance up to its rest-length sum — (SEGMENTS − 0.5)/SEGMENTS of the
     * fixed length, because the tie body is the last segment's center — and
     * must not be stretched past it. The connect flow gates both its tie
     * clicks and its glow with this one predicate, so what glows is exactly
     * what ties; the endpoint-0 knot realizes at the anchor itself, so the
     * same measure covers both ends of a pinned rope.
     * @param {number} x
     * @param {number} y
     * @param {number} [slack=0] - extra px allowed (a tie click's aim tolerance)
     * @returns {boolean}
     */
    isPointWithinReach(x, y, slack = 0) {
        const anchor = this._anchor?.position;
        if (!anchor) return false;
        return Math.hypot(x - anchor.x, y - anchor.y) <= this._length * (SEGMENTS - 0.5) / SEGMENTS + slack;
    }

    /**
     * The hand re-lay (ADR 0007 decision 4, issue #54): lay the chain so
     * its free-end tie square (the last segment's center) rides to (x, y),
     * clamped — an untied rope takes the demanded square distance as a
     * chain span of demand · (SEGMENTS/(SEGMENTS − 0.5)), with the span
     * floored at MIN_ROPE_SPAN; a frozen rope (knots) re-orients only
     * around its frozen reach circle and its length never moves. The
     * anchor stays exactly where it is. Delegates the re-lay to
     * setEndpoints, which announces rope:chain-converge so an in-world
     * rope swaps its constraints instead of keeping stale members.
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
        const span = this.lengthFrozen
            ? this._length
            : Math.max(demanded * SEGMENTS / (SEGMENTS - 0.5), MIN_ROPE_SPAN);
        this.setEndpoints(
            { x: anchor.x, y: anchor.y },
            { x: anchor.x + ux * span, y: anchor.y + uy * span }
        );
        // A frozen rope's length is sealed: setEndpoints re-derived it from
        // the re-laid layout (float dust off the frozen value possible) —
        // restore the exact frozen length so the accounting never drifts.
        if (this.lengthFrozen) this._length = span;
    }

    /**
     * Re-lay the rope between two points (edit-time placement seam, issue
     * 04): the anchor lands on `start`, the segments re-line up along the
     * straight line to `end`, and the chain is rebuilt for the new span.
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
        const dx = (end.x - start.x) / SEGMENTS;
        const dy = (end.y - start.y) / SEGMENTS;
        for (let i = 0; i < SEGMENTS; i++) {
            Body.setPosition(this._segments[i], {
                x: start.x + dx * (i + 0.5),
                y: start.y + dy * (i + 0.5),
            });
        }
        if (!this._severed) {
            const previous = this._constraints;
            this._constraints = this._buildChainConstraints(this._length);
            // The re-lay replaced the chain: announce the swap so the
            // physics engine drops the old chain for the rebuilt one when
            // this rope lives in a world (the usual edit-stage case is
            // out-of-world, where the engine's registration guard makes the
            // event a no-op; after a play→reset rewind the board does live
            // in the world). A severed rope rebuilt no chain — see above.
            eventBus.emit('rope:chain-converge', { rope: this, previous });
        }
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
        // intact. When a free rope severs, its endpoint-0 knot link dies
        // with the cut and the loose body stays invisible.
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
        this._attachments = [[], []];
        this._pendingAttachments = [];
        this._anchor = null;
        this._segments = [];
        this._constraints = [];
    }
}
