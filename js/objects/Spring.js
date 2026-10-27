/**
 * Spring — Compressed launcher that releases stored energy
 *
 * When an object lands on the spring, it compresses and then
 * launches the object upward with a burst of force.
 *
 * Launch contract (bug-20261023T180834Z-gwce, "the ball did not bounce from
 * the spring ??"): the burst velocity is mass-independent — the applied
 * force scales with the rider's mass, so a bowling ball leaves the platform
 * as fast as a tennis ball. And the rider that armed the compression stays
 * launched even if its own rebound lifts it off the platform during the
 * 13-tick release window: the spring remembers the bodies of whatever armed
 * it and bursts them (while they remain within capture range) at release,
 * alongside anything still touching the platform at that moment.
 */

import Matter from 'matter-js';
import BaseObject from './BaseObject.js';

const { Bodies, Body } = Matter;

const SPRING_WIDTH = 30;
const SPRING_HEIGHT = 40;
// The launch burst is applied as force × body.mass: matter integrates
// Δv = F/m·dt², so an absolute force here would hand a bowling ball a
// ~13 px hop and a tennis ball a rocket. With the scaling, every rider
// leaves at Δv ≈ LAUNCH_FORCE × dt² (≈ 22 px/tick at the standard
// 16.667 ms step) regardless of its mass. The literal value stays 0.08
// so serialized launchForce options keep their meaning.
const LAUNCH_FORCE = 0.08;
// At release, a remembered rider only counts while its centre stays within
// this distance of the platform. The 13-tick compression window can let a
// full-canvas drop rebound ~140 px upward; 160 covers that while excluding
// a rider hauled or blown away mid-compression (whatever moved it owns it).
const SPRING_CAPTURE_RADIUS = 160;
const SPRING_COLOR = '#cc6633';
const COIL_COLOR = '#999';
const PLATFORM_COLOR = '#777';

export default class Spring extends BaseObject {
    constructor(x, y, options = {}) {
        super(x, y, options);
        this._launchForce = options.launchForce || LAUNCH_FORCE;

        // The base is static
        this._base = Bodies.rectangle(x, y + SPRING_HEIGHT / 2 - 5, SPRING_WIDTH + 10, 10, {
            isStatic: true,
            label: 'spring-base',
            angle: this._angle,
        });

        // The platform (top) detects objects landing on it
        this._platform = Bodies.rectangle(x, y - SPRING_HEIGHT / 2 + 5, SPRING_WIDTH, 8, {
            isStatic: true,
            label: 'spring-platform',
            restitution: 0.1,
            angle: this._angle,
        });

        /** @type {number} compression: 0 = rest, 1 = fully compressed */
        this._compression = 0;
        /** @type {boolean} */
        this._triggered = false;
        /** @type {number} trigger cooldown timer */
        this._cooldown = 0;
        /** @type {Matter.Body[]} bodies whose contact armed the current launch (cleared at release) */
        this._riders = [];
    }

    get type() { return 'spring'; }
    get bodies() { return [this._base, this._platform]; }

    get bounds() {
        return {
            x: this._base.position.x - SPRING_WIDTH / 2 - 5,
            y: this._platform.position.y - 4,
            width: SPRING_WIDTH + 10,
            height: SPRING_HEIGHT,
        };
    }

    setPosition(x, y) {
        super.setPosition(x, y);
        Body.setPosition(this._base, { x, y: y + SPRING_HEIGHT / 2 - 5 });
        Body.setPosition(this._platform, { x, y: y - SPRING_HEIGHT / 2 + 5 });
    }

    setAngle(angle) {
        super.setAngle(angle);
        Body.setAngle(this._base, angle);
        Body.setAngle(this._platform, angle);
    }

    /**
     * Decision seam for the interaction matrix: did something land on the
     * spring platform while the spring is armed (off cooldown, untriggered)?
     * @param {BaseObject} _other
     * @param {Matter.Pair} pair
     * @returns {boolean}
     */
    isLaunchTrigger(_other, pair) {
        if (this._cooldown > 0) return false;
        const hitPlatform = pair.bodyA === this._platform || pair.bodyB === this._platform;
        return hitPlatform && !this._triggered;
    }

    /**
     * Behavior seam: compress and arm the launch (release happens in onBeforeUpdate).
     * @param {BaseObject|null} [other=null] - the object whose contact armed us;
     *        its bodies are remembered and burst at release even if the pair's
     *        restitution (the rider's own) lifts them off the platform mid-window.
     */
    armLaunch(other = null) {
        this._triggered = true;
        this._compression = 1;

        // Remember who armed us: the recorded bowling ball rebounded ~9 px
        // above the platform during the compression, so a touching-only
        // sweep at release found nobody and the burst went nowhere.
        if (other && Array.isArray(other.bodies)) {
            for (const body of other.bodies) {
                if (body) this._riders.push(body);
            }
        }
    }

    onBeforeUpdate(engine) {
        if (this._cooldown > 0) {
            this._cooldown--;
        }

        if (this._triggered && this._compression > 0) {
            // Animate compression
            this._compression -= 0.08;

            if (this._compression <= 0) {
                this._compression = 0;
                this._triggered = false;
                this._cooldown = 30; // Cooldown frames before retriggering

                // The burst goes to the union of (a) the riders whose contact
                // armed this launch — they may be rebounding a few px above
                // the platform (the pair resolves at the landing body's own
                // restitution), which a touching-only sweep would miss — and
                // (b) anything touching the platform right now.
                const angle = this._base.angle;
                const launchDirX = -Math.sin(angle);
                const launchDirY = -Math.cos(angle);
                const platPos = this._platform.position;
                const targets = new Set(this._riders);

                // Platform-only contacts via the engine's discovery seam
                // (ADR 0002): sourceBodies excludes base contacts; statics
                // and the spring's own bodies are pre-filtered.
                for (const body of engine.queryTouching(this, { sourceBodies: [this._platform] })) {
                    targets.add(body);
                }
                this._riders = [];

                for (const body of targets) {
                    // A rider hauled away mid-compression is no longer ours
                    // to launch; see SPRING_CAPTURE_RADIUS.
                    const dx = body.position.x - platPos.x;
                    const dy = body.position.y - platPos.y;
                    if (dx * dx + dy * dy > SPRING_CAPTURE_RADIUS * SPRING_CAPTURE_RADIUS) continue;
                    // A sleeping rider would skip force integration — waking
                    // is part of launching it (ADR 0002).
                    engine.wakeBodies([body]);
                    Body.applyForce(body, body.position, {
                        x: launchDirX * this._launchForce * body.mass,
                        y: launchDirY * this._launchForce * body.mass,
                    });
                }
            }
        }
    }

    draw(ctx) {
        const basePos = this._base.position;
        const platPos = this._platform.position;
        const angle = this._base.angle;

        ctx.save();
        ctx.translate(basePos.x, basePos.y);
        ctx.rotate(angle);

        const hw = SPRING_WIDTH / 2;
        const baseTop = -5;
        const platY = -(SPRING_HEIGHT - 10) + this._compression * 15;

        // Base
        ctx.fillStyle = SPRING_COLOR;
        ctx.fillRect(-hw - 5, baseTop - 5, SPRING_WIDTH + 10, 10);
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(-hw - 5, baseTop - 5, SPRING_WIDTH + 10, 10);

        // Coil spring
        ctx.strokeStyle = COIL_COLOR;
        ctx.lineWidth = 2.5;
        const coils = 5;
        const coilTop = platY + 4;
        const coilBot = baseTop - 5;
        const coilHeight = coilBot - coilTop;
        ctx.beginPath();
        for (let i = 0; i <= coils; i++) {
            const cy = coilTop + (coilHeight / coils) * i;
            const sx = (i % 2 === 0) ? -hw + 4 : hw - 4;
            if (i === 0) {
                ctx.moveTo(sx, cy);
            } else {
                ctx.lineTo(sx, cy);
            }
        }
        ctx.stroke();

        // Platform
        ctx.fillStyle = PLATFORM_COLOR;
        ctx.fillRect(-hw, platY, SPRING_WIDTH, 8);
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(-hw, platY, SPRING_WIDTH, 8);

        ctx.restore();
    }

    drawToolboxIcon(ctx, w, h) {
        const cx = w / 2;
        // Base
        ctx.fillStyle = SPRING_COLOR;
        ctx.fillRect(cx - 10, h * 0.65, 20, 5);
        // Coil
        ctx.strokeStyle = COIL_COLOR;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(cx - 6, h * 0.35);
        ctx.lineTo(cx + 6, h * 0.42);
        ctx.lineTo(cx - 6, h * 0.49);
        ctx.lineTo(cx + 6, h * 0.56);
        ctx.lineTo(cx - 6, h * 0.63);
        ctx.stroke();
        // Platform
        ctx.fillStyle = PLATFORM_COLOR;
        ctx.fillRect(cx - 8, h * 0.3, 16, 4);
    }

    serialize() {
        return {
            ...super.serialize(),
            options: { ...this._options, launchForce: this._launchForce },
        };
    }

    static deserialize(data) {
        return new Spring(data.x, data.y, {
            angle: data.angle,
            isFixed: data.isFixed,
            isAnchored: data.isAnchored,
            customId: data.id,
            launchForce: data.options?.launchForce || LAUNCH_FORCE,
        });
    }

    /**
     * Snapshot-restore seam (BaseObject lifecycle contract, ADR 0003):
     * trigger/compression/cooldown are behavioral transients — a
     * same-instance physics restore must restart the spring armed-fresh,
     * not mid-animation with a half-ticked cooldown. Snapshots are taken
     * at play start (GameLoop.play → takeSnapshot), when the spring is
     * untriggered with no cooldown — cycles start clean.
     * @param {object} _data - serialized snapshot entry (pose-only for Spring)
     */
    restoreState(_data) {
        this._triggered = false;
        this._compression = 0;
        this._cooldown = 0;
        this._riders = [];
    }

    dispose() {
        this._base = null;
        this._platform = null;
        this._riders = [];
    }
}
