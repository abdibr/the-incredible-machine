/**
 * Per-row contract tests for the interaction matrix (js/interactions/rules.js).
 *
 * Every row ships with exactly one test here — the row's `test` field refers
 * to it. Objects are exercised through the matrix seam
 * `resolve(actor, target, pair)` with Matter-style pair fixtures; deeper
 * object behavior lives in the per-class test files.
 */
import { describe, it, expect } from 'vitest';
import Matter from 'matter-js';
import Rope from '../js/objects/Rope.js';
import Candle from '../js/objects/Candle.js';
import Balloon from '../js/objects/Balloon.js';
import Scissors from '../js/objects/Scissors.js';
import Bucket from '../js/objects/Bucket.js';
import Gear from '../js/objects/Gear.js';
import Mouse from '../js/objects/Mouse.js';
import Spring from '../js/objects/Spring.js';
import Trampoline from '../js/objects/Trampoline.js';
import Ball from '../js/objects/Ball.js';
import Ramp from '../js/objects/Ramp.js';
import Conveyor from '../js/objects/Conveyor.js';
import Fan from '../js/objects/Fan.js';
import Domino from '../js/objects/Domino.js';
import Pulley from '../js/objects/Pulley.js';
import PhysicsEngine from '../js/engine/PhysicsEngine.js';
import { InteractionMatrix } from '../js/interactions/InteractionMatrix.js';
import { DEFAULT_INTERACTION_ROWS } from '../js/interactions/rules.js';
import { renderInteractionDoc } from '../js/interactions/docs.js';
import { readFileSync } from 'node:fs';
import { eventBus } from '../js/EventBus.js';

const matrix = new InteractionMatrix(DEFAULT_INTERACTION_ROWS);

/** First rope segment body (non-static chain link). */
const ropeSegOf = (rope) => rope.bodies.find((b) => b.label?.startsWith('rope-seg'));
const bodyWithLabel = (obj, label) => obj.bodies.find((b) => b.label === label);

describe('Interaction matrix API', () => {
    it('validates rows: id and handler are required (docOnly rows excepted)', () => {
        const m = new InteractionMatrix();
        expect(() => m.define({})).toThrow();
        expect(() => m.define({ id: 'x' })).toThrow();
        expect(() => m.define({ id: 'x', actor: {}, target: {} })).toThrow();
        expect(() => m.define({ id: 'x', actor: {}, target: {}, docOnly: true })).not.toThrow();
    });

    it('an unordered row matches in both orientations and routes canonical (actor, target)', () => {
        const seen = [];
        const custom = new InteractionMatrix([
            {
                id: 'uni', summary: '', actor: { type: 'burner' }, target: { type: 'fuel' },
                handler: (actor, target) => seen.push([actor.type, target.type]),
            },
        ]);
        const burner = { type: 'burner' };
        const fuel = { type: 'fuel' };
        expect(custom.resolve(burner, fuel, { bodyA: {}, bodyB: {} })).toEqual(['uni']);
        expect(custom.resolve(fuel, burner, { bodyA: {}, bodyB: {} })).toEqual(['uni']);
        expect(seen).toEqual([['burner', 'fuel'], ['burner', 'fuel']]); // canonical order both times
    });

    it('fires every matching row in registration order', () => {
        const custom = new InteractionMatrix([
            { id: 'first', summary: '', actor: { type: 'a' }, target: {}, handler: () => {} },
            { id: 'second', summary: '', actor: { type: 'a' }, target: { type: 'b' }, handler: () => {} },
            { id: 'third', summary: '', actor: { type: 'b' }, target: { type: 'a' }, handler: () => {} },
        ]);
        expect(custom.resolve({ type: 'a' }, { type: 'b' }, { bodyA: {}, bodyB: {} }))
            .toEqual(['first', 'second', 'third']);
    });

    it('label matchers key on the collision pair body labels', () => {
        const custom = new InteractionMatrix([
            { id: 'lbl', summary: '', actor: {}, target: { label: 'torch-flame' }, handler: () => {} },
        ]);
        expect(custom.resolve({ type: 'x' }, { type: 'y' }, { bodyA: { label: 'torch-flame' }, bodyB: {} }))
            .toEqual(['lbl']);
        expect(custom.resolve({ type: 'x' }, { type: 'y' }, { bodyA: { label: 'wax' }, bodyB: {} }))
            .toEqual([]);
    });

    it('docOnly rows never dispatch', () => {
        expect(matrix.resolve({ type: 'boundary-wall' }, { type: 'ball' }, { bodyA: {}, bodyB: {} }))
            .toEqual([]);
    });
});

// (per-row tests continue below)

describe('Row rope-candle-flame', () => {
    it('rope ✕ candle-flame severs; rope ✕ candle wax does not', () => {
        const rope = new Rope(200, 40, { length: 60 });
        const candle = new Candle(200, 80);
        const seg = ropeSegOf(rope);
        const flame = bodyWithLabel(candle, 'candle-flame');
        expect(flame).toBeTruthy();

        const fired = matrix.resolve(rope, candle, { bodyA: flame, bodyB: seg });
        expect(fired).toContain('rope-candle-flame');
        expect(rope.isSevered).toBe(true);

        // BUG-FIX regression: the solid wax body alone must not sever the
        // rope (the pre-matrix code keyed on other.type === 'candle').
        const rope2 = new Rope(200, 40, { length: 60 });
        const wax = bodyWithLabel(candle, 'candle');
        expect(wax).toBeTruthy();
        expect(matrix.resolve(rope2, candle, { bodyA: wax, bodyB: ropeSegOf(rope2) })).toEqual([]);
        expect(rope2.isSevered).toBe(false);
    });
});

describe('Row rope-closed-scissors-blade', () => {
    it('rope ✕ closed-scissors blade severs; open blades and handles never cut', () => {
        const scissors = new Scissors(400, 300);
        const blade = bodyWithLabel(scissors, 'scissors-blade');
        const handle = bodyWithLabel(scissors, 'scissors-handle');

        // Open scissors never cut (rope resting between open blades)
        const openRope = new Rope(200, 40, { length: 60 });
        expect(matrix.resolve(openRope, scissors, { bodyA: blade, bodyB: ropeSegOf(openRope) })).toEqual([]);
        expect(matrix.resolve(openRope, scissors, { bodyA: handle, bodyB: ropeSegOf(openRope) })).toEqual([]);
        expect(openRope.isSevered).toBe(false);

        // Snap them shut (row scissors-snap: dynamic weight on a handle)
        matrix.resolve(scissors, { type: 'ball' }, { bodyA: handle, bodyB: { isStatic: false } });
        expect(scissors.isClosed).toBe(true);

        const rope = new Rope(200, 40, { length: 60 });
        const fired = matrix.resolve(rope, scissors, { bodyA: blade, bodyB: ropeSegOf(rope) });
        expect(fired).toContain('rope-closed-scissors-blade');
        expect(rope.isSevered).toBe(true);
    });
});

describe('Rows balloon-scissors / balloon-candle', () => {
    it('balloon ✕ scissors pops (any body)', () => {
        const balloon = new Balloon(200, 200);
        const scissors = new Scissors(400, 300);
        const fired = matrix.resolve(
            balloon, scissors,
            { bodyA: balloon.bodies[0], bodyB: bodyWithLabel(scissors, 'scissors-handle') }
        );
        expect(fired).toContain('balloon-scissors');
        expect(balloon.isPopped).toBe(true);
    });

    it('balloon ✕ candle pops (wax or flame)', () => {
        const balloon = new Balloon(200, 200);
        const candle = new Candle(200, 400);
        const wax = bodyWithLabel(candle, 'candle');
        const fired = matrix.resolve(balloon, candle, { bodyA: balloon.bodies[0], bodyB: wax });
        expect(fired).toContain('balloon-candle');
        expect(balloon.isPopped).toBe(true);
    });

    it('balloon ✕ anything else does not pop', () => {
        const balloon = new Balloon(200, 200);
        expect(matrix.resolve(balloon, { type: 'ball' }, { bodyA: balloon.bodies[0], bodyB: {} }))
            .toEqual([]);
        expect(balloon.isPopped).toBe(false);
    });
});

// (bucket/gear/scissors rows continue below)

describe('Row bucket-catch', () => {
    it('bucket ✕ matching object via sensor emits bucket:caught once per object', () => {
        const caught = [];
        const handler = (payload) => caught.push(payload);
        eventBus.on('bucket:caught', handler);
        try {
            const bucket = new Bucket(400, 300, { catchType: 'ball' });
            const ball = new Ball(400, 320, { variant: 'tennis' });
            const sensor = bodyWithLabel(bucket, 'bucket-sensor');

            const fired = matrix.resolve(bucket, ball, { bodyA: sensor, bodyB: ball.bodies[0] });
            expect(fired).toContain('bucket-catch');
            expect(caught).toHaveLength(1);
            expect(caught[0].bucket).toBe(bucket);
            expect(caught[0].object).toBe(ball);
            expect(caught[0].totalCaught).toBe(1);

            // Same ball again: deduped by object id
            matrix.resolve(bucket, ball, { bodyA: sensor, bodyB: ball.bodies[0] });
            expect(caught).toHaveLength(1);
        } finally {
            eventBus.off('bucket:caught', handler);
        }
    });

    it('bucket does not catch on non-sensor contacts or a mismatched catchType', () => {
        const caught = [];
        const handler = (payload) => caught.push(payload);
        eventBus.on('bucket:caught', handler);
        try {
            const bucket = new Bucket(400, 300, { catchType: 'ball' });
            const floor = bodyWithLabel(bucket, 'bucket-floor');
            const otherMouse = new Mouse(700, 594); // real object: predicates can be evaluated on both orientations

            expect(matrix.resolve(bucket, otherMouse, { bodyA: floor, bodyB: {} })).toEqual([]);
            expect(matrix.resolve(bucket, otherMouse, { bodyA: bodyWithLabel(bucket, 'bucket-sensor'), bodyB: {} }))
                .toEqual([]);
            expect(caught).toHaveLength(0);
        } finally {
            eventBus.off('bucket:caught', handler);
        }
    });
});

describe('Row gear-gear', () => {
    it('gear ✕ gear meshes mutually through the public mesh seam', () => {
        const a = new Gear(400, 300);
        const b = new Gear(450, 300);
        const fired = matrix.resolve(a, b, { bodyA: a.bodies[0], bodyB: b.bodies[0] });
        expect(fired).toContain('gear-gear');

        // Same outcome as the old mutual double-dispatch: both gears
        // counter-rotate at their own speed magnitude.
        expect(a.serialize().options.angularSpeed).toBeCloseTo(-0.03, 10);
        expect(b.serialize().options.angularSpeed).toBeCloseTo(-0.03, 10);

        // Asymmetric speeds: d (−0.02) is driven to +0.03 by c, then drives
        // c to −0.03 — exactly the pre-matrix call order.
        const c = new Gear(450, 300, { angularSpeed: 0.03 });
        const d = new Gear(500, 300, { angularSpeed: -0.02 });
        matrix.resolve(c, d, { bodyA: c.bodies[0], bodyB: d.bodies[0] });
        expect(c.serialize().options.angularSpeed).toBeCloseTo(-0.03, 10);
        expect(d.serialize().options.angularSpeed).toBeCloseTo(0.03, 10);
    });

    it('the mesh seam is public state, not a reach-through', () => {
        const g = new Gear(400, 300, { angularSpeed: 0.05 });
        g.applyGearDrive(-0.02); // receiving a drive reverses sign, adopts magnitude
        expect(g.serialize().options.angularSpeed).toBeCloseTo(-0.02, 10);
    });
});

describe('Row scissors-snap', () => {
    it('scissors ✕ dynamic weight on handle snaps; rope/static/blade contacts never do', () => {
        const scissors = new Scissors(400, 300);
        const handle = bodyWithLabel(scissors, 'scissors-handle');
        const blade = bodyWithLabel(scissors, 'scissors-blade');

        expect(matrix.resolve(scissors, { type: 'rope' }, { bodyA: handle, bodyB: { isStatic: false } }))
            .toEqual([]);
        expect(matrix.resolve(scissors, { type: 'ramp' }, { bodyA: handle, bodyB: { isStatic: true } }))
            .toEqual([]);
        expect(matrix.resolve(scissors, { type: 'ball' }, { bodyA: blade, bodyB: { isStatic: false } }))
            .toEqual([]);
        expect(scissors.isClosed).toBe(false);

        const fired = matrix.resolve(scissors, { type: 'ball' }, { bodyA: handle, bodyB: { isStatic: false } });
        expect(fired).toContain('scissors-snap');
        expect(scissors.isClosed).toBe(true);

        // One-shot: already shut — no more snapping
        expect(matrix.resolve(scissors, { type: 'ball' }, { bodyA: handle, bodyB: { isStatic: false } }))
            .toEqual([]);
    });
});

// (mouse/spring/trampoline rows continue below)

describe('Row mouse-reverse', () => {
    it('mouse ✕ head-on contact reverses once within the debounce window', () => {
        const mouse = new Mouse(400, 594, { direction: 1 });
        Matter.Body.setVelocity(mouse.bodies[0], { x: 1.2, y: 0 }); // armed walking drive

        // Obstacle ahead on the right; normal points from the mouse body toward it
        const pair = {
            bodyA: mouse.bodies[0],
            bodyB: { position: { x: mouse.bodies[0].position.x + 10, y: mouse.bodies[0].position.y }, velocity: { x: 0, y: 0 } },
            normal: { x: 1, y: 0 },
        };
        const fired = matrix.resolve(mouse, { type: 'ramp' }, pair);
        expect(fired).toContain('mouse-reverse');
        expect(mouse.serialize().options.direction).toBe(-1);

        // Debounced: an immediate follow-up contact must not flip again
        matrix.resolve(mouse, { type: 'ramp' }, pair);
        expect(mouse.serialize().options.direction).toBe(-1);
    });

    it('mouse ✕ other mouse and ground-level contacts never reverse', () => {
        const walker = new Mouse(400, 594, { direction: 1 });
        Matter.Body.setVelocity(walker.bodies[0], { x: 1.2, y: 0 });
        const other = new Mouse(410, 594, { direction: -1 });

        expect(matrix.resolve(walker, other, {
            bodyA: walker.bodies[0],
            bodyB: other.bodies[0],
            normal: { x: 1, y: 0 },
        })).toEqual([]);

        // Contact from directly above/below: not front-facing, never head-on
        expect(matrix.resolve(walker, { type: 'ramp' }, {
            bodyA: walker.bodies[0],
            bodyB: { position: { x: walker.bodies[0].position.x, y: walker.bodies[0].position.y + 10 }, velocity: { x: 0, y: 0 } },
            normal: { x: 0, y: 1 },
        })).toEqual([]);
    });
});

describe('Row spring-trigger', () => {
    it('spring ✕ platform contact triggers; cooldown suppresses retriggers', () => {
        const spring = new Spring(400, 300);
        const platform = bodyWithLabel(spring, 'spring-platform');

        const pair = { bodyA: platform, bodyB: { isStatic: false } };
        expect(matrix.resolve(spring, { type: 'ball' }, pair)).toContain('spring-trigger');
        expect(matrix.resolve(spring, { type: 'ball' }, pair)).toEqual([]); // armed, no refire
        expect(spring.isLaunchTrigger({ type: 'ball' }, pair)).toBe(false);

        // Non-platform body contacts never trigger
        const base = bodyWithLabel(spring, 'spring-base');
        expect(matrix.resolve(spring, { type: 'ball' }, { bodyA: base, bodyB: { isStatic: false } })).toEqual([]);
    });

    it('after launch + cooldown the spring re-arms (full cycle via onBeforeUpdate)', () => {
        const spring = new Spring(400, 300);
        const platform = bodyWithLabel(spring, 'spring-platform');
        matrix.resolve(spring, { type: 'ball' }, { bodyA: platform, bodyB: { isStatic: false } });

        // The launch discovers riders through the engine seam (ADR 0002), so the
        // full cycle needs a real PhysicsEngine; no rider contact is required —
        // the state machine under test runs identically on an empty world.
        const engine = new PhysicsEngine(800, 600);
        try {
            engine.addObject(spring);
            // ~13 frames complete the 0.08/step compression release → 30-frame cooldown
            for (let i = 0; i < 14; i++) spring.onBeforeUpdate(engine);
            expect(spring.isLaunchTrigger({ type: 'ball' }, { bodyA: platform, bodyB: { isStatic: false } })).toBe(false);

            for (let i = 0; i < 30; i++) spring.onBeforeUpdate(engine);
            expect(spring.isLaunchTrigger({ type: 'ball' }, { bodyA: platform, bodyB: { isStatic: false } })).toBe(true);
        } finally {
            engine.dispose();
        }
    });
});

describe('Row trampoline-stretch', () => {
    it('trampoline ✕ any contact stretches; unrelated pairs fire nothing', () => {
        const trampoline = new Trampoline(400, 500);
        const fired = matrix.resolve(trampoline, { type: 'ball' }, { bodyA: trampoline.bodies[0], bodyB: {} });
        expect(fired).toEqual(['trampoline-stretch']);
        expect(trampoline._stretch).toBe(1); // the row's declared effect

        // Decay runs from onBeforeUpdate like any animation state
        trampoline.onBeforeUpdate({});
        expect(trampoline._stretch).toBeLessThan(1);

        // Silent pair: two balls collide — no row fires
        const a = new Ball(400, 300, { variant: 'tennis' });
        const b = new Ball(500, 300, { variant: 'baseball' });
        expect(matrix.resolve(a, b, { bodyA: a.bodies[0], bodyB: b.bodies[0] })).toEqual([]);
    });
});

describe('Boundary integration', () => {
    it('PhysicsEngine routes collisionStart through the matrix (end-to-end)', () => {
        const engine = new PhysicsEngine(800, 600);
        try {
            const rope = new Rope(200, 40, { length: 60 });
            const candle = new Candle(200, 80);
            engine.addObject(rope);
            engine.addObject(candle);
            expect(rope.isSevered).toBe(false);
            engine.step(1000 / 60);
            // engine maps pair bodies → objects → matrix.resolve → rope-candle-flame → sever
            expect(rope.isSevered).toBe(true);
        } finally {
            engine.dispose();
        }
    });
});

describe('Row boundary-null', () => {
    it('boundary walls are null participants', () => {
        // The docOnly row itself can never dispatch...
        expect(matrix.resolve({ type: 'boundary-wall' }, { type: 'ball' }, { bodyA: {}, bodyB: {} }))
            .toEqual([]);

        // ...and the real guarantee is stronger still: walls are not mapped to
        // objects, so a wall collisionStart pair never reaches resolve() at all
        // (PhysicsEngine skips dispatch when an owner lookup returns null). A
        // wildcard spy row must stay silent while a ball actually hits the floor.
        const engine = new PhysicsEngine(800, 600);
        try {
            const fired = [];
            engine.interactions.define({
                id: 'spy-any-pair', summary: '', actor: {}, target: {},
                handler: () => fired.push(true),
            });

            let wallPairs = 0;
            const onCollisionStart = (event) => {
                for (const pair of event.pairs) {
                    if (pair.bodyA.label?.startsWith('wall-') || pair.bodyB.label?.startsWith('wall-')) {
                        wallPairs++;
                    }
                }
            };
            Matter.Events.on(engine.engine, 'collisionStart', onCollisionStart);

            try {
                const ball = new Ball(400, 560, { variant: 'bowling' });
                engine.addObject(ball);
                for (let i = 0; i < 30 && wallPairs === 0; i++) engine.step(1000 / 60);

                // Positive control: the ball really did contact a boundary wall...
                expect(wallPairs).toBeGreaterThan(0);
                // ...and not one row fired for those wall pairs.
                expect(fired).toEqual([]);
            } finally {
                Matter.Events.off(engine.engine, 'collisionStart', onCollisionStart);
            }
        } finally {
            engine.dispose();
        }
    });
});

describe('Row silent-objects-null', () => {
    it('silent classes have no reaction rows', () => {
        const silent = [
            new Ball(100, 100, { variant: 'tennis' }),
            new Ramp(200, 100),
            new Conveyor(300, 100),
            new Fan(400, 100),
            new Domino(500, 100),
            new Pulley(600, 100),
            new Candle(700, 100),
        ];
        for (const obj of silent) {
            // Either orientation, any counterpart: no row ever fires for them.
            expect(matrix.resolve(obj, { type: 'unrelated' }, { bodyA: obj.bodies[0], bodyB: {} }))
                .toEqual([]);
            expect(matrix.resolve({ type: 'unrelated' }, obj, { bodyA: {}, bodyB: obj.bodies[0] }))
                .toEqual([]);
        }
    });
});

describe('docs/interactions.md sync', () => {
    it('the generated doc matches the current table', () => {
        const onDisk = readFileSync(new URL('../docs/interactions.md', import.meta.url), 'utf8');
        expect(onDisk).toBe(renderInteractionDoc(DEFAULT_INTERACTION_ROWS));
    });
});