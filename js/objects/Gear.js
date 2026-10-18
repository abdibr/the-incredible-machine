/**
 * Gear — Rotating wheel
 *
 * A circular body that rotates at a constant angular velocity.
 * Can mesh with adjacent gears (contact reverses direction).
 * The teeth push contacting bodies along the rim in onBeforeUpdate
 * (a static body's rotation alone is ignored by Matter.js).
 */

import Matter from 'matter-js';
import BaseObject from './BaseObject.js';

const { Bodies, Body, Sleeping } = Matter;

const GEAR_RADIUS = 28;
const GEAR_TEETH = 10;
const GEAR_COLOR = '#a0a0b0';
const TOOTH_COLOR = '#8888a0';
const HUB_COLOR = '#606070';

export default class Gear extends BaseObject {
    constructor(x, y, options = {}) {
        super(x, y, options);
        this._radius = options.radius || GEAR_RADIUS;
        this._angularSpeed = options.angularSpeed ?? 0.03;
        this._teethCount = options.teeth || GEAR_TEETH;

        // Create gear body — use a circle for physics, draw teeth visually
        this._body = Bodies.circle(x, y, this._radius, {
            isStatic: true,
            friction: 0.8,
            label: 'gear',
        });

        // Apply constant rotation
        Body.setAngularVelocity(this._body, this._angularSpeed);
    }

    get type() { return 'gear'; }
    get bodies() { return [this._body]; }

    get bounds() {
        const pos = this._body.position;
        const r = this._radius + 6;
        return { x: pos.x - r, y: pos.y - r, width: r * 2, height: r * 2 };
    }

    setPosition(x, y) {
        super.setPosition(x, y);
        Body.setPosition(this._body, { x, y });
    }

    setAngle(angle) {
        super.setAngle(angle);
        Body.setAngle(this._body, angle);
    }

    onBeforeUpdate(engine, dt) {
        // Maintain constant rotation (static body doesn't rotate on its own)
        Body.setAngle(this._body, this._body.angle + this._angularSpeed);

        this._applyToothTraction(engine);
    }

    /**
     * Tooth interaction — the Matter.js solver ignores a static body's
     * rotation, so bodies touching the teeth are pushed manually each step:
     * their velocity's tangential component (perpendicular to the radial
     * direction at the contact) is driven toward the local tooth surface speed
     * (omega * radius), proportional to the gear rotation rate. Only the
     * tangential component changes, so normal motion — gravity resting on the
     * rim, solver penetration resolution — is untouched. Bodies already riding
     * at tooth speed are left alone so they may sleep.
     * @param {object} engine - PhysicsEngine instance
     * @private
     */
    _applyToothTraction(engine) {
        const omega = this._angularSpeed;
        if (omega === 0 || !engine || !engine.world) return;

        const center = this._body.position;
        const toothSpeed = omega * this._radius;

        for (const body of Matter.Composite.allBodies(engine.world)) {
            if (body.isStatic) continue;

            const collision = Matter.Collision.collides(this._body, body);
            if (!collision || !collision.collided) continue;

            // Outward radial direction from the gear centre to the touching body
            const rx = body.position.x - center.x;
            const ry = body.position.y - center.y;
            const dist = Math.hypot(rx, ry);
            if (dist < 1e-6) continue; // degenerate: body exactly at gear centre

            // Tooth motion direction at this contact; surface points move along
            // (-r.y, r.x) for positive omega (rigid rotation velocity omega x r)
            const ux = -ry / dist;
            const uy = rx / dist;

            // Drive the tangential velocity component toward the tooth speed
            const dv = toothSpeed - (body.velocity.x * ux + body.velocity.y * uy);
            if (Math.abs(dv) < 0.01) continue; // already riding; allow it to sleep

            Sleeping.set(body, false);
            Body.setVelocity(body, {
                x: body.velocity.x + ux * dv,
                y: body.velocity.y + uy * dv,
            });
        }
    }

    onCollision(other, pair) {
        // When touching another gear, reverse their direction
        if (other.type === 'gear') {
            other._angularSpeed = -Math.sign(other._angularSpeed) * Math.abs(this._angularSpeed);
        }
    }

    draw(ctx) {
        const pos = this._body.position;
        const angle = this._body.angle;
        const r = this._radius;

        ctx.save();
        ctx.translate(pos.x, pos.y);
        ctx.rotate(angle);

        // Gear teeth
        ctx.beginPath();
        for (let i = 0; i < this._teethCount; i++) {
            const a = (i / this._teethCount) * Math.PI * 2;
            const halfTooth = Math.PI / this._teethCount * 0.5;

            const innerR = r - 4;
            const outerR = r + 5;

            ctx.lineTo(Math.cos(a - halfTooth) * innerR, Math.sin(a - halfTooth) * innerR);
            ctx.lineTo(Math.cos(a - halfTooth * 0.6) * outerR, Math.sin(a - halfTooth * 0.6) * outerR);
            ctx.lineTo(Math.cos(a + halfTooth * 0.6) * outerR, Math.sin(a + halfTooth * 0.6) * outerR);
            ctx.lineTo(Math.cos(a + halfTooth) * innerR, Math.sin(a + halfTooth) * innerR);
        }
        ctx.closePath();
        ctx.fillStyle = TOOTH_COLOR;
        ctx.fill();
        ctx.strokeStyle = '#666';
        ctx.lineWidth = 1;
        ctx.stroke();

        // Main wheel
        ctx.beginPath();
        ctx.arc(0, 0, r - 4, 0, Math.PI * 2);
        ctx.fillStyle = GEAR_COLOR;
        ctx.fill();
        ctx.strokeStyle = '#777';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Spokes
        ctx.strokeStyle = '#888';
        ctx.lineWidth = 2;
        for (let i = 0; i < 4; i++) {
            const sa = (i / 4) * Math.PI * 2;
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(Math.cos(sa) * (r - 8), Math.sin(sa) * (r - 8));
            ctx.stroke();
        }

        // Center hub
        ctx.beginPath();
        ctx.arc(0, 0, 6, 0, Math.PI * 2);
        ctx.fillStyle = HUB_COLOR;
        ctx.fill();
        ctx.strokeStyle = '#555';
        ctx.lineWidth = 1;
        ctx.stroke();

        // Center dot
        ctx.beginPath();
        ctx.arc(0, 0, 2, 0, Math.PI * 2);
        ctx.fillStyle = '#444';
        ctx.fill();

        ctx.restore();
    }

    drawToolboxIcon(ctx, w, h) {
        const cx = w / 2;
        const cy = h / 2;
        const r = Math.min(w, h) * 0.33;

        ctx.beginPath();
        const teeth = 8;
        for (let i = 0; i < teeth; i++) {
            const a = (i / teeth) * Math.PI * 2;
            const halfTooth = Math.PI / teeth * 0.4;
            const innerR = r * 0.75;
            const outerR = r;
            ctx.lineTo(cx + Math.cos(a - halfTooth) * innerR, cy + Math.sin(a - halfTooth) * innerR);
            ctx.lineTo(cx + Math.cos(a - halfTooth) * outerR, cy + Math.sin(a - halfTooth) * outerR);
            ctx.lineTo(cx + Math.cos(a + halfTooth) * outerR, cy + Math.sin(a + halfTooth) * outerR);
            ctx.lineTo(cx + Math.cos(a + halfTooth) * innerR, cy + Math.sin(a + halfTooth) * innerR);
        }
        ctx.closePath();
        ctx.fillStyle = GEAR_COLOR;
        ctx.fill();
        ctx.strokeStyle = '#666';
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(cx, cy, 2, 0, Math.PI * 2);
        ctx.fillStyle = HUB_COLOR;
        ctx.fill();
    }

    serialize() {
        return {
            ...super.serialize(),
            options: {
                ...this._options,
                radius: this._radius,
                angularSpeed: this._angularSpeed,
                teeth: this._teethCount,
            },
        };
    }

    static deserialize(data) {
        return new Gear(data.x, data.y, {
            angle: data.angle,
            isFixed: data.isFixed,
            customId: data.id,
            radius: data.options?.radius || GEAR_RADIUS,
            angularSpeed: data.options?.angularSpeed ?? 0.03,
            teeth: data.options?.teeth || GEAR_TEETH,
        });
    }

    dispose() {
        this._body = null;
    }
}
