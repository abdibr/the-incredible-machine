/**
 * recorder/schema — bug-file schema constants + normalization helpers.
 *
 * Pure, DOM-free, Node-safe: shared by the browser session recorder
 * (js/recorder/SessionRecorder.js) and the Node replay harness
 * (js/recorder/replay.js + scripts/replay-bugfile.mjs).
 *
 * Schema doc: docs/plans/session-bug-file-recorder.md
 * Decision log: docs/adr/0006-session-bug-file.md
 */

/** Download schema version — bump on any breaking field change. */
export const BUGFILE_SCHEMA_VERSION = 1;

/** Sample poses every Nth tick (~10 Hz at 60 fps). */
export const POSE_SAMPLE_INTERVAL = 6;

/** Dense mode: every tick (60 Hz) — the Editor panel's big-file toggle. */
export const POSE_DENSE_INTERVAL = 1;

/** Rolling pose-row budget per run: older rows drop when exceeded (~2 min dense). */
export const MAX_POSE_ROWS = 72000;

/** Crash-mirror cadence (ms) — the events-only localStorage projection. */
export const MIRROR_INTERVAL_MS = 2000;

/** Crash-mirror event cap — the projection keeps the LAST rows only. */
export const MIRROR_MAX_EVENT_ROWS = 4000;

/**
 * Bus topics recorded as the edit-time build trace (runs[] narrative context).
 * `mode:changed` is NOT here — the recorder's dedicated mode handler records
 * it (with the session arming/disarming on the same event, one row per event).
 * Payload normalization per topic lives in normalizeEditEvent().
 */
export const EDIT_TOPICS = Object.freeze([
    'object:placed',
    'object:moved',
    'object:rotated',
    'object:pinned',
    'object:anchored',
    'object:removed',
    'level:loaded',
]);

/**
 * Bus topics recorded as play events, appended to the currently open run.
 * Collision pairs are NOT here — they are captured by the recorder's own
 * Matter.Events.on(engine, 'collisionStart') hook (see SessionRecorder),
 * recorded under the "physics:collision" topic in the bug file. That keeps
 * the bus free of a dispatch-facing collision topic (ADR 0001) while still
 * giving the recorder the same one-per-new-contact signal the matrix sees.
 *
 * Command rows (`controls:reset`, `loop:speed`, `loop:pause`, `mode:changed`)
 * are recorded for narrative/semantics but excluded from replay comparison
 * (see REPLAYABLE_TOPICS): the harness consumes them, it does not re-emit them.
 */
export const PLAY_TOPICS = Object.freeze([
    'rope:severed',
    'rope:chain-converge',
    'rope:chain-spawned',
    'rope:unbundled',
    'balloon:popped',
    'bucket:caught',
    'goal:reached',
    'goal:failed',
    'physics:snapshot-mismatch',
    'controls:reset',
    'loop:speed',
    'loop:pause',
]);

/**
 * Run-event topics the replay harness can reproduce from the recorded
 * world + dt stream, and therefore compares between recorded and replayed
 * sessions. Everything else is narrative (commands, mode navigation).
 * `rope:chain-spawned` (issue #55) is play-recorded but NOT replayable: a
 * spawn is born of an edit-time tie, not of the dt stream — its
 * `rope:unbundled` counterpart is replayable (a collapse happens in play).
 */
export const REPLAYABLE_TOPICS = Object.freeze([
    'physics:collision',
    'rope:severed',
    'rope:chain-converge',
    'rope:unbundled',
    'balloon:popped',
    'bucket:caught',
    'goal:reached',
    'goal:failed',
    'physics:snapshot-mismatch',
]);

/** Round a pose component to 3 decimals (Q12b: compact rows, stable diffs). */
export function round3(n) {
    return Math.round(n * 1000) / 1000;
}

/** Round a dt value to 6 decimals (ms). */
export function roundDt(n) {
    return Math.round(n * 1e6) / 1e6;
}

/**
 * Stable cross-session reference for a board row (recording and replay agree
 * on it): the row's named id from level JSON when present, otherwise
 * `type@<boardOrdinal>`. Board order is stable (fixed rows first, placed rows
 * after — the same order serializePlacedBoard annotates rope tokens against).
 *
 * @param {object|string} rowOrType — serialized board row (or bare type string)
 * @param {number} ordinal — index of the row in board-snapshot order
 * @returns {string}
 */
export function refIdOfRow(rowOrType, ordinal) {
    if (typeof rowOrType === 'string') return `${rowOrType}@${ordinal}`;
    const id = rowOrType?.id;
    if (id) return String(id);
    return `${rowOrType?.type ?? '?'}@${ordinal}`;
}

/** Human-facing narrative ref for a live instance (build trace only). */
export function narrativeRef(type, instanceId) {
    return `${type}#${instanceId}`;
}

/**
 * Normalize a collisionStart Matter pair to plain display data:
 * each side becomes `{ ref, body, stat }` — the owning object's refId,
 * the body's Matter label (unchanged for boundary walls), and isStatic.
 * Unknown bodies (no mapping — i.e. boundary walls) keep their label as ref.
 */
export function normalizeCollisionSide(body, bodyRefMap) {
    const mapped = bodyRefMap.get(body.id);
    return {
        ref: mapped ? mapped.ref : body.label ?? `body-${body.id}`,
        body: body.label ?? null,
        stat: !!body.isStatic,
    };
}

/** Build the {fileId, createdAtUtc} id pair for a new session. */
export function newSessionIds(nowMs) {
    const date = new Date(nowMs ?? Date.now());
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    const y = date.getUTCFullYear();
    const mo = pad(date.getUTCMonth() + 1);
    const d = pad(date.getUTCDate());
    const h = pad(date.getUTCHours());
    const mi = pad(date.getUTCMinutes());
    const s = pad(date.getUTCSeconds());
    const slug = `${y}${mo}${d}T${h}${mi}${s}Z`;
    const rnd = Math.floor(Math.random() * 36 ** 4)
        .toString(36)
        .padStart(4, '0');
    return {
        fileId: `bug-${slug}-${rnd}`,
        createdAtUtc: date.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    };
}

/**
 * Canonical ordering of a collision pair's sides. Matter's bodyA/bodyB
 * orientation within a collisionStart pair is emergent (SAT/detector order,
 * which can differ when Matter body ids differ across sessions) — the
 * *simulation* is deterministic, the pair orientation is not, so the
 * recorder normalizes both directions to the same canonical order
 * (smaller ref first, then body label, then static flag).
 *
 * @param {{ref: string, body: string|null, stat: boolean}} sideA
 * @param {{ref: string, body: string|null, stat: boolean}} sideB
 * @returns {[sideA, sideB]}
 */
export function canonicalCollisionPair(sideA, sideB) {
    const key = (side) => `${side.ref}\u0000${side.body ?? ''}\u0000${side.stat ? 1 : 0}`;
    return key(sideA) <= key(sideB) ? [sideA, sideB] : [sideB, sideA];
}

/** localStorage mirror key prefix (the adapter carries the storage itself). */
export const MIRROR_KEY = 'tim-bugfile-mirror';