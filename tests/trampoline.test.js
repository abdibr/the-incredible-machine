/**
 * Trampoline material regression — bug-20261023T174706Z-0oca.
 *
 * matter-js zeroes a static body's restitution and forces friction = 1 when
 * the body goes static, and the `isStatic: true` option flows through that
 * same Body.setStatic path inside Body.create — so the trampoline's declared
 * restitution 0.95 / friction 0.3 in the body options were silently
 * discarded and the fabric entered the solver with restitution 0. Since
 * Pair.update resolves a collision at max(the two live restitutions), the
 * trampoline bounced like whatever hit it: the recorded bowling ball (0.3)
 * rebounded at ~0.24x impact speed instead of ~0.9x. The constructor now
 * re-asserts the fabric material after the implicit static flip.
 */
import { describe, expect, it } from 'vitest';
import Trampoline from '../js/objects/Trampoline.js';
import { objectRegistry } from '../js/objects/ObjectRegistry.js';
import { registerAllObjects } from '../js/objects/registerAllObjects.js';
import { PhysicsEngine } from '../js/engine/PhysicsEngine.js';

registerAllObjects();

const DT = 1000 / 60;

describe('Trampoline fabric material (bug-20261023T174706Z-0oca)', () => {
    it('keeps its declared restitution 0.95 and friction 0.3 after the static flip', () => {
        // Without the constructor re-assert, Body.create's implicit setStatic
        // leaves restitution 0 and friction 1 on the runtime body.
        const trampoline = new Trampoline(500, 450);
        const [body] = trampoline.bodies;

        expect(body.isStatic).toBe(true);
        expect(body.restitution).toBe(0.95);
        expect(body.friction).toBe(0.3);
    });

    it('rebounds a bowling ball at ~0.9x impact speed (bug recording: ~0.24x)', () => {
        const engine = new PhysicsEngine(1000, 600);
        const trampoline = objectRegistry.create('trampoline', 500, 455);
        const ball = objectRegistry.create('ball', 505, 120, { variant: 'bowling' });
        engine.addObject(trampoline);
        engine.addObject(ball);

        // ~150 ticks covers the drop (impact lands around t≈45) plus the
        // full first rebound arc.
        const frames = [];
        for (let i = 0; i < 150; i++) {
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

        // Apex of the rebound flight (min y after impact). The ball sits at
        // y ≈ 432 at contact; at pair restitution 0.95 the fabric throws it
        // back up to y ≈ 185, while the zeroed-fabric bug topped out around
        // y ≈ 415 — a ~17px hop (the recorded "no bounce").
        let apexY = Infinity;
        for (let i = impactTick + 1; i < frames.length; i++) {
            apexY = Math.min(apexY, frames[i].y);
        }

        expect(apexY).toBeLessThan(300);
    });
});