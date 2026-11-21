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
import { describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { eventBus } from '../js/EventBus.js';
import { objectRegistry } from '../js/objects/ObjectRegistry.js';
import { registerAllObjects } from '../js/objects/registerAllObjects.js';
import { PhysicsEngine } from '../js/engine/PhysicsEngine.js';
import { GameLoop } from '../js/engine/GameLoop.js';
import { bindPlacedTokens, restorePlacedFromSnapshot, serializePlacedBoard } from '../js/reset/levelReset.js';
import { SessionRecorder } from '../js/recorder/SessionRecorder.js';
import { assertBugFileReplaysExactly, loadBugFile, replayRun, replayBugFile } from './helpers/replayBugFile.js';

registerAllObjects();
const FIXTURE = fileURLToPath(new URL('./fixtures/bugfiles/ball-drop-ramp.json', import.meta.url));
const FIXTURE_UFZS = fileURLToPath(new URL('./fixtures/bugfiles/bug-20261114T021258Z-ufzs.json', import.meta.url));
const FIXTURE_0TXH = fileURLToPath(new URL('./fixtures/bugfiles/bug-20261027T151221Z-0txh.json', import.meta.url));

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

    /**
     * bug-20261027T151221Z-0txh — "weird mechanics for tennis ball interacting
     * with the spring .. it should not be that fast and the ball tunnels thru
     * the spring" (issue #81; the recording is issue #80's original exhibit,
     * captured 2026-10-27 UNDER THE PRE-FIX LOOP). A pre-#80 recording: the
     * dt tape carries the reporter's raw variable frame dts (16.67 prime,
     * then ~31 ms), because then GameLoop fed raw frame dt straight into
     * Engine.update. The replay harness consumes that tape verbatim (ADR 0006
     * decision 2 — the mechanism #80 left standing), so the rebuild follows
     * the broken trajectory BIT-EXACTLY — the recording as-recorded:
     *
     *   - the spring-under-throttle launch burst scales with frame dt² — the
     *     release wraps the ball to ≈ 77 px/tick (a raw ~31 ms step integrates
     *     a 0.08 force into 0.08 × 31² ≈ 77 px, vs the tuned 0.08 × 16.67² ≈ 22);
     *   - the re-entry at that warp silently tunnels the 8 px spring-platform
     *     (no CCD): armed t15, ceiling slam t34, ball x floor + spring-base at
     *     t45 — NO spring-platform contact after the arming one — and settles
     *     below the base at y ≈ 592.6 until the reset at t107.
     *
     * This test pins the verbatim file AND its broken stream as the red side
     * of the pair: the next test steps the same snapshot through the current
     * (ADR 0008) contract and asserts every one of these symptoms GONE. If the
     * symptoms ever return, that test fails while this one keeps replaying —
     * exactly the deliberate-divergence shape of the 2026-10-23 spring fix
     * (bug-20261023T180834Z-gwce: "the fixed replay's next collision
     * diverges from the recording's").
     */
    it('bug-20261027T151221Z-0txh replays bit-exactly: the recording is the broken pre-#80 stream (issue #81)', () => {
        const report = assertBugFileReplaysExactly(FIXTURE_0TXH);
        expect(report.ok).toBe(true);

        // The pinned RECORDED facts (file data, not live behavior): the
        // collision stream skips the re-entry contact...
        const file = loadBugFile(FIXTURE_0TXH);
        const run = file.runs[0];
        const collisions = run.events.filter((e) => e.topic === 'physics:collision');
        expect(collisions.map((e) => [e.tick, e.data.a.body, e.data.b.body])).toEqual([
            [15, 'spring-platform', 'ball-tennis'], // the arming contact
            [34, 'ball-tennis', 'wall-ceiling'], // the dt² burst slams the ceiling
            [45, 'ball-tennis', 'wall-floor'], // and the re-entry tunnels down past
            [45, 'spring-base', 'ball-tennis'], // everything, floor + base at t45
        ]);
        expect(collisions.filter((e) => e.tick > 15 && e.data.a.body === 'spring-platform')).toHaveLength(0);

        // ...the burst is the dt² wrap (pose samples are [ref,label,x,y,a,vx,vy]):
        const rowAt = (tick) => run.poses.rows.find((r) => r[0] === tick)[1];
        const ballRow = (tick) => rowAt(tick).find((c) => c[1] === 'ball-tennis');
        expect(ballRow(30)[6]).toBe(-39.425); // mid-burst, sampled on the way up

        // ...and the recorded run "settles" beneath the spring's static base —
        // reachable only through the 8 px platform it tunneled (base bottom at
        // spring.y + 15 + 5 = 585.297; the ball rests on the floor at 592.648).
        expect(ballRow(102)[3]).toBe(592.648);
    });

    /**
     * The fix side of the 0txh pair (issue #81). The same play-start board
     * snapshot, rebuilt per the ADR 0006 flow (fresh deserialize = the
     * restore, ADR 0006 decision 1) and collected by the same passive
     * SessionRecorder conventions (decision 9) — but played through the REAL
     * GameLoop (ADR 0008): the recorded ~31 ms dt rows are rAF FRAMES now,
     * fed to _frame as wall-clock deltas; the accumulator drains them as
     * exact 1000/60 quanta. Physics never sees dt ≠ 1000/60, so:
     *
     *   - the launch burst is dt-independent: the release integrates the
     *     tuned 0.08 × 16.67² ≈ 22 px/tick one-step Δv — not the recorded
     *     ≈ 77 the raw ~31 ms steps would wrap;
     *   - the re-entry lands at a catchable speed and CONTACTS the 8 px
     *     spring-platform again in the replayed collision stream;
     *   - the ball never passes below the spring base — the recorded
     *     y ≈ 592.6 sub-base settle is unreachable.
     *
     * Driving the real loop (not a re-implementation of its accumulator)
     * means this pin trips if the stepping contract itself regresses, just
     * as it trips if the spring or platform contract does. Replay ticks are
     * re-numbered by quantization (~1.87 quanta per ~31 ms frame; t29 arm,
     * t43 release, t64 ceiling, t96 re-entry) — the assertions pin the
     * sequence, not the legacy tick numbers.
     */
    it('bug-20261027T151221Z-0txh: the current GameLoop contract clears both symptoms (issue #81)', () => {
        const file = loadBugFile(FIXTURE_0TXH);
        const run = file.runs[0];

        // ADR 0006 rebuild: the snapshot rows ARE the world (construction is
        // the restore) — identical to replayRun's board assembly.
        const physics = new PhysicsEngine(file.playfield.width, file.playfield.height, {
            gravityX: file.engine.gravityX, gravityY: file.engine.gravityY,
            enableSleeping: file.engine.enableSleeping,
        });
        const board = run.boardSnapshot.map((row) => objectRegistry.deserialize(row));
        bindPlacedTokens(board, board);
        for (const obj of board) physics.addObject(obj);
        const loop = new GameLoop(physics, () => {}); // the real browser loop
        const ball = board.find((obj) => obj.type === 'tennis-ball');
        const spring = board.find((obj) => obj.type === 'spring');

        // The comparison collector — same SessionRecorder, driven passively
        // (decisions 2 + 9): the collision stream is recorded under the same
        // conventions the original report used.
        const observer = new SessionRecorder({ passive: true });
        observer.init({
            getBoard: () => board,
            getSnapshot: () => run.boardSnapshot,
            getEngine: () => physics.engine,
            getPlayfield: () => file.playfield,
            getEngineInfo: () => file.engine,
        });
        observer.startSession();

        // rAF never fires: _frame is driven with the recording's rhythm.
        vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
        vi.stubGlobal('cancelAnimationFrame', vi.fn());

        const baseBottom = spring.bounds.y + spring.bounds.height; // 586.297 at angle 0
        let maxAbsVy = 0;
        let firstBurstDv = null;
        let prevVy = 0;
        let ticks = 0;
        const unFrame = eventBus.on('loop:frame', () => {
            ticks++;
            // The emission lands after Engine.update — the same post-step
            // per-tick window the live recorder samples.
            const body = ball.bodies[0];
            const vy = body.velocity.y;
            maxAbsVy = Math.max(maxAbsVy, Math.abs(vy));
            if (prevVy - vy > 16 && firstBurstDv === null) firstBurstDv = prevVy - vy;
            prevVy = vy;
            if (body.position.y > baseBottom + 1) {
                throw new Error(`ball below the spring base at tick ${ticks}: y ${body.position.y.toFixed(3)} > ${baseBottom.toFixed(3)} + 1`);
            }
        });

        try {
            loop.play(); // emits loop:play → the recorder opens the run

            // Consume the recorded frame sequence as wall clock: the tape's
            // row 0 (16.67) is the priming frame after play() (dt <= 0 →
            // exactly one fixed step), each ~31 ms row drains 2− quanta.
            let t = 1000;
            loop._frame(t);
            for (let i = 1; i < run.dt.values.length; i++) loop._frame(t += run.dt.values[i]);

            // The whole tape played under the current contract.
            const replayed = observer.closeOpenRun('replay-end');

            // The launch burst is dt-independent (≈ the tuned 0.08 × 16.67²
            // = 22.22, friction-trimmed): the first upward one-tick launch Δv —
            // recorded: ≈ 77-class through the raw ~31 ms steps.
            expect(firstBurstDv).not.toBeNull();
            expect(firstBurstDv).toBeGreaterThan(18);
            expect(firstBurstDv).toBeLessThan(26);
            // No 77-class warp anywhere in the replayed run (the tunneling
            // guardrail: a re-entry faster than the ≈ 22 px overlap window of
            // the 8 px platform + ball slips through).
            expect(maxAbsVy).toBeLessThan(32);

            // The replayed collision stream catches the re-entry: the 8 px
            // spring-platform contacts the ball again AFTER the ceiling slam
            // (recorded: never — one arming row, then tunnel-through).
            const stream = replayed.events.filter((e) => e.topic === 'physics:collision');
            const platformPair = (e) =>
                [e.data.a.body, e.data.b.body].includes('spring-platform')
                && [e.data.a.body, e.data.b.body].includes('ball-tennis');
            expect(stream.length).toBeGreaterThan(0);
            expect(stream.filter(platformPair).length).toBeGreaterThan(0);
            const firstCeiling = stream.findIndex((e) =>
                [e.data.a.body, e.data.b.body].includes('wall-ceiling'));
            expect(firstCeiling).toBeGreaterThan(-1);
            const reEntry = stream.findIndex((e, i) => i > firstCeiling && platformPair(e));
            expect(reEntry).toBeGreaterThan(firstCeiling);

            // Every recorded frame consumed; no pose row below the base
            // (the per-tick guard above asserts it live; the stream echo).
            expect(replayed.lastTick).toBe(ticks);
            expect(replayed.poses.rows.every((row) =>
                row[1].filter((c) => c[1] === 'ball-tennis').every((c) => c[3] < baseBottom))).toBe(true);
        } finally {
            unFrame();
            loop.dispose();
            observer.dispose();
            physics.dispose();
            vi.unstubAllGlobals();
        }
    });
});
/**
 * The replay harness consumes the run-lifecycle owner's facts (issue #78):
 * the replayed run is framed with the loop's published contract - loop:play
 * (begin), one loop:frame {dt, elapsed} per tape row in the step -> elapsed
 * -> emit order (ADR 0006 decision 2: the dt tape is consumed verbatim),
 * loop:reset (the owned end fact) - so the recorder's run bookkeeping runs
 * by its own consumption, sandbox-identical, and no harness-private close
 * marker exists.
 */
describe('the replay harness consumes the loop run facts (issue #78)', () => {
    it('publishes the loop fact sequence for a replayed run: begin, per-step step-to facts, end', () => {
        const file = recordScenario({ steps: 30, boardFactory: rampAndBall });
        const facts = [];
        const topics = ['loop:play', 'loop:frame', 'loop:reset'];
        const unsubs = topics.map((topic) => {
            const listener = (packet) => facts.push({ topic, packet });
            eventBus.on(topic, listener);
            return () => eventBus.off(topic, listener);
        });
        try {
            const report = replayRun(file, 0);
            expect(report.ok).toBe(true);
            expect(facts[0]).toMatchObject({ topic: 'loop:play', packet: { elapsed: 0 } });
            const frames = facts.filter((f) => f.topic === 'loop:frame');
            expect(frames).toHaveLength(30);
            expect(frames[0].packet).toEqual({ dt: DT, elapsed: DT });
            expect(facts[facts.length - 1].topic).toBe('loop:reset');
        } finally {
            for (const unsub of unsubs) unsub();
        }
    });

    it("closes the replayed run by consuming the end fact - the recorder's consumption, sandbox-identical", () => {
        const file = recordScenario({ steps: 30, boardFactory: rampAndBall });
        // The harness's own consumer is internal; a second passive recorder
        // on the bus sees the same published facts and runs the same
        // consumption the sandbox recorder runs.
        const watcher = new SessionRecorder({ passive: true });
        watcher.init({}); // binds the bus - accessors stay out (pose refs unneeded here)
        watcher.startSession();
        try {
            replayRun(file, 0);
            const run = watcher.toJSON().runs[0];
            expect(run.endedBy).toBe('loop:reset');
            expect(run.lastTick).toBe(30);
        } finally {
            watcher.dispose();
        }
    });
});
