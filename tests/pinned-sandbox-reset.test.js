/**
 * Regression tests for the bugfile bug-20261025T193755Z - pinning a bucket as
 * a Sandbox goal broke editing after a play/reset cycle:
 *
 * - Bug A (the pin never reached the bodies): BaseObject.set 'isFixed' flipped
 *   only the flag; bodies are created once, reading isStatic at construction,
 *   so a part pinned after construction kept dynamic bodies - the pinned goal
 *   bucket fell during play while isFixed simultaneously barred every edit
 *   gate.
 * - Bug B (the reset kept disposed zombies on the board): the sandbox
 *   play/reset cycle disposed every object (physics clear) but kept fixed
 *   instances on the board; the surviving bucket had null bodies, so its
 *   draw() threw - which, through the then-unguarded renderer draw loop,
 *   dropped whole frames - and restoring the next play skipped fixed rows, so
 *   the pinned bucket vanished from the board entirely (addable, movable or
 *   re-pinnable by nobody).
 *
 * Harness mirrors reset.test.js: dynamic module imports per test, production
 * seams only (registry.create, beginPlay / resetSandboxBoard, PhysicsEngine).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Matter from 'matter-js';

const { Composite } = Matter;

// ── Helpers ──────────────────────────────────────────────────────────────────

/** All bodies in the world that are not boundary walls. */
function playBodies(physics) {
    return Composite.allBodies(physics.world).filter((b) => !/^wall-/.test(b.label ?? ''));
}

/** Minimal canvas-2D stub - every method no-ops, property sets are stored. */
function makeCtx() {
    const store = {};
    return new Proxy(store, {
        get: (target, key) => (key in target ? target[key] : () => {}),
        set: (target, key, value) => { target[key] = value; return true; },
    });
}

// Shared imports for every describe block below.
let levelReset;
let objectRegistry;
let PhysicsEngine;
let Renderer;
let eventBus;

beforeEach(async () => {
    const reg = await import('../js/objects/ObjectRegistry.js');
    const registerAllObjectsMod = await import('../js/objects/registerAllObjects.js');
    const physicsMod = await import('../js/engine/PhysicsEngine.js');
    const resetMod = await import('../js/reset/levelReset.js');
    const rendererMod = await import('../js/render/Renderer.js');
    const eventBusMod = await import('../js/EventBus.js');

    objectRegistry = reg.objectRegistry;
    PhysicsEngine = physicsMod.PhysicsEngine;
    levelReset = resetMod;
    Renderer = rendererMod.default;
    eventBus = eventBusMod.eventBus ?? eventBusMod.default;

    registerAllObjectsMod.registerAllObjects();

    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
});

afterEach(() => {
    vi.unstubAllGlobals();
});

// ── Bug A: pinning reaches the Matter bodies ─────────────────────────────

describe('Bug A - pinning a placed bucket flips its bodies static (and back)', () => {
    it('set isFixed(true) statics all four bodies; unpinning restores them welded', () => {
        const bucket = objectRegistry.create('bucket', 500, 300);
        try {
            expect(bucket.bodies.every((b) => b && !b.isStatic)).toBe(true);

            const material = () => bucket.bodies.map((b) => [b.isStatic, b.friction, b.restitution]);
            const born = material(); // walls/floor friction 0.3, sensor 0.1 (Matter default)

            bucket.isFixed = true;
            expect(bucket.bodies.every((b) => b.isStatic)).toBe(true);
            // The pin preserves each body's own pre-pin material: setStatic
            // parks friction 1 / restitution 0, the constructor path leaves
            // optioned values - a pinned part must play with the material it
            // was built with either way (born-fixed twin parity).
            expect(material().map(([, f, r]) => [f, r])).toEqual(born.map(([, f, r]) => [f, r]));

            bucket.isFixed = false;
            expect(bucket.bodies.every((b) => b && !b.isStatic)).toBe(true);
            expect(bucket._welds.length).toBeGreaterThan(0); // welds rebuilt
            expect(material().map(([, f, r]) => [f, r])).toEqual(born.map(([, f, r]) => [f, r]));
        } finally {
            bucket.dispose();
        }
    });

    it('a set isFixed that changes nothing touches nothing (idempotent)', () => {
        const bucket = objectRegistry.create('bucket', 500, 300);
        try {
            const before = bucket.bodies.map((b) => [b.isStatic, b.friction]);
            bucket.isFixed = false; // already false
            expect(bucket.bodies.map((b) => [b.isStatic, b.friction])).toEqual(before);
        } finally {
            bucket.dispose();
        }
    });

    it('a born-fixed bucket unpins into a welded dynamic container (Save-stamp round-trip)', () => {
        const fixed = objectRegistry.create('bucket', 500, 300, { isFixed: true });
        try {
            expect(fixed.bodies.every((b) => b.isStatic)).toBe(true);
            expect(fixed._welds.length).toBe(0); // no joints at birth

            fixed.isFixed = false;
            expect(fixed.bodies.every((b) => b && !b.isStatic)).toBe(true);
            expect(fixed._welds.length).toBeGreaterThan(0); // welded at current positions
        } finally {
            fixed.dispose();
        }
    });

    it('playing with a pinned goal bucket: its bodies sit static in the world and hold position', () => {
        const physics = new PhysicsEngine(800, 600);
        const bucket = objectRegistry.create('bucket', 500, 300);
        bucket.isFixed = true; // pin as the goal
        const ball = objectRegistry.create('ball', 500, 60);

        const snapshot = levelReset.beginPlay(physics, [bucket, ball]);
        expect(snapshot).toHaveLength(2);
        const floorStart = { x: bucket._floor.position.x, y: bucket._floor.position.y };

        for (let i = 0; i < 30; i++) physics.step(16.666);

        // The ball fell; not one body of the pinned bucket moved.
        expect(ball.bodies[0].isStatic).toBe(false);
        expect(ball.bodies[0].position.y).toBeGreaterThan(100);
        for (const body of bucket.bodies) expect(body.isStatic).toBe(true);
        expect(bucket._floor.position.x).toBe(floorStart.x);
        expect(bucket._floor.position.y).toBe(floorStart.y);

        expect(() => levelReset.resetSandboxBoard(physics, [bucket, ball], snapshot)).not.toThrow();
        expect(playBodies(physics)).toHaveLength(0); // cleared for the next edit
        bucket.dispose();
        ball.dispose();
    });
});

// ── Bug B: sandbox play/reset restores pinned parts ──────────────────────

describe('Bug B - sandbox play/reset keeps a pinned goal bucket on the board and editable', () => {
    it('reset rewinds the whole board - the pinned bucket comes back fresh and pinned', () => {
        const physics = new PhysicsEngine(800, 600);
        const ball = objectRegistry.create('ball', 500, 80);
        const bucket = objectRegistry.create('bucket', 700, 300);
        bucket.isFixed = true; // the player pinned the goal bucket
        const board = [ball, bucket];

        const snapshot = levelReset.beginPlay(physics, board);
        physics.step(16.666);
        physics.step(16.666); // …play happens; the goal may or may not be won …

        const restored = levelReset.resetSandboxBoard(physics, board, snapshot);

        // Whole board restored, in snapshot order, as fresh instances (the
        // play reset disposed everything, pinned parts included).
        expect(board).toHaveLength(2);
        expect(restored).toHaveLength(2);
        const ballOnBoard = board[0];
        const bucketOnBoard = board[1];
        expect(bucketOnBoard).not.toBe(bucket);

        // The pin survived: static bodies, welds parked, draw() works - the
        // exact call that used to throw on the disposed zombie.
        expect(bucketOnBoard.isFixed).toBe(true);
        expect(bucketOnBoard.bodies.every((b) => b && b.isStatic)).toBe(true);
        expect(bucketOnBoard._welds.length).toBe(0);
        expect(() => bucketOnBoard.draw(makeCtx())).not.toThrow();

        // And it is editable again: unpin - welded & dynamic - re-pin.
        const fresh = objectRegistry.create('bucket', 100, 100);
        bucketOnBoard.isFixed = false;
        expect(bucketOnBoard.bodies.every((b) => b && !b.isStatic)).toBe(true);
        expect(bucketOnBoard._welds.length).toBe(fresh._welds.length);
        bucketOnBoard.isFixed = true;
        expect(bucketOnBoard.bodies.every((b) => b.isStatic)).toBe(true);
        expect(bucketOnBoard._welds.length).toBe(0);
        fresh.dispose();

        // The ball is back at its edit position and movable.
        expect(ballOnBoard.x).toBe(500);
        expect(ballOnBoard.y).toBe(80);
        expect(ballOnBoard.bodies[0].isStatic).toBe(false);

        expect(playBodies(physics)).toHaveLength(0);

        bucket.dispose();
        ball.dispose();
    });
});

describe('Bug B - sandbox play/reset cycles stay repeatable and the seams stay honest', () => {
    it('play/reset cycles are repeatable with a pinned part on the board', () => {
        const physics = new PhysicsEngine(800, 600);
        const ball = objectRegistry.create('ball', 500, 80);
        const bucket = objectRegistry.create('bucket', 700, 300);
        bucket.isFixed = true;
        const board = [ball, bucket];

        const ownedBodyCount = () => board.reduce((n, o) => n + o.bodies.length, 0);
        const baseline = ownedBodyCount();

        for (let cycle = 0; cycle < 2; cycle++) {
            const snapshot = levelReset.beginPlay(physics, board);
            physics.step(16.666);
            const worldHeld = playBodies(physics).length;
            levelReset.resetSandboxBoard(physics, board, snapshot);

            // World drains to boundaries on reset, refills on play - never
            // grows, so neither disposed zombies nor leaked bodies pile up.
            expect(playBodies(physics)).toHaveLength(0);
            expect(worldHeld).toBe(ownedBodyCount());
            expect(board).toHaveLength(2);
            for (const obj of board) expect(() => obj.draw(makeCtx())).not.toThrow();
        }

        expect(ownedBodyCount()).toBe(baseline); // same shape every cycle
        bucket.dispose();
        ball.dispose();
    });

    it('restorePlacedFromSnapshot keeps skipping fixed rows by default (level-reload contract)', () => {
        const levelSnapshot = [
            { type: 'bucket', x: 600, y: 520, isFixed: true, options: {} },
            { type: 'ball', x: 120, y: 100, isFixed: false, options: {} },
        ];
        const placed = [];
        const restored = levelReset.restorePlacedFromSnapshot(placed, levelSnapshot, objectRegistry);

        expect(restored).toHaveLength(1); // the fixed bucket rebuilds from level JSON
        expect(placed).toHaveLength(1);
        expect(placed[0].type).toBe('ball');
    });

    it('restorePlacedFromSnapshot opts back INTO fixed rows for the sandbox rewind', () => {
        const levelSnapshot = [
            { type: 'bucket', x: 600, y: 520, isFixed: true, options: {} },
            { type: 'ball', x: 120, y: 100, isFixed: false, options: {} },
        ];
        const placed = [];
        const restored = levelReset.restorePlacedFromSnapshot(
            placed, levelSnapshot, objectRegistry, { includeFixed: true },
        );

        expect(restored).toHaveLength(2);
        expect(placed[0].type).toBe('bucket');
        expect(placed[0].isFixed).toBe(true);
        expect(placed[0].bodies.every((b) => b && b.isStatic)).toBe(true);
    });
});

// ── Renderer: a failing object draw cannot blank the frame ───────────────

describe('Renderer - one throwing object must not blank the whole frame', () => {
    afterEach(() => eventBus.clear()); // init() registers listeners

    it('render() survives a throwing object; later objects still draw; the error surfaces', () => {
        const ctx = makeCtx();
        const renderer = new Renderer();
        // init() caches this.ctx from the canvas - assigning the canvas field
        // directly leaves ctx null and render() dies on the background fill
        // (which is outside the per-object guard, by design).
        renderer.init({ width: 1000, height: 600, getContext: () => ctx });

        const thrower = objectRegistry.create('ball', 200, 200);
        thrower.draw = () => { throw new Error('boom'); };
        const good = objectRegistry.create('ball', 700, 200);
        let drew = 0;
        const realDraw = good.draw.bind(good);
        good.draw = (c) => { drew += 1; realDraw(c); };

        renderer.setObjects([thrower, good]);
        let errorSpy;
        try {
            // spy BEFORE render so the expected failure log is swallowed and
            // countable; assert BEFORE restore - mockRestore() clears the
            // recorded calls, so restoring first always reports 0 calls.
            errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            expect(() => renderer.render()).not.toThrow(); // frame survives
            expect(drew).toBe(1);                      // the healthy object still painted
            expect(errorSpy).toHaveBeenCalledTimes(1); // failure surfaced, not swallowed
            expect(String(errorSpy.mock.calls[0][0])).toContain('[Renderer] draw failed');
        } finally {
            errorSpy?.mockRestore();
        }
    });
});