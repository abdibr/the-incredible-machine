/**
 * Bucket — Goal container that catches objects
 *
 * The primary goal object in most puzzles.
 * Detects when a target object enters it via collision.
 */

import Matter from 'matter-js';
import BaseObject from './BaseObject.js';
import { eventBus } from '../EventBus.js';

const { Bodies, Body, Composite, Constraint } = Matter;

const BUCKET_WIDTH = 50;
const BUCKET_HEIGHT = 40;
const WALL_THICKNESS = 5;
const BUCKET_COLOR = '#8B4513';
const BUCKET_INNER = '#6B3310';
const RIM_COLOR = '#a0a0a0';

export default class Bucket extends BaseObject {
    constructor(x, y, options = {}) {
        super(x, y, options);
        this._width = options.width || BUCKET_WIDTH;
        this._height = options.height || BUCKET_HEIGHT;
        this._catchType = options.catchType || null; // null = catch anything

        const wallThickness = WALL_THICKNESS;
        const hw = this._width / 2;
        const hh = this._height / 2;

        // Build bucket from three bodies: left wall, right wall, floor.
        // Unfixed buckets are dynamic (issue 04 — a bucket can be lowered,
        // hoisted or dropped by ropes and payloads); fixed buckets stay
        // static exactly as before.
        this._leftWall = Bodies.rectangle(
            x - hw + wallThickness / 2, y, wallThickness, this._height, {
            isStatic: this._isFixed, label: 'bucket-wall', friction: 0.3,
        }
        );
        this._rightWall = Bodies.rectangle(
            x + hw - wallThickness / 2, y, wallThickness, this._height, {
            isStatic: this._isFixed, label: 'bucket-wall', friction: 0.3,
        }
        );
        this._floor = Bodies.rectangle(
            x, y + hh - wallThickness / 2, this._width - wallThickness * 2, wallThickness, {
            isStatic: this._isFixed, label: 'bucket-floor', friction: 0.3,
        }
        );

        // Sensor zone inside the bucket (detects objects landing inside)
        this._sensor = Bodies.rectangle(
            x, y + 5, this._width - wallThickness * 2 - 4, this._height * 0.5, {
            isStatic: this._isFixed,
            isSensor: true,
            label: 'bucket-sensor',
        }
        );

        /** @type {Set<string>} IDs of objects that have been caught */
        this._caught = new Set();

        // Weld the container together for dynamic buckets (issue 04):
        // distance constraints at stiffness 1 along the construction
        // layout. Skipped when fixed — static bodies never move and the
        // goal bucket's zone must stay put.
        this._welds = this._isFixed ? [] : this._buildWelds();
    }

    get type() { return 'bucket'; }

    get bodies() {
        return [this._leftWall, this._rightWall, this._floor, this._sensor];
    }

    get bounds() {
        return {
            x: this._x - this._width / 2,
            y: this._y - this._height / 2,
            width: this._width,
            height: this._height,
        };
    }

    /**
     * @returns {Matter.Constraint[]} object-owned weld constraints holding
     * the container together (empty for fixed buckets — static bodies never
     * need joints). Removed/re-added wholesale by PhysicsEngine's generic
     * lifecycle seam.
     */
    get constraints() {
        return this._welds;
    }

    /**
     * Welds binding the bucket's four bodies into one rigid container
     * (issue 04). Distance constraints with stiffness 1 and lengths taken
     * from the construction layout: a triangle over wall-wall-floor plus
     * the sensor pinned to the floor. They hold the shape under a dropped
     * ball load — see tests/bucket.test.js.
     * @private
     * @returns {Matter.Constraint[]}
     */
    _buildWelds() {
        const weld = (bodyA, bodyB) => Constraint.create({
            bodyA,
            bodyB,
            length: Math.hypot(
                bodyA.position.x - bodyB.position.x,
                bodyA.position.y - bodyB.position.y,
            ),
            stiffness: 1,
        });
        return [
            weld(this._leftWall, this._rightWall),
            weld(this._leftWall, this._floor),
            weld(this._rightWall, this._floor),
            weld(this._sensor, this._floor),
        ];
    }

    /**
     * Rope anchor seam (issue 04): the bucket offers its rim — the mouth's
     * top edge — as a tying point. Tied to a fixed bucket the rope is
     * nailed in place; tied to a falling one, the payload is dragged along.
     * The offset is floor-local: from the floor body's center up to the
     * bucket's top edge (it follows any motion of the carried floor).
     * @returns {Array<{id: string, body: Matter.Body, offset: {x: number, y: number}}>}
     */
    get attachmentPoints() {
        return [{
            id: 'rim',
            body: this._floor,
            offset: { x: 0, y: -(this._height - WALL_THICKNESS / 2) },
        }];
    }

    setPosition(x, y) {
        const dx = x - this._x;
        const dy = y - this._y;
        super.setPosition(x, y);

        Body.translate(this._leftWall, { x: dx, y: dy });
        Body.translate(this._rightWall, { x: dx, y: dy });
        Body.translate(this._floor, { x: dx, y: dy });
        Body.translate(this._sensor, { x: dx, y: dy });
    }

    setAngle(angle) {
        // Bucket doesn't rotate
        super.setAngle(0);
    }

    /**
     * Decision seam for the interaction matrix: does this contact count as
     * the sensor catching `other`?
     * @param {BaseObject} other
     * @param {Matter.Pair} pair
     * @returns {boolean}
     */
    isCatchContact(other, pair) {
        // Only the sensor zone catches; wall/floor contacts don't count
        if (pair.bodyA !== this._sensor && pair.bodyB !== this._sensor) return false;
        // Never catch itself (issue 04): with dynamic buckets the sensor
        // sits flush against the floor body and its own walls brush it —
        // the resulting self-pairs previously made a falling bucket
        // register itself as caught.
        if (other === this) return false;
        // Catch type filter (null = catch anything)
        return !this._catchType || other.type === this._catchType;
    }

    /**
     * Behavior seam: register the catch, once per object, and announce it.
     * @param {BaseObject} other
     * @returns {boolean} true if this was a new catch
     */
    registerCatch(other) {
        if (this._caught.has(other.id)) return false;
        this._caught.add(other.id);
        eventBus.emit('bucket:caught', {
            bucket: this,
            object: other,
            totalCaught: this._caught.size,
        });
        return true;
    }

    /** @returns {number} */
    get caughtCount() {
        return this._caught.size;
    }

    draw(ctx) {
        const x = this._leftWall.position.x + 2.5;
        const y = this._leftWall.position.y;
        const w = this._width;
        const h = this._height;
        const hw = w / 2 - 2.5;
        const hh = h / 2;

        ctx.save();
        ctx.translate(x + hw, y);

        // Bucket interior (dark)
        ctx.fillStyle = BUCKET_INNER;
        ctx.fillRect(-hw, -hh, w - 5, h);

        // Left wall
        ctx.fillStyle = BUCKET_COLOR;
        ctx.fillRect(-hw, -hh, 5, h);

        // Right wall
        ctx.fillRect(hw - 5, -hh, 5, h);

        // Floor
        ctx.fillRect(-hw + 5, hh - 5, w - 15, 5);

        // Rim / lip
        ctx.fillStyle = RIM_COLOR;
        ctx.fillRect(-hw - 2, -hh, w - 1, 4);

        // Wood texture lines
        ctx.strokeStyle = '#7a3a10';
        ctx.lineWidth = 0.5;
        ctx.globalAlpha = 0.3;
        for (let ly = -hh + 8; ly < hh - 5; ly += 7) {
            // Left wall grain
            ctx.beginPath();
            ctx.moveTo(-hw + 1, ly);
            ctx.lineTo(-hw + 4, ly);
            ctx.stroke();
            // Right wall grain
            ctx.beginPath();
            ctx.moveTo(hw - 4, ly);
            ctx.lineTo(hw - 1, ly);
            ctx.stroke();
        }
        ctx.globalAlpha = 1;

        // Band / strap
        ctx.fillStyle = '#666';
        ctx.fillRect(-hw - 1, -hh + h * 0.35, w - 3, 3);
        ctx.fillRect(-hw - 1, -hh + h * 0.7, w - 3, 3);

        // Outline
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(-hw, -hh);
        ctx.lineTo(-hw, hh);
        ctx.lineTo(hw - 5, hh);
        ctx.lineTo(hw - 5, -hh);
        ctx.stroke();

        ctx.restore();
    }

    drawToolboxIcon(ctx, w, h) {
        const bw = w * 0.5;
        const bh = h * 0.5;
        const bx = w / 2 - bw / 2;
        const by = h / 2 - bh / 2;

        // Interior
        ctx.fillStyle = BUCKET_INNER;
        ctx.fillRect(bx, by, bw, bh);

        // Walls
        ctx.fillStyle = BUCKET_COLOR;
        ctx.fillRect(bx, by, 3, bh);
        ctx.fillRect(bx + bw - 3, by, 3, bh);
        ctx.fillRect(bx + 3, by + bh - 3, bw - 6, 3);

        // Rim
        ctx.fillStyle = RIM_COLOR;
        ctx.fillRect(bx - 1, by, bw + 2, 2);

        ctx.strokeStyle = '#333';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(bx, by);
        ctx.lineTo(bx, by + bh);
        ctx.lineTo(bx + bw, by + bh);
        ctx.lineTo(bx + bw, by);
        ctx.stroke();
    }

    serialize() {
        return {
            ...super.serialize(),
            options: {
                ...this._options,
                width: this._width,
                height: this._height,
                catchType: this._catchType,
            },
        };
    }

    static deserialize(data) {
        return new Bucket(data.x, data.y, {
            angle: data.angle,
            isFixed: data.isFixed,
            customId: data.id,
            width: data.options?.width || BUCKET_WIDTH,
            height: data.options?.height || BUCKET_HEIGHT,
            catchType: data.options?.catchType || null,
        });
    }

    /**
     * Snapshot-restore seam (BaseObject lifecycle contract, ADR 0003):
     * `_caught` is behavioral — a same-instance physics restore must not
     * carry mid-play catches into the replayed attempt (GoalChecker re-arms
     * per attempt). Snapshots are taken at play start (GameLoop.play →
     * takeSnapshot), when the set is empty — cycles start clean.
     * @param {object} _data - serialized snapshot entry (poses-only for Bucket)
     */
    restoreState(_data) {
        this._caught.clear();
    }

    dispose() {
        this._leftWall = null;
        this._rightWall = null;
        this._floor = null;
        this._sensor = null;
    }
}
