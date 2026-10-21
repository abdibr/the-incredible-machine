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
 * Serialize the placed board with rope attachment tokens (issue 04).
 *
 * Each row is the object's own serialize() — ropes intentionally emit no
 * attachment data of their own — and the annotator then writes live knot
 * refs onto each rope's row as ordinal tokens:
 * `{ endpoint, targetType, targetOrdinal, pointId }`. The ordinal indexes
 * THIS array; board order is stable across play/reset cycles (fixed
 * objects rebuilt from level JSON first, placed parts restored in snapshot
 * order), which is what makes an ordinal restorable.
 *
 * @param {import('../objects/BaseObject.js').default[]} board — shared live board (fixed + placed, board order)
 * @returns {object[]} serialized rows (rope rows may carry `attachments`)
 */
export function serializePlacedBoard(board) {
    const entries = board.map((o) => o.serialize());
    const ordinalByObject = new Map(board.map((obj, index) => [obj, index]));
    for (let index = 0; index < board.length; index++) {
        const obj = board[index];
        if (obj.type !== 'rope' || typeof obj.getAttachmentRefs !== 'function') continue;
        const tokens = [];
        for (const ref of obj.getAttachmentRefs()) {
            // Target no longer on the board → the knot dies with it
            const ordinal = ordinalByObject.get(ref.target);
            if (ordinal === undefined) continue;
            tokens.push({
                endpoint: ref.endpoint,
                targetType: ref.target.type,
                targetOrdinal: ordinal,
                pointId: ref.pointId,
            });
        }
        if (tokens.length > 0) entries[index].attachments = tokens;
    }
    return entries;
}

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
    const snapshot = serializePlacedBoard(placedObjects);
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
    const rows = snapshot ?? [];
    for (const data of rows) {
        if (!data || data.isFixed) continue; // fixed objects are rebuilt from level data
        try {
            restored.push(registry.deserialize(data));
        } catch (e) {
            console.warn(`[App] Skipping un-restorable placed object "${data.type}":`, e);
        }
    }
    placedObjects.push(...restored);

    // Two-phase bind (issue 04): rope attachment tokens only resolve once
    // every row has come back — they index the full snapshot order, and the
    // rebuilt board (fixed from level JSON first, restored placed in
    // snapshot order) mirrors it one-to-one. On any count disagreement the
    // ordinals cannot be trusted: bind with no board so every token drops
    // with a warning, instead of tying across a shifted layout.
    const aligned = rows.length > 0 && placedObjects.length === rows.length;
    if (!aligned) {
        console.warn(
            `[App] Placed snapshot/board size mismatch (${rows.length} rows vs ${placedObjects.length} objects) — dropping attachment tokens.`
        );
    }
    for (const obj of restored) {
        if (typeof obj.bindAttachment === 'function') {
            obj.bindAttachment(aligned ? placedObjects : null);
        }
    }
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