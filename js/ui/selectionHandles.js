/**
 * selectionHandles — the state-driven selection handle set (issues #68, #67)
 *
 * THE single source of truth for which selection handles a part offers:
 * the renderer derives both what it draws and what it hit-tests from these
 * rows, and the DragDropManager gates its move/rotate/delete/anchor verbs
 * against the same table — so offering, drawing, hit-testing and
 * interacting can never disagree again.
 *
 * An offered set derives from (part state × stage posture):
 * - part state — classified below across the three part states: `isFixed`
 *   pinning (#66) and `isAnchored` scene content (#67); this file is that
 *   integration surface, so future part states stay table rows.
 * - stage posture — SANDBOX authoring edits scenery in place, so pinned and
 *   anchored parts keep their full handle set there (dragging a pinned goal
 *   bucket IS the goal-zone authoring move, #66); every other stage leaves
 *   a pinned part only its pin handle and an anchored part only its anchor
 *   handle — the unpin/unanchor escape hatches.
 */

/**
 * The canonical selection handle slots, in the order the renderer draws
 * them: move above the bounds, rotate to its right, delete to its left,
 * pin below — the pin slot mirroring the move slot across the bounds.
 * @type {string[]}
 */
export const SELECTION_HANDLES = Object.freeze(['move', 'rotate', 'delete', 'pin', 'anchor']);

/** A fixed part's handles outside sandbox authoring: only the pin — the
 * one affordance that can still unpin it (issue #66 follow-up). */
const PINNED_OTHER_HANDLES = Object.freeze(['pin']);

/** An anchored part's handles outside sandbox authoring: only the anchor —
 * the one affordance that can still un-anchor it (issue #67), the same
 * boundary the pinned part's unpin escape hatch uses. */
const ANCHORED_OTHER_HANDLES = Object.freeze(['anchor']);

/**
 * Solid parts may anchor; the rope family is out of scope until its
 * connector redesign (issue #67) — ropes never offer the anchor handle and
 * the toggle refuses them.
 */
const NON_ANCHOR_TYPES = Object.freeze(new Set(['rope', 'free-rope']));

/**
 * Whether a part of `type` may be anchored at all (issue #67 scope).
 * @param {string} type
 * @returns {boolean}
 */
export function isAnchorCapableType(type) {
    return typeof type === 'string' && !NON_ANCHOR_TYPES.has(type);
}

/**
 * Whether this part may be anchored (convenience over isAnchorCapableType).
 * @param {BaseObject} obj
 * @returns {boolean}
 */
export function isAnchorCapable(obj) {
    return !!obj && isAnchorCapableType(obj.type);
}

/**
 * Classify a part's state into the handle-table row name. The one seam
 * future part states arrive at: a new state is a new row here. Non-null
 * part expected; the policy function short-circuits a missing selection
 * itself. Pinned classification wins when the flags disagree (a state the
 * affordances never produce — they keep pinned and anchored exclusive — so
 * a hand-written row with both flags acts play-static, the safe reading).
 * @param {BaseObject} obj
 * @returns {'movable'|'pinned'|'anchored'}
 */
export function partHandleState(obj) {
    if (obj.isFixed) return 'pinned';
    if (obj.isAnchored) return 'anchored';
    return 'movable';
}

/** Handle rows per part state per stage posture. Sandbox authoring is the
 * one posture that edits fixed scenery in place; everywhere else a pinned
 * part keeps only its pin and an anchored part only its anchor. Movable and
 * anchored-capable parts offer everything in all postures. */
const HANDLE_SETS = Object.freeze({
    movable: { sandbox: SELECTION_HANDLES, other: SELECTION_HANDLES },
    pinned: { sandbox: SELECTION_HANDLES, other: PINNED_OTHER_HANDLES },
    anchored: { sandbox: SELECTION_HANDLES, other: ANCHORED_OTHER_HANDLES },
});

// Rope scope exclusion (issue #67): ropes resolve their rows like any part,
// but the anchor handle is filtered out — precomputed frozen twins so the
// common solid path returns the canonical arrays untouched (no per-frame
// allocation) and the rope path returns a stable frozen array as well.
const ANCHORLESS_TWINS = new Map();
function anchorless(handles) {
    let twin = ANCHORLESS_TWINS.get(handles);
    if (!twin) {
        twin = Object.freeze(handles.filter((name) => name !== 'anchor'));
        ANCHORLESS_TWINS.set(handles, twin);
    }
    return twin;
}

/**
 * The rebuild-row options for a serialized level/fixedObjects row (issue #67 —
 * the one rule main.js `_setupLevel`, EditorPanel `_applyLoadedLevel` and the
 * agent harness share, so every board rebuild agrees on part state):
 * - legacy rows (carry no `isFixed`) keep today's behavior: forced-fixed
 *   scenery, exactly what `_setupLevel` always built;
 * - rows carrying `isFixed` keep it (pinned rows reload static, un-pinned
 *   anchored rows reload play-dynamic);
 * - `isAnchored` rides along only for anchor-capable solid rows, and never
 *   on a fixed one (the states are exclusive — pinned absorbs the anchor).
 * @param {object} data — the serialized row
 * @returns {{ angle: number, isFixed: boolean, isAnchored: boolean,
 *             customId: string|null }} options for objectRegistry.create
 */
export function levelObjectOptions(data) {
    return {
        angle: data.angle || 0,
        isFixed: data.isFixed === undefined ? true : !!data.isFixed,
        isAnchored: data.isFixed !== true && isAnchorCapableType(data.type) && !!data.isAnchored,
        customId: data.id,
    };
}

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
    const row = HANDLE_SETS[partHandleState(obj)];
    const handles = row[mode === 'SANDBOX' ? 'sandbox' : 'other'];
    return isAnchorCapable(obj) ? handles : anchorless(handles);
}