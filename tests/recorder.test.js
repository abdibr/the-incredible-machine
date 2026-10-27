/**
 * SessionRecorder + schema tests (ADR 0006).
 *
 * Every test uses FRESH recorder instances (never the app singleton) so the
 * shared eventBus's per-test subscriptions stay isolated.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eventBus } from '../js/EventBus.js';
import { objectRegistry } from '../js/objects/ObjectRegistry.js';
import { registerAllObjects } from '../js/objects/registerAllObjects.js';
import { SessionRecorder } from '../js/recorder/SessionRecorder.js';
import Balloon from '../js/objects/Balloon.js';
import {
    BUGFILE_SCHEMA_VERSION,
    MAX_POSE_ROWS,
    MIRROR_KEY,
    canonicalCollisionPair,
    normalizeCollisionSide,
    newSessionIds,
    refIdOfRow,
    round3,
    roundDt,
} from '../js/recorder/schema.js';

registerAllObjects();

/** Fresh passive-free recorder with injected deps. */
function makeRecorder({ board = null, mirrorStore = null } = {}, options = {}) {
    const recorder = new SessionRecorder(options);
    recorder.init({
        getBoard: () => board ?? [],
        getPlayfield: () => ({ width: 1000, height: 600 }),
        getEngineInfo: () => ({ gravityX: 0, gravityY: 1, enableSleeping: true }),
        mirrorStore,
    });
    return recorder;
}

/** Simple localStorage-shaped store for mirror tests. */
function makeStore() {
    const map = new Map();
    return {
        get: (key) => (map.has(key) ? map.get(key) : null),
        set: (key, value) => map.set(key, value),
        remove: (key) => map.delete(key),
        map,
    };
}

/** A real two-object sandbox board (ramp below, ball above-right). */
function realBoard() {
    return [
        objectRegistry.create('ramp', 500, 300, { angle: 0.35 }),
        objectRegistry.create('ball', 520, 80),
    ];
}

afterEach(() => {
    vi.useRealTimers();
});

describe('recorder/schema helpers', () => {
    it('prefers a board row’s named id for the refId, else type@ordinal', () => {
        expect(refIdOfRow({ type: 'bucket', id: 'bucket-goal' }, 7)).toBe('bucket-goal');
        expect(refIdOfRow({ type: 'ball' }, 3)).toBe('ball@3');
        expect(refIdOfRow('rope', 5)).toBe('rope@5');
    });

    it('rounds pose components to 3 decimals and dt to 6', () => {
        expect(round3(512.30991)).toBe(512.31);
        expect(round3(-0.00049)).toBe(-0); // rounds to zero
        expect(roundDt(16.666666666)).toBe(16.666667);
        expect(roundDt(0.05)).toBe(0.05);
    });

    it('normalizes collision sides: mapped refs, wall fallback', () => {
        const map = new Map([[11, { ref: 'ball@1', label: 'ball', isStatic: false }]]);
        expect(normalizeCollisionSide({ id: 11, label: 'ball', isStatic: false }, map)).toEqual({
            ref: 'ball@1', body: 'ball', stat: false,
        });
        // Boundary walls have no mapping — they record as their own label
        expect(normalizeCollisionSide({ id: 99, label: 'wall-floor', isStatic: true }, map)).toEqual({
            ref: 'wall-floor', body: 'wall-floor', stat: true,
        });
    });

    it('canonicalizes collision pair order (Matter orientation is emergent)', () => {
        const ball = { ref: 'ball@1', body: 'ball', stat: false };
        const wall = { ref: 'wall-floor', body: 'wall-floor', stat: true };
        expect(canonicalCollisionPair(ball, wall)).toEqual([ball, wall]);
        expect(canonicalCollisionPair(wall, ball)).toEqual([ball, wall]); // order-independent
    });

    it('builds the header id pair', () => {
        const { fileId, createdAtUtc } = newSessionIds();
        expect(fileId).toMatch(/^bug-\d{8}T\d{6}Z-[a-z0-9]{4}$/);
        expect(createdAtUtc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    });
});

describe('SessionRecorder session lifecycle', () => {
    it('arms automatically on MENU→SANDBOX and records the build trace', () => {
        const recorder = makeRecorder();
        eventBus.emit('mode:changed', { oldMode: 'MENU', newMode: 'SANDBOX' });
        expect(recorder.active).toBe(true);

        const ball = objectRegistry.create('ball', 300, 200);
        eventBus.emit('object:placed', { type: 'ball', id: ball.id, object: ball });
        const doc = recorder.toJSON();
        // build[0] = the visit-start mode row, then the placement
        expect(doc.build).toHaveLength(2);
        expect(doc.build[0].topic).toBe('mode:changed');
        expect(doc.build[1].topic).toBe('object:placed');
        expect(doc.build[1].data.ref).toBe(`ball#${ball.id}`);
        expect(doc.build[1].data.snapshot.type).toBe('ball');

        // Leaving the sandbox family ends the session (the closing mode row
        // lands in the build trace of the ended session)
        eventBus.emit('mode:changed', { oldMode: 'SANDBOX', newMode: 'EDITING' });
        expect(recorder.active).toBe(false);
        expect(recorder.toJSON().build).toHaveLength(3);
        expect(recorder.toJSON().build[2].topic).toBe('mode:changed');
        recorder.dispose();
    });

    it('ignores edit events while inactive and re-arms fresh', () => {
        const recorder = makeRecorder();
        eventBus.emit('object:placed', { type: 'ball', id: 1, object: { type: 'ball', id: 1, serialize() { return {}; } } });
        expect(recorder.toJSON().build).toHaveLength(0);

        eventBus.emit('mode:changed', { oldMode: 'MENU', newMode: 'SANDBOX' });
        const doc = recorder.toJSON();
        expect(doc.fileId).toMatch(/^bug-/);
        expect(doc.runs).toHaveLength(0);
        recorder.dispose();
    });

    it('records free-text notes like everything else', () => {
        const recorder = makeRecorder();
        recorder.startSession();
        recorder.notes = 'balloon passes through ramp';
        expect(recorder.toJSON().notes).toBe('balloon passes through ramp');
        expect(recorder.toJSON().notes.length).toBeLessThanOrEqual(2000);
        recorder.dispose();
    });
});

/** ── (part 2: run machinery tests) ── */

describe('SessionRecorder run machinery', () => {
    it('opens a run on loop:play, records the dt stream, and samples poses', () => {
        const board = realBoard();
        const recorder = makeRecorder({ board });
        recorder.startSession();
        eventBus.emit('loop:play', { elapsed: 0 });
        for (let i = 0; i < 13; i++) {
            eventBus.emit('loop:frame', { dt: 16.667, elapsed: (i + 1) * 16.667 });
        }
        const run = recorder.openRun;
        expect(run).not.toBeNull();
        expect(run.dt.values).toHaveLength(13);
        expect(run.dt.values[0]).toBe(16.667);
        // interval 6 → samples at ticks 6 and 12
        expect(run.poses.rows.map((r) => r[0])).toEqual([6, 12]);
        const refs = run.poses.rows[0][1].map((c) => c[0]);
        expect(refs).toContain('ramp@0');
        expect(refs).toContain('ball@1');

        eventBus.emit('controls:reset');
        const doc = recorder.toJSON();
        expect(doc.runs[0].endedBy).toBe('controls:reset');
        // the reset row lands in the run it closes
        expect(doc.runs[0].events.some((e) => e.topic === 'controls:reset')).toBe(true);
        recorder.dispose();
    });

    it('keeps one run across a pause/resume cycle', () => {
        const board = realBoard();
        const recorder = makeRecorder({ board });
        recorder.startSession();
        eventBus.emit('loop:play', { elapsed: 0 });
        for (let i = 0; i < 6; i++) eventBus.emit('loop:frame', { dt: 16.667, elapsed: 0 });
        eventBus.emit('loop:pause', { elapsed: 100 });
        eventBus.emit('loop:play', { elapsed: 100 }); // resume — no new run
        for (let i = 0; i < 6; i++) eventBus.emit('loop:frame', { dt: 16.667, elapsed: 0 });
        expect(recorder.getRun(0).dt.values).toHaveLength(12);
        expect(recorder.toJSON().runs).toHaveLength(1);
        recorder.dispose();
    });

    it('records speed changes into run.timeScale (replay seam)', () => {
        const recorder = makeRecorder({ board: realBoard() });
        recorder.startSession();
        eventBus.emit('loop:play', { elapsed: 0 });
        eventBus.emit('loop:speed', { speed: 2 });
        expect(recorder.openRun.timeScale).toEqual([{ tick: 0, speed: 2 }]);
        recorder.dispose();
    });

    it('opens a fresh run per play after a reset (two-run session)', () => {
        const recorder = makeRecorder({ board: realBoard() });
        recorder.startSession();
        eventBus.emit('loop:play', { elapsed: 0 });
        for (let i = 0; i < 5; i++) eventBus.emit('loop:frame', { dt: 16.667, elapsed: 0 });
        eventBus.emit('controls:reset');
        eventBus.emit('loop:play', { elapsed: 0 });
        for (let i = 0; i < 4; i++) eventBus.emit('loop:frame', { dt: 16.667, elapsed: 0 });
        const doc = recorder.toJSON();
        expect(doc.runs).toHaveLength(2);
        expect(doc.runs[0].lastTick).toBe(5);
        expect(doc.runs[1].lastTick).toBe(4);
        recorder.dispose();
    });

    it('honors the dense toggle for future runs', () => {
        const recorder = makeRecorder({ board: realBoard() });
        recorder.startSession();
        recorder.dense = true;
        eventBus.emit('loop:play', { elapsed: 0 });
        for (let i = 0; i < 3; i++) eventBus.emit('loop:frame', { dt: 16.667, elapsed: 0 });
        expect(recorder.openRun.poses.interval).toBe(1);
        expect(recorder.openRun.poses.rows.map((r) => r[0])).toEqual([1, 2, 3]);
        recorder.dispose();
    });

    it('enforces the rolling pose budget and flags truncation', () => {
        const recorder = makeRecorder({ board: realBoard() }, { maxPoseRows: 2 });
        expect(MAX_POSE_ROWS).toBeGreaterThan(2); // production budget is the exported constant
        recorder.startSession();
        eventBus.emit('loop:play', { elapsed: 0 });
        for (let i = 0; i < 30; i++) eventBus.emit('loop:frame', { dt: 16.667, elapsed: 0 });
        const run = recorder.openRun;
        expect(run.poses.rows.length).toBe(2);
        expect(run.poses.rows[0][0]).toBe(24);
        expect(run.poses.rows[1][0]).toBe(30);
        expect(run.poses.posesTruncated).toBe(true);
        recorder.dispose();
    });

    it('closes an open run at export as open-at-export', () => {
        const recorder = makeRecorder({ board: realBoard() });
        recorder.startSession();
        eventBus.emit('loop:play', { elapsed: 0 });
        for (let i = 0; i < 3; i++) eventBus.emit('loop:frame', { dt: 16.667, elapsed: 0 });
        const { filename, json } = recorder.exportSession();
        expect(filename).toMatch(/^bugfile-bug-.+\.json$/);
        const doc = JSON.parse(json);
        expect(doc.runs[0].endedBy).toBe('open-at-export');
        expect(filename).toContain(doc.fileId);
        recorder.dispose();
    });

    it('serializes to JSON without Matter-side maps or live refs', () => {
        const recorder = makeRecorder({ board: realBoard() });
        recorder.startSession();
        eventBus.emit('loop:play', { elapsed: 0 });
        eventBus.emit('loop:frame', { dt: 16.667, elapsed: 16.667 });
        const parsed = JSON.parse(JSON.stringify(recorder.toJSON()));
        expect(parsed.schemaVersion).toBe(BUGFILE_SCHEMA_VERSION);
        expect(parsed.runs[0].boardSnapshot).toHaveLength(2);
        expect(parsed.runs[0].refTable.map((r) => r.ref)).toEqual(['ramp@0', 'ball@1']);
        expect('instanceRef' in parsed.runs[0]).toBe(false);
        expect('bodiesById' in parsed.runs[0]).toBe(false);
        recorder.dispose();
    });
});

/** ── (part 3: mirror + recovery + balloon tests) ── */

describe('SessionRecorder crash mirror + recovery', () => {
    it('mirrors events-only, throttled ~2s, never poses', () => {
        vi.useFakeTimers();
        const store = makeStore();
        const recorder = makeRecorder({ board: realBoard(), mirrorStore: store });
        expect(recorder.active).toBe(false);
        eventBus.emit('mode:changed', { oldMode: 'MENU', newMode: 'SANDBOX' });
        expect(recorder.active).toBe(true);
        // The arm itself wrote the events-only projection immediately
        let doc = JSON.parse(store.map.get(MIRROR_KEY));
        expect(doc.kind).toBe('bugfile-mirror');
        expect(doc.runs).toHaveLength(0); // nothing played yet

        eventBus.emit('loop:play', { elapsed: 0 });
        eventBus.emit('loop:frame', { dt: 16.667, elapsed: 16.667 });
        eventBus.emit('loop:frame', { dt: 16.667, elapsed: 33.334 });
        // Inside the throttle window: the trailing timer carries the writes
        expect(JSON.parse(store.map.get(MIRROR_KEY)).runs).toHaveLength(0);
        vi.advanceTimersByTime(3000);
        doc = JSON.parse(store.map.get(MIRROR_KEY));
        expect(doc.runs[0].dt.values).toHaveLength(2);
        expect(doc.runs[0].poses.rows).toHaveLength(0);     // never poses
        expect(doc.runs[0].poses.posesLostToCrash).toBe(true);
        expect(doc.runs[0].endedBy).toBe('open-at-crash');  // run still open
        recorder.dispose();
    });

    it('stashes and exports a crashed previous session', () => {
        const store = makeStore();
        store.map.set(MIRROR_KEY, JSON.stringify({
            kind: 'bugfile-mirror',
            fileId: 'bug-20261020T123456Z-old',
            build: [],
            runs: [],
        }));
        const recorder = makeRecorder({ mirrorStore: store });
        expect(recorder.hasCrashedSession).toBe(false);
        eventBus.emit('mode:changed', { oldMode: 'MENU', newMode: 'SANDBOX' });
        expect(recorder.hasCrashedSession).toBe(true);
        expect(recorder.getCrashedSession().fileId).toBe('bug-20261020T123456Z-old');

        const recovered = recorder.exportCrashedSession();
        expect(recovered.filename.startsWith('recovered-')).toBe(true);
        expect(JSON.parse(recovered.json).fileId).toBe('bug-20261020T123456Z-old');
        expect(recorder.hasCrashedSession).toBe(false);
        recorder.discardCrashedSession();
        recorder.dispose();
    });

    it('recovers the immediately-previous session after a fresh arm (bus-driven)', () => {
        const store = makeStore();
        const first = makeRecorder({ board: realBoard(), mirrorStore: store });
        eventBus.emit('mode:changed', { oldMode: 'MENU', newMode: 'SANDBOX' });
        eventBus.emit('loop:play', { elapsed: 0 });
        eventBus.emit('loop:frame', { dt: 16.667, elapsed: 16.667 });
        const firstId = first.toJSON().fileId;
        first.dispose(); // stopSession → final mirror write for the fresh session

        // A reloaded page would start empty: same store, fresh recorder.
        const second = makeRecorder({ board: realBoard(), mirrorStore: store });
        eventBus.emit('mode:changed', { oldMode: 'MENU', newMode: 'SANDBOX' });
        expect(second.hasCrashedSession).toBe(true);
        expect(second.getCrashedSession().fileId).toBe(firstId);
        expect(second.toJSON().fileId).not.toBe(firstId); // new session is fresh
        second.dispose();
    });
});

describe('Balloon bobPhase serialization (ADR 0006 decision 5)', () => {
    it('round-trips an explicit phase through serialize/deserialize', () => {
        const b1 = new Balloon(300, 100, { bobPhase: 1.23456789 });
        const doc = b1.serialize();
        expect(doc.options.bobPhase).toBe(1.23456789);
        const b2 = Balloon.deserialize(doc);
        expect(b2._bobPhase).toBe(1.23456789);
        expect(b2.serialize().options.bobPhase).toBe(1.23456789);
    });

    it('serializes the LIVE phase after bobbing, not the constructed one', () => {
        const b = new Balloon(300, 100, { bobPhase: 0 });
        b.onBeforeUpdate({ wakeBodies() {} }, 16.667);
        expect(b._bobPhase).toBeCloseTo(0.03, 8);
        expect(b.serialize().options.bobPhase).toBeCloseTo(0.03, 8);
    });

    it('keeps seeding randomly when no recorded phase is given', () => {
        const b = new Balloon(300, 100);
        expect(Number.isFinite(b.serialize().options.bobPhase)).toBe(true);
    });
});