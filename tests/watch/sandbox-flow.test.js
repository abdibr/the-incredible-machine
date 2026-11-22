import { describe, it, expect, afterEach } from 'vitest';
import { AgentSession } from '../../agent/session.js';
import { place, trial } from '../../agent/actions.js';
import { SandboxFlow, SANDBOX_BOARD, bannerForSandboxResult } from '../../js/watch/sandboxFlow.js';
import { applyBuildBeat, beatLabel, SANDBOX_BUILD_SCRIPT, SANDBOX_RUN_SECONDS } from '../../js/watch/sandboxScript.js';

/**
 * The sandbox view's controller (issue #64).
 *
 * Sandbox Watch drives a goal-less sandbox session (ADR 0011) through the
 * same phase-1 surface the level view drives: the board starts empty, the
 * deterministic build script applies its placements beat by beat - every
 * beat re-materialized live by the session (construction IS the restore,
 * without the run framing), each part appearing on the board as it lands -
 * then Run plays the built contraption over the #61 steppable seam with
 * the same event HUD as the level view. There is NO goal in sandbox, so no
 * goal banner ever appears: the run ends by timeout or manual stop, the
 * event log telling the story. This suite injects the page's cadence (a
 * manual ticker, the #62 suite's seam) and pins the whole sandbox cycle;
 * the shipped script itself is pinned against real physics too.
 */

/** @type {import('../../js/watch/sandboxFlow.js').SandboxFlow|null} */
let flow = null;

afterEach(() => {
    flow?.cancel();
    flow = null;
});

/**
 * A manual animation-frame scheduler (the page's cadence, unwrapped):
 * pump(times) runs the callbacks queued at that instant, each fed the
 * given tick timestamp. Callbacks that re-schedule wait for the next
 * pump, exactly like real frames do.
 */
function makeTicker() {
    const queue = [];
    return {
        schedule: (cb) => { queue.push(cb); return queue.length; },
        size: () => queue.length,
        pump: (times) => {
            const n = queue.length;
            for (let i = 0; i < n && queue.length > 0; i++) queue.shift()(times);
        },
    };
}

describe('the sandbox cycle - the empty board and the scripted build (issue #64)', () => {
    it(
        'starts an empty goal-less board, then the build applies its placements one beat per tick, live and visibly',
        { timeout: 30000 },
        async () => {
            const ticker = makeTicker();
            const session = new AgentSession({ seed: null, sandbox: true });
            const statuses = [];
            const frames = [];
            const errors = [];
            const boards = [];
            flow = new SandboxFlow({
                session,
                schedule: ticker.schedule,
                buildBeatMs: 0, // test pacing: one beat per pump
                listeners: {
                    onBoardLoaded: (doc) => boards.push(doc),
                    onStatus: (text) => statuses.push(text),
                    onEvent: () => {},
                    onFrame: () => frames.push([...flow.liveObjects()].map((o) => o.type)),
                    onError: (message) => errors.push(message),
                },
            });

            await flow.start();
            expect(flow.status).toBe('building');
            expect(errors).toHaveLength(0);

            // The empty playfield is REAL: nothing on it before any beat.
            expect(flow.liveObjects()).toEqual([]);
            // The sandbox posture is real: no goal exists to judge.
            expect(session.goal).toBeNull();

            // The script applied: one beat per tick, every part visible as it lands.
            let guard = 0;
            while (flow.status === 'building' && guard++ < 20) ticker.pump();
            expect(guard).toBeLessThan(20);
            expect(flow.status).toBe('built');
            expect(boards).toEqual([{ ...SANDBOX_BOARD }]);
            expect(frames).toHaveLength(8); // the empty board, then one paint per beat
            expect(frames).toEqual([
                [],
                ['bucket'], ['bucket', 'ball'], ['bucket', 'ball', 'ramp'],
                ['bucket', 'ball', 'ramp'], ['bucket', 'ball', 'ramp', 'ball'],
                ['bucket', 'ball', 'ramp', 'ball'], ['bucket', 'ball', 'ramp', 'ball', 'bucket'],
            ]);
            // The script's mechanics all visible on the final board: the ramp
            // rotated to its slope, the ramp ball nudged onto it.
            expect(session.materializeBoard().map((r) => [r.type, r.x, r.y, r.angle])).toEqual([
                ['bucket', 700, 470, 0],
                ['ball', 700, 100, 0],
                ['ramp', 480, 380, 0.4],
                ['ball', 470, 325, 0],
                ['bucket', 620, 470, 0],
            ]);
            expect(session.placements).toHaveLength(5); // 5 places (rotate/nudge edit placed rows)
            expect(session.budget()).toMatchObject({ bucket: 8, ball: 8, ramp: 9, domino: 10 });
            // The build narrated itself (the status stream carried the beats).
            expect(statuses.some((t) => /building/.test(t))).toBe(true);
            expect(statuses[statuses.length - 1]).toContain('build complete');
        },
    );

    it(
        'the build rides the phase-1 surface: a refused beat is data, the cycle never throws',
        { timeout: 30000 },
        async () => {
            const ticker = makeTicker();
            const statuses = [];
            flow = new SandboxFlow({
                session: new AgentSession({ seed: null, sandbox: true }),
                schedule: ticker.schedule,
                buildBeatMs: 0,
                script: [
                    { kind: 'place', type: 'unregistered-widget', x: 100, y: 100 },
                    { kind: 'teleport', type: 'ball', x: 100, y: 100 },
                    { kind: 'place', type: 'ball', x: 100, y: 100 },
                ],
                listeners: {
                    onStatus: (text) => statuses.push(text),
                    onEvent: () => {},
                    onFrame: () => {},
                },
            });

            await flow.start();
            let guard = 0;
            while (flow.status === 'building' && guard++ < 20) ticker.pump();
            expect(flow.status).toBe('built');
            expect(flow.liveObjects().map((o) => o.type)).toEqual(['ball']); // only the legal beat stands
            // Reported, never thrown: each refusal surfaced in the status stream.
            expect(statuses.some((t) => t.includes('unknown type: unregistered-widget'))).toBe(true);
            expect(statuses.some((t) => t.includes('unknown beat kind: teleport'))).toBe(true);
        },
    );
});

describe('the shipped build script (issue #64)', () => {
    it('names its beats for the build status, and every beat the action API accepts on an empty sandbox board', async () => {
        expect(SANDBOX_BUILD_SCRIPT.map((b) => beatLabel(b)).join('|')).toMatch(/place|rotate|nudge/);
        const session = new AgentSession({ seed: null, sandbox: true });
        await session.loadLevel({ id: 'sandbox-script-check', name: 'the script check board', fixedObjects: [] });
        const verdicts = SANDBOX_BUILD_SCRIPT.map((b) => applyBuildBeat(session, b));
        expect(verdicts.every((r) => r.ok)).toBe(true);
        session.dispose();
    });
});

describe('AgentSession.materializeBoard - the build phase board (issue #64)', () => {
    it('rebuilds the world from the current placements, with NO run framing, and answers the pose snapshot', async () => {
        const session = new AgentSession({ seed: null, sandbox: true });
        await session.loadLevel({ id: 'sandbox-mb', name: 'empty board', fixedObjects: [] });
        expect(place(session, 'ball', 500, 200).ok).toBe(true);

        const poses = session.materializeBoard();
        expect(poses).toEqual([{ id: expect.any(String), type: 'ball', x: 500, y: 200, angle: 0 }]);
        expect(session.engine).not.toBeNull();
        expect(session.trialRun).toBeNull(); // a build, not a run
        // Removing the placement and re-materializing returns the empty board.
        session.placements.length = 0;
        expect(session.materializeBoard()).toEqual([]);
        session.dispose();
    });

    it('refuses while a steppable run is open - the run owns the world', async () => {
        const session = new AgentSession({ seed: null, sandbox: true });
        await session.loadLevel({ id: 'sandbox-mb-open', name: 'empty board', fixedObjects: [] });
        session.beginTrial({ seconds: 1 / 60 });
        expect(() => session.materializeBoard()).toThrow(/run is open/);
        session.finalizeTrial();
        // Closed again: materializing works.
        expect(session.materializeBoard()).toEqual([]);
        session.dispose();
    });
});

describe('the sandbox run (issue #64)', () => {
    /** Drive one flow to 'built' (the scripted build, one beat per pump). */
    async function buildToBuilt(ticker, options = {}) {
        const session = new AgentSession({ seed: null, sandbox: true });
        flow = new SandboxFlow({ session, schedule: ticker.schedule, buildBeatMs: 0, ...options });
        await flow.start();
        let guard = 0;
        while (flow.status === 'building' && guard++ < 20) ticker.pump();
        expect(flow.status).toBe('built');
        return { session, flow: () => flow };
    }

    it(
        'plays the built contraption over the steppable seam in capped batches, streams the event HUD, and ends by its budget with a no-goal banner',
        { timeout: 60000 },
        async () => {
            const ticker = makeTicker();
            const events = [];
            const outcomes = [];
            const order = [];
            let frames = 0;
            const { session } = await buildToBuilt(ticker, {
                listeners: {
                    onStatus: () => {},
                    onEvent: (rows) => {
                        events.push(...rows);
                        order.push(...rows.map(() => 'event'));
                    },
                    onFrame: () => frames++,
                    onSandboxRunEnded: (result, meta) => {
                        outcomes.push({ result, meta });
                        order.push('outcome');
                    },
                    onError: () => {},
                },
            });

            // Run opens the steppable trial over the built placements (#61).
            flow.run();
            expect(flow.status).toBe('running');
            expect(session.trialRun).not.toBeNull(); // the run view is open between ticks
            expect(session.trialRun.open).toBe(true);

            // The trial unwraps on ticks in small capped batches - never a
            // whole trial in one call (the WatchFlow discipline).
            const batches = [];
            let now = 0;
            let guard = 0;
            while (flow.status === 'running' && guard++ < 3000) {
                const before = session.trialRun.stepped;
                now += 17;
                ticker.pump(now);
                if (flow.status === 'running') {
                    batches.push(session.trialRun.stepped - before);
                    expect(session.trialRun.done).toBe(false);
                }
            }
            expect(guard).toBeLessThan(3000);
            expect(flow.status).toBe('ended');
            expect(session.trialRun).toBeNull(); // finalized cleanly
            expect(batches.length).toBeGreaterThan(20); // ~5s of sim unwrapped over dozens of ticks
            expect(Math.max(...batches)).toBeLessThanOrEqual(3);

            // The result: the sandbox posture judges NOTHING - a timeout,
            // the whole budget stepped, no failure reason, no reachable zone.
            expect(flow.result.outcome).toBe('timeout');
            expect(flow.result.elapsed).toBeCloseTo(5000, 6); // the whole budget, whole quanta
            expect(flow.result.distance).toBe(Infinity);
            expect(flow.result.failureReason).toBeNull();
            expect(flow.stoppedHow).toBe('budget');
            expect(frames).toBeGreaterThan(20); // the run painted live

            // The event log told the story, streamed as it happened: the
            // two catches with their timestamps - and NEVER a goal verdict.
            expect(events.map((r) => r.text)).toEqual(['ball caught by bucket', 'ball caught by bucket']);
            expect(events.map((r) => r.t)).toEqual(['0.95', '1.57']);
            events.forEach((r) => expect(r.t).toMatch(/^\d+\.\d{2}$/));
            expect(events.every((r) => !r.landmark)).toBe(true); // landmark rows are goal verdicts - none here
            expect(order.lastIndexOf('event')).toBe(order.indexOf('outcome') - 1); // rows before the banner
            expect(outcomes).toHaveLength(1);
            expect(outcomes[0].result).toEqual(flow.result);
            expect(outcomes[0].meta).toEqual({ stopped: false, seconds: 5 });

            // The payload the page composes is NOT a goal banner - ever.
            const banner = bannerForSandboxResult(outcomes[0].result, outcomes[0].meta);
            expect(banner.label).toMatch(/timeout/i);
            expect(banner.label).not.toMatch(/goal|reached|failed/i);
            expect(banner.text).toMatch(/no goal/);
            expect(banner.kind).toBe('timeout');
        },
    );

    it(
        'the watched run IS trial() over the scripted placements, and repeated cycles land identically',
        { timeout: 90000 },
        async () => {
            const poses = (snapshot) => snapshot.map((row, i) => ({ ...row, id: /^([a-z0-9-]+)-(\d+)$/.test(row.id) ? `${row.type}@${i}` : row.id }));
            const view = (result) => ({
                outcome: result.outcome,
                elapsed: result.elapsed,
                distance: result.distance,
                events: result.events.map((r) => [r.t, r.text]),
                snapshot: poses(result.snapshot),
            });

            async function driveCycle() {
                const ticker = makeTicker();
                await buildToBuilt(ticker);
                flow.run();
                let now = 0;
                let guard = 0;
                while (flow.status === 'running' && guard++ < 3000) ticker.pump((now += 17));
                expect(flow.status).toBe('ended');
                const result = flow.result;
                flow.cancel(); // the live session's listeners must not co-fire on the shared bus
                return result;
            }

            const resultA = await driveCycle();
            const resultB = await driveCycle();

            // Deterministic trials: two identical cycles, identical stories.
            expect(view(resultB)).toEqual(view(resultA));

            // And the reference: trial() over the same board + script, a
            // fresh session - what the watched run judges is what the
            // all-at-once trial judges (the stepping parity, #61).
            const refSession = new AgentSession({ seed: null, sandbox: true });
            await refSession.loadLevel({ ...SANDBOX_BOARD });
            for (const beat of SANDBOX_BUILD_SCRIPT) expect(applyBuildBeat(refSession, beat).ok).toBe(true);
            const refResult = trial(refSession, { seconds: 5 });
            refSession.dispose();

            expect(view(refResult)).toEqual(view(resultA));
            expect(SANDBOX_RUN_SECONDS).toBe(5); // the run budget rides the module constant
        },
    );

    it(
        'bannerForSandboxResult only ever composes stop and timeout labels - the goal banner vocabulary cannot come out of it',
        () => {
            const timeout = bannerForSandboxResult({ outcome: 'timeout', elapsed: 5000 }, { seconds: 5 });
            expect(timeout.label).toMatch(/timeout/i);
            expect(timeout.label).not.toMatch(/goal|reached|failed/i);
            expect(timeout.text).toMatch(/no goal/);
            expect(timeout.kind).toBe('timeout');
            const stopped = bannerForSandboxResult({ outcome: 'timeout', elapsed: 2312 }, { stopped: true, seconds: 5 });
            expect(stopped.label).toMatch(/stopped/i);
            expect(stopped.label).not.toMatch(/goal|reached|failed/i);
            expect(stopped.text).toMatch(/2\.31s of its 5\.00s budget/);
            expect(stopped.kind).toBe('stopped');
            // Even an impossible verdict shape lands on the neutral spellings.
            for (const outcome of ['reached', 'failed']) {
                const neutral = bannerForSandboxResult({ outcome, elapsed: 100 }, {});
                expect(neutral.label).not.toMatch(/goal|reached|failed/i);
            }
        },
    );
});