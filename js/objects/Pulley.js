/**
 * Pulley — Rope with two platforms over a pivot
 *
 * One side goes up when the other side goes down (issue #13): both platforms
 * hang from one shared rope over the pivot. Per physics step the sides
 * exchange rope length in onBeforeUpdate (constraint rest-length exchange,
 * driven by measured load weight), so loading one platform sinks it and
 * raises the other.
 */

import Matter from 'matter-js';
import BaseObject from './BaseObject.js';

const { Bodies, Body, Composite, Constraint, Query, Sleeping } = Matter;

const PLATFORM_WIDTH = 60;
const PLATFORM_HEIGHT = 8;
const ROPE_COLOR = '#8B6914';
const PLATFORM_COLOR = '#7B6B5A';
const WHEEL_COLOR = '#888';
const WHEEL_RADIUS = 10;

// ── Shared-rope coupling (issue #13) ──
// The two platforms hang from ONE rope over the wheel: the side carrying
// more weight sinks while the exchanged length raises the other side.
const DEFAULT_STEP_MS = 1000 / 60;
const MIN_SIDE_REST = 14;        // px — a side's rope can't shorten past the wheel wrap
const MAX_COUPLE_SPEED = 0.9;    // px per 60fps step at full weight imbalance
const IMBALANCE_EPS = 0.02;      // weight imbalance below this = balanced, no transfer
const SUPPORT_DEPTH = 2;         // riders of riders (covers 2-ball stacks)
const TELEPORT_EPS = 0.1;        // px per step — platform jump = snapshot restore/reset
const WINCH_SLACK = 0.35;        // px — platform motion matching the last rest change is the winch, not a teleport

export default class Pulley extends BaseObject {
    /**
     * @param {number} x - Pivot point x (top center)
     * @param {number} y - Pivot point y
     * @param {object} [options={}]
     * @param {number} [options.ropeLength=150] - Total rope length
     */
    constructor(x, y, options = {}) {
        super(x, y, options);
        this._ropeLength = options.ropeLength || 150;
        const halfRope = this._ropeLength / 2;

        // Pivot wheel (static)
        this._wheel = Bodies.circle(x, y, WHEEL_RADIUS, {
            isStatic: true,
            label: 'pulley-wheel',
            collisionFilter: { category: 0x0002, mask: 0 }, // no collision
        });

        // Left platform
        this._leftPlatform = Bodies.rectangle(
            x - 60, y + halfRope / 2, PLATFORM_WIDTH, PLATFORM_HEIGHT, {
            density: 0.002,
            friction: 0.6,
            label: 'pulley-left',
        }
        );

        // Right platform
        this._rightPlatform = Bodies.rectangle(
            x + 60, y + halfRope / 2, PLATFORM_WIDTH, PLATFORM_HEIGHT, {
            density: 0.002,
            friction: 0.6,
            label: 'pulley-right',
        }
        );

        // Constraints — connect each platform to the pivot point
        this._leftConstraint = Constraint.create({
            bodyA: this._leftPlatform,
            pointB: { x: x - 60, y },
            stiffness: 0.9,
            damping: 0.05,
            length: halfRope / 2,
            label: 'pulley-rope-left',
            render: { strokeStyle: ROPE_COLOR },
        });

        this._rightConstraint = Constraint.create({
            bodyA: this._rightPlatform,
            pointB: { x: x + 60, y },
            stiffness: 0.9,
            damping: 0.05,
            length: halfRope / 2,
            label: 'pulley-rope-right',
            render: { strokeStyle: ROPE_COLOR },
        });

        // Coupling state — length exchange between the two rest lengths keeps
        // the shared-rope total conservative.
        this._ropeTotal = this._leftConstraint.length + this._rightConstraint.length;
        this._prevLeftPos = { ...this._leftPlatform.position };
        this._prevRightPos = { ...this._rightPlatform.position };
        this._lastRestDelta = 0;
    }

    get type() { return 'pulley'; }

    get bodies() {
        return [this._wheel, this._leftPlatform, this._rightPlatform];
    }

    get constraints() {
        return [this._leftConstraint, this._rightConstraint];
    }

    /**
     * Called before every physics step. Implements the shared-rope coupling
     * (issue #13): each side's carried weight is measured, and constraint
     * rest lengths exchange length so the rope total stays conservative —
     * the heavily loaded side sinks while the other side rises.
     * @param {number} dt - delta time in ms
     * @param {object} engine - PhysicsEngine instance (for load queries)
     */
    onBeforeUpdate(dt, engine) {
        const leftC = this._leftConstraint;
        const rightC = this._rightConstraint;
        if (!this._leftPlatform || !this._rightPlatform || !leftC || !rightC) return;

        const leftPos = this._leftPlatform.position;
        const rightPos = this._rightPlatform.position;

        // A platform teleported between steps (snapshot restore / reset):
        // re-derive the rope split from the restored geometry so play/reset
        // cycles always start from the same rope state.
        if (this._isTeleport(leftPos, rightPos)) {
            this._syncRopeToGeometry(leftPos, rightPos);
            this._lastRestDelta = 0;
        } else {
            const stepMs = Number.isFinite(dt) && dt > 0 ? dt : DEFAULT_STEP_MS;
            const loadLeft = this._sideMass(engine, this._leftPlatform);
            const loadRight = this._sideMass(engine, this._rightPlatform);
            const imbalance = (loadLeft - loadRight) / (loadLeft + loadRight);

            if (Math.abs(imbalance) > IMBALANCE_EPS) {
                // Length exchange toward the heavier side; the shorter rest
                // on the light side is what pulls that platform upward.
                const rate = MAX_COUPLE_SPEED * imbalance * (stepMs / DEFAULT_STEP_MS);
                const prevLength = leftC.length;
                leftC.length = Math.min(
                    Math.max(leftC.length + rate, MIN_SIDE_REST),
                    this._ropeTotal - MIN_SIDE_REST
                );
                rightC.length = this._ropeTotal - leftC.length;
                this._lastRestDelta = leftC.length - prevLength;

                if (this._lastRestDelta !== 0) {
                    // Sleeping platforms are skipped by the constraint solver —
                    // wake them whenever the rope actually exchanges length.
                    Sleeping.set(this._leftPlatform, false);
                    Sleeping.set(this._rightPlatform, false);
                }
            } else {
                this._lastRestDelta = 0;
            }
        }

        this._prevLeftPos = { x: leftPos.x, y: leftPos.y };
        this._prevRightPos = { x: rightPos.x, y: rightPos.y };
    }

    /** True when a platform jumped by more than the winch could have moved it. */
    _isTeleport(leftPos, rightPos) {
        if (!this._prevLeftPos || !this._prevRightPos) return false;
        const dl = Math.hypot(leftPos.x - this._prevLeftPos.x, leftPos.y - this._prevLeftPos.y);
        const dr = Math.hypot(rightPos.x - this._prevRightPos.x, rightPos.y - this._prevRightPos.y);
        // During length exchange the platforms legitimately move by ~|rate|/frame
        // (they chase their freshly shifted rest lengths) — only motion the winch
        // can't explain is an external teleport (snapshot restore / reset).
        const lTele = dl > TELEPORT_EPS && Math.abs(dl - this._lastRestDelta) > WINCH_SLACK;
        const rTele = dr > TELEPORT_EPS && Math.abs(dr + this._lastRestDelta) > WINCH_SLACK;
        return lTele || rTele;
    }

    /** Make the rope split consistent with where the platforms currently hang. */
    _syncRopeToGeometry(leftPos, rightPos) {
        const leftC = this._leftConstraint;
        const dLeft = Math.hypot(leftPos.x - leftC.pointB.x, leftPos.y - leftC.pointB.y);
        const dRight = Math.hypot(rightPos.x - this._rightConstraint.pointB.x, rightPos.y - this._rightConstraint.pointB.y);
        const split = (dLeft - dRight) / 2;
        leftC.length = Math.min(
            Math.max(this._ropeTotal / 2 + split, MIN_SIDE_REST),
            this._ropeTotal - MIN_SIDE_REST
        );
        this._rightConstraint.length = this._ropeTotal - leftC.length;
    }

    /**
     * Mass carried by one rope side: the platform plus the stack of dynamic
     * bodies resting on it (support closure, so stacked loads also count).
     * @private
     */
    _sideMass(engine, platform) {
        let mass = platform.mass;
        if (!engine || !engine.world) return mass;

        const own = [this._wheel, this._leftPlatform, this._rightPlatform];
        const allBodies = Composite.allBodies(engine.world);
        const counted = new Set(own);
        let frontier = [platform];

        for (let depth = 0; depth < SUPPORT_DEPTH && frontier.length; depth++) {
            const next = [];
            for (const support of frontier) {
                for (const collision of Query.collides(support, allBodies)) {
                    const rider = collision.bodyA === support ? collision.bodyB : collision.bodyA;
                    if (rider.isStatic || counted.has(rider)) continue;
                    counted.add(rider);
                    mass += rider.mass;
                    next.push(rider);
                }
            }
            frontier = next;
        }
        return mass;
    }

    get bounds() {
        return {
            x: this._x - 100,
            y: this._y - WHEEL_RADIUS,
            width: 200,
            height: this._ropeLength + WHEEL_RADIUS,
        };
    }

    setPosition(x, y) {
        const dx = x - this._x;
        const dy = y - this._y;
        super.setPosition(x, y);

        Body.setPosition(this._wheel, { x, y });
        Body.translate(this._leftPlatform, { x: dx, y: dy });
        Body.translate(this._rightPlatform, { x: dx, y: dy });

        this._leftConstraint.pointB.x += dx;
        this._leftConstraint.pointB.y += dy;
        this._rightConstraint.pointB.x += dx;
        this._rightConstraint.pointB.y += dy;
    }

    draw(ctx) {
        const pivotPos = this._wheel.position;
        const leftPos = this._leftPlatform.position;
        const rightPos = this._rightPlatform.position;

        ctx.save();

        // Ropes
        ctx.strokeStyle = ROPE_COLOR;
        ctx.lineWidth = 2;

        // Left rope
        ctx.beginPath();
        ctx.moveTo(pivotPos.x - 6, pivotPos.y);
        ctx.lineTo(leftPos.x, leftPos.y);
        ctx.stroke();

        // Right rope
        ctx.beginPath();
        ctx.moveTo(pivotPos.x + 6, pivotPos.y);
        ctx.lineTo(rightPos.x, rightPos.y);
        ctx.stroke();

        // Pivot wheel
        ctx.beginPath();
        ctx.arc(pivotPos.x, pivotPos.y, WHEEL_RADIUS, 0, Math.PI * 2);
        ctx.fillStyle = WHEEL_COLOR;
        ctx.fill();
        ctx.strokeStyle = '#666';
        ctx.lineWidth = 2;
        ctx.stroke();

        // Wheel groove
        ctx.beginPath();
        ctx.arc(pivotPos.x, pivotPos.y, WHEEL_RADIUS - 3, 0, Math.PI * 2);
        ctx.strokeStyle = '#999';
        ctx.lineWidth = 1;
        ctx.stroke();

        // Center axle
        ctx.beginPath();
        ctx.arc(pivotPos.x, pivotPos.y, 3, 0, Math.PI * 2);
        ctx.fillStyle = '#555';
        ctx.fill();

        // Left platform
        this._drawPlatform(ctx, leftPos);

        // Right platform
        this._drawPlatform(ctx, rightPos);

        ctx.restore();
    }

    _drawPlatform(ctx, pos) {
        const hw = PLATFORM_WIDTH / 2;
        const hh = PLATFORM_HEIGHT / 2;

        ctx.fillStyle = PLATFORM_COLOR;
        ctx.fillRect(pos.x - hw, pos.y - hh, PLATFORM_WIDTH, PLATFORM_HEIGHT);
        ctx.strokeStyle = '#555';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(pos.x - hw, pos.y - hh, PLATFORM_WIDTH, PLATFORM_HEIGHT);

        // Rope attachment point
        ctx.fillStyle = ROPE_COLOR;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y - hh, 3, 0, Math.PI * 2);
        ctx.fill();
    }

    drawToolboxIcon(ctx, w, h) {
        const cx = w / 2;
        const top = h * 0.2;

        // Wheel
        ctx.beginPath();
        ctx.arc(cx, top, 5, 0, Math.PI * 2);
        ctx.fillStyle = WHEEL_COLOR;
        ctx.fill();
        ctx.strokeStyle = '#666';
        ctx.lineWidth = 1;
        ctx.stroke();

        // Ropes
        ctx.strokeStyle = ROPE_COLOR;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx - 3, top);
        ctx.lineTo(cx - 10, h * 0.65);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cx + 3, top);
        ctx.lineTo(cx + 10, h * 0.65);
        ctx.stroke();

        // Platforms
        ctx.fillStyle = PLATFORM_COLOR;
        ctx.fillRect(cx - 17, h * 0.65, 14, 3);
        ctx.fillRect(cx + 3, h * 0.65, 14, 3);
    }

    serialize() {
        return {
            ...super.serialize(),
            options: { ...this._options, ropeLength: this._ropeLength },
        };
    }

    static deserialize(data) {
        return new Pulley(data.x, data.y, {
            angle: data.angle,
            isFixed: data.isFixed,
            customId: data.id,
            ropeLength: data.options?.ropeLength || 150,
        });
    }

    dispose() {
        this._wheel = null;
        this._leftPlatform = null;
        this._rightPlatform = null;
        this._leftConstraint = null;
        this._rightConstraint = null;
        this._prevLeftPos = null;
        this._prevRightPos = null;
    }
}
