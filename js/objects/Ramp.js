/**
 * Ramp — Angled surface for redirecting objects
 *
 * A static sloped surface that objects can roll or slide down.
 * Can be rotated during edit mode to change the angle.
 */

import Matter from 'matter-js';
import BaseObject from './BaseObject.js';

const { Bodies, Body } = Matter;

const RAMP_WIDTH = 120;
const RAMP_HEIGHT = 12;
const RAMP_COLOR = '#8B7355';
const RAMP_EDGE = '#6b5335';

// Declared surface material. Like the trampoline's fabric (see
// Trampoline.js), the `isStatic: true` option is applied through matter-js's
// Body.setStatic inside Body.create, which zeroes restitution and forces
// friction = 1 — so values passed in the body options never reach the solver.
// For this value set the loss is currently behaviorally inert: the pair
// solver takes max(rest) / min(friction) of the two live bodies, and every
// ball variant (restitution ≥ 0.3, friction ≤ 0.5) already dominates or
// washes out the blend. But any future tuning of the ramp's surface would
// silently do nothing — the same latent trap that ate the trampoline's
// declared 0.95 (bug-20261023T174706Z-0oca). Re-asserting after creation
// keeps the body honest; Pair.update recomputes the pair's restitution and
// friction from the live body values every tick, so the assignment sticks.
const RAMP_FRICTION = 0.5;
const RAMP_RESTITUTION = 0.1;

export default class Ramp extends BaseObject {
    /**
     * @param {number} x - Center x
     * @param {number} y - Center y
     * @param {object} [options={}]
     * @param {number} [options.width=120] - Ramp width
     */
    constructor(x, y, options = {}) {
        super(x, y, options);
        this._width = options.width || RAMP_WIDTH;
        this._height = RAMP_HEIGHT;

        this._body = Bodies.rectangle(x, y, this._width, this._height, {
            isStatic: true,
            friction: RAMP_FRICTION,
            restitution: RAMP_RESTITUTION,
            angle: this._angle,
            label: 'ramp',
        });
        // Re-assert the declared surface material after the body's implicit
        // static flip (see the constants note above).
        this._body.restitution = RAMP_RESTITUTION;
        this._body.friction = RAMP_FRICTION;
    }

    get type() { return 'ramp'; }

    get bodies() { return [this._body]; }

    get bounds() {
        const b = this._body.bounds;
        return {
            x: b.min.x,
            y: b.min.y,
            width: b.max.x - b.min.x,
            height: b.max.y - b.min.y,
        };
    }

    setPosition(x, y) {
        super.setPosition(x, y);
        Body.setPosition(this._body, { x, y });
    }

    setAngle(angle) {
        super.setAngle(angle);
        Body.setAngle(this._body, angle);
    }

    draw(ctx) {
        const vertices = this._body.vertices;

        ctx.save();

        // Fill
        ctx.beginPath();
        ctx.moveTo(vertices[0].x, vertices[0].y);
        for (let i = 1; i < vertices.length; i++) {
            ctx.lineTo(vertices[i].x, vertices[i].y);
        }
        ctx.closePath();
        ctx.fillStyle = RAMP_COLOR;
        ctx.fill();

        // Wood grain lines
        const pos = this._body.position;
        const angle = this._body.angle;
        ctx.save();
        ctx.translate(pos.x, pos.y);
        ctx.rotate(angle);
        ctx.strokeStyle = RAMP_EDGE;
        ctx.lineWidth = 0.5;
        ctx.globalAlpha = 0.4;
        const grainSpacing = 8;
        for (let gx = -this._width / 2 + grainSpacing; gx < this._width / 2; gx += grainSpacing) {
            ctx.beginPath();
            ctx.moveTo(gx, -this._height / 2);
            ctx.lineTo(gx, this._height / 2);
            ctx.stroke();
        }
        ctx.globalAlpha = 1;
        ctx.restore();

        // Outline
        ctx.beginPath();
        ctx.moveTo(vertices[0].x, vertices[0].y);
        for (let i = 1; i < vertices.length; i++) {
            ctx.lineTo(vertices[i].x, vertices[i].y);
        }
        ctx.closePath();
        ctx.strokeStyle = RAMP_EDGE;
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.restore();
    }

    drawToolboxIcon(ctx, w, h) {
        ctx.save();
        ctx.translate(w / 2, h / 2);
        ctx.rotate(-0.2);
        const rw = w * 0.7;
        const rh = 4;
        ctx.fillStyle = RAMP_COLOR;
        ctx.fillRect(-rw / 2, -rh / 2, rw, rh);
        ctx.strokeStyle = RAMP_EDGE;
        ctx.lineWidth = 1;
        ctx.strokeRect(-rw / 2, -rh / 2, rw, rh);
        ctx.restore();
    }

    serialize() {
        return {
            ...super.serialize(),
            options: { ...this._options, width: this._width },
        };
    }

    static deserialize(data) {
        return new Ramp(data.x, data.y, {
            angle: data.angle,
            isFixed: data.isFixed,
            customId: data.id,
            width: data.options?.width || RAMP_WIDTH,
        });
    }

    dispose() {
        this._body = null;
    }
}
