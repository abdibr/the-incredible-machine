/**
 * Rope — Flexible connector between two points
 *
 * Connects two objects or an object to a fixed point.
 * Can be burned by candle flame (severs the constraint).
 */

import Matter from 'matter-js';
import BaseObject from './BaseObject.js';
import { eventBus } from '../EventBus.js';

const { Bodies, Body, Constraint } = Matter;

/**
 * How close (px) a placed rope endpoint must land to an attachment point
 * for the two to tie (issue 04). Shared by the placement snap
 * (DragDropManager._snapRopeEndpoints) and the drag-time hint marks
 * (Renderer._drawRopeSnapHints) — one number, one meaning.
 * @type {number}
 */
export const ROPE_SNAP_RADIUS = 24;

const ROPE_COLOR = '#8B6914';
const SEGMENTS = 6;
const SEGMENT_RADIUS = 3;

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

        this._segments = [];
        this._constraints = [];

        // Rope→payload knots (issue 04): live refs only, one list per
        // endpoint (several knots may share an endpoint). Tokens live in
        // serialized data only and bind through bindAttachment().
        this._attachments = [[], []];
        this._pendingAttachments = [];

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

        // Passive restore tokens (issue 04): a severed rope cannot hold a
        // payload, so it binds nothing.
        this._pendingAttachments = this._severed ? [] : (attachments ?? []);
    }

    get type() { return 'rope'; }

    get bodies() {
        return [this._anchor, ...this._segments];
    }

    get constraints() {
        return this._constraints;
    }

    /**
     * Build the chain constraints along the current layout (anchor→first
     * segment, then consecutive segments). Extracted so construction, the
     * severed→intact rewind and setEndpoints re-lays all build identical
     * chains for a given span.
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
                length: segLength * 0.6,
            }));
        }
        return chain;
    }

    /**
     * The body a given endpoint ties through (issue 04): 0 = the start's
     * static anchor, 1 = the free-chain last segment.
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
        this._attachments[endpoint].push({ target, pointId });
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
    }

    get bounds() {
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
        Body.setPosition(this._anchor, { x, y });
        for (const seg of this._segments) {
            Body.translate(seg, { x: dx, y: dy });
        }
    }

    /** Sever the rope (e.g., by candle flame or closed scissors blades). */
    sever() {
        if (this._severed) return;
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
            this._constraints = this._buildChainConstraints(this._length);
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

        // Anchor point
        ctx.fillStyle = '#555';
        ctx.beginPath();
        ctx.arc(this._anchor.position.x, this._anchor.position.y, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 1;
        ctx.stroke();

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
