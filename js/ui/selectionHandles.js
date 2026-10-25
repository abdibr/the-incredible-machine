/**
 * selectionHandles — the state-driven selection handle set (issue #68)
 *
 * THE single source of truth for which selection handles a part offers:
 * the renderer derives both what it draws and what it hit-tests from these
 * rows, and the DragDropManager gates its move/rotate/delete verbs against
 * the same table — so offering, drawing, hit-testing and interacting can
 * never disagree again.
 *
 * An offered set derives from (part state × stage posture):
 * - part state — classified below on `isFixed` pinning (#66); the future
 *   anchored parts of issue #67 add their own row here without touching
 *   any drawing, hit-testing or interaction code (this file is the #67
 *   integration surface).
 * - stage posture — SANDBOX authoring edits scenery in place, so fixed
 *   parts keep their full handle set there (dragging a pinned goal bucket
 *   IS the goal-zone authoring move, #66); every other stage leaves a
 *   pinned part only its pin handle — the unpin escape hatch.
 */

/**
 * The canonical selection handle slots, in the order the renderer draws
 * them: move above the bounds, rotate to its right, delete to its left,
 * pin below — the pin slot mirroring the move slot across the bounds.
 * @type {string[]}
 */
export const SELECTION_HANDLES = Object.freeze(['move', 'rotate', 'delete', 'pin']);

/** A fixed part's handles outside sandbox authoring: only the pin — the
 * one affordance that can still unpin it (issue #66 follow-up). */
const PINNED_OTHER_HANDLES = Object.freeze(['pin']);

/**
 * Classify a part's state into the handle-table row name. The one seam
 * future part states arrive at: #67's anchored parts get a row in the
 * table without any consumer change. Non-null part expected; the policy
 * function short-circuits a missing selection itself.
 * @param {BaseObject} obj
 * @returns {'movable'|'pinned'}
 */
export function partHandleState(obj) {
    return obj.isFixed ? 'pinned' : 'movable';
}

/** Handle rows per part state per stage posture. Sandbox authoring is the
 * one posture that edits fixed scenery in place; everywhere else a fixed
 * part keeps only its pin. Movable parts always offer everything. */
const HANDLE_SETS = Object.freeze({
    movable: { sandbox: SELECTION_HANDLES, other: SELECTION_HANDLES },
    pinned: { sandbox: SELECTION_HANDLES, other: PINNED_OTHER_HANDLES },
});

/**
 * The selection handle set a part offers: every handle name the selection
 * UI may draw / hit-test / act on for `obj` in stage mode `mode`.
 * @param {BaseObject|null} obj — the part in question
 * @param {string|null} [mode] — the active stage mode ('SANDBOX', 'EDITING',
 *   'MENU', …); anything but 'SANDBOX' resolves to the non-authoring posture
 * @returns {string[]} handle names, in draw/slot order
 */
export function selectionHandleSet(obj, mode = null) {
    if (!obj) return Object.freeze([]);
    return HANDLE_SETS[partHandleState(obj)][mode === 'SANDBOX' ? 'sandbox' : 'other'];
}