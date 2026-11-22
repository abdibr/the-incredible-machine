import { describe, it, expect, afterEach } from 'vitest';
import { AgentSession } from '../../agent/session.js';
import { place } from '../../agent/actions.js';
import { applyBuildBeat, SANDBOX_BUILD_SCRIPT, beatLabel } from '../../js/watch/sandboxScript.js';
import { SandboxFlow, SANDBOX_BOARD } from '../../js/watch/sandboxFlow.js';

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
