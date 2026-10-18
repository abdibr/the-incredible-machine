/**
 * Unit tests for popped-balloon body removal (work plan §1.4 / issue #7).
 *
 * A popped balloon must leave zero physics bodies in the world immediately.
 * Leftover "ghost" bodies are invisible but keep colliding and acting on
 * other objects (buoyancy), breaking the puzzles that pop balloons.
 */

import { describe, it, expect, afterEach } from 'vitest';
import Matter from 'matter-js';
import Balloon from '../js/objects/Balloon.js';
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
});