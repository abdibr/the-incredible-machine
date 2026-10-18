/**
 * Unit tests for the goal system (GitHub issue #11):
 * GoalChecker listens on bucket:caught / loop:frame and turns the level
 * goal into goal:reached / goal:failed (display and progression paths
 * already listen for those events).
 *
 * Seams under test:
 * - GoalChecker lifecycle: init({ physicsEngine }) then real EventBus
 *   traffic (level:loaded, bucket:caught, loop:frame, mode:changed).
 *   Collaborators are the real Bucket/Ball/Mouse classes and a real
 *   PhysicsEngine — the same objects main.js builds from level JSON.
 * - LevelManager progression: markComplete → unlock → next-level load,
 *   on a fresh class instance (fetch stubbed per level file).
 * - Zone-id stamping (EditorPanel save parity) exported from the goal
 *   module, because EditorPanel itself is not node-importable.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eventBus } from '../js/EventBus.js';
import { PhysicsEngine } from '../js/engine/PhysicsEngine.js';
import Ball from '../js/objects/Ball.js';
import Mouse from '../js/objects/Mouse.js';
import Bucket from '../js/objects/Bucket.js';
import { GoalChecker, DEFAULT_GOAL_ZONE_ID, stampGoalZoneIds } from '../js/goals/GoalChecker.js';
import { objectRegistry } from '../js/objects/ObjectRegistry.js';
import LevelManager from '../js/levels/LevelManager.js';
import level01 from '../js/levels/puzzles/level-01.json';
import level02 from '../js/levels/puzzles/level-02.json';
import level05 from '../js/levels/puzzles/level-05.json';

/** The goal criteria from level-01.json (known-good literal from the repo) */
const GOAL = level01.goal; // { type: 'object_in_zone', targetType: 'ball', zoneId: 'bucket-goal' }

describe('GoalChecker win path (issue #11)', () => {
    let checker;
    let physics;

    beforeEach(() => {
        eventBus.clear();
        physics = new PhysicsEngine(800, 600);
        checker = new GoalChecker();
        checker.init({ physicsEngine: physics });
    });

    afterEach(() => {
        physics.dispose();
    });

    it('emits goal:reached { levelId } when the target type is caught by the zone matching goal.zoneId', () => {
        const reached = vi.fn();
        eventBus.on('goal:reached', reached);

        eventBus.emit('level:loaded', level01);

        // Objects built exactly the way main.js _setupLevel builds them
        const bucket = Bucket.deserialize(level01.fixedObjects[0]);
        const ball = new Ball(700, 450);

        eventBus.emit('bucket:caught', { bucket, object: ball, totalCaught: 1 });

        expect(reached).toHaveBeenCalledTimes(1);
        expect(reached).toHaveBeenCalledWith({ levelId: 'level-01' });
    });

    it('does not win when a wrong object is caught — target-type filtering (issue #11)', () => {
        const reached = vi.fn();
        eventBus.on('goal:reached', reached);

        eventBus.emit('level:loaded', level01); // level-01 goal.targetType === 'ball'

        const bucket = Bucket.deserialize(level01.fixedObjects[0]);
        const wrongObject = { type: 'domino', id: 99 }; // non-ball stray (the payload Bucket emits)

        eventBus.emit('bucket:caught', { bucket, object: wrongObject, totalCaught: 1 });

        expect(reached).not.toHaveBeenCalled();
    });

    it('does not win when the catching bucket is not the goal zone (customId mismatch)', () => {
        const reached = vi.fn();
        eventBus.on('goal:reached', reached);

        eventBus.emit('level:loaded', level01); // level-01 goal.zoneId === 'bucket-goal'

        const decoyBucket = new Bucket(300, 480); // no customId → not the goal zone
        const ball = new Ball(300, 400);

        eventBus.emit('bucket:caught', { bucket: decoyBucket, object: ball, totalCaught: 1 });

        expect(reached).not.toHaveBeenCalled();
    });

    it('does not win for goal types the checker does not implement', () => {
        const reached = vi.fn();
        eventBus.on('goal:reached', reached);

        eventBus.emit('level:loaded', {
            ...level01,
            id: 'custom-pop',
            goal: { ...GOAL, type: 'pop_all_balloons' }, // editor offers this type; not zone-based
        });

        const bucket = new Bucket(700, 480, { customId: 'bucket-goal' });
        const ball = new Ball(700, 450);

        eventBus.emit('bucket:caught', { bucket, object: ball, totalCaught: 1 });

        expect(reached).not.toHaveBeenCalled();
    });

    it('emits goal:reached once per play attempt even if the zone reports the catch repeatedly', () => {
        const reached = vi.fn();
        eventBus.on('goal:reached', reached);

        eventBus.emit('level:loaded', level01);

        const bucket = Bucket.deserialize(level01.fixedObjects[0]);
        const ball = new Ball(700, 450);

        eventBus.emit('bucket:caught', { bucket, object: ball, totalCaught: 1 });
        eventBus.emit('bucket:caught', { bucket, object: ball, totalCaught: 1 });

        expect(reached).toHaveBeenCalledTimes(1);
    });

    it('re-arms for a new play attempt so a retry after win can win again', () => {
        const reached = vi.fn();
        eventBus.on('goal:reached', reached);

        eventBus.emit('level:loaded', level01);

        const bucket = Bucket.deserialize(level01.fixedObjects[0]);
        eventBus.emit('bucket:caught', { bucket, object: new Ball(700, 450), totalCaught: 1 });

        // Retry → play again (a new PLAYING attempt, no new level load)
        eventBus.emit('mode:changed', { oldMode: 'WON', newMode: 'PLAYING' });
        eventBus.emit('bucket:caught', { bucket, object: new Ball(700, 450), totalCaught: 1 });

        expect(reached).toHaveBeenCalledTimes(2);
    });
});

describe('GoalChecker fail path (issue #11)', () => {
    let checker;
    let physics;

    beforeEach(() => {
        eventBus.clear();
        physics = new PhysicsEngine(800, 600);
        checker = new GoalChecker();
        checker.init({ physicsEngine: physics });
    });

    afterEach(() => {
        physics.dispose();
    });

    /** Add a real target object to the physics world (as play does) */
    function playBallAt(x, y) {
        const ball = new Ball(x, y);
        physics.addObject(ball);
        return ball;
    }

    it('emits goal:failed { levelId, reason } when the target falls off-world below the canvas', () => {
        const failed = vi.fn();
        const reached = vi.fn();
        eventBus.on('goal:failed', failed);
        eventBus.on('goal:reached', reached);

        eventBus.emit('level:loaded', level01);

        const ball = playBallAt(400, 300);
        ball.setPosition(400, 700); // below the 600px canvas

        eventBus.emit('loop:frame', { dt: 16.67, elapsed: 16.67 });

        expect(failed).toHaveBeenCalledTimes(1);
        expect(failed).toHaveBeenCalledWith({ levelId: 'level-01', reason: expect.any(String) });
        expect(reached).not.toHaveBeenCalled();
    });

    it('does not fail while the target stays within the playfield', () => {
        const failed = vi.fn();
        eventBus.on('goal:failed', failed);

        eventBus.emit('level:loaded', level01);
        playBallAt(400, 300);

        eventBus.emit('loop:frame', { dt: 16.67, elapsed: 16.67 });
        eventBus.emit('loop:frame', { dt: 16.67, elapsed: 33.34 });

        expect(failed).not.toHaveBeenCalled();
    });

    it('does not fail after the goal was already reached (one decision per attempt)', () => {
        const failed = vi.fn();
        eventBus.on('goal:failed', failed);

        eventBus.emit('level:loaded', level01);

        const bucket = Bucket.deserialize(level01.fixedObjects[0]);
        eventBus.emit('bucket:caught', { bucket, object: playBallAt(700, 450), totalCaught: 1 });

        const ball2 = playBallAt(400, 300); // a second stray target below canvas… irrelevant: decided
        ball2.setPosition(400, 700);
        eventBus.emit('loop:frame', { dt: 16.67, elapsed: 16.67 });

        expect(failed).not.toHaveBeenCalled();
    });

    it('fail check respects target-type filtering (level-05: mouse is the target)', () => {
        const failed = vi.fn();
        eventBus.on('goal:failed', failed);

        eventBus.emit('level:loaded', level05); // goal.targetType === 'mouse'

        const ball = playBallAt(400, 300); // non-target stray off-world
        ball.setPosition(400, 700);
        eventBus.emit('loop:frame', { dt: 16.67, elapsed: 16.67 });

        expect(failed).not.toHaveBeenCalled();

        const mouse = new Mouse(400, 700); // the actual target off-world
        physics.addObject(mouse);
        eventBus.emit('loop:frame', { dt: 16.67, elapsed: 33.34 });

        expect(failed).toHaveBeenCalledTimes(1);
        expect(failed).toHaveBeenCalledWith({ levelId: 'level-05', reason: expect.any(String) });
    });
});

describe('Level-progression path (issue #11)', () => {
    let physics;
    let checker;
    let levelManager;

    /**
     * Serve the actual level JSONs when LevelManager fetches
     * /js/levels/puzzles/<id>.json (node can't resolve the relative URLs).
     */
    function stubFetchForLevels() {
        const levelFiles = new Map([
            ['level-01', level01],
            ['level-02', level02],
        ]);
        vi.stubGlobal('fetch', vi.fn(async (url) => {
            const match = String(url).match(/([a-z0-9-]+)\.json$/);
            const data = match ? levelFiles.get(match[1]) : undefined;
            if (data) {
                return { ok: true, json: async () => data };
            }
            return { ok: false, status: 404, json: async () => ({}) };
        }));
        const storage = new Map();
        vi.stubGlobal('localStorage', {
            getItem: (key) => storage.get(key) ?? null,
            setItem: (key, value) => storage.set(key, String(value)),
        });
    }

    beforeEach(() => {
        stubFetchForLevels();

        eventBus.clear();
        physics = new PhysicsEngine(800, 600);
        levelManager = new LevelManager();
        levelManager.init();

        checker = new GoalChecker();
        checker.init({ physicsEngine: physics });
    });

    afterEach(() => {
        physics.dispose();
        vi.unstubAllGlobals();
    });

    it('marks the level complete and unlocks the next one when the ball is caught', async () => {
        await levelManager.loadLevel('level-01');

        const bucket = Bucket.deserialize(level01.fixedObjects[0]);
        eventBus.emit('bucket:caught', { bucket, object: new Ball(700, 450), totalCaught: 1 });

        expect(levelManager.isLevelCompleted('level-01')).toBe(true);
        expect(levelManager.isLevelUnlocked('level-02')).toBe(true);
    });

    /**
     * The Next Level action: GoalOverlay's button emits
     * 'overlay:next-level' { levelId: nextId } and main.js answers with
     * levelManager.loadLevel(levelId) — verified here at the same seam.
     */
    it('Next Level action loads the following level id', async () => {
        await levelManager.loadLevel('level-01');

        const bucket = Bucket.deserialize(level01.fixedObjects[0]);
        eventBus.emit('bucket:caught', { bucket, object: new Ball(700, 450), totalCaught: 1 });

        const nextId = levelManager.getNextLevel();
        expect(nextId).toBe('level-02');

        const loaded = vi.fn();
        eventBus.on('level:loaded', loaded);
        await levelManager.loadLevel(nextId); // what the overlay:next-level listener does

        expect(levelManager.getCurrentLevel().id).toBe('level-02');
        expect(loaded).toHaveBeenCalledWith(level02);
    });
});

describe('Editor-saved level parity (issue #11)', () => {
    let physics;
    let checker;

    beforeEach(async () => {
        const { registerAllObjects } = await import('../js/objects/registerAllObjects.js');
        registerAllObjects();

        eventBus.clear();
        physics = new PhysicsEngine(800, 600);
        checker = new GoalChecker();
        checker.init({ physicsEngine: physics });
    });

    afterEach(() => {
        physics.dispose();
    });

    /**
     * An editor-scene bucket as _saveLevel sees it: placed via
     * objectRegistry.create (no named id) and then serialized.
     */
    function saveLevelLikeEditorPanel() {
        const fixedBucket = objectRegistry.create('bucket', 700, 480, { isFixed: true });
        const fixedObjects = [fixedBucket.serialize()]; // EditorPanel splits fixed/placed

        return {
            id: `custom-${Date.now()}`,
            name: 'Custom Level',
            difficulty: 1,
            goal: {
                type: 'object_in_zone',
                targetType: 'ball',
                zoneId: DEFAULT_GOAL_ZONE_ID, // what EditorPanel hard-codes
            },
            fixedObjects: stampGoalZoneIds(fixedObjects), // the parity step under test
            availableParts: { ball: 10 },
            hints: [],
        };
    }

    it('stamps save-shaped buckets with the goal zone id, never overwriting named ids or non-buckets', () => {
        const bucketData = objectRegistry.create('bucket', 700, 480, { isFixed: true }).serialize();
        expect('id' in bucketData).toBe(false); // editor-placed buckets carry no named id

        const [stampedBucket] = stampGoalZoneIds([bucketData]);
        expect(stampedBucket.id).toBe('bucket-goal');

        // Named ids survive the stamp (e.g. a bucket loaded from an official level)
        const namedData = { ...level01.fixedObjects[0], id: 'my-bucket' };
        expect(stampGoalZoneIds([{ ...namedData }])[0].id).toBe('my-bucket');

        // Non-bucket objects are left untouched
        const ballData = objectRegistry.create('ball', 400, 300).serialize();
        const [stampedBall] = stampGoalZoneIds([ballData]);
        expect('id' in stampedBall).toBe(false);
    });

    it('a reloaded editor-saved level with the hard-coded zone id is winnable the same way', () => {
        const reached = vi.fn();
        const failed = vi.fn();
        eventBus.on('goal:reached', reached);
        eventBus.on('goal:failed', failed);

        const level = saveLevelLikeEditorPanel();
        eventBus.emit('level:loaded', level); // what _applyLoadedLevel does for custom levels

        // Reload path (main.js _setupLevel / EditorPanel._applyLoadedLevel)
        const bucket = objectRegistry.deserialize(level.fixedObjects[0]);
        expect(bucket.customId).toBe(level.goal.zoneId); // checker convention matches the editor

        eventBus.emit('bucket:caught', { bucket, object: objectRegistry.create('ball', 700, 450), totalCaught: 1 });
        eventBus.emit('loop:frame', { dt: 16.67, elapsed: 16.67 });

        expect(reached).toHaveBeenCalledWith({ levelId: level.id });
        expect(failed).not.toHaveBeenCalled();
    });
});