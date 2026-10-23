/**
 * SessionRecorder — always-on bug-file recorder for SANDBOX play (ADR 0006).
 *
 * DOM-free core, Node-safe (replay harness + vitest reuse this very class).
 * Subscribes on the shared eventBus, mirrors the GameLoop lifecycle from
 * `loop:play` / `loop:pause` / `controls:reset` / `mode:changed`, and
 * produces a self-contained JSON "bug file" for one sandbox visit:
 *
 *   { header..., build[], runs[] }  — build[] = edit trace (per-action object
 *   snapshots); runs[] = per-play board snapshot + recorded dt stream +
 *   normalized play events + sampled poses.
 *
 * The play-start board snapshot is the authoritative replay source; the
 * harness (js/recorder/replay.js) drives a second passive recorder instance
 * against a rebuilt engine and compares the streams — the tick/event
 * conventions therefore live in exactly one implementation: this file.
 *
 * Browser-only concerns (localStorage adapter, file download) live in
 * browser.js and are imported only by UI wiring.
 */

import Matter from 'matter-js';
import { eventBus } from '../EventBus.js';
import { serializePlacedBoard } from '../reset/levelReset.js';
import {
    BUGFILE_SCHEMA_VERSION,
    POSE_SAMPLE_INTERVAL,
    POSE_DENSE_INTERVAL,
    MAX_POSE_ROWS,
    MIRROR_INTERVAL_MS,
    MIRROR_MAX_EVENT_ROWS,
    MIRROR_KEY,
    EDIT_TOPICS,
    PLAY_TOPICS,
    round3,
    roundDt,
    refIdOfRow,
    narrativeRef,
    normalizeCollisionSide,
    canonicalCollisionPair,
    newSessionIds,
} from './schema.js';
import { APP_VERSION, userAgentString } from './meta.js';

const LOOP_STOPPED = 'stopped';
const LOOP_RUNNING = 'running';
const LOOP_PAUSED = 'paused';

/** Mode family one sandbox visit survives across (ADR 0006 decision 7). */
const SESSION_MODES = new Set(['SANDBOX', 'PLAYING', 'PAUSED', 'WON']);

export class SessionRecorder {
    /**
     * @param {object} [options]
     * @param {object|null} [options.mirrorStore] {get,set,remove} adapter
     * @param {boolean} [options.passive] true when driven by the replay
     *        harness: no mirror, no mode-driven arming — start/stopSession()
     *        are called explicitly.
     * @param {number} [options.maxPoseRows] rolling per-run pose budget
     */
    constructor({ mirrorStore = null, passive = false, maxPoseRows = MAX_POSE_ROWS } = {}) {
        this._mirrorStore = mirrorStore;
        this._passive = passive;
        this._maxPoseRows = maxPoseRows;

        /** @type {Array<() => void>} bus unsubs (installed by init) */
        this._unsubs = [];
        this._bound = false;
        this._active = false;

        /** deps injected via init() */
        this._getBoard = null;      // () => BaseObject[] — edit board, board order
        this._getSnapshot = null;   // () => board rows|null — beginPlay output if at hand
        this._getEngine = null;     // () => Matter engine|null
        this._getPlayfield = null;  // () => {width, height}|null
        this._getEngineInfo = null; // () => {gravityX, gravityY, enableSleeping}|null

        /** session state */
        this._fileId = null;
        this._createdAtUtc = null;
        this._notes = '';
        this._dense = false;
        this._build = [];
        this._runs = [];
        this._openRun = null;
        this._tick = 0;           // completed loop:frames within the open run
        this._seq = 0;
        this._loopState = LOOP_STOPPED;
        this._latestLevelId = null;
        this._latestGoal = null;

        /** crash-recovery stash (parsed mirror of the previous session) */
        this._crashed = null;

        /** collision hook bookkeeping: Matter engine → handler */
        this._hookedByEngine = new WeakMap();

        /** mirror throttling */
        this._lastMirrorAt = 0;
        this._mirrorTimer = null;
    }

    /** ── (part 2: init, lifecycle) ── */

    /**
     * Inject accessors and bind the bus. Idempotent like GoalChecker.init.
     * @param {object} deps
     * @param {() => BaseObject[]} deps.getBoard — the live placed board (array, board order)
     * @param {() => object[]|null} [deps.getSnapshot] — beginPlay's placed snapshot when available
     * @param {() => Matter.Engine|null} [deps.getEngine]
     * @param {() => ({width:number, height:number})|null} [deps.getPlayfield]
     * @param {() => object|null} [deps.getEngineInfo] — header engine facts
     * @param {object|null} [deps.mirrorStore] — {get,set,remove} (overrides ctor)
     */
    init({ getBoard, getSnapshot = null, getEngine = null, getPlayfield = null, getEngineInfo = null, mirrorStore = null } = {}) {
        this._getBoard = getBoard ?? this._getBoard;
        this._getSnapshot = getSnapshot ?? this._getSnapshot;
        this._getEngine = getEngine ?? this._getEngine;
        this._getPlayfield = getPlayfield ?? this._getPlayfield;
        this._getEngineInfo = getEngineInfo ?? this._getEngineInfo;
        if (mirrorStore) this._mirrorStore = mirrorStore;

        if (this._bound) return; // already wired
        this._bound = true;

        this._unsubs.push(eventBus.on('mode:changed', (packet) => this._onModeChanged(packet)));
        this._unsubs.push(eventBus.on('loop:play', () => this._onLoopPlay()));
        this._unsubs.push(eventBus.on('loop:pause', () => this._onLoopPause()));
        this._unsubs.push(eventBus.on('loop:frame', (packet) => this._onLoopFrame(packet)));
        // Generic topic recording — installed BEFORE the run-boundary close
        // listener below, so a `controls:reset` row lands in the closing run.
        for (const topic of PLAY_TOPICS) {
            this._unsubs.push(eventBus.on(topic, (packet) => this._onPlayTopic(topic, packet)));
        }
        for (const topic of EDIT_TOPICS) {
            this._unsubs.push(eventBus.on(topic, (packet) => this._onEditTopic(topic, packet)));
        }
        // Run boundary close — installed AFTER the generic topic recording
        // above, so the `controls:reset` row lands in the run it closes.
        this._unsubs.push(eventBus.on('controls:reset', () => this.closeOpenRun('controls:reset')));
        // `mode:changed` closing is handled inside _onModeChanged (it must
        // also end the session when the visit leaves the sandbox family).
    }

    /** Detach from the bus and stop mirroring. The buffers stay readable. */
    dispose() {
        this.stopSession();
        for (const unsub of this._unsubs) unsub();
        this._unsubs = [];
        this._bound = false;
        this._hookedByEngine = new WeakMap();
        if (this._mirrorTimer !== null) {
            clearTimeout(this._mirrorTimer);
            this._mirrorTimer = null;
        }
    }

    // ── Session lifecycle ─────────────────────────

    /** Begin recording a fresh sandbox session (idempotent while active). */
    startSession() {
        if (this._active) return;
        const { fileId, createdAtUtc } = newSessionIds();
        this._fileId = fileId;
        this._createdAtUtc = createdAtUtc;
        this._build = [];
        this._runs = [];
        this._openRun = null;
        this._tick = 0;
        this._seq = 0;
        this._loopState = LOOP_STOPPED;
        this._latestLevelId = null;
        this._latestGoal = null;
        this._active = true;
    }

    /** End the session; an open run is closed first (still exportable). */
    stopSession() {
        if (!this._active) return;
        this.closeOpenRun('mode:changed');
        this._writeMirrorNow(); // final flush while still active
        this._active = false;
    }

    /** @returns {boolean} */
    get active() {
        return this._active;
    }

    /**
     * Arms automatically when the app enters a sandbox visit from the MENU
     * and disarms when it leaves the sandbox family (ADR 0006 decision 7).
     * @private
     */
    _onModeChanged({ oldMode, newMode } = {}) {
        if (!this._passive && newMode === 'SANDBOX' && (oldMode === 'MENU' || oldMode == null)) {
            this._stashCrashedFromMirror();
            this.startSession();
        }
        if (!this._active) return;
        // The mode row belongs to the run it closes.
        this._recordInContext('mode:changed', { oldMode: oldMode ?? null, newMode: newMode ?? null });
        if (!SESSION_MODES.has(newMode)) {
            this.stopSession();
        }
    }

    // ── Loop-state mirroring / run boundaries ─────

    /** @private */
    _onLoopPlay() {
        if (!this._active) return;
        if (this._loopState === LOOP_STOPPED) this._startRun();
        this._loopState = LOOP_RUNNING;
    }

    /** @private */
    _onLoopPause() {
        if (!this._active) return;
        this._loopState = LOOP_PAUSED;
    }

    /** @private */
    _onLoopFrame({ dt = 0 } = {}) {
        if (!this._active || !this._openRun) return;
        this._loopState = LOOP_RUNNING;
        const run = this._openRun;
        this._tick++;
        run.lastTick = this._tick;
        // Recorded UNROUNDED: the replay steps this exact double (bit-exact
        // dt is the whole point — ADR 0006 decision 2). JSON round-trips
        // doubles losslessly; rounding would silently break reproduction.
        run.dt.values.push(dt);
        if (this._tick % run.poses.interval === 0) {
            run.poses.rows.push([this._tick, this._sampleCells(run)]);
        }
        if (run.poses.rows.length > this._maxPoseRows) {
            run.poses.rows.splice(0, run.poses.rows.length - this._maxPoseRows);
            run.poses.posesTruncated = true;
        }
        this._scheduleMirror();
    }

    /** ── (part 3: run machinery) ── */

    /**
     * Close the open run (run-ends marker). Safe to call freely.
     * @param {string} endedBy — 'controls:reset' | 'mode:changed' | 'open-at-export' | 'replay-end'
     * @returns {object|null} the closed run
     */
    closeOpenRun(endedBy = 'controls:reset') {
        const run = this._openRun;
        if (!run) return null;
        run.endedBy = endedBy;
        this._openRun = null;
        this._tick = 0;
        this._loopState = LOOP_STOPPED;
        return run;
    }

    /** @returns {object|null} the currently open run (tests/harness access) */
    get openRun() {
        return this._openRun;
    }

    /** @returns {object|null} a recorded run by index */
    getRun(index) {
        return this._runs[index] ?? null;
    }

    /**
     * Open a run: capture the play-start board snapshot + ref tables, reset
     * the tick counter, and hook the engine's collisionStart (once per engine).
     * (Named _startRun: the `_openRun` field holds the opened run.)
     * @private
     */
    _startRun() {
        const board = this._getBoard ? this._getBoard() : [];
        const rows = (this._getSnapshot ? this._getSnapshot() : null) ?? serializePlacedBoard(board);
        const safeRows = Array.isArray(rows) ? rows : [];
        const refTable = safeRows.map((row, ordinal) => ({ ref: refIdOfRow(row, ordinal), type: row?.type ?? null }));
        const instanceRef = new Map();
        const bodiesById = new Map();
        for (let i = 0; i < board.length; i++) {
            const obj = board[i];
            if (!obj || !refTable[i]) continue;
            instanceRef.set(obj, refTable[i].ref);
            for (const body of obj.bodies ?? []) {
                if (!body) continue;
                bodiesById.set(body.id, { ref: refTable[i].ref, label: body.label ?? null, isStatic: !!body.isStatic });
            }
        }
        this._tick = 0;
        this._openRun = {
            index: this._runs.length,
            refTable,
            instanceRef,
            bodiesById,
            boardSnapshot: safeRows,
            dt: { policy: 'recorded', values: [] },
            events: [],
            timeScale: [],
            poses: {
                interval: this._dense ? POSE_DENSE_INTERVAL : POSE_SAMPLE_INTERVAL,
                rows: [],
                posesTruncated: false,
            },
            goal: this._latestGoal,
            levelId: this._latestLevelId,
            lastTick: 0,
            endedBy: null,
        };
        this._runs.push(this._openRun);
        this._attachCollisionHook();
    }

    /**
     * Collision capture (ADR 0006 decision 4): the recorder owns the
     * Matter-side hook; dispatch still routes only through the matrix.
     * @private
     */
    _attachCollisionHook() {
        const engine = this._getEngine ? this._getEngine() : null;
        if (!engine || this._hookedByEngine.has(engine)) return;
        const handler = (ev) => this._onCollisionStart(ev);
        this._hookedByEngine.set(engine, handler);
        Matter.Events.on(engine, 'collisionStart', handler);
    }

    /** @private */
    _onCollisionStart(ev) {
        const run = this._openRun;
        if (!run) return;
        for (const pair of ev.pairs ?? []) {
            const [a, b] = canonicalCollisionPair(
                normalizeCollisionSide(pair.bodyA, run.bodiesById),
                normalizeCollisionSide(pair.bodyB, run.bodiesById),
            );
            this._recordInContext('physics:collision', { a, b });
        }
    }

    /** ── (part 4: topic recording + normalization) ── */

    /** Record into the open run, else into the build trace. @private */
    _recordInContext(topic, data) {
        if (this._openRun) {
            this._openRun.events.push({ seq: this._seq++, tick: this._tick, topic, data });
        } else if (this._active) {
            this._build.push({ seq: this._seq++, topic, data });
        }
        this._scheduleMirror();
    }

    /** Play-topic entry point: normalize + record. @private */
    _onPlayTopic(topic, packet) {
        this._recordInContext(topic, this._normalizePlayEvent(topic, packet, this._openRun));
    }

    /** Edit-topic entry point (build trace; or open-run context rows). @private */
    _onEditTopic(topic, packet) {
        if (!this._active) return;
        if (topic === 'level:loaded') {
            this._latestLevelId = packet?.id ?? null;
            this._latestGoal = packet?.goal ?? null;
        }
        this._recordInContext(topic, this._normalizeEditEvent(topic, packet));
    }

    /**
     * Normalize a play packet to plain, Matter-id-free data —
     * refs resolve through the open run's board-order tables.
     * @private
     */
    _normalizePlayEvent(topic, packet, run) {
        const refOf = (obj) => (run && run.instanceRef.get(obj)) ?? null;
        switch (topic) {
            case 'rope:severed':
                return { ref: refOf(packet?.rope) };
            case 'rope:chain-converge':
                return { ref: refOf(packet?.rope) };
            case 'balloon:popped':
                return { ref: refOf(packet?.balloon) };
            case 'bucket:caught':
                return {
                    bucket: refOf(packet?.bucket),
                    caught: refOf(packet?.object),
                    total: packet?.totalCaught ?? packet?.total ?? null,
                };
            case 'goal:reached':
                return { levelId: packet?.levelId ?? null };
            case 'goal:failed':
                return { levelId: packet?.levelId ?? null, reason: packet?.reason ?? null };
            case 'physics:snapshot-mismatch':
                // Matter body ids do not survive the session — counts only.
                return {
                    snapshotMissed: packet?.unmatchedSnapshotBodyIds?.length ?? 0,
                    liveMissed: packet?.unmatchedLiveBodyIds?.length ?? 0,
                };
            case 'controls:reset':
                return {};
            case 'loop:speed':
                if (run) run.timeScale.push({ tick: this._tick, speed: packet?.speed ?? 1 });
                return { speed: packet?.speed ?? null };
            case 'loop:pause':
                return { elapsed: packet?.elapsed ?? null };
            default:
                return _plainData(packet);
        }
    }

    /** ── (part 4b: edit normalization + sampling) ── */

    /**
     * Normalize an edit packet. `object:placed` carries the live object, so
     * its snapshot (serialize + rope attachment refs) captures the exact
     * post-snap state the toolbox drop produced.
     * @private
     */
    _normalizeEditEvent(topic, packet) {
        switch (topic) {
            case 'object:placed': {
                const obj = packet?.object;
                return {
                    ref: obj ? narrativeRef(obj.type, obj.id) : `?#${packet?.id ?? '?'}`,
                    type: obj?.type ?? packet?.type ?? null,
                    snapshot: obj ? this._serializeWithAttachments(obj) : null,
                };
            }
            case 'object:moved': {
                const obj = this._findBoardObjectById(packet?.id);
                return {
                    ref: obj ? narrativeRef(obj.type, obj.id) : `?#${packet?.id ?? '?'}`,
                    x: packet?.x ?? null,
                    y: packet?.y ?? null,
                    snapshot: obj ? this._serializeWithAttachments(obj) : null,
                };
            }
            case 'object:rotated': {
                const obj = this._findBoardObjectById(packet?.id);
                return {
                    ref: obj ? narrativeRef(obj.type, obj.id) : `?#${packet?.id ?? '?'}`,
                    angle: packet?.angle ?? null,
                    snapshot: obj ? this._serializeWithAttachments(obj) : null,
                };
            }
            case 'object:removed':
                return { ref: narrativeRef(packet?.type ?? '?', packet?.id ?? '?'), type: packet?.type ?? null };
            case 'level:loaded':
                return { levelId: packet?.id ?? null, name: packet?.name ?? null, goal: packet?.goal ?? null };
            case 'mode:changed':
                return { oldMode: packet?.oldMode ?? null, newMode: packet?.newMode ?? null };
            default:
                return _plainData(packet);
        }
    }

    /** serialize() + rope knot refs as narrative tokens. */
    _serializeWithAttachments(obj) {
        try {
            const data = obj.serialize();
            if (obj.type === 'rope' && typeof obj.getAttachmentRefs === 'function') {
                data.attachments = obj.getAttachmentRefs().map((t) => ({
                    endpoint: t.endpoint,
                    target: t.target ? narrativeRef(t.target.type, t.target.id) : null,
                    pointId: t.pointId,
                }));
            }
            return data;
        } catch (e) {
            return { type: obj?.type ?? null, serializeError: String(e) };
        }
    }

    /** Resolve a numeric instance id against the current edit board. */
    _findBoardObjectById(id) {
        const board = this._getBoard ? this._getBoard() : [];
        for (const obj of board) {
            if (obj && obj.id === id) return obj;
        }
        return null;
    }

    /** Pose sample: one cell row per live body [ref, label, x, y, a, vx, vy]. */
    _sampleCells(run) {
        const cells = [];
        for (const obj of run.instanceRef.keys()) {
            const ref = run.instanceRef.get(obj);
            for (const body of obj.bodies ?? []) {
                if (!body?.position) continue;
                cells.push([
                    ref,
                    body.label ?? null,
                    round3(body.position.x),
                    round3(body.position.y),
                    round3(body.angle),
                    round3(body.velocity.x),
                    round3(body.velocity.y),
                ]);
            }
        }
        return cells;
    }

    /** ── (part 5: mirror, recovery, export) ── */

    // ── Crash-survival mirror (ADR 0006 decision 8) ──

    /**
     * Throttled (~2 s) events-only mirror on the injected store. The mirror
     * is the recovery projection: header + notes + build + per-run events +
     * dt stream — never poses (too big) and never Matter internals.
     */
    _scheduleMirror() {
        if (this._passive || !this._mirrorStore || !this._active) return;
        const now = Date.now();
        const since = now - this._lastMirrorAt;
        if (since >= MIRROR_INTERVAL_MS) {
            this._writeMirrorNow();
            return;
        }
        if (this._mirrorTimer === null) {
            this._mirrorTimer = setTimeout(() => {
                this._mirrorTimer = null;
                if (this._active) this._writeMirrorNow();
            }, MIRROR_INTERVAL_MS - since);
        }
    }

    /** Immediate mirror write (throttle bypass; flush before unload). */
    _writeMirrorNow() {
        if (this._passive || !this._mirrorStore || !this._active) return;
        this._lastMirrorAt = Date.now();
        try {
            this._mirrorStore.set(MIRROR_KEY, JSON.stringify(this._mirrorView(this._fileId ?? 'none')));
        } catch (e) {
            console.warn('[BugFile] mirror write failed:', e);
        }
    }

    /** Immediate mirror write, ignoring throttle (used by beforeunload). */
    flushMirror() {
        if (this._passive || !this._mirrorStore) return;
        if (this._active) this._writeMirrorNow();
    }

    /** @private — the events-only projection, per-run rows capped. */
    _mirrorView(fileId) {
        return {
            kind: 'bugfile-mirror',
            ...this._headerFor(fileId),
            notes: this._notes,
            context: this._contextOf(),
            build: this._build,
            runs: this._runs.map((run) => {
                const truncate = (rows) => (rows.length > MIRROR_MAX_EVENT_ROWS
                    ? rows.slice(rows.length - MIRROR_MAX_EVENT_ROWS)
                    : rows);
                return {
                    ...this._runToDoc(run, { recovered: true }),
                    dt: { policy: run.dt.policy, values: truncate(run.dt.values) },
                    events: truncate(run.events),
                    poses: {
                        interval: run.poses.interval,
                        rows: [],
                        posesTruncated: true,
                        posesLostToCrash: true,
                    },
                };
            }),
        };
    }

    // ── Crash recovery (previous-session stash) ───

    /**
     * Stash the previous session's mirror (parsed) before a fresh session
     * starts overwriting the same key. @private
     */
    _stashCrashedFromMirror() {
        if (this._passive || !this._mirrorStore) return;
        try {
            const raw = this._mirrorStore.get(MIRROR_KEY);
            if (!raw) return;
            const parsed = JSON.parse(raw);
            if (parsed?.kind === 'bugfile-mirror' && parsed?.fileId && parsed.fileId !== this._fileId) {
                this._crashed = parsed;
            }
        } catch (e) {
            // Corrupt mirror — drop it silently; nothing recoverable.
            try { this._mirrorStore.remove(MIRROR_KEY); } catch (_e) { /* ignore */ }
        }
    }

    /** @returns {boolean} a crashed/reloaded session is awaiting recovery */
    get hasCrashedSession() {
        return this._crashed !== null;
    }

    /** @returns {object|null} the crashed session document (read-only view) */
    getCrashedSession() {
        return this._crashed;
    }

    /**
     * Consume the crashed session as a downloadable export.
     * @returns {{filename: string, json: string}|null}
     */
    exportCrashedSession() {
        if (!this._crashed) return null;
        const doc = this._crashed;
        this._crashed = null;
        return {
            filename: `recovered-${doc.fileId}.json`,
            json: JSON.stringify(doc, null, 2),
        };
    }

    /** Discard the crashed-session stash without exporting. */
    discardCrashedSession() {
        this._crashed = null;
    }

    /** ── (part 6: export, status, options) ── */

    // ── Export ────────────────────────────────────

    /** @private — header fields shared by export and mirror. */
    _headerFor(fileId) {
        const playfield = this._getPlayfield ? this._getPlayfield() : null;
        const info = this._getEngineInfo ? this._getEngineInfo() : null;
        return {
            schemaVersion: BUGFILE_SCHEMA_VERSION,
            fileId: fileId ?? null,
            createdAtUtc: this._createdAtUtc,
            appVersion: APP_VERSION,
            matterVersion: Matter.version,
            userAgent: userAgentString(),
            playfield: playfield ? { width: playfield.width, height: playfield.height } : null,
            engine: {
                gravityX: info?.gravityX ?? 0,
                gravityY: info?.gravityY ?? 1,
                enableSleeping: info?.enableSleeping ?? true,
            },
        };
    }

    /** @private */
    _contextOf() {
        return {
            mode: 'SANDBOX',
            levelId: this._latestLevelId,
            goal: this._latestGoal,
            dense: this._dense,
        };
    }

    /**
     * Explicit run → plain-document mapping (internal Maps and live-object
     * refs stay OUT of any export — Maps JSON-serialize as {} and live
     * object refs are cyclic).
     * @private
     */
    _runToDoc(run, { recovered = false } = {}) {
        return {
            index: run.index,
            refTable: run.refTable,
            boardSnapshot: run.boardSnapshot,
            dt: { policy: run.dt.policy, values: run.dt.values },
            timeScale: run.timeScale,
            events: run.events,
            poses: {
                interval: run.poses.interval,
                rows: run.poses.rows,
                posesTruncated: run.poses.posesTruncated,
            },
            goal: run.goal,
            levelId: run.levelId,
            lastTick: run.lastTick,
            endedBy: run.endedBy ?? (recovered ? 'open-at-crash' : null),
        };
    }

    /** The full bug-file document. @returns {object} */
    toJSON() {
        return {
            ...this._headerFor(this._fileId),
            notes: this._notes,
            context: this._contextOf(),
            build: this._build,
            runs: this._runs.map((run) => this._runToDoc(run)),
        };
    }

    /**
     * Export the session as a downloadable JSON payload. An open run is
     * closed first, marked `open-at-export`.
     * @returns {{filename: string, json: string}}
     */
    exportSession() {
        this.closeOpenRun('open-at-export');
        this._writeMirrorNowIfActive();
        const slug = this._fileId ?? 'bugfile';
        return {
            filename: `bugfile-${slug}.json`,
            json: JSON.stringify(this.toJSON(), null, 2),
        };
    }

    /** @private — export mirrors even when the session is mid-stop. */
    _writeMirrorNowIfActive() {
        if (this._active) this._writeMirrorNow();
    }

    // ── Options / status ──────────────────────────

    get notes() {
        return this._notes;
    }

    /** Free-text bug notes exported into the file (Q9b). */
    set notes(text) {
        this._notes = String(text ?? '').slice(0, 2000);
        this._scheduleMirror();
    }

    /** @returns {boolean} dense (60 Hz) pose sampling for FUTURE runs */
    get dense() {
        return this._dense;
    }

    set dense(value) {
        this._dense = !!value;
        this._scheduleMirror();
    }

    /** UI status snapshot for the Editor panel line. */
    status() {
        return {
            active: this._active,
            fileId: this._fileId,
            dense: this._dense,
            buildEvents: this._build.length,
            openRun: this._openRun !== null,
            crashedSession: this.hasCrashedSession,
            runs: this._runs.map((run) => ({
                index: run.index,
                ticks: run.lastTick,
                events: run.events.length,
                poses: run.poses.rows.length,
                endedBy: run.endedBy ?? '(open)',
            })),
        };
    }
}

/** Drop non-JSON-safe (object/array) values from an unknown packet. */
function _plainData(packet) {
    if (packet == null || typeof packet !== 'object') return packet ?? null;
    const out = {};
    for (const [key, value] of Object.entries(packet)) {
        if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
            out[key] = value;
        }
    }
    return out;
}

/** Singleton recorder (armed by main.js wiring, driven by the Editor panel). */
export const sessionRecorder = new SessionRecorder();
export default SessionRecorder;