/**
 * GoalChecker — decides when a level's goal is reached or failed.
 *
 * Makes levels winnable end-to-end (issue #11):
 * - Listens on `bucket:caught` (emitted by Bucket sensors): if the caught
 *   object matches the level goal (object_in_zone → goal.targetType) and
 *   the bucket's customId matches goal.zoneId, emit `goal:reached { levelId }`.
 *   (Display: GoalOverlay shows the win overlay. Progression:
 *   LevelManager.markComplete unlocks the next level.)
 * - Per-frame fail check on `loop:frame`: if a target object falls
 *   off-world below the canvas, emit `goal:failed { levelId, reason }`.
 *   (Display: GoalOverlay shows the fail overlay.)
 *
 * Either outcome fires once per play attempt; the checker re-arms on a
 * new PLAYING attempt and on every level load.
 */

import { eventBus } from '../EventBus.js';

/** The only goal type this checker implements (level JSON `goal.type`) */
const ZONE_GOAL_TYPE = 'object_in_zone';

/**
 * The zone id EditorPanel hard-codes into custom levels' goals
 * (EditorPanel._saveLevel). Buckets saved without a named id get this
 * stamped on, so a reloaded custom level's bucket resolves to
 * `goal.zoneId` exactly like official level JSON does.
 */
export const DEFAULT_GOAL_ZONE_ID = 'bucket-goal';

/**
 * Stamp the goal zone id onto serialized fixed buckets that have no
 * named id yet (EditorPanel save parity: keeps an existing id, never
 * touches non-bucket objects).
 * @param {Array<object>} fixedObjects - fresh serialize() results from _saveLevel
 * @param {string} [zoneId]
 * @returns {Array<object>} the same array, ids stamped
 */
export function stampGoalZoneIds(fixedObjects, zoneId = DEFAULT_GOAL_ZONE_ID) {
    for (const data of fixedObjects) {
        if (data?.type === 'bucket' && !data.id) {
            data.id = zoneId;
        }
    }
    return fixedObjects;
}

export class GoalChecker {
    constructor() {
        /** @type {import('../engine/PhysicsEngine.js').PhysicsEngine|null} */
        this._physics = null;

        /** @type {object|null} Level goal (level JSON `goal` field) */
        this._goal = null;

        /** @type {string|null} Current level id */
        this._levelId = null;

        /** @type {string|null} 'reached' | 'failed' | null (latched per play attempt) */
        this._decided = null;
    }

    /**
     * Initialize the checker and hook it into the event bus.
     * @param {object} [deps]
     * @param {import('../engine/PhysicsEngine.js').PhysicsEngine} [deps.physicsEngine]
     *        Needed for the per-frame off-world fail check.
     */
    init({ physicsEngine = null } = {}) {
        this._physics = physicsEngine;

        // Track the active goal; every loaded level re-arms the checker
        eventBus.on('level:loaded', (levelData) => {
            this._goal = levelData.goal ?? null;
            this._levelId = levelData.id ?? null;
            this._decided = null;
        });

        // A new play attempt re-arms the checker (retry / replay)
        eventBus.on('mode:changed', ({ newMode }) => {
            if (newMode === 'PLAYING') {
                this._decided = null;
            }
        });

        eventBus.on('bucket:caught', ({ bucket, object }) => {
            this._onCaught(bucket, object);
        });

        // Per-step fail check (GameLoop emits loop:frame once per physics step)
        eventBus.on('loop:frame', () => {
            this._checkOffWorld();
        });
    }

    /**
     * Fail condition: a target object's body pushed off-world below the
     * canvas (e.g. tunneled through the boundary walls) ends the attempt
     * with `goal:failed`.
     * @private
     */
    _checkOffWorld() {
        const goal = this._goal;
        if (!goal || this._decided || !this._physics) return;

        const physics = this._physics;
        for (const obj of physics.getObjects()) {
            if (goal.targetType !== obj.type) continue;

            for (const body of obj.bodies) {
                if (body?.position && body.position.y > physics.height) {
                    this._decided = 'failed';
                    eventBus.emit('goal:failed', {
                        levelId: this._levelId,
                        reason: 'The target fell off the playfield.',
                    });
                    return;
                }
            }
        }
    }

    /** @private */
    _onCaught(bucket, object) {
        const goal = this._goal;
        if (!goal || this._decided) return;

        // Only zone-type goals are checked here
        if (goal.type !== ZONE_GOAL_TYPE) return;

        // Target-type filtering: a wrong object caught in the zone does not win
        if (goal.targetType !== object?.type) return;

        // Zone filtering: the catching bucket must be the level's goal zone
        if (goal.zoneId !== bucket?.customId) return;

        this._decided = 'reached';
        eventBus.emit('goal:reached', { levelId: this._levelId });
    }
}

/** Singleton goal checker instance (initialized by main.js) */
export const goalChecker = new GoalChecker();
export default GoalChecker;