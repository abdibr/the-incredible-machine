/**
 * Unit tests for PhysicsEngine, GameLoop, and game object serialization.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── PhysicsEngine Tests ───────────────────────────

describe('PhysicsEngine', () => {
    let PhysicsEngine;

    beforeEach(async () => {
        const mod = await import('../js/engine/PhysicsEngine.js');
        PhysicsEngine = mod.PhysicsEngine;
    });

    it('should create an engine with gravitational properties', () => {
        const engine = new PhysicsEngine(800, 600);
        expect(engine.engine).toBeDefined();
        expect(engine.engine.gravity.y).toBe(1);
        expect(engine.width).toBe(800);
        expect(engine.height).toBe(600);
        engine.dispose();
    });

    it('should allow custom gravity', () => {
        const engine = new PhysicsEngine(800, 600, { gravityX: 0.5, gravityY: 2 });
        expect(engine.engine.gravity.x).toBe(0.5);
        expect(engine.engine.gravity.y).toBe(2);
        engine.dispose();
    });

    it('should step the simulation without error', () => {
        const engine = new PhysicsEngine(800, 600);
        expect(() => engine.step(16.67)).not.toThrow();
        engine.dispose();
    });

    it('should take and restore snapshots', () => {
        const engine = new PhysicsEngine(800, 600);
        expect(engine.hasSnapshot()).toBe(false);

        engine.takeSnapshot();
        expect(engine.hasSnapshot()).toBe(true);

        engine.restoreSnapshot();
        engine.clearSnapshot();
        expect(engine.hasSnapshot()).toBe(false);

        engine.dispose();
    });

    it('restores by body id so a mid-play deletion never misplaces other objects', async () => {
        const engine = new PhysicsEngine(800, 600);
        const { default: Ball } = await import('../js/objects/Ball.js');

        const a = new Ball(200, 100);
        const b = new Ball(400, 100);
        const c = new Ball(600, 100);
        for (const obj of [a, b, c]) engine.addObject(obj);

        engine.takeSnapshot();
        const poseOf = (obj) => ({ x: obj.bodies[0].position.x, y: obj.bodies[0].position.y });
        const snapshotPoses = [poseOf(a), poseOf(b), poseOf(c)];

        // Mid-play: the simulation runs and objects move.
        for (let i = 0; i < 12; i++) engine.step(16.67);
        expect(poseOf(c).y).not.toBe(snapshotPoses[2].y);

        // Delete an object mid-play, then reset to the snapshot.
        engine.removeObject(b);
        engine.restoreSnapshot();

        // Survivors must land at their OWN snapshot poses; index-based mapping
        // would silently skip/misapply entries shifted by the deletion.
        expect(poseOf(a)).toEqual(snapshotPoses[0]);
        expect(poseOf(c)).toEqual(snapshotPoses[2]);

        engine.dispose();
    });

    it('flags a snapshot/world mismatch loudly and re-baselines it after a deletion', async () => {
        const engine = new PhysicsEngine(800, 600);
        const { default: Ball } = await import('../js/objects/Ball.js');
        const { eventBus } = await import('../js/EventBus.js');

        const a = new Ball(200, 150);
        const b = new Ball(400, 150);
        engine.addObject(a);
        engine.addObject(b);
        engine.takeSnapshot();

        const warnings = [];
        const mismatches = [];
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation((msg) => warnings.push(msg));
        const unsubscribe = eventBus.on('physics:snapshot-mismatch', (payload) => mismatches.push(payload));

        const bBodyId = b.bodies[0].id;
        engine.removeObject(b); // delete mid-play
        engine.restoreSnapshot(); // "reset"

        // Mismatch is loud: a console warning and a physics:snapshot-mismatch event.
        expect(warnings.length).toBe(1);
        expect(mismatches.length).toBe(1);
        expect(mismatches[0].unmatchedSnapshotBodyIds).toEqual([bBodyId]);
        expect(mismatches[0].unmatchedLiveBodyIds).toEqual([]);
        expect(engine.hasSnapshot()).toBe(true);

        // Self-healing: the fresh baseline matches the restored world, so the
        // next restore does not repeat the mismatch.
        engine.step(16.67);
        mismatches.length = 0;
        warnings.length = 0;
        engine.restoreSnapshot();

        expect(mismatches.length).toBe(0);
        expect(warnings.length).toBe(0);

        unsubscribe();
        warnSpy.mockRestore();
        engine.dispose();
    });

    it('never moves objects added after the snapshot and re-baselines for them', async () => {
        const engine = new PhysicsEngine(800, 600);
        const { default: Ball } = await import('../js/objects/Ball.js');
        const { eventBus } = await import('../js/EventBus.js');

        const a = new Ball(200, 150);
        engine.addObject(a);
        engine.takeSnapshot();

        const mismatches = [];
        const unsubscribe = eventBus.on('physics:snapshot-mismatch', (payload) => mismatches.push(payload));

        // Add another object AFTER the snapshot was taken, then run and reset.
        const b = new Ball(400, 150);
        engine.addObject(b);
        const snapshotA = { x: a.bodies[0].position.x, y: a.bodies[0].position.y };
        for (let i = 0; i < 12; i++) engine.step(16.67);
        const midPlayB = { x: b.bodies[0].position.x, y: b.bodies[0].position.y };

        engine.restoreSnapshot();

        // The snapshotted object still returns to its own pose.
        expect({ x: a.bodies[0].position.x, y: a.bodies[0].position.y }).toEqual(snapshotA);
        // The late addition is untouched (pose is left as-is, not zeroed/teleported).
        expect({ x: b.bodies[0].position.x, y: b.bodies[0].position.y }).toEqual(midPlayB);
        // Drift is reported in the other direction too.
        expect(mismatches.length).toBe(1);
        expect(mismatches[0].unmatchedLiveBodyIds).toEqual([b.bodies[0].id]);
        expect(mismatches[0].unmatchedSnapshotBodyIds).toEqual([]);

        unsubscribe();
        engine.dispose();
    });

    it('restores cleanly without flagging a mismatch when the world matches the snapshot', async () => {
        const engine = new PhysicsEngine(800, 600);
        const { default: Ball } = await import('../js/objects/Ball.js');
        const { eventBus } = await import('../js/EventBus.js');

        const mismatches = [];
        const unsubscribe = eventBus.on('physics:snapshot-mismatch', (payload) => mismatches.push(payload));

        const a = new Ball(300, 100);
        const b = new Ball(500, 100);
        engine.addObject(a);
        engine.addObject(b);
        engine.takeSnapshot();
        const snapshotA = { x: a.bodies[0].position.x, y: a.bodies[0].position.y };
        const snapshotB = { x: b.bodies[0].position.x, y: b.bodies[0].position.y };
        for (let i = 0; i < 12; i++) engine.step(16.67);

        engine.restoreSnapshot();

        expect({ x: a.bodies[0].position.x, y: a.bodies[0].position.y }).toEqual(snapshotA);
        expect({ x: b.bodies[0].position.x, y: b.bodies[0].position.y }).toEqual(snapshotB);
        expect(mismatches.length).toBe(0);
        expect(engine.hasSnapshot()).toBe(true);

        unsubscribe();
        engine.dispose();
    });

    it('should set time scale', () => {
        const engine = new PhysicsEngine(800, 600);
        engine.setTimeScale(2);
        expect(engine.engine.timing.timeScale).toBe(2);
        engine.dispose();
    });

    it('should clear all objects', () => {
        const engine = new PhysicsEngine(800, 600);
        engine.clear();
        expect(engine.getObjects().size).toBe(0);
        engine.dispose();
    });
});

// ── GameLoop Tests ─────────────────────────────────

describe('GameLoop', () => {
    let GameLoop, PhysicsEngine, LoopState;

    beforeEach(async () => {
        const engineMod = await import('../js/engine/PhysicsEngine.js');
        const loopMod = await import('../js/engine/GameLoop.js');
        PhysicsEngine = engineMod.PhysicsEngine;
        GameLoop = loopMod.GameLoop;
        LoopState = loopMod.LoopState;

        // Stub browser animation globals for Node environment
        vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
        vi.stubGlobal('cancelAnimationFrame', vi.fn());
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('should start in STOPPED state', () => {
        const physics = new PhysicsEngine(800, 600);
        const loop = new GameLoop(physics, () => { });

        expect(loop.state).toBe(LoopState.STOPPED);
        expect(loop.isStopped).toBe(true);
        expect(loop.isRunning).toBe(false);
        expect(loop.isPaused).toBe(false);

        loop.dispose();
        physics.dispose();
    });

    it('should transition to RUNNING on play', () => {
        const physics = new PhysicsEngine(800, 600);
        const loop = new GameLoop(physics, () => { });

        loop.play();
        expect(loop.state).toBe(LoopState.RUNNING);
        expect(loop.isRunning).toBe(true);

        loop.dispose();
        physics.dispose();
    });

    it('should transition to PAUSED on pause', () => {
        const physics = new PhysicsEngine(800, 600);
        const loop = new GameLoop(physics, () => { });

        loop.play();
        loop.pause();
        expect(loop.state).toBe(LoopState.PAUSED);
        expect(loop.isPaused).toBe(true);

        loop.dispose();
        physics.dispose();
    });

    it('should reset to STOPPED on reset', () => {
        const physics = new PhysicsEngine(800, 600);
        const loop = new GameLoop(physics, () => { });

        loop.play();
        loop.reset();
        expect(loop.state).toBe(LoopState.STOPPED);
        expect(loop.elapsed).toBe(0);

        loop.dispose();
        physics.dispose();
    });

    it('should cycle speed between 1× and 2×', () => {
        const physics = new PhysicsEngine(800, 600);
        const loop = new GameLoop(physics, () => { });

        expect(loop.speed).toBe(1);
        loop.cycleSpeed();
        expect(loop.speed).toBe(2);
        loop.cycleSpeed();
        expect(loop.speed).toBe(1);

        loop.dispose();
        physics.dispose();
    });
});

// ── Object Serialization Tests ────────────────────

describe('Object Serialization', () => {
    it('should serialize and deserialize a Ball', async () => {
        const { default: Ball } = await import('../js/objects/Ball.js');
        const ball = new Ball(100, 200, { variant: 'tennis' });

        const data = ball.serialize();
        expect(data.type).toBe('ball');
        expect(data.x).toBe(100);
        expect(data.y).toBe(200);
        expect(data.options.variant).toBe('tennis');

        const restored = Ball.deserialize(data);
        expect(restored.type).toBe('ball');
        expect(restored._variant).toBe('tennis');
    });

    it('should serialize and deserialize a Ramp', async () => {
        const { default: Ramp } = await import('../js/objects/Ramp.js');
        const ramp = new Ramp(300, 400, { width: 150, angle: 0.5 });

        const data = ramp.serialize();
        expect(data.type).toBe('ramp');
        expect(data.options.width).toBe(150);

        const restored = Ramp.deserialize(data);
        expect(restored.type).toBe('ramp');
    });

    it('should serialize and deserialize a Conveyor', async () => {
        const { default: Conveyor } = await import('../js/objects/Conveyor.js');
        const conveyor = new Conveyor(200, 300, { speed: -3 });

        const data = conveyor.serialize();
        expect(data.type).toBe('conveyor');
        expect(data.options.speed).toBe(-3);

        const restored = Conveyor.deserialize(data);
        expect(restored.type).toBe('conveyor');
    });

    it('should serialize and deserialize a Domino', async () => {
        const { default: Domino } = await import('../js/objects/Domino.js');
        const domino = new Domino(150, 250);

        const data = domino.serialize();
        expect(data.type).toBe('domino');

        const restored = Domino.deserialize(data);
        expect(restored.type).toBe('domino');
    });

    it('should serialize and deserialize a Bucket', async () => {
        const { default: Bucket } = await import('../js/objects/Bucket.js');
        const bucket = new Bucket(400, 500, { catchType: 'ball' });

        const data = bucket.serialize();
        expect(data.type).toBe('bucket');
        expect(data.options.catchType).toBe('ball');

        const restored = Bucket.deserialize(data);
        expect(restored.type).toBe('bucket');
    });

    it('should serialize and deserialize a Balloon', async () => {
        const { default: Balloon } = await import('../js/objects/Balloon.js');
        const balloon = new Balloon(200, 100, { colorIndex: 2 });

        const data = balloon.serialize();
        expect(data.type).toBe('balloon');
        expect(data.options.colorIndex).toBe(2);

        const restored = Balloon.deserialize(data);
        expect(restored.type).toBe('balloon');
    });

    it('should serialize and deserialize a Mouse', async () => {
        const { default: Mouse } = await import('../js/objects/Mouse.js');
        const mouse = new Mouse(300, 400, { direction: -1, speed: 2 });

        const data = mouse.serialize();
        expect(data.type).toBe('mouse');
        expect(data.options.direction).toBe(-1);
        expect(data.options.speed).toBe(2);

        const restored = Mouse.deserialize(data);
        expect(restored.type).toBe('mouse');
    });
});

// ── ObjectRegistry Tests ──────────────────────────

describe('ObjectRegistry', () => {
    it('should register and create objects', async () => {
        const { objectRegistry } = await import('../js/objects/ObjectRegistry.js');
        const { default: Ball } = await import('../js/objects/Ball.js');

        // Register if not already
        if (!objectRegistry.has('ball')) {
            objectRegistry.register('ball', Ball, {
                displayName: 'Ball',
                category: 'balls',
            });
        }

        const ball = objectRegistry.create('ball', 100, 200);
        expect(ball.type).toBe('ball');
        expect(ball.bodies.length).toBe(1);
    });

    it('should throw for unknown types', async () => {
        const { objectRegistry } = await import('../js/objects/ObjectRegistry.js');

        expect(() => objectRegistry.create('nonexistent', 0, 0)).toThrow();
    });

    it('should list categories', async () => {
        const { registerAllObjects } = await import('../js/objects/registerAllObjects.js');
        const { objectRegistry } = await import('../js/objects/ObjectRegistry.js');

        registerAllObjects();

        const categories = objectRegistry.getCategories();
        expect(categories).toContain('balls');
        expect(categories).toContain('surfaces');
        expect(categories).toContain('machines');
        expect(categories).toContain('triggers');
    });

    it('should register all 17 object types', async () => {
        const { objectRegistry } = await import('../js/objects/ObjectRegistry.js');

        const all = objectRegistry.getAll();
        expect(all.length).toBeGreaterThanOrEqual(17);
    });
});
