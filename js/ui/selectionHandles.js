/**
 * selectionHandles — the state-driven selection handle set (issues #68, #67;
 * scene lock from ADR 0009, `docs/adr/0009-scene-lock-and-solution-scenes.md`)
 *
 * THE single source of truth for which selection handles a part offers:
 * the renderer derives both what it draws and what it hit-tests from these
 * rows, and the DragDropManager gates its move/rotate/delete/anchor verbs
 * against the same table — so offering, drawing, hit-testing and
 * interacting can never disagree again.
 *
 * An offered set derives from (part state × stage posture):
 * - part state — classified below across the four part states: `isFixed`
 *   pinning (#66), `isAnchored` scene content (#67), and `isScene` authored
 *   scene content (ADR 0009 — level-author board furniture from `fixedObjects`);
 *   this file is that integration surface, so future part states stay table rows.
 * - stage posture — SANDBOX authoring edits scenery in place, so pinned,
 *   anchored and scene parts keep their full handle set there (dragging a
 *   pinned goal bucket IS the goal-zone authoring move, #66). Everywhere
 *   else: a player-authored pinned part keeps only its pin, a player-authored
 *   anchored part only its anchor — the unpin/unanchor escape hatches for
 *   the player's OWN states — while authored scene parts (ADR 0009) offer
 *   NOTHING: not movable, not deletable, and no unpin/un-anchor route into
 *   a movable part — solving a level may not rearrange or un-author its
 *   contents.
 */

import { ROPE_FAMILY_TYPES } from '../objects/Rope.js';

/**
 * The canonical selection handle slots, in the order the renderer draws
 * them: move above the bounds, rotate to its right, delete to its left,
 * pin below — the pin slot mirroring the move slot across the bounds.
 * @type {string[]}
 */
export const SELECTION_HANDLES = Object.freeze(['move', 'rotate', 'delete', 'pin', 'anchor']);

/** A player-authored pinned part's handles outside sandbox authoring: only
 * the pin — the one affordance that can still unpin it (issue #66
 * follow-up). Authored scene parts offer nothing outside sandbox
 * (ADR 0009); the empty list is frozen so per-frame asks reuse it. */
const PINNED_OTHER_HANDLES = Object.freeze(['pin']);

/** An anchored part's handles outside sandbox authoring: only the anchor —
 * the one affordance that can still un-anchor it (issue #67), the same
 * boundary the pinned part's unpin escape hatch uses. */
const ANCHORED_OTHER_HANDLES = Object.freeze(['anchor']);

/** Authored scene content (ADR 0009) outside sandbox authoring: no handles
 * at all — no move, no delete, no unpin/un-anchor route into a movable
 * part. Solving a level may neither rearrange nor un-author its contents. */
const SCENE_OTHER_HANDLES = Object.freeze([]);

/**
 * Solid parts may anchor; the rope family is refused (issue #67 scope,
 * and ADR 0007 keeps it that way — ropes never offer the anchor handle
 * and the toggle refuses them). The refusal set derives from the rope
 * module's family fact (C1, issue #75): a new ROPE_FAMILY_TYPES member
 * arrives already anchor-refused, instead of leaving a hand-rolled type
 * pair to drift.
 */
const NON_ANCHOR_TYPES = Object.freeze(new Set(ROPE_FAMILY_TYPES));

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
 * @returns {'scene'|'movable'|'pinned'|'anchored'}
 */
export function partHandleState(obj) {
    // Scene classification wins (ADR 0009): authored scene content stays
    // scene whether the row pins it, anchors it or leaves it dynamic — the
    // player-locked posture answer keys on authorship, not the pin flags.
    if (obj.isScene) return 'scene';
    if (obj.isFixed) return 'pinned';
    if (obj.isAnchored) return 'anchored';
    return 'movable';
}

/** Handle rows per part state per stage posture. Sandbox authoring is the
 * one posture that edits fixed scenery in place; everywhere else a player-
 * authored pinned part keeps only its pin, a player-authored anchored part
 * only its anchor, and authored scene parts (ADR 0009) nothing at all.
 * Movable and anchored-capable player parts offer everything in all postures. */
const HANDLE_SETS = Object.freeze({
    movable: { sandbox: SELECTION_HANDLES, other: SELECTION_HANDLES },
    pinned: { sandbox: SELECTION_HANDLES, other: PINNED_OTHER_HANDLES },
    anchored: { sandbox: SELECTION_HANDLES, other: ANCHORED_OTHER_HANDLES },
    scene: { sandbox: SELECTION_HANDLES, other: SCENE_OTHER_HANDLES },
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
 * @param {object} data - the serialized row
 * @returns {{ angle: number, isFixed: boolean, isAnchored: boolean,
 *             isScene: boolean, customId: string|null }} options for objectRegistry.create
 */
export function levelObjectOptions(data) {
    return {
        angle: data.angle || 0,
        isFixed: data.isFixed === undefined ? true : !!data.isFixed,
        isAnchored: data.isFixed !== true && isAnchorCapableType(data.type) && !!data.isAnchored,
        // ADR 0009: every row rebuilt through the level/fixedObjects seams is
        // authored scene content — stamped so the handle table and the
        // placed-snapshot restore rule key on authorship, whichever pin
        // state the row carries.
        isScene: true,
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