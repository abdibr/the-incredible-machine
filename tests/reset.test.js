/**
 * Unit tests for the reset path (issue #8 — Reset preserves the player's machine):
 *
 * - Level modes: reset restores player-placed objects from the placed-parts
 *   snapshot at their edit positions; physics bodies are re-added on next play.
 * - Sandbox: reset rewinds to the start of the last play (decided semantic),
 *   and never destroys a sandbox that was never played.
 * - Play/reset cycles are repeatable: the body count returns to the baseline
 *   after every reset (no leaked bodies left in the physics world).
 *
 * Test harness mirrors main.js orchestration:
 *   play  = controls:play    → levelReset.beginPlay(physics, placed)
 *   reset = controls:reset   → gameLoop.reset() then _resetLevel()
 *                              → levelReset.restorePlacedFromSnapshot / resetSandboxBoard
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Matter from 'matter-js';

const { Composite } = Matter;

// ── Helpers ───────────────────────────────────────────────────────

/** All bodies in the world that are not boundary walls. */
function playBodies(physics) {
    return Composite.allBodies(physics.world).filter((b) => !/^wall-/.test(b.label ?? ''));
}

/** Bodies owned by the board objects (independent expectation source). */
function ownedBodyCount(placedObjects) {
    return placedObjects.reduce((n, o) => n + o.bodies.length, 0);
}

/** Fixed-object build — mirrors main.js _setupLevel()'s fixed loop. */
function buildFixedObjects(levelData, registry) {
    const fixed = [];
    for (const objData of levelData.fixedObjects) {
        const obj = registry.create(objData.type, objData.x, objData.y, {
            angle: objData.angle || 0,
            isFixed: true,
            customId: objData.id, // named id from level JSON (goal zone refs)
        });
        fixed.push(obj);
    }
    return fixed;
}

// Level board used by the level-mode tests: 2 fixed + 2 player-placed parts.
const LEVEL_DATA = {
    id: 'test-level',
    fixedObjects: [
        { type: 'bucket', id: 'bucket-goal', x: 600, y: 520 },
        { type: 'ramp', x: 260, y: 420, angle: -0.2 },
    ],
};

// Shared imports for every describe block below.
let levelReset;
let objectRegistry;
let PhysicsEngine;
let GameLoop;

beforeEach(async () => {
    const reg = await import('../js/objects/ObjectRegistry.js');
    const registerAllObjectsMod = await import('../js/objects/registerAllObjects.js');
    const physicsMod = await import('../js/engine/PhysicsEngine.js');
    const loopMod = await import('../js/engine/GameLoop.js');
    const resetMod = await import('../js/reset/levelReset.js');

    objectRegistry = reg.objectRegistry;
    levelReset = resetMod;
    PhysicsEngine = physicsMod.PhysicsEngine;
    GameLoop = loopMod.GameLoop;

    registerAllObjectsMod.registerAllObjects();

    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
});

afterEach(() => {
    vi.unstubAllGlobals();
});

// ── restorePlacedFromSnapshot ─────────────────────────────────────

// ── buildFixedObjects (customId seam) ─────────────────────────────

describe('levelReset.buildFixedObjects', () => {
    it('passes named ids through the production registry.create seam (no dead _goalId)', () => {
        const physics = new PhysicsEngine(800, 600);
        const placed = buildFixedObjects(LEVEL_DATA, objectRegistry);

        // Production parity with main.js _setupLevel: fixed level objects
        // are built with registry.create(..., { customId: objData.id })
        // because GoalChecker matches bucket.customId against goal.zoneId.
        expect(placed[0].customId).toBe('bucket-goal');
        // The dead hand-set property is gone.
        expect('_goalId' in placed[0]).toBe(false);
        // Unnamed level objects stay unnamed (no phantom ids).
        expect(placed[1].customId).toBeNull();

        physics.dispose();
    });
});

describe('levelReset.restorePlacedFromSnapshot', () => {
    it('restores player-placed objects at their edit positions after play', () => {
        const physics = new PhysicsEngine(800, 600);
        const placed = [];

        // Level setup: fixed objects from level data…
        placed.push(...buildFixedObjects(LEVEL_DATA, objectRegistry));
        // …plus player-placed parts.
        const ball = objectRegistry.create('ball', 120, 100);
        const tennis = objectRegistry.create('tennis-ball', 220, 80);
        placed.push(ball, tennis);

        // ── Play (controls:play EDITING branch) — objects enter the world ──
        const savedPlacedSnapshot = levelReset.beginPlay(physics, placed);
        expect(savedPlacedSnapshot).toHaveLength(4);

        // Drift during play — the live objects are no longer at edit positions.
        Matter.Body.setPosition(ball.bodies[0], { x: 500, y: 300 });
        Matter.Body.setPosition(tennis.bodies[0], { x: 500, y: 200 });

        // ── Reset (controls:reset → gameLoop.reset() + _resetLevel()) ──
        physics.restoreSnapshot();
        physics.clearSnapshot();

        const snapshot = [...savedPlacedSnapshot]; // captured before _setupLevel wipes it
        physics.clear(); // _setupLevel
        placed.length = 0;
        placed.push(...buildFixedObjects(LEVEL_DATA, objectRegistry));
        const restoredParts = levelReset.restorePlacedFromSnapshot(placed, snapshot, objectRegistry);

        // Machine intact: 2 fixed + 2 player parts, at edit positions.
        expect(restoredParts).toHaveLength(2);
        expect(placed).toHaveLength(4);

        const [restoredBall, restoredTennis] = restoredParts;
        expect(restoredBall).not.toBe(ball); // fresh instances — old ones were disposed
        expect(restoredBall.type).toBe('ball');
        expect(restoredBall.x).toBe(120);
        expect(restoredBall.y).toBe(100);
        expect(restoredBall.bodies[0].position.x).toBe(120);
        expect(restoredTennis.x).toBe(220);
        expect(restoredTennis.bodies[0].position.y).toBe(80);

        // Bodies re-added only on next play — world holds nothing but boundaries.
        expect(playBodies(physics)).toHaveLength(0);

        physics.dispose();
    });

    it('skips fixed entries — fixed objects come from level data, not the snapshot', () => {
        const snapshot = [
            { type: 'bucket', x: 600, y: 520, angle: 0, isFixed: true, options: {} },
            { type: 'ball', x: 99, y: 66, angle: 0.25, isFixed: false, options: {} },
        ];
        const placed = [];

        const restored = levelReset.restorePlacedFromSnapshot(placed, snapshot, objectRegistry);

        expect(restored).toHaveLength(1);
        expect(placed).toHaveLength(1);
        expect(placed[0].isFixed).toBe(false);
        expect(placed[0].x).toBe(99);

        expect(placed[0].angle).toBeCloseTo(0.25);
    });

    it('keeps variants through the registry round-trip', () => {
        const tennis = objectRegistry.create('tennis-ball', 10, 20);
        const placed = [];

        const restored = levelReset.restorePlacedFromSnapshot(placed, [tennis.serialize()], objectRegistry);

        expect(restored).toHaveLength(1);
        expect(restored[0].type).toBe('tennis-ball');
        expect(restored[0].bodies[0].label).toBe('ball-tennis');
    });

    it('skips unknown/legacy types without dropping the rest of the machine', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const snapshot = [
            { type: 'ball', x: 1, y: 2, angle: 0, isFixed: false, options: {} },
            { type: 'no-such-part', x: 0, y: 0 },
            { type: 'domino', x: 5, y: 6 },
        ];
        const placed = [];

        const restored = levelReset.restorePlacedFromSnapshot(placed, snapshot, objectRegistry);

        expect(restored.map((o) => o.type)).toEqual(['ball', 'domino']);
        expect(placed).toHaveLength(2);

        warnSpy.mockRestore();
    });

    it('tolerates a missing/empty snapshot (restores nothing)', () => {
        const placed = [];
        expect(levelReset.restorePlacedFromSnapshot(placed, null, objectRegistry)).toHaveLength(0);
        expect(levelReset.restorePlacedFromSnapshot(placed, undefined, objectRegistry)).toHaveLength(0);
        expect(placed).toHaveLength(0);
    });
});

// ── No leaked bodies across repeated play/reset cycles (level mode) ──

describe('reset cycles — no leaked bodies (level mode)', () => {
    it('body count returns to the baseline after every play/reset cycle', () => {
        const physics = new PhysicsEngine(800, 600);
        const loop = new GameLoop(physics, () => {});
        const placed = [];

        placed.push(...buildFixedObjects(LEVEL_DATA, objectRegistry));
        placed.push(objectRegistry.create('ball', 120, 100));
        placed.push(objectRegistry.create('ball', 300, 60));

        const expectedAtPlay = ownedBodyCount(placed); // fixed + parts bodies added per play
        expect(expectedAtPlay).toBeGreaterThan(5); // sanity: more than just walls would own

        let playedBodyCount = null;

        for (let cycle = 1; cycle <= 4; cycle++) {
            // ── Play: main.js controls:play (EDITING branch) ──
            const savedPlacedSnapshot = levelReset.beginPlay(physics, placed);
            const worldBodies = playBodies(physics).length;
            if (playedBodyCount === null) {
                expect(worldBodies).toBe(expectedAtPlay);
                playedBodyCount = worldBodies;
            }
            expect(worldBodies).toBe(playedBodyCount); // stable every cycle, never grows

            // Simulate a few frames (GameLoop._frame equivalent).
            for (let f = 0; f < 6; f++) physics.step(16.67);

            // ── Reset: main.js controls:reset → gameLoop.reset() + _resetLevel() ──
            loop.reset();
            const snapshot = [...savedPlacedSnapshot];
            physics.clear(); // _setupLevel
            placed.length = 0;
            placed.push(...buildFixedObjects(LEVEL_DATA, objectRegistry));
            levelReset.restorePlacedFromSnapshot(placed, snapshot, objectRegistry);

            // Baseline restored: NO bodies remain in the world after reset —
            // both fixed and player bodies are re-added on the next play.
            // (playBodies === 0 is the leak detector.)
            expect(placed.filter((o) => !o.isFixed)).toHaveLength(2);
            expect(playBodies(physics)).toHaveLength(0);
            expect(loop.state).toBe('stopped');
        }

        loop.dispose();
        physics.dispose();
    });
});

// ── No leaked bodies across repeated play/reset cycles (sandbox) ──

describe('reset cycles — no leaked bodies (sandbox)', () => {
    it('rewinds to the last play start; body count never grows across cycles', () => {
        const physics = new PhysicsEngine(800, 600);
        const loop = new GameLoop(physics, () => {});
        const placed = [];

        placed.push(objectRegistry.create('ball', 150, 100));
        placed.push(objectRegistry.create('domino', 400, 520));

        const expectedAtPlay = ownedBodyCount(placed);
        let playedBodyCount = null;

        for (let cycle = 1; cycle <= 4; cycle++) {
            // ── Play: controls:play SANDBOX branch ──
            const savedPlacedSnapshot = levelReset.beginPlay(physics, placed);
            const worldBodies = playBodies(physics).length;
            if (playedBodyCount === null) {
                expect(worldBodies).toBe(expectedAtPlay);
                playedBodyCount = worldBodies;
            }
            expect(worldBodies).toBe(playedBodyCount);

            for (let f = 0; f < 6; f++) physics.step(16.67);

            // ── Reset: sandbox branch of _resetLevel() ──
            loop.reset();
            const snapshot = [...savedPlacedSnapshot];
            levelReset.resetSandboxBoard(physics, placed, snapshot, objectRegistry);

            expect(placed[0].x).toBe(150); // parts back at their edit positions
            expect(placed).toHaveLength(2);
            expect(playBodies(physics)).toHaveLength(0); // no leaked bodies after reset
        }

        loop.dispose();
        physics.dispose();
    });

    it('leaves a never-played sandbox untouched (no snapshot to rewind to)', () => {
        const physics = new PhysicsEngine(800, 600);
        const placed = [];

        placed.push(objectRegistry.create('ball', 150, 100));
        placed.push(objectRegistry.create('domino', 400, 520));

        const restored = levelReset.resetSandboxBoard(physics, placed, [], objectRegistry);

        expect(restored).toHaveLength(0);
        expect(placed).toHaveLength(2);
        expect(placed[0].x).toBe(150);

        physics.dispose();
    });
});