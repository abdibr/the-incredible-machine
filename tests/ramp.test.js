/**
 * Ramp surface material regression — follow-up to bug-20261023T174706Z-0oca
 * (the trampoline fabric fix).
 *
 * matter-js zeroes a static body's restitution and forces friction = 1 when
 * the body goes static, and the `isStatic: true` option flows through that
 * same Body.setStatic path inside Body.create — so the ramp's declared
 * friction 0.5 / restitution 0.1 in the body options were silently discarded
 * and the ramp entered the solver as restitution 0, friction 1. Unlike the
 * trampoline (whose 0.95 was load-bearing) the loss is inert for today's
 * population — pairs resolve at max(live restitutions) / min(live frictions),
 * and every ball variant (restitution ≥ 0.3, friction ≤ 0.5) dominates or
 * washes out the blend — but any future tuning of the ramp's surface would
 * silently do nothing. The constructor now re-asserts the declared material
 * after the implicit static flip, same pattern as Trampoline.js.
 */
import { describe, expect, it } from 'vitest';
import Ramp from '../js/objects/Ramp.js';
import { objectRegistry } from '../js/objects/ObjectRegistry.js';
import { registerAllObjects } from '../js/objects/registerAllObjects.js';
import { PhysicsEngine } from '../js/engine/PhysicsEngine.js';

registerAllObjects();

const DT = 1000 / 60;

describe('Ramp surface material (static-flip follow-up)', () => {
    it('keeps its declared friction 0.5 and restitution 0.1 after the static flip', () => {
        // Without the constructor re-assert, Body.create's implicit setStatic
        // leaves restitution 0 and friction 1 on the runtime body.
        const ramp = new Ramp(500, 300);
        const [body] = ramp.bodies;

        expect(body.isStatic).toBe(true);
        expect(body.restitution).toBe(0.1);
        expect(body.friction).toBe(0.5);
    });

    it('bounces a dead ball (restitution 0) — the ramp is the only bouncy side of the pair', () => {
        // Pair restitution = max(the two live restitutions). Every shipped
        // ball variant carries restitution ≥ 0.3, so none can exercise the
        // ramp's own 0.1 — a ball forced to restitution 0 can: with the fix
        // the pair is max(0.1, 0) = 0.1 and the drop rebounds at ~0.07x
        // impact speed; with the pre-fix zeroed material the pair is
        // max(0, 0) = 0 — a dead thud (probe-measured: rebound 0.0, rise
        // 0.0 px; calibration probe in .scratch/probe-ramp.mjs).
        const engine = new PhysicsEngine(1000, 600);
        const ramp = objectRegistry.create('ramp', 500, 300);
        const ball = objectRegistry.create('ball', 500, 140, { variant: 'bowling' });
        ball.bodies[0].restitution = 0; // dead ball: only the ramp can bounce it
        engine.addObject(ramp);
        engine.addObject(ball);

        // ~120 ticks covers the drop (impact lands around t≈30) plus the
        // short first rebound arc.
        const frames = [];
        for (let i = 0; i < 120; i++) {
            engine.step(DT);
            const body = ball.bodies[0];
            frames.push({ vy: body.velocity.y, y: body.position.y });
        }

        // First impact: last tick of downward motion before the first reversal.
        let impactTick = -1;
        for (let i = 1; i < frames.length; i++) {
            if (frames[i].vy <= 0 && frames[i - 1].vy > 0) {
                impactTick = i;
                break;
            }
        }
        expect(impactTick).toBeGreaterThan(0);

        // Max upward velocity after the impact. Measured with the fix:
        // impact vy 8.21 at t≈30 → rebound −0.57 vy (restitution-0.1 pair
        // bounce, ~0.9 px hop). The pre-fix zeroed material measured exactly 0.
        let reboundVy = 0;
        for (let i = impactTick + 1; i < frames.length; i++) {
            reboundVy = Math.min(reboundVy, frames[i].vy);
        }

        expect(reboundVy).toBeLessThan(-0.3);
    });
});