/**
 * levelReset — keeps the player's machine across play/reset cycles.
 *
 * At play start the placed board is serialized (beginPlay) so the reset
 * path can rewind to it; on reset, restorePlacedFromSnapshot deserializes
 * the player-placed (non-fixed) parts back into the board at their edit
 * positions. Physics bodies are only (re-)added by beginPlay — the
 * restored board exists for rendering/editing until the next play.
 *
 * Used by
 *   - main.js `controls:play` (EDITING/SANDBOX start)            → beginPlay
 *   - main.js `_resetLevel()` level branch (after _setupLevel)    → restorePlacedFromSnapshot
 *   - main.js `_resetLevel()` sandbox branch                      → resetSandboxBoard
 */

import { objectRegistry } from '../objects/ObjectRegistry.js';

/**
 * Enter play: serialize the placed board, then rebuild the physics world
 * from the live placed objects.
 *
 * Must clear the world BEFORE adding: placed objects disposed by a previous
 * reset may have null bodies, and Matter's Composite.remove() chokes on null.
 *
 * @param {import('../engine/PhysicsEngine.js').PhysicsEngine|null} physics
 * @param {import('../objects/BaseObject.js').default[]} placedObjects — shared live board
 * @returns {object[]} Placed snapshot entries (what serialize() wrote at play start).
 */
export function beginPlay(physics, placedObjects) {
    const snapshot = placedObjects.map((o) => o.serialize());
    if (physics) {
        physics.clear();
        for (const obj of placedObjects) {
            physics.addObject(obj);
        }
    }
    return snapshot;
}

/**
 * Restore the player's machine from a placed snapshot.
 *
 * Deserialized non-fixed parts are appended to `placedObjects` (mutated in
 * place — the same array is shared with the renderer/drag-drop). Fixed
 * snapshot entries are skipped: fixed objects are rebuilt from level data.
 *
 * Never touches the physics world — bodies are re-added on next play.
 *
 * @param {import('../objects/BaseObject.js').default[]} placedObjects — shared live board
 * @param {object[]|null} snapshot — serialized placed data (from beginPlay)
 * @param {import('../objects/ObjectRegistry.js').ObjectRegistry} [registry]
 * @returns {import('../objects/BaseObject.js').default[]} restored instances
 */
export function restorePlacedFromSnapshot(placedObjects, snapshot, registry = objectRegistry) {
    const restored = [];
    for (const data of snapshot ?? []) {
        if (!data || data.isFixed) continue; // fixed objects are rebuilt from level data
        try {
            restored.push(registry.deserialize(data));
        } catch (e) {
            console.warn(`[App] Skipping un-restorable placed object "${data.type}":`, e);
        }
    }
    placedObjects.push(...restored);
    return restored;
}

/**
 * Sandbox reset: rewind the board to the state captured at the start of
 * the most recent play. Never destroys a sandbox that has not been played
 * yet (no snapshot → nothing to rewind to).
 *
 * Order matters: the physics world is cleared while the stale instances
 * still own their bodies (removeObject strips them from the world and then
 * disposes); clearing disposed objects would leak their bodies.
 *
 * @param {import('../engine/PhysicsEngine.js').PhysicsEngine|null} physics
 * @param {import('../objects/BaseObject.js').default[]} placedObjects — shared live board
 * @param {object[]|null} snapshot — serialized placed data (from beginPlay)
 * @param {import('../objects/ObjectRegistry.js').ObjectRegistry} [registry]
 * @returns {import('../objects/BaseObject.js').default[]} restored instances
 */
export function resetSandboxBoard(physics, placedObjects, snapshot, registry = objectRegistry) {
    if (!snapshot || snapshot.length === 0) return []; // no play happened — leave untouched

    physics?.clear();

    // Stale edit instances were already removed from (and disposed by) the
    // physics clear above — just drop them from the board.
    for (let i = placedObjects.length - 1; i >= 0; i--) {
        if (!placedObjects[i].isFixed) {
            placedObjects.splice(i, 1);
        }
    }

    return restorePlacedFromSnapshot(placedObjects, snapshot, registry);
}