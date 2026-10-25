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
export const ZONE_GOAL_TYPE = 'object_in_zone';

/**
 * Goal types the checker implements. The editor's Goal Type select offers
 * exactly these as selectable choices (issue #66) — the other known types
 * stay visible but disabled, so a selection can never silently produce a
 * level that cannot be won. Expands alongside #43.
 */
export const IMPLEMENTED_GOAL_TYPES = Object.freeze([ZONE_GOAL_TYPE]);

/**
 * Every goal type the editor's Goal Type select knows (issue #66), with its
 * implementation status. Single source for the select's option list: when
 * #43 implements a type, GoalChecker.js flips its flag and the editor's
 * select follows without another edit.
 */
export const KNOWN_GOAL_TYPES = Object.freeze([
    { type: ZONE_GOAL_TYPE, implemented: true },
    { type: 'pop_all_balloons', implemented: false },
    { type: 'chain_complete', implemented: false },
    { type: 'mouse_in_zone', implemented: false },
    { type: 'custom', implemented: false },
]);

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
 * touches non-bucket objects, and stamps only the FIRST unnamed bucket —
 * decoy buckets stay unnamed, so a multi-bucket machine cannot be won
 * through the wrong one).
 * @param {Array<object>} fixedObjects - fresh serialize() results from _saveLevel
 * @param {string} [zoneId]
 * @returns {Array<object>} the same array, the goal bucket id stamped
 */
export function stampGoalZoneIds(fixedObjects, zoneId = DEFAULT_GOAL_ZONE_ID) {
    let stamped = false;
    for (const data of fixedObjects) {
        if (!stamped && data?.type === 'bucket' && !data.id) {
            data.id = zoneId;
            stamped = true; // only the first unnamed bucket carries the goal zone
        }
    }
    return fixedObjects;
}

/**
 * Resolve the object that plays a goal's win zone (issue #66).
 *
 * One resolver serves the editor's goal readout, the renderer's GOAL-zone
 * marker and Save's zoneId choice, so the three can never disagree:
 * - Zone-type goals (`object_in_zone`): the board object whose named id
 *   matches `goal.zoneId` — exactly what GoalChecker._onCaught compares.
 * - `stampFallback` (sandbox editing): when there is no explicit match,
 *   the FIRST unnamed fixed bucket — the one stampGoalZoneIds will name
 *   on the next Save. A null or unresolvable zone-type goal therefore
 *   resolves to "the bucket Save would make the zone".
 * - Foreign goal types have no zone and resolve to null.
 * @param {Array<import('../objects/BaseObject.js').default>} objects - the
 *        board (dragDropManager/renderer order defines "first")
 * @param {object|null} goal - level JSON goal, or null (implied sandbox default)
 * @param {{ stampFallback?: boolean }} [opts] - sandbox editing passes true
 * @returns {object|null} the goal-zone object, or null when unresolvable
 */
export function resolveGoalZoneObject(objects, goal, { stampFallback = false } = {}) {
    const zoneTypeGoal = goal?.type === ZONE_GOAL_TYPE;
    if (zoneTypeGoal && goal.zoneId) {
        const zone = objects.find((obj) => obj.customId === goal.zoneId);
        if (zone) return zone;
    }
    if (stampFallback && (!goal || zoneTypeGoal)) {
        return objects.find((obj) => obj.type === 'bucket' && obj.isFixed && obj.customId == null) ?? null;
    }
    return null;
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

        /** @type {Array<() => void>} eventBus unsubscribe fns (captured by init, drained by dispose) */
        this._unsubscribes = [];
    }

    /**
     * Initialize the checker and hook it into the event bus. Idempotent:
     * the init-once guard keeps a second call from stacking duplicate
     * subscriptions (which would double goal:reached / goal:failed).
     * Subscriptions are captured in `_unsubscribes` and drained by dispose(),
     * so a dispose() → init() round-trip re-subscribes exactly once.
     * @param {object} [deps]
     * @param {import('../engine/PhysicsEngine.js').PhysicsEngine} [deps.physicsEngine]
     *        Needed for the per-frame off-world fail check.
     */
    init({ physicsEngine = null } = {}) {
        this._physics = physicsEngine;
        if (this._unsubscribes.length > 0) return; // already initialized

        this._unsubscribes.push(
            // Track the active goal; every loaded level re-arms the checker
            eventBus.on('level:loaded', (levelData) => {
                this._goal = levelData.goal ?? null;
                this._levelId = levelData.id ?? null;
                this._decided = null;
            }),
            // A new play attempt re-arms the checker (retry / replay)
            eventBus.on('mode:changed', ({ newMode }) => {
                if (newMode === 'PLAYING') {
                    this._decided = null;
                }
            }),
            eventBus.on('bucket:caught', ({ bucket, object }) => {
                this._onCaught(bucket, object);
            }),
            // Per-step fail check (GameLoop emits loop:frame once per physics step)
            eventBus.on('loop:frame', () => {
                this._checkOffWorld();
            }),
        );
    }

    /**
     * Detach from the event bus and release state references (mainly for
     * tests and future teardown callers). Safe to call more than once:
     * it drains only the captured unsubscribes, and a subsequent init()
     * re-subscribes exactly once.
     */
    dispose() {
        for (const unsubscribe of this._unsubscribes) unsubscribe();
        this._unsubscribes = [];
        this._physics = null;
        this._goal = null;
        this._levelId = null;
        this._decided = null;
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