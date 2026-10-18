/**
 * Scissors — weight-triggered rope cutter that rests open
 *
 * Static hazard built from two levers crossing at the pivot:
 *   - Blades are sensor bodies fanned open; a rope can rest between the
 *     open blades without being cut.
 *   - Solid handle bodies sit behind the pivot; when a dynamic weight
 *     lands on one, the levers snap shut (one-shot: they stay closed).
 *
 * Cutting semantics:
 *   - The snap severs any rope with a segment inside the open-blade fan
 *     right away — collision events alone can't cover this, since
 *     rope/blade pairs already in flight don't re-emit collisionStart
 *     when the blades move.
 *   - While closed, ropes touching the blade bodies sever via the normal
 *     collision path (Rope.onCollision gates on isClosed + blade label).
 *   - Open blades never cut; handle contact never triggers the snap and
 *     ropes never trigger it either (they're too light to pull a lever).
 * Balloons still pop on any scissors contact (see Balloon.onCollision).
 */

import Matter from 'matter-js';
import BaseObject from './BaseObject.js';

const { Bodies, Body } = Matter;

const SCISSORS_COLOR = '#c0c0c0';
const HANDLE_COLOR = '#cc4444';
const BLADE_COLOR = '#d0d0d0';

// Lever geometry (px in the scissors' local frame; object angle on top)
const BLADE_LENGTH = 30;         // blade sensor rect, tail at the pivot
const BLADE_THICKNESS = 4;
const BLADE_CENTER_OFFSET = 15;  // half its length
const HANDLE_LENGTH = 12;
const HANDLE_THICKNESS = 9;
const HANDLE_CENTER_OFFSET = 22; // behind the pivot
const OPEN_SPLAY = 0.42;         // rad, blades/handles at rest (open X)
const CLOSED_SPLAY = 0.06;       // rad, tips nearly touching when snapped
const CLOSE_TIME = 120;          // ms for the snap animation
const ROPE_CUT_PAD = 4;          // reach beyond blade surfaces (seg r≈3 + grace)

export default class Scissors extends BaseObject {
    constructor(x, y, options = {}) {
        super(x, y, options);

        // Always spawns open — closed state only ever comes from play,
        // never from construction/deserialization (boards start clean).
        this._closed = false;
        this._closeAnim = 1;      // 0..1 progress toward shut
        this._splay = OPEN_SPLAY;
        this._engine = null;

        this._bladeTop = Bodies.rectangle(x, y, BLADE_LENGTH, BLADE_THICKNESS, {
            isStatic: true,
            isSensor: true,       // blades don't block, they cut
            label: 'scissors-blade',
        });
        this._bladeBottom = Bodies.rectangle(x, y, BLADE_LENGTH, BLADE_THICKNESS, {
            isStatic: true,
            isSensor: true,
            label: 'scissors-blade',
        });
        this._handleUpper = Bodies.rectangle(x, y, HANDLE_LENGTH, HANDLE_THICKNESS, {
            isStatic: true,
            label: 'scissors-handle',
        });
        this._handleLower = Bodies.rectangle(x, y, HANDLE_LENGTH, HANDLE_THICKNESS, {
            isStatic: true,
            label: 'scissors-handle',
        });

        this._applyLeverPoses();
    }

    get type() { return 'scissors'; }
    get bodies() {
        return [this._bladeTop, this._handleUpper, this._bladeBottom, this._handleLower];
    }
    get isOpen() { return !this._closed; }
    get isClosed() { return this._closed; }
    get splayAngle() { return this._splay; }

    get bounds() {
        // Spread of all four lever bodies (Matter bounds are pre-rotated)
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const body of this.bodies) {
            const b = body.bounds;
            if (b.min.x < minX) minX = b.min.x;
            if (b.min.y < minY) minY = b.min.y;
            if (b.max.x > maxX) maxX = b.max.x;
            if (b.max.y > maxY) maxY = b.max.y;
        }
        return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    }

    setPosition(x, y) {
        super.setPosition(x, y);
        this._applyLeverPoses();
    }

    setAngle(angle) {
        super.setAngle(angle);
        this._applyLeverPoses();
    }

    onBeforeUpdate(engine, dt) {
        this._engine = engine;
        if (!this._closed || this._closeAnim >= 1) return;
        const stepMs = Number.isFinite(dt) ? dt : 16.67;
        this._closeAnim = Math.min(1, this._closeAnim + stepMs / CLOSE_TIME);
        // Snap hard at first, ease into the shut pose
        const eased = 1 - Math.pow(1 - this._closeAnim, 2);
        this._splay = OPEN_SPLAY + (CLOSED_SPLAY - OPEN_SPLAY) * eased;
        this._applyLeverPoses();
    }

    onCollision(other, pair) {
        if (this._closed) return;
        if (!this._touchingHandle(pair)) return;
        // Light, flimsy rope segments brushing the handles shouldn't snap
        // them shut; statics can't "fall" onto a handle either.
        if (other.type === 'rope') return;
        const otherBody = pair.bodyA === this._handleUpper || pair.bodyA === this._handleLower
            ? pair.bodyB
            : pair.bodyA;
        if (otherBody.isStatic) return;
        this._snapShut();
    }

    _touchingHandle(pair) {
        return pair.bodyA === this._handleUpper || pair.bodyB === this._handleUpper ||
               pair.bodyA === this._handleLower || pair.bodyB === this._handleLower;
    }

    _snapShut() {
        if (this._closed) return;
        this._closed = true;
        this._closeAnim = 0;
        // Cut whatever hangs in the open-blade fan right now — that's the
        // region the blades sweep shut. Pairs already in flight won't
        // re-emit collisionStart when the blades move, so relying on the
        // closed-blade collision path would miss ropes resting between
        // the blades.
        this._severRopesInBladeFan();
    }

    _severRopesInBladeFan() {
        if (!this._engine) return;
        const cosB = Math.cos(this._angle);
        const sinB = Math.sin(this._angle);
        const tip = BLADE_CENTER_OFFSET + BLADE_LENGTH / 2 + ROPE_CUT_PAD;
        for (const obj of this._engine.getObjects()) {
            if (obj.type !== 'rope' || obj.isSevered) continue;
            for (const body of obj.bodies) {
                if (!body || body.isStatic) continue; // skip the anchor nail
                const dx = body.position.x - this._x;
                const dy = body.position.y - this._y;
                // World → scissors-local: pivot at origin, blades on +x
                const along = dx * cosB + dy * sinB;
                const across = -dx * sinB + dy * cosB;
                const reach = Math.tan(OPEN_SPLAY) * Math.max(along, 0) +
                    BLADE_THICKNESS / 2 + ROPE_CUT_PAD;
                if (along > -(ROPE_CUT_PAD + BLADE_THICKNESS / 2) &&
                    along <= tip && Math.abs(across) <= reach) {
                    obj.sever();
                    break;
                }
            }
        }
    }

    /**
     * Reposition the four lever bodies from (position, angle, splay).
     * The bodies are static and moved directly — placement, rotation,
     * the closing animation and snapshot restores share this one path.
     */
    _applyLeverPoses() {
        const a = this._splay;
        const base = this._angle;
        const px = this._x;
        const py = this._y;

        const bladeTopAngle = base - a;
        Body.setPosition(this._bladeTop, {
            x: px + BLADE_CENTER_OFFSET * Math.cos(bladeTopAngle),
            y: py + BLADE_CENTER_OFFSET * Math.sin(bladeTopAngle),
        });
        Body.setAngle(this._bladeTop, bladeTopAngle);

        const bladeBottomAngle = base + a;
        Body.setPosition(this._bladeBottom, {
            x: px + BLADE_CENTER_OFFSET * Math.cos(bladeBottomAngle),
            y: py + BLADE_CENTER_OFFSET * Math.sin(bladeBottomAngle),
        });
        Body.setAngle(this._bladeBottom, bladeBottomAngle);

        // Handles mirror the blades across the pivot (levers cross), so
        // each handle rides the opposite blade's lever.
        const handleUpperAngle = base + a;
        Body.setPosition(this._handleUpper, {
            x: px - HANDLE_CENTER_OFFSET * Math.cos(handleUpperAngle),
            y: py - HANDLE_CENTER_OFFSET * Math.sin(handleUpperAngle),
        });
        Body.setAngle(this._handleUpper, handleUpperAngle);

        const handleLowerAngle = base - a;
        Body.setPosition(this._handleLower, {
            x: px - HANDLE_CENTER_OFFSET * Math.cos(handleLowerAngle),
            y: py - HANDLE_CENTER_OFFSET * Math.sin(handleLowerAngle),
        });
        Body.setAngle(this._handleLower, handleLowerAngle);
    }

    draw(ctx) {
        ctx.save();
        ctx.translate(this._x, this._y);
        ctx.rotate(this._angle);

        // Levers: blade toward +x, handle behind the pivot, splayed open
        // (or eased shut) around the pivot.
        for (const s of [-1, 1]) {
            ctx.save();
            ctx.rotate(s * this._splay);

            // Blade — tapering wedge, tip away from the pivot
            ctx.beginPath();
            ctx.moveTo(-1, s * 1.5);
            ctx.lineTo(26, s * 4);
            ctx.lineTo(29, s * 2);
            ctx.lineTo(26, 0);
            ctx.closePath();
            ctx.fillStyle = s < 0 ? BLADE_COLOR : SCISSORS_COLOR;
            ctx.fill();
            ctx.strokeStyle = '#888';
            ctx.lineWidth = 1;
            ctx.stroke();

            // Shank — metal arm linking the ring to the pivot, so the
            // handle doesn't float detached from its blade
            ctx.beginPath();
            ctx.rect(-16, -2, 15, 4);
            ctx.fillStyle = s < 0 ? BLADE_COLOR : SCISSORS_COLOR;
            ctx.fill();
            ctx.strokeStyle = '#888';
            ctx.lineWidth = 1;
            ctx.stroke();

            // Handle ring + hole, straddling the lever axis
            ctx.beginPath();
            ctx.ellipse(-22, 0, 8, 5, 0, 0, Math.PI * 2);
            ctx.fillStyle = HANDLE_COLOR;
            ctx.fill();
            ctx.strokeStyle = '#993333';
            ctx.stroke();

            ctx.beginPath();
            ctx.ellipse(-23, 0, 4, 2.5, 0, 0, Math.PI * 2);
            ctx.fillStyle = '#e8e0d0';
            ctx.fill();

            ctx.restore();
        }

        // Pivot screw on top
        ctx.beginPath();
        ctx.arc(0, 0, 2.5, 0, Math.PI * 2);
        ctx.fillStyle = '#777';
        ctx.fill();
        ctx.strokeStyle = '#555';
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.restore();
    }

    drawToolboxIcon(ctx, w, h) {
        const cx = w / 2;
        const cy = h / 2;

        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(-0.3);

        // Levers: shank from the ring to the pivot, blade from the pivot
        // outward — one continuous arm per lever, like the placed object.
        for (const s of [-1, 1]) {
            // Shank (ends just inside the ring so it reads attached)
            ctx.strokeStyle = SCISSORS_COLOR;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(-7.5, s * 2);
            ctx.lineTo(-1, s * 0.3);
            ctx.stroke();

            // Blade
            ctx.beginPath();
            ctx.moveTo(-0.5, s * 0.3);
            ctx.lineTo(11, s * 4);
            ctx.stroke();

            // Handle ring
            ctx.strokeStyle = HANDLE_COLOR;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.ellipse(-11, s * 3, 4, 3, 0, 0, Math.PI * 2);
            ctx.stroke();
        }

        // Pivot screw
        ctx.fillStyle = '#555';
        ctx.beginPath();
        ctx.arc(0, 0, 1.5, 0, Math.PI * 2);
        ctx.fill();

        ctx.restore();
    }

    serialize() {
        const data = super.serialize();
        // Runtime closed state rides along in options so play/reset
        // cycles replay deterministically (see restoreState).
        data.options.closed = this._closed;
        return data;
    }

    static deserialize(data) {
        return new Scissors(data.x, data.y, {
            angle: data.angle,
            isFixed: data.isFixed,
            customId: data.id,
        });
    }

    /**
     * Re-apply serialized behavioral state after a snapshot restore, so
     * play/reset cycles replay deterministically (Mouse pattern). The
     * static lever bodies carry no body-level snapshot state, so this
     * also restores their poses from the closed flag.
     */
    restoreState(data) {
        this._closed = data?.options?.closed === true;
        this._closeAnim = this._closed ? 1 : 0;
        this._splay = this._closed ? CLOSED_SPLAY : OPEN_SPLAY;
        this._applyLeverPoses();
    }

    dispose() {
        this._bladeTop = null;
        this._bladeBottom = null;
        this._handleUpper = null;
        this._handleLower = null;
    }
}
