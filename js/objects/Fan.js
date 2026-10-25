/**
 * Fan — Electric fan that blows objects in a direction
 *
 * Applies a directional force to objects within its wind zone.
 * The wind zone extends outward from the fan face.
 */

import Matter from 'matter-js';
import BaseObject from './BaseObject.js';

const { Bodies, Body } = Matter;

const FAN_WIDTH = 40;
const FAN_HEIGHT = 50;
const WIND_RANGE = 200;
const WIND_FORCE = 0.0008;
const FAN_COLOR = '#5577aa';
const CAGE_COLOR = '#888';

export default class Fan extends BaseObject {
    constructor(x, y, options = {}) {
        super(x, y, options);
        this._windRange = options.windRange || WIND_RANGE;
        this._windForce = options.windForce || WIND_FORCE;

        this._body = Bodies.rectangle(x, y, FAN_WIDTH, FAN_HEIGHT, {
            isStatic: true,
            label: 'fan',
            angle: this._angle,
        });

        /** @type {number} blade rotation animation */
        this._bladeAngle = 0;
        this._isBlowing = false;
    }

    get type() { return 'fan'; }
    get bodies() { return [this._body]; }

    get bounds() {
        const b = this._body.bounds;
        return { x: b.min.x, y: b.min.y, width: b.max.x - b.min.x, height: b.max.y - b.min.y };
    }

    setPosition(x, y) {
        super.setPosition(x, y);
        Body.setPosition(this._body, { x, y });
    }

    setAngle(angle) {
        super.setAngle(angle);
        Body.setAngle(this._body, angle);
    }

    /**
     * Apply wind force to bodies in the fan's wind zone.
     * Wind blows outward from the fan face (upward by default).
     *
     * A thin wrapper over the engine's impulse-field primitive (ADR 0002
     * amendment): the fan's law — rect zone out of the face, linear distance
     * falloff, mass-scaled force along local "up" (default), wake-on-act —
     * lives in one engine seam; the fan supplies only its dial settings and
     * the blade animation.
     */
    onBeforeUpdate(engine) {
        this._isBlowing = true;
        this._bladeAngle += 0.3;

        engine.applyImpulseField(this._body, {
            // Rect zone out of the fan face — queryZone convention: cx/cy the
            // rect's local centre offset, width/height its extents.
            zone: {
                cx: 0,
                cy: -this._windRange / 2,
                width: 2 * FAN_WIDTH,
                height: this._windRange,
            },
            range: this._windRange,
            force: this._windForce,
        });
    }

    draw(ctx) {
        const pos = this._body.position;
        const angle = this._body.angle;

        ctx.save();
        ctx.translate(pos.x, pos.y);
        ctx.rotate(angle);

        const hw = FAN_WIDTH / 2;
        const hh = FAN_HEIGHT / 2;

        // Fan housing
        ctx.fillStyle = FAN_COLOR;
        ctx.fillRect(-hw, -hh, FAN_WIDTH, FAN_HEIGHT);

        // Front grille / cage
        ctx.strokeStyle = CAGE_COLOR;
        ctx.lineWidth = 1.5;
        for (let i = -hw + 6; i <= hw - 6; i += 6) {
            ctx.beginPath();
            ctx.moveTo(i, -hh);
            ctx.lineTo(i, -hh + 8);
            ctx.stroke();
        }

        // Spinning blades
        ctx.save();
        ctx.translate(0, 0);
        ctx.rotate(this._bladeAngle);
        ctx.fillStyle = '#aabbcc';
        const bladeCount = 3;
        const bladeLen = hw - 4;
        for (let i = 0; i < bladeCount; i++) {
            const ba = (i / bladeCount) * Math.PI * 2;
            ctx.save();
            ctx.rotate(ba);
            ctx.beginPath();
            ctx.ellipse(bladeLen / 2, 0, bladeLen / 2, 4, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        }
        // Center hub
        ctx.fillStyle = '#666';
        ctx.beginPath();
        ctx.arc(0, 0, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        // Wind lines (when blowing)
        if (this._isBlowing) {
            ctx.strokeStyle = 'rgba(180, 200, 220, 0.4)';
            ctx.lineWidth = 1;
            const time = this._bladeAngle * 2;
            for (let i = 0; i < 4; i++) {
                const ly = -hh - 10 - i * 15 - ((time * 3 + i * 7) % 30);
                const waveAmp = 3 + i * 1.5;
                ctx.beginPath();
                ctx.moveTo(-hw + 8, ly);
                ctx.quadraticCurveTo(0, ly + waveAmp, hw - 8, ly);
                ctx.stroke();
            }
        }

        // Outline
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 2;
        ctx.strokeRect(-hw, -hh, FAN_WIDTH, FAN_HEIGHT);

        ctx.restore();
    }

    drawToolboxIcon(ctx, w, h) {
        ctx.fillStyle = FAN_COLOR;
        ctx.fillRect(w * 0.2, h * 0.2, w * 0.6, h * 0.6);
        // Simple blade icon
        ctx.strokeStyle = '#aabbcc';
        ctx.lineWidth = 2;
        const cx = w / 2;
        const cy = h / 2;
        for (let i = 0; i < 3; i++) {
            const a = (i / 3) * Math.PI * 2 - Math.PI / 6;
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.lineTo(cx + Math.cos(a) * 8, cy + Math.sin(a) * 8);
            ctx.stroke();
        }
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 1;
        ctx.strokeRect(w * 0.2, h * 0.2, w * 0.6, h * 0.6);
    }

    serialize() {
        return {
            ...super.serialize(),
            options: {
                ...this._options,
                windRange: this._windRange,
                windForce: this._windForce,
            },
        };
    }

    static deserialize(data) {
        return new Fan(data.x, data.y, {
            angle: data.angle,
            isFixed: data.isFixed,
            isAnchored: data.isAnchored,
            customId: data.id,
            windRange: data.options?.windRange || WIND_RANGE,
            windForce: data.options?.windForce || WIND_FORCE,
        });
    }

    dispose() {
        this._body = null;
    }
}
