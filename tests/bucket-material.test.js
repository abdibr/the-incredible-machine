/**
 * Bucket material regression — gh issue #72. Follow-up of the trampoline
 * (bug-20261023T174706Z-0oca) and ramp static-flip fixes: matter-js zeroes a
 * static body's restitution and forces friction = 1 when the body goes
 * static — and buckets are born fixed from options, the Body.create route.
 * Common.extend merges `isStatic: true` onto the body *before* Body.set
 * hands it to Body.setStatic, whose `_original` stash is guarded by
 * `if (!part.isStatic)` — a born-static part keeps no stash to restore from,
 * so its declared friction 0.3 is silently discarded and the walls/floor
 * enter the solver parked at friction 1. Pair friction resolves at
 * min(the two live frictions), so a friction-0.5 tennis ball resting in the
 * goal bucket skidded at 0.5 instead of stopping at 0.3; and the runtime pin
 * seam (BaseObject's isFixed setter re-applying a late flip's stash) meant a
 * pinned bucket played 0.3 while a born-fixed one played 1. The constructor
 * now re-asserts the declared wall/floor material after body creation, same
 * pattern as Trampoline.js / Ramp.js.
 */
import { describe, expect, it } from 'vitest';
import Bucket from '../js/objects/Bucket.js';
import { objectRegistry } from '../js/objects/ObjectRegistry.js';
import { registerAllObjects } from '../js/objects/registerAllObjects.js';
import { PhysicsEngine } from '../js/engine/PhysicsEngine.js';

registerAllObjects();

const DT = 1000 / 60;

/** Frictions of the material surfaces — matched by body label (the
 * GLOSSARY's discriminator), not by position: [left wall, right wall, floor]. */
const materialFrictions = (bucket) => bucket.bodies
    .filter((b) => b.label === 'bucket-wall' || b.label === 'bucket-floor')
    .map((b) => b.friction);

describe('Bucket wall/floor material (gh issue #72)', () => {
    it('keeps its declared friction 0.3 when born fixed (the level-JSON / sandbox-pinned seam)', () => {
        // Without the constructor re-assert, the implicit setStatic parks
        // the walls/floor at friction 1 — there is no _original stash to
        // restore from for a body that was never dynamic.
        const bucket = new Bucket(500, 430, { isFixed: true });
        for (const body of bucket.bodies.slice(0, 3)) {
            expect(body.isStatic).toBe(true);
        }
        expect(materialFrictions(bucket)).toEqual([0.3, 0.3, 0.3]);
    });

    it('plays a pinned and a born-fixed bucket alike (the two "fixed" flavors agree)', () => {
        const born = new Bucket(400, 330, { isFixed: true });
        const pinned = new Bucket(700, 330);
        pinned.isFixed = true;

        // A movable bucket keeps its declared 0.3 on the dynamic bodies too —
        // the re-assert must be a no-op there for both flavors to hold.
        const loose = new Bucket(900, 330);
        expect(materialFrictions(loose)).toEqual([0.3, 0.3, 0.3]);

        expect(materialFrictions(pinned)).toEqual(materialFrictions(born));
    });

    it('stops a friction-0.5 tennis ball at the declared 0.3, not at the visitor\u2019s', () => {
        // Pair friction = min(the two live frictions) every tick. Pre-fix the
        // parked walls met the 0.5 ball at min(1, 0.5) = 0.5 — the bucket can
        // never be the slippier side of its own pair.
        const engine = new PhysicsEngine(1000, 600);
        const bucket = objectRegistry.create('bucket', 500, 430, { isFixed: true });
        const ball = objectRegistry.create('ball', 500, 180, { variant: 'tennis' }); // friction 0.5
        engine.addObject(bucket);
        engine.addObject(ball);

        // The catch sensor is no material surface — match the physical
        // walls/floor by label, never the sensor pair.
        const surfaces = new Set(bucket.bodies.filter(
            (b) => b.label === 'bucket-wall' || b.label === 'bucket-floor'));
        let pair = null;
        for (let i = 0; i < 120 && !pair; i++) {
            engine.step(DT);
            const ballBody = ball.bodies[0];
            pair = engine.engine.pairs.list.find((p) =>
                p.isActive &&
                ((p.bodyA === ballBody && surfaces.has(p.bodyB)) ||
                    (p.bodyB === ballBody && surfaces.has(p.bodyA))));
        }

        expect(pair).toBeTruthy();
        expect(pair.friction).toBe(0.3);
    });
});