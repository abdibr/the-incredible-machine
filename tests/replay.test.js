/**
 * Record ≡ replay round-trip + divergence detection (ADR 0006, harness).
 *
 * A synthetic sandbox machine is recorded with the real SessionRecorder
 * (browser event order: engine.step → loop:frame), then replayed with
 * replayRun and compared — recorded and replayed streams must match
 * bit-exactly. Includes the balloon bob-phase case: before ADR 0006 the
 * phase was construction-random and unreproducible; now it rides the
 * board snapshot.
 */
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { eventBus } from '../js/EventBus.js';
import { objectRegistry } from '../js/objects/ObjectRegistry.js';
import { registerAllObjects } from '../js/objects/registerAllObjects.js';
import { PhysicsEngine } from '../js/engine/PhysicsEngine.js';
import { restorePlacedFromSnapshot, serializePlacedBoard } from '../js/reset/levelReset.js';
import { SessionRecorder } from '../js/recorder/SessionRecorder.js';
import { assertBugFileReplaysExactly, loadBugFile, replayRun, replayBugFile } from './helpers/replayBugFile.js';

registerAllObjects();
const FIXTURE = fileURLToPath(new URL('./fixtures/bugfiles/ball-drop-ramp.json', import.meta.url));
const FIXTURE_UFZS = fileURLToPath(new URL('./fixtures/bugfiles/bug-20261114T021258Z-ufzs.json', import.meta.url));

const DT = 1000 / 60;

/**
 * Record a synthetic sandbox session exactly the way the live app plays:
 * board → (build events) → loop:play → [step; loop:frame]* → controls:reset.
 */
function recordScenario({ steps, boardFactory, notes = '', dense = false, goal = null } = {}) {
    const board = boardFactory();
    const engine = new PhysicsEngine(1000, 600);
    for (const obj of board) engine.addObject(obj);

    const recorder = new SessionRecorder({ passive: true });
    recorder.init({
        getBoard: () => board,
        getEngine: () => engine.engine, // the Matter engine, not the wrapper
        getPlayfield: () => ({ width: 1000, height: 600 }),
        getEngineInfo: () => ({ gravityX: 0, gravityY: 1, enableSleeping: true }),
    });
    recorder.dense = dense;
    recorder.notes = notes;
    recorder.startSession();
    for (const obj of board) {
        eventBus.emit('object:placed', { type: obj.type, id: obj.id, object: obj });
    }
    if (goal) eventBus.emit('level:loaded', { id: 'custom-test', goal });
    eventBus.emit('loop:play', { elapsed: 0 });

    let elapsed = 0;
    for (let i = 0; i < steps; i++) {
        engine.step(DT);
        elapsed += DT;
        eventBus.emit('loop:frame', { dt: DT, elapsed }); // browser order: step → loop:frame
    }
    eventBus.emit('controls:reset');
    recorder.dispose();
    return recorder.toJSON(); // buffers stay readable after dispose
}

/** A real two-object sandbox board (ramp below, ball above-right). */
function rampAndBall() {
    return [
        objectRegistry.create('ramp', 500, 300, { angle: 0.35 }),
        objectRegistry.create('ball', 520, 80),
    ];
}

describe('record ≡ replay (ADR 0006)', () => {
    it('replays a recorded ball-on-ramp run bit-exactly', () => {
        const file = recordScenario({ steps: 240, boardFactory: rampAndBall, notes: 'ball rolls off ramp end' });
        const report = replayRun(file, 0);
        expect(report.divergence).toBeNull();
        expect(report.ok).toBe(true);
        expect(report.compared.events).toBeGreaterThan(0);
        expect(report.compared.poses).toBe(40); // every 6th of 240 ticks
        expect(report.lastTickRecorded).toBe(240);
    });

    it('carries balloon bobPhase through the snapshot (the nondeterminism killer)', () => {
        const file = recordScenario({
            steps: 180,
            boardFactory: () => [
                objectRegistry.create('ramp', 500, 150),
                objectRegistry.create('balloon', 500, 450),
            ],
            notes: 'balloon drifts sideways while rising',
        });
        // The snapshot carries the live phase...
        const phase = file.runs[0].boardSnapshot[1].options.bobPhase;
        expect(typeof phase).toBe('number');
        expect(Number.isFinite(phase)).toBe(true);
        // ...and a replay restored from it matches the recording
        const report = replayRun(file, 0);
        expect(report.ok).toBe(true);
    });

    it('replays runs that carry a goal (GoalChecker path, idle verdicts)', () => {
        const file = recordScenario({
            steps: 60,
            boardFactory: rampAndBall,
            goal: { type: 'object_in_zone', targetType: 'ball', zoneId: 'bucket-goal' },
        });
        const report = replayRun(file, 0);
        expect(report.ok).toBe(true);
    });

    it('replays every run of a multi-run session', () => {
        // Mirrors the live sandbox cycle: play → controls:reset (world
        // cleared, board restored FRESH from the placed snapshot — the
        // resetSandboxBoard path) → play again. The recorder keeps one
        // session across both runs; each run replays from its own snapshot.
        let currentBoard = rampAndBall();
        const engine = new PhysicsEngine(1000, 600);
        const placedSnapshot = serializePlacedBoard(currentBoard); // what beginPlay returns at play start
        for (const obj of currentBoard) engine.addObject(obj);

        const recorder = new SessionRecorder({ passive: true });
        recorder.init({
            getBoard: () => currentBoard,
            getEngine: () => engine.engine, // the Matter engine, not the wrapper
            getPlayfield: () => ({ width: 1000, height: 600 }),
            getEngineInfo: () => ({ gravityX: 0, gravityY: 1, enableSleeping: true }),
        });
        recorder.startSession();

        for (const runSteps of [30, 20]) {
            eventBus.emit('loop:play', { elapsed: 0 });
            for (let i = 0; i < runSteps; i++) {
                engine.step(DT);
                eventBus.emit('loop:frame', { dt: DT, elapsed: i * DT });
            }
            eventBus.emit('controls:reset');
            // The sandbox reset branch: physics world cleared; placed parts
            // rebuilt fresh from the snapshot (fresh ids — refs @0/@1 stay
            // stable because they derive from board order, not instance ids).
            engine.clear();
            const nextBoard = restorePlacedFromSnapshot([], placedSnapshot);
            currentBoard = nextBoard;
            for (const obj of nextBoard) engine.addObject(obj);
        }
        recorder.dispose();

        const result = replayBugFile(recorder.toJSON());
        expect(result.ok).toBe(true);
        expect(result.runReports).toHaveLength(2);
        expect(result.runReports.every((r) => r.divergence === null)).toBe(true);
    });

    it('throws for a missing run index', () => {
        const file = recordScenario({ steps: 10, boardFactory: rampAndBall });
        expect(() => replayRun(file, 9)).toThrow(/no run 9/);
    });
});

/** ── (part 2: divergence detection + committed fixture) ── */

/**
 * Committed bugfile regression fixtures (ADR 0006 decision 13 and the
 * graduated-divergence verdicts). Each fixture is a REAL reporter recording,
 * committed verbatim (byte-exact: the split ticket comments stitched, no
 * re-serialization), rebuilt per the ADR 0006 replay flow (fresh deserialize
 * = the restore), and replayed against its recorded stream.
 */
describe('committed bugfile regression fixtures (ADR 0006)', () => {
    it('ball-drop-ramp replays bit-exactly', () => {
        const report = assertBugFileReplaysExactly(FIXTURE);
        expect(report.ok).toBe(true);
    });

    /**
     * bug-20261114T021258Z-ufzs — "the free rope disconnects from the other
     * rope without a reason" (issue #93). The recording's board snapshot
     * carries the free rope's SAVED SPAN (length 86.209, endPoint (120.55,
     * 290.06) — the hand's last re-lay, laid across the pinned rope's
     * chain), so the snapshot-authoritative rebuild re-derives the chain
     * along that lay: the tail sags into the bucket and its segments
     * contact `bucket-wall` at ticks 77/79/82 of the recorded dt tape —
     * exactly the recorded stream.
     *
     * DELIBERATE DIVERGENCE from the pre-fix rebuild (the wrong side): the
     * free-rope restore was spawning the chain through the fresh-coil birth
     * (`_spawnChain`'s straight-down default), teleporting the tail into a
     * vertical dead hang under the balloon — 0 collisions, the stream diverged
     * (event-count 3 vs 0). The verdict (ADR 0006 amendment, issue #93): the
     * saved span is the restore lay — recorded-correct; the straight-down
     * rebuild was unintended restore drift from the free family's restore
     * path. This test fails if that wrong side returns.
     */
    it('bug-20261114T021258Z-ufzs replays bit-exactly: the saved span is the restore lay (issue #93)', () => {
        const file = loadBugFile(FIXTURE_UFZS);
        const report = assertBugFileReplaysExactly(FIXTURE_UFZS);
        expect(report.ok).toBe(true);

        // The pinned collision stream AT THE RECORDED DT TAPE: the free
        // rope's tail segments contact the bucket wall on the same three
        // ticks the reporter's run saw (77/79/82, tail inward: seg-5,
        // seg-4, seg-3).
        const run = file.runs[0];
        const collisions = run.events.filter((e) => e.topic === 'physics:collision');
        expect(collisions.map((e) => [e.tick, e.data.b.body])).toEqual([
            [77, 'rope-seg-5'], [79, 'rope-seg-4'], [82, 'rope-seg-3'],
        ]);
        expect(collisions.every((e) => e.data.a.body === 'bucket-wall'
            && e.data.a.ref === 'bucket@1' && e.data.b.ref === 'free-rope@3')).toBe(true);
    });
});