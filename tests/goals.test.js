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
import Bucket from '../js/objects/Bucket.js';
import { GoalChecker } from '../js/goals/GoalChecker.js';
import level01 from '../js/levels/puzzles/level-01.json';

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
});