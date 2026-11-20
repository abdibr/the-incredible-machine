/**
 * Solution scenes (ADR 0009, docs/adr/0009-scene-lock-and-solution-scenes.md):
 * every shipped level carries `solution.scene` — the solved board shown when
 * the player gives up — and the level must be PROVEN solvable, not presumed.
 *
 * Seams under test:
 * - LevelManager.validateCustom (the same _validate the campaign loader runs)
 *   accepts each shipped level: two scenes present, well-formed.
 * - The replay: each level's solution scene, built exactly the way
 *   main.js's give-up path builds it (restorePlacedFromSnapshot with
 *   includeFixed, then physics.addObject), reaches `goal:reached` in a real
 *   engine — a fixed timestep per step like GameLoop, with the checker's
 *   loop:frame fail check wired by hand. This is the solvability proof in
 *   CI: editing a scene or level furniture that breaks solvability fails here.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eventBus } from '../js/EventBus.js';
import { PhysicsEngine } from '../js/engine/PhysicsEngine.js';
import { GoalChecker } from '../js/goals/GoalChecker.js';
import { objectRegistry } from '../js/objects/ObjectRegistry.js';
import { registerAllObjects } from '../js/objects/registerAllObjects.js';
import { restorePlacedFromSnapshot } from '../js/reset/levelReset.js';
import LevelManager from '../js/levels/LevelManager.js';
import level01 from '../js/levels/puzzles/level-01.json';
import level02 from '../js/levels/puzzles/level-02.json';
import level03 from '../js/levels/puzzles/level-03.json';
import level04 from '../js/levels/puzzles/level-04.json';
import level05 from '../js/levels/puzzles/level-05.json';
import level06 from '../js/levels/puzzles/level-06.json';

const LEVELS = [level01, level02, level03, level04, level05, level06];

/** Upper bound on replay steps (~25 s of simulated time). */
const MAX_STEPS = 1500;

describe('shipped levels are proven solvable (ADR 0009)', () => {
    let physics;
    let checker;

    registerAllObjects();

    afterEach(() => {
        if (physics) physics.dispose();
        physics = null;
        eventBus.clear();
    });

    for (const level of LEVELS) {
        it(`"${level.name}" (${level.id}) validates and its solution scene reaches the goal`, () => {
            // 1. The loader's schema accepts the level: both scenes present.
            const manager = new LevelManager();
            expect(() => manager.validateCustom(level)).not.toThrow();
            expect(Array.isArray(level.solution.scene)).toBe(true);
            expect(level.solution.scene.length).toBeGreaterThan(0);

            // 2. Replay the solved board exactly the way the give-up path
            //    builds it — full-board restore, then physics objects.
            eventBus.clear();
            physics = new PhysicsEngine(1000, 600);
            checker = new GoalChecker();
            checker.init({ physicsEngine: physics });

            let result = null;
            eventBus.on('goal:reached', () => { result = 'reached'; });
            eventBus.on('goal:failed', (ev) => { result = `failed: ${ev.reason}`; });

            eventBus.emit('level:loaded', level);

            physics.clear();
            const board = [];
            restorePlacedFromSnapshot(board, level.solution.scene, objectRegistry, { includeFixed: true });
            for (const obj of board) physics.addObject(obj);
            expect(board.length).toBe(level.solution.scene.length);

            let steps = 0;
            for (; steps < MAX_STEPS && !result; steps++) {
                physics.step(1000 / 60);
                eventBus.emit('loop:frame');
            }

            expect(result).toBe('reached');
            expect(result).not.toMatch(/^failed/);
        });
    }
});
