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
        //
        // The parts sit in flush contact by construction — the walls' inner
        // faces exactly on the floor's ends, the sensor's bottom exactly on
        // the floor's top — so Matter generates mutual contact pairs every
        // step. With only centre-held welds those contacts resolved into
        // off-centre nudges: a hanging bucket churned, its walls spun like
        // pinwheels and the container folded (bug-20261023T152411Z-05xt).
        // One exclusive negative collision group per bucket instance stops
        // the self-resolution; groups differ between buckets, and against
        // everything else the filter falls through to the default category
        // masks (balls, ropes and walls all still collide with the parts).
        let selfGroup = Body.nextGroup(true);
        if (selfGroup === -1) selfGroup = Body.nextGroup(true); // −1 = the rope chain's reserved group

        this._leftWall = Bodies.rectangle(
            x - hw + wallThickness / 2, y, wallThickness, this._height, {
            isStatic: this._isFixed, label: 'bucket-wall', friction: 0.3,
            collisionFilter: { group: selfGroup },
        }
        );
        this._rightWall = Bodies.rectangle(
            x + hw - wallThickness / 2, y, wallThickness, this._height, {
            isStatic: this._isFixed, label: 'bucket-wall', friction: 0.3,
            collisionFilter: { group: selfGroup },
        }
        );
        this._floor = Bodies.rectangle(
            x, y + hh - wallThickness / 2, this._width - wallThickness * 2, wallThickness, {
            isStatic: this._isFixed, label: 'bucket-floor', friction: 0.3,
            collisionFilter: { group: selfGroup },
        }
        );

        // Sensor zone inside the bucket (detects objects landing inside)
        this._sensor = Bodies.rectangle(
            x, y + 5, this._width - wallThickness * 2 - 4, this._height * 0.5, {
            isStatic: this._isFixed,
            isSensor: true,
            label: 'bucket-sensor',
            collisionFilter: { group: selfGroup },
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
     * Pin sync (bug-20261025T193755Z): the BaseObject seam flips the flag and
     * statics/restores the bodies; the welds are bucket-specific and follow
     * here. Pinning drops live welds — static parts never move, and joints
     * left behind would be construction-geometry ghosts when the bucket
     * unpins later (weld() reads part positions at build time). Unpinning
     * rebuilds them from the parts' CURRENT positions. The rebuild also
     * serves buckets born fixed (level scenery, or a sandbox pin that
     * round-tripped through a snapshot reset) whose weld set is empty by
     * construction: the moment they become dynamic they must be welded
     * containers, not four loose bodies (the pinwheel/fold bug). Bodies-null
     * check: a disposed instance can no longer weld (and is off the board,
     * so it never needs to).
     * @param {boolean} value
     */
    /**
     * Paired with the setter below: naming an accessor "isFixed" in this
     * subclass hides BaseObject's getter - the prototype lookup stops at
     * Bucket.prototype's set-only descriptor and every external read
     * (renderer, panel, save flow, tests) would see undefined. The delegate
     * keeps flag reads single-sourced through BaseObject.
     * @returns {boolean}
     */
    get isFixed() { return super.isFixed; }

    set isFixed(value) {
        const wasFixed = this._isFixed;
        super.isFixed = value;
        if (this._isFixed === wasFixed || !this._leftWall) return;
        if (this._isFixed) {
            this._welds = [];
        } else if (this._welds.length === 0) {
            this._welds = this._buildWelds();
        }
    }

    /**
     * Welds binding the bucket's four bodies into one rigid container
     * (issue 04; rigid scheme per ADR 0005 decision 12). Each body-to-body
     * joint is TWO zero-length constraints anchored at both ends of the
     * parts' construction contact seam — two distinct coinciding points
     * lock the pair's relative rotation, which a single centre-to-centre
     * distance weld leaves free (the pinwheel/fold failure recorded in
     * bug-20261023T152411Z-05xt). The wall↔wall weld keeps a centre
     * distance across the rim to triangulate the mouth's aperture. All
     * lengths are satisfied exactly by the construction layout, so no
     * weld starts under load.
     * @private
     * @returns {Matter.Constraint[]}
     */
    _buildWelds() {
        const wt = WALL_THICKNESS;
        const floorHalf = (this._width - 2 * wt) / 2;      // 20: the floor's half-length
        const floorHalfThickness = wt / 2;                 // 2.5
        const rimY = this._height / 2 - wt;                // 15: floor's top edge, wall-local
        const wallBottomY = this._height / 2;              // 20: the walls' bottom end
        const sensorHalf = (this._width - 2 * wt - 4) / 2; // 18: the sensor's half-width
        const sensorBottomY = this._height * 0.25;         // 10: the sensor's bottom edge

        const pin = (bodyA, pointA, bodyB, pointB) => Constraint.create({
            bodyA, bodyB, pointA, pointB, length: 0, stiffness: 1,
        });
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
            // Rim: wall↔wall centre distance triangulates the mouth
            weld(this._leftWall, this._rightWall),
            // Left wall ↔ floor: both ends of their shared edge seam
            pin(this._leftWall,  { x:  wt / 2, y: rimY },       this._floor, { x: -floorHalf, y: -floorHalfThickness }),
            pin(this._leftWall,  { x:  wt / 2, y: wallBottomY }, this._floor, { x: -floorHalf, y:  floorHalfThickness }),
            // Right wall ↔ floor (mirrored)
            pin(this._rightWall, { x: -wt / 2, y: rimY },       this._floor, { x:  floorHalf, y: -floorHalfThickness }),
            pin(this._rightWall, { x: -wt / 2, y: wallBottomY }, this._floor, { x:  floorHalf, y:  floorHalfThickness }),
            // Sensor ↔ floor: both ends of their flush seam
            pin(this._sensor, { x: -sensorHalf, y: sensorBottomY }, this._floor, { x: -sensorHalf, y: -floorHalfThickness }),
            pin(this._sensor, { x:  sensorHalf, y: sensorBottomY }, this._floor, { x:  sensorHalf, y: -floorHalfThickness }),
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
        const w = this._width;
        const h = this._height;
        const hw = w / 2 - 2.5;
        const hh = h / 2;

        ctx.save();
        // Draw in the floor body's frame (issue 04, ADR 0005 decision 12):
        // the rigid welds make the four parts one container whose pose the
        // floor body carries — the same body the `rim` attachment point
        // rides — so anchoring the painting on the floor (rotating with its
        // angle) keeps the render welded to the physics for hangs, hoists
        // and swings. The offsets are the construction offsets from the
        // floor's centre to the drawn shape's origin; upright they match
        // the previous left-wall-anchored origin pixel for pixel.
        ctx.translate(this._floor.position.x, this._floor.position.y);
        ctx.rotate(this._floor.angle);
        ctx.translate(2.5, -(hh - WALL_THICKNESS / 2));

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
            isAnchored: data.isAnchored,
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
