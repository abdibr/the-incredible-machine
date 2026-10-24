/**
 * Pairwise conformance kit (C5) — one real-physics scenario for every ACTIVE
 * row of the interaction matrix (see js/interactions/rules.js), plus
 * coverage lint so the matrix, the object registry and this file can drift
 * no further:
 *
 *  - meta: the SCENARIO_ROW_IDS registry below covers every active row id
 *    exactly (missing rows and orphan scenarios both fail)
 *  - meta: every row's `test` string still exists in tests/interactions.test.js
 *  - lint: the object registry is exactly the expected type set and every
 *    reactive (non-silent) type participates in at least one active row
 *  - scenarios: each row must fire through the REAL engine — Matter gravity,
 *    collisionStart dispatch, eventBus consumers — not synthetic resolve()
 *    calls. Sole exception: gear ✕ gear — both gears are static bodies and
 *    Matter never generates static×static collision pairs, so the row is fed
 *    live by the gears' own per-step mesh discovery (Gear._updateMeshContacts
 *    makes the engine's single dispatch seam, the exact call its collision
 *    feed would make). Its scenarios prove that live feeder end-to-end and
 *    pin the radius-ratio drive exchange. Geometry matches the proven rigs
 *    from the object suites.
 *
 * Silent types (ball variants, ramp, conveyor, fan, domino, pulley, candle
 * wax…) intentionally have no scenario: the `silent-objects-null` doc-only
 * row records that they never act.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { PhysicsEngine } from '../js/engine/PhysicsEngine.js';
import { DEFAULT_INTERACTION_ROWS } from '../js/interactions/rules.js';
import { eventBus } from '../js/EventBus.js';
import { objectRegistry } from '../js/objects/ObjectRegistry.js';
import { registerAllObjects } from '../js/objects/registerAllObjects.js';

import Ball from '../js/objects/Ball.js';
import Balloon from '../js/objects/Balloon.js';
import Bucket from '../js/objects/Bucket.js';
import Candle from '../js/objects/Candle.js';
import Gear from '../js/objects/Gear.js';
import Mouse from '../js/objects/Mouse.js';
import Ramp from '../js/objects/Ramp.js';
import Rope from '../js/objects/Rope.js';
import Scissors from '../js/objects/Scissors.js';
import Spring from '../js/objects/Spring.js';
import Trampoline from '../js/objects/Trampoline.js';

const DT = 1000 / 60;

// Rows that exist purely as documentation ("this pair deliberately does
// nothing"). They get no physical scenario.
const DOC_ONLY_ROW_IDS = ['boundary-null', 'silent-objects-null'];

// The scenario registry under test: one entry per active matrix row.
const SCENARIO_ROW_IDS = [
    'rope-candle-flame',
    'free-rope-candle-flame',
    'rope-closed-scissors-blade',
    'free-rope-closed-scissors-blade',
    'balloon-scissors',
    'balloon-candle',
    'bucket-catch',
    'gear-gear',
    'scissors-snap',
    'mouse-reverse',
    'spring-trigger',
    'trampoline-stretch',
];
// The `silent-objects-null` doc-only row declares these base classes as never
// reacting. The registry expands them into these concrete types (Ball has the
// tennis/baseball variants). A new type must either join this list or be
// wired into at least one active row — see the lint test.
const SILENT_REGISTRY_TYPES = new Set([
    'ball', 'tennis-ball', 'baseball',
    'ramp', 'conveyor', 'fan', 'domino', 'pulley', 'candle',
]);

const EXPECTED_REGISTRY_TYPES = [
    'ball', 'tennis-ball', 'baseball',
    'ramp', 'conveyor', 'trampoline',
    'fan', 'spring', 'domino', 'gear', 'pulley',
    'balloon', 'bucket', 'candle', 'rope', 'free-rope', 'scissors', 'mouse',
];

const interactionsTestPath = fileURLToPath(
    new URL('./interactions.test.js', import.meta.url),
);

// ── Harness ─────────────────────────────────────────────────────────────

let engines = [];
const unsubscribers = [];

afterEach(() => {
    for (const off of unsubscribers.splice(0)) off();
    for (const engine of engines) engine.dispose();
    engines.length = 0;
});

function makeEngine(width = 800, height = 600) {
    const engine = new PhysicsEngine(width, height);
    engines.push(engine);
    return engine;
}

/**
 * Subscribe to a module-singleton bus event for one test only; the
 * subscription is dropped in afterEach so counters never bleed across suites.
 */
function trackEvent(name) {
    const events = [];
    unsubscribers.push(eventBus.on(name, (payload) => events.push(payload ?? null)));
    return events;
}

/** Step until `predicate` holds or the budget runs out, then assert success. */
function stepUntil(engine, predicate, maxSteps, label) {
    let done = false;
    for (let i = 0; i < maxSteps && !done; i += 1) {
        engine.step(DT);
        done = Boolean(predicate());
    }
    expect(done, `${label} within ${maxSteps} steps`).toBe(true);
    return done;
}

// ── Meta: matrix ↔ tests ↔ registry coherence ───────────────────────────

describe('pairwise conformance kit (C5) — matrix ↔ tests ↔ registry coherence', () => {
    registerAllObjects();

    it('scenario registry covers every active row id exactly — nothing more, nothing less', () => {
        const activeIds = DEFAULT_INTERACTION_ROWS
            .filter((row) => !DOC_ONLY_ROW_IDS.includes(row.id))
            .map((row) => row.id);
        expect([...SCENARIO_ROW_IDS].sort()).toEqual([...activeIds].sort());
    });

    it('doc-sync: every row (doc-only ones included) names a test that still exists in tests/interactions.test.js', () => {
        const suiteSource = readFileSync(interactionsTestPath, 'utf8');
        const drifted = DEFAULT_INTERACTION_ROWS
            .filter((row) => !suiteSource.includes(row.test))
            .map((row) => `${row.id}: "${row.test}"`);
        expect(drifted).toEqual([]);
    });

    it('lint: the registry is exactly the expected types, and every reactive type participates in an active row', () => {
        const registered = objectRegistry.getAll().map((entry) => entry.type).sort();
        expect(registered).toEqual([...EXPECTED_REGISTRY_TYPES].sort());

        const activeRows = DEFAULT_INTERACTION_ROWS
            .filter((row) => !DOC_ONLY_ROW_IDS.includes(row.id));
        const referencedBlob = JSON.stringify(activeRows);
        for (const type of EXPECTED_REGISTRY_TYPES.filter((t) => !SILENT_REGISTRY_TYPES.has(t))) {
            expect(referencedBlob, `reactive type "${type}" is not referenced by any active row`).toContain(`"${type}"`);
        }
    });
});

describe('pairwise conformance kit (C5) — one real-physics scenario per active row', () => {
    it('rope-candle-flame: touching the flame severs the rope and the tail drops', () => {
        const engine = makeEngine();
        const rope = new Rope(200, 40, { length: 60 });
        const candle = new Candle(200, 80);
        engine.addObject(rope);
        engine.addObject(candle);
        const severed = trackEvent('rope:severed');

        expect(rope.isSevered).toBe(false);
        stepUntil(engine, () => rope.isSevered, 20, 'rope severing');
        expect(severed.length).toBe(1);

        const tailY = rope.bodies[rope.bodies.length - 1].position.y;
        for (let i = 0; i < 45; i += 1) engine.step(DT);
        const tailNow = rope.bodies[rope.bodies.length - 1].position.y;
        expect(tailNow, 'severed tail must fall under gravity').toBeGreaterThan(tailY + 20);
    });

    it('rope-closed-scissors-blade: a ball snapping the scissors cuts the rope mid-span', () => {
        const engine = makeEngine();
        const rope = new Rope(400, 40, { length: 60 });
        const scissors = new Scissors(400, 55);
        const ball = new Ball(379, 28, { variant: 'tennis' });
        engine.addObject(rope);
        engine.addObject(scissors);
        engine.addObject(ball);

        const constraintCount = rope.constraints.length;
        expect(constraintCount, 'an intact rope holds its span by constraints').toBeGreaterThan(0);

        stepUntil(engine, () => scissors.isClosed, 90, 'scissors snap');
        stepUntil(engine, () => rope.isSevered, 90, 'rope cut');

        // sever() empties the constraint chain synchronously (Rope.sever →
        // rope:severed → the engine drops every rope constraint from the
        // world), so nothing of the rope remains constraint-held. The freed
        // pieces' landing geometry depends on what they collide with (the
        // closed blades sit inside the span here), so assert the chain
        // itself rather than a fall distance.
        expect(rope.constraints.length, 'severing must drop the constraint chain').toBe(0);
    });

    it('free-rope-candle-flame: the first tie births the chain and the flame cuts it', () => {
        const engine = makeEngine();
        // The bundle ties ONCE to the balloon knot — that first tie is the
        // chain's birth (issue #55): it hangs straight down from the knot
        // and, from spawn on, burns exactly like a laid rope.
        const rope = objectRegistry.create('free-rope', 200, 40, { length: 60 });
        const balloon = new Balloon(200, 10);
        const candle = new Candle(200, 80);
        engine.addObject(rope);
        engine.addObject(balloon);
        engine.addObject(candle);
        rope.attachEndpoint(0, balloon, 'knot');
        expect(rope.bodies.length, 'the first tie spawns the hanging chain').toBeGreaterThan(0);
        const severed = trackEvent('rope:severed');

        stepUntil(engine, () => rope.isSevered, 60, 'free-rope chain severing');
        expect(severed.length).toBe(1);
    });

    it('free-rope-closed-scissors-blade: a spawned chain across the blades is cut when the scissors snap', () => {
        const engine = makeEngine();
        // Mirror of the laid-rope scissors rig: the chain dangles from a
        // balloon knot above the open blades; the ball snapping the scissors
        // cuts the spawned chain mid-span.
        const rope = objectRegistry.create('free-rope', 400, 40, { length: 60 });
        const balloon = new Balloon(400, -10);
        const scissors = new Scissors(400, 55);
        const ball = new Ball(379, 28, { variant: 'tennis' });
        engine.addObject(rope);
        engine.addObject(balloon);
        engine.addObject(scissors);
        engine.addObject(ball);
        rope.attachEndpoint(0, balloon, 'knot');
        expect(rope.constraints.length, 'the spawned chain holds itself by constraints').toBeGreaterThan(0);

        stepUntil(engine, () => scissors.isClosed, 90, 'scissors snap');
        stepUntil(engine, () => rope.isSevered, 90, 'chain cut');
        expect(rope.constraints.length, 'severing must drop the constraint chain').toBe(0);
    });

    it('balloon-scissors: contact with an open blade pops the balloon once, body gone', () => {
        const engine = makeEngine();
        const scissors = new Scissors(400, 300);
        const balloon = new Balloon(414, 291);
        engine.addObject(scissors);
        engine.addObject(balloon);
        const popped = trackEvent('balloon:popped');

        expect(balloon.isPopped).toBe(false);
        stepUntil(engine, () => balloon.isPopped, 30, 'balloon pop');
        expect(popped.length, 'double blade overlap must not double-pop').toBe(1);
        expect(balloon.bodies).toEqual([]);
    });

    it('balloon-candle: any candle contact pops the balloon exactly once', () => {
        const engine = makeEngine();
        const candle = new Candle(400, 300);
        const balloon = new Balloon(400, 296);
        engine.addObject(candle);
        engine.addObject(balloon);
        const popped = trackEvent('balloon:popped');

        stepUntil(engine, () => balloon.isPopped, 30, 'balloon pop');
        // The wax rect and the flame sensor both overlap the balloon on the
        // same first update — the popped guard keeps it to a single pop.
        expect(popped.length).toBe(1);
    });

    it('bucket-catch: a dropped ball is caught exactly once and settles inside', () => {
        const engine = makeEngine();
        // The conformance scenario pins the bucket: a goal bucket in real
        // levels is fixed (bucket mobility itself is covered by
        // tests/bucket.test.js). The ball drops in through the mouth,
        // bounces once, and settles inside the sensor walls.
        const bucket = new Bucket(400, 325, { isFixed: true });
        const ball = new Ball(400, 250, { variant: 'tennis' });
        engine.addObject(bucket);
        engine.addObject(ball);
        const caught = trackEvent('bucket:caught');

        stepUntil(engine, () => {
            const { x, y } = ball.bodies[0].position;
            return y > 285 && y < 322 && Math.abs(x - 400) < 15
                && Math.abs(ball.bodies[0].velocity.y) < 0.5;
        }, 150, 'ball settling inside the bucket');
        expect(caught.length, 'sensor re-entries must not re-report the catch').toBe(1);
        expect(bucket.caughtCount).toBe(1);
    });

    it('gear-gear: touching gears counter-rotate — the receiver turns opposite its driver and stays steady', () => {
        const engine = makeEngine();
        const a = new Gear(400, 300);
        const b = new Gear(450, 300);
        engine.addObject(a);
        engine.addObject(b);
        let fired = 0;
        engine.interactions.define({
            id: 'test-gear-gear-spy',
            actor: { type: 'gear' },
            target: { type: 'gear' },
            handler: () => { fired += 1; },
        });

        expect(a.serialize().options.angularSpeed).toBe(0.03);
        expect(b.serialize().options.angularSpeed).toBe(0.03);

        // No scripted push: the gears discover each other mid-step through
        // their per-step mesh scan (Gear._updateMeshContacts) and dispatch
        // the row through the engine's single dispatch seam themselves.
        stepUntil(engine, () => fired >= 1, 30, 'live mesh dispatch');
        expect(a.serialize().options.angularSpeed).toBeCloseTo(0.03);
        expect(b.serialize().options.angularSpeed).toBeCloseTo(-0.03);

        for (let i = 0; i < 30; i += 1) engine.step(DT);
        // One dispatch per contact episode: the pin keeps the touching pair
        // from re-firing every step, and the counter-rotating speeds are steady.
        expect(fired).toBe(1);
        expect(a.serialize().options.angularSpeed).toBeCloseTo(0.03);
        expect(b.serialize().options.angularSpeed).toBeCloseTo(-0.03);
    });

    it('gear-gear: unequal radii exchange drive by the radius ratio (equal rim speeds)', () => {
        const engine = makeEngine();
        const small = new Gear(400, 300, { radius: 28 }); // ω = 0.03, added first → row actor
        const large = new Gear(470, 300, { radius: 56 }); // centre gap 70 → rims overlap 14px
        engine.addObject(small);
        engine.addObject(large);
        let fired = 0;
        engine.interactions.define({
            id: 'test-gear-gear-spy',
            actor: { type: 'gear' },
            target: { type: 'gear' },
            handler: () => { fired += 1; },
        });

        stepUntil(engine, () => fired >= 1, 30, 'live mesh dispatch');
        // Actor keeps its own spin; the counterpart adopts it scaled by the
        // crossed ratio, turning opposite it — equal rim speeds:
        // 0.03 * 28 = 0.015 * 56 px/step.
        expect(small.serialize().options.angularSpeed).toBeCloseTo(0.03);
        expect(large.serialize().options.angularSpeed).toBeCloseTo(-0.015);

        for (let i = 0; i < 30; i += 1) engine.step(DT);
        expect(fired).toBe(1);
        expect(small.serialize().options.angularSpeed).toBeCloseTo(0.03);
        expect(large.serialize().options.angularSpeed).toBeCloseTo(-0.015);
    });

    it('scissors-snap: a ball onto the handle snaps the scissors closed once', () => {
        const engine = makeEngine();
        const scissors = new Scissors(400, 300);
        const ball = new Ball(379, 273, { variant: 'tennis' });
        engine.addObject(scissors);
        engine.addObject(ball);

        expect(scissors.isClosed).toBe(false);
        stepUntil(engine, () => scissors.isClosed, 90, 'snap');
        for (let i = 0; i < 20; i += 1) engine.step(DT);
        expect(scissors.isClosed, 'the snap must persist').toBe(true);
    });

    it('mouse-reverse: walking into a vertical wall reverses the mouse for good', () => {
        const engine = makeEngine();
        const wall = new Ramp(595, 540, { width: 120, angle: Math.PI / 2 });
        const mouse = new Mouse(560, 594);
        engine.addObject(wall);
        engine.addObject(mouse);

        stepUntil(engine, () => mouse.serialize().options.direction === -1, 240, 'wall reversal');
        const xAtReversal = mouse.bodies[0].position.x;
        for (let i = 0; i < 30; i += 1) engine.step(DT);
        expect(mouse.serialize().options.direction).toBe(-1);
        expect(mouse.bodies[0].position.x, 'the mouse must walk away, not grind the wall')
            .toBeLessThan(xAtReversal - 10);
    });

    // mouse ✕ ball has no matrix row of its own: a head-on ball bump IS
    // mouse-reverse (isRelevantContact counts light obstacles as walls), and
    // the wall scenario above already exercises that row physically.

    it('spring-trigger: a dropped ball arms the spring, dwells, and is launched high', () => {
        const engine = makeEngine();
        const spring = new Spring(400, 500);
        const ball = new Ball(400, 466, { variant: 'tennis' });
        engine.addObject(spring);
        engine.addObject(ball);

        const startY = ball.bodies[0].position.y;
        let minVy = 0;
        let launchRise = 0;
        let dwell = 0;
        for (let i = 0; i < 90; i += 1) {
            engine.step(DT);
            const { x, y } = ball.bodies[0].position;
            minVy = Math.min(minVy, ball.bodies[0].velocity.y);
            launchRise = Math.max(launchRise, startY - y);
            if (y > 462 && y < 490 && Math.abs(x - 400) < 10) dwell += 1;
        }
        expect(dwell, 'the ball must rest on the plate before the launch beat').toBeGreaterThanOrEqual(8);
        expect(minVy, 'the launch impulse must far exceed the small drop bounces').toBeLessThanOrEqual(-10);
        expect(launchRise, 'the launch must carry the ball a substantial height').toBeGreaterThan(150);
    });

    it('trampoline-stretch: a bouncing ball stretches the fabric', () => {
        const engine = makeEngine();
        const trampoline = new Trampoline(400, 560);
        const ball = new Ball(400, 500, { variant: 'tennis' });
        engine.addObject(trampoline);
        engine.addObject(ball);

        let maxStretch = 0;
        let minVy = 0;
        let minY = ball.bodies[0].position.y;
        for (let i = 0; i < 60; i += 1) {
            engine.step(DT);
            maxStretch = Math.max(maxStretch, trampoline._stretch ?? 0);
            minVy = Math.min(minVy, ball.bodies[0].velocity.y);
            minY = Math.min(minY, ball.bodies[0].position.y);
        }
        expect(maxStretch, 'contact must trigger the stretch animation').toBeGreaterThanOrEqual(0.5);
        expect(minVy, 'rebound off the stretchy fabric must be strong').toBeLessThanOrEqual(-3.0);
        expect(minY, 'the rebound must be visible').toBeLessThan(525);
    });
});