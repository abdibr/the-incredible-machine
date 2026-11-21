/**
 * Unit tests for popped-balloon body removal (work plan §1.4 / issue #7).
 *
 * A popped balloon must leave zero physics bodies in the world immediately.
 * Leftover "ghost" bodies are invisible but keep colliding and acting on
 * other objects (buoyancy), breaking the puzzles that pop balloons.
 *
 * It also pins the balloon's board-draw string policy (issue #101, group spec
 * Implementation Decision 6): the balloon paints NO decorative string - tied
 * or untied - so the rope's own drawn tail is the only string in the game.
 */

import { describe, it, expect, afterEach } from 'vitest';
import Matter from 'matter-js';
import Balloon from '../js/objects/Balloon.js';
import Rope from '../js/objects/Rope.js';
import Ball from '../js/objects/Ball.js';
import Scissors from '../js/objects/Scissors.js';
import PhysicsEngine from '../js/engine/PhysicsEngine.js';
import { eventBus } from '../js/EventBus.js';

const { Composite } = Matter;

describe('Balloon pop - ghost body removal', () => {
    const engines = [];

    afterEach(() => {
        for (const engine of engines) engine.dispose();
        engines.length = 0;
    });

    function createEngine(options) {
        const engine = new PhysicsEngine(800, 600, options);
        engines.push(engine);
        return engine;
    }

    const balloonBodiesIn = (engine) =>
        Composite.allBodies(engine.world).filter((b) => b.label === 'balloon');

    it('removes its Matter body from the physics world synchronously on pop', () => {
        const engine = createEngine();
        const balloon = new Balloon(200, 200);
        engine.addObject(balloon);

        // Precondition: the balloon body is inside the physics world
        expect(balloonBodiesIn(engine)).toHaveLength(1);

        balloon.pop();

        // Immediately - before any physics step runs
        expect(balloonBodiesIn(engine)).toHaveLength(0);
    });

    it('a popped balloon no longer collides with objects placed where it popped', () => {
        const engine = createEngine();
        const balloon = new Balloon(200, 200);
        engine.addObject(balloon);

        // Observe Matter collisionStart directly (the `physics:collision`
        // event was pruned for having no production listener).
        const collisions = [];
        const onCollisionStart = (event) => collisions.push(event);
        Matter.Events.on(engine.engine, 'collisionStart', onCollisionStart);
        try {
            balloon.pop();

            // Drop a ball exactly onto the popped balloon's last position;
            // a remaining ghost body would fire collisionStart with it.
            const ball = new Ball(200, 200, { variant: 'tennis' });
            engine.addObject(ball);

            engine.step(16.666);
            engine.step(16.666);

            // Wall pairs are excluded from the assertion on purpose: the
            // question is only whether the balloon body survived the pop.
            const balloonCollisions = collisions.filter(
                (e) => e.pairs.some(
                    (pair) => pair.bodyA.label === 'balloon' || pair.bodyB.label === 'balloon'
                )
            );
            expect(balloonCollisions).toHaveLength(0);
        } finally {
            Matter.Events.off(engine.engine, 'collisionStart', onCollisionStart);
        }
    });

    it('keeps the popped balloon in the engine object list as an inert, bodyless shell', () => {
        const engine = createEngine();
        const balloon = new Balloon(200, 200);
        engine.addObject(balloon);

        balloon.pop();

        // The GameObject stays in _objects (snapshot/restore maps by index,
        // TODO §3.5), but contributes no bodies and takes no part in physics.
        expect(engine.getObjects().has(balloon)).toBe(true);
        expect(balloon.bodies).toHaveLength(0);
        expect(balloon.isPopped).toBe(true);
    });

    it('popping on scissors contact leaves zero balloon bodies in the world', () => {
        const engine = createEngine({ enableSleeping: false });
        const balloon = new Balloon(200, 200);
        engine.addObject(balloon);

        // Static scissors overlapping the balloon - collisionStart during
        // engine.step() dispatches Balloon.onCollision -> pop() mid-update.
        const scissors = new Scissors(200, 200);
        engine.addObject(scissors);

        engine.step(16.666);

        expect(balloon.isPopped).toBe(true);
        expect(balloonBodiesIn(engine)).toHaveLength(0);

        // And it never comes back on later steps
        engine.step(16.666);
        expect(balloonBodiesIn(engine)).toHaveLength(0);
    });

    it('floats upward at a gentle speed (regression: rocket buoyancy)', () => {
        const engine = createEngine({ enableSleeping: false });
        const balloon = new Balloon(400, 500);
        engine.addObject(balloon);
        const y0 = balloon.bodies[0].position.y;

        // One second of standard-tick steps (60 x 16.666ms)
        for (let i = 0; i < 60; i++) engine.step(16.666);

        const rise = y0 - balloon.bodies[0].position.y;

        // The old tuning (-0.0015) netted ~29x own weight and crossed the
        // 600px-tall world in a handful of ticks (~12,000 px/s); dead
        // buoyancy wouldn't move at all. The gentle float covers ~130 px
        // per second of simulation.
        expect(rise).toBeGreaterThan(50);
        expect(rise).toBeLessThan(250);
    });
});

describe('Balloon decorative string (issue #101) - the rope is the only string', () => {
    // No canvas in Node. balloon.draw is observed at the recorded-canvas seam
    // (the rope.test.js recording-ctx style). Spec test #5 pins the string
    // policy as a SNAPSHOT OF THE DRAWN PATH, never as a knot query: a knot
    // may be inbound from another rope's ref, which the balloon's own
    // attachment list does not carry, so the draw path must not consult
    // attachments at all (group spec Implementation Decision 6 - the
    // unconditional no-string policy).
    function makeRecordingCtx() {
        const calls = [];
        const ctx = {};
        for (const fn of [
            'save', 'restore', 'translate', 'beginPath', 'moveTo', 'lineTo',
            'quadraticCurveTo', 'arc', 'ellipse', 'closePath', 'fill', 'stroke',
        ]) {
            ctx[fn] = (...args) => { calls.push([fn, ...args]); };
        }
        ctx.calls = calls;
        return ctx;
    }

    // The drawn path is the ordered path-geometry ops; fill/style calls are
    // presentation, not the connection story under test.
    const GEOMETRY_OPS = new Set(['ellipse', 'moveTo', 'lineTo', 'quadraticCurveTo']);

    // Snapshot form: the op sequence must match exactly and each written
    // coordinate must match within 1e-9 (bit-equal where the same arithmetic
    // repeats on both sides).
    function expectDrawnPath(ctx, expected) {
        const path = ctx.calls.filter(([op]) => GEOMETRY_OPS.has(op));
        expect(path.map(([op]) => op), 'drawn-path op sequence')
            .toEqual(expected.map(([op]) => op));
        for (let i = 0; i < expected.length; i++) {
            const [, ...expArgs] = expected[i];
            const [, ...actArgs] = path[i];
            for (const [j, e] of expArgs.entries()) {
                expect(actArgs[j], `path op #${i} arg #${j}`).toBeCloseTo(e, 9);
            }
        }
    }

    // The expected drawn path for an unpopped balloon, built from PUBLIC
    // surfaces only - R from the public bounds, TIP from the public
    // attachment seam (the knot address the rope ties), the triangle shape
    // from the issue's own description of the geometry. An extra string
    // segment below the knot would add ops past the final lineTo.
    function expectedBalloonPath(balloon) {
        const R = balloon.bounds.width / 2;
        const TIP = balloon.attachmentPoints[0].offset.y; // r*1.2 + 4
        return [
            ['ellipse', 0, 0, R, R * 1.2, 0, 0, Math.PI * 2],      // body oval
            ['ellipse', -R * 0.3, -R * 0.4, R * 0.25, R * 0.35, -0.4, 0, Math.PI * 2], // shine
            ['ellipse', 0, 0, R, R * 1.2, 0, 0, Math.PI * 2],      // outline
            ['moveTo', -2, R * 1.2],                               // knot triangle base
            ['lineTo', 0, TIP],                                    // tip: the rope ties exactly here
            ['lineTo', 2, R * 1.2],
        ];
    }

    it('an untied balloon draws no decorative string - the drawn path ends at the knot triangle (accepted delta: no 25px tail)', () => {
        const balloon = new Balloon(300, 250);
        const ctx = makeRecordingCtx();
        balloon.draw(ctx);

        expectDrawnPath(ctx, expectedBalloonPath(balloon));

        balloon.dispose();
    });

    it('a tied balloon draws no decorative string either - the rope owns the connection story', () => {
        const balloon = new Balloon(100, 74.4); // knot lands at (100, 100), on the rope's anchor
        const rope = new Rope(100, 100);
        rope.attachEndpoint('anchor', balloon, 'knot');
        // Precondition read off the ROPE's own public roster (the rope holds
        // the ref) - the assertion under test stays the drawn path, never a
        // knot query on the balloon.
        expect(rope.getAttachmentRefs().map((r) => r.seat)).toEqual(['anchor']);

        const ctx = makeRecordingCtx();
        balloon.draw(ctx);

        expectDrawnPath(ctx, expectedBalloonPath(balloon));

        rope.dispose();
        balloon.dispose();
    });
});
