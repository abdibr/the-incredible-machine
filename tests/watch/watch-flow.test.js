import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { FIXED_STEP_MS } from '../../js/engine/GameLoop.js';
import { AgentSession } from '../../agent/session.js';
import { place } from '../../agent/actions.js';
import {
    WatchFlow,
    fetchLevelDocument,
    levelUrlFor,
    formatEventRow,
    bannerForRunResult,
} from '../../js/watch/watchFlow.js';

/**
 * The watch page's run controller (issue #62).
 *
 * Solve & Watch on level-01, driven headlessly over the phase-1 surface:
 * the browser fetches the level JSON itself (the agent session's fs loader
 * stays Node-only, ADR 0010), the scripted solver searches through its
 * steppable facade one candidate per scheduled tick, and the winning
 * trial is then stepped over the #61 seam in small advance batches on the
 * page's own cadence - the page is never blocked for a whole trial. This
 * suite pins that cycle against an injected scheduler and an injected
 * fetch (the same served file the campaign loader points at), so the
 * browser-only rendering layer stays covered by the testable seams.
 */

/** @type {import('../../js/watch/watchFlow.js').WatchFlow|null} */
let flow = null;

afterEach(() => {
    flow?.cancel();
    flow = null;
    vi.restoreAllMocks();
});

/** The same served level document the campaign loader fetches. */
function readLevelJson(id) {
    return JSON.parse(readFileSync(new URL(`../../js/levels/puzzles/${id}.json`, import.meta.url), 'utf8'));
}

function diskFetch(id = 'level-01') {
    return () => {
        const doc = readLevelJson(id);
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(doc) });
    };
}

/**
 * A manual animation-frame scheduler (the page's cadence, unwrapped):
 * pump(times) runs one round - the callbacks queued at that instant, each
 * fed the given tick timestamp. Callbacks that re-schedule wait for the
 * next pump, exactly like real frames do.
 */
function makeTicker() {
    const queue = [];
    const schedule = (cb) => { queue.push(cb); return queue.length; };
    return {
        schedule,
        size: () => queue.length,
        clear: () => { queue.length = 0; },
        pump: (times) => {
            const n = queue.length;
            let ran = 0;
            for (let i = 0; i < n && queue.length > 0; i++) {
                queue.shift()(times);
                ran++;
            }
            return ran;
        },
    };
}

// Instance-id normalization: process-lifetime counter values are not world
// state (the parity suite's own convention - keep the two suites in step).
const INSTANCE_ID = /^([a-z0-9-]+)-(\d+)$/;
const ref = (id, type, i) => (INSTANCE_ID.test(id) ? `${type}@${i}` : id);
const poses = (snapshot) => snapshot.map((row, i) => ({ ...row, id: ref(row.id, row.type, i) }));

/**
 * Drive one flow through its solver phase (one candidate per tick) to the
 * watch phase or a terminal status. Returns nothing - the caller reads
 * flow.status after each call.
 */
function pumpSolving(ticker) {
    let guard = 0;
    while (flow.status === 'solving' && guard++ < 2000) ticker.pump();
    expect(guard).toBeLessThan(2000); // the search is bounded
}

describe('WatchFlow - the Solve & Watch cycle (issue #62)', () => {
    it(
        'streams level-01: solving progress per tick, the winning trial animated in small batches, live event rows, goal-reached banner',
        { timeout: 120000 },
        async () => {
            const ticker = makeTicker();
            const session = new AgentSession({ seed: null });
            const statuses = [];
            const events = [];
            const frames = [];
            const outcomes = [];
            const unsolved = [];
            const errors = [];
            flow = new WatchFlow({
                session,
                schedule: ticker.schedule,
                fetchImpl: diskFetch('level-01'),
                listeners: {
                    onStatus: (text) => statuses.push(text),
                    onEvent: (rows) => events.push(...rows),
                    onFrame: () => {
                        frames.push(session.engine ? [...session.engine.getObjects()].length : -1);
                    },
                    onWatchOutcome: (result) => outcomes.push(result),
                    onSolverUnsolved: (report) => unsolved.push(report),
                    onError: (message) => errors.push(message),
                },
            });

            await flow.start();
            expect(flow.status).toBe('solving');
            expect(statuses[0]).toContain(levelUrlFor('level-01')); // the fetch path the page runs
            expect(flow.levelId).toBe('level-01');

            // The solver search streams: one judged candidate per tick.
            pumpSolving(ticker);
            expect(flow.status).toBe('watching'); // the script found the win in-page
            // Progress streams one candidate per tick when the search runs
                        // past its first judgment (level-01 often wins on trial #1).
            if (flow.solverReport.trials > 1) {
                expect(statuses.some((t) => /solving - trial #/.test(t))).toBe(true);
            }
            const solved = statuses.find((t) => /solved after \d+ trial/.test(t));
            expect(solved).toContain('watching the winning trial');
            // The winning placements stand on the session (the watched rebuild uses them).
            expect(flow.solverReport.placements.length).toBeGreaterThan(0);

            // The watched run: small batches per tick - never the whole trial.
            let now = 0;
            const batches = [];
            let guard = 0;
            while (flow.status === 'watching' && guard++ < 2000) {
                const openRun = session.trialRun; // the #61 run view between ticks
                expect(openRun).not.toBeNull();
                expect(openRun.done).toBe(false);
                const before = openRun.stepped;
                now += 17;
                ticker.pump(now);
                if (flow.status === 'watching') {
                    const stepped = session.trialRun.stepped;
                    batches.push(stepped - before);
                    expect(stepped - before).toBeLessThanOrEqual(3); // small batches (maxBatchFrames)
                }
            }

            expect(flow.status).toBe('ended');
            // The trial unwrapped on ticks; a 1-frame win (a spawn-overlap
            // catch) is at least honest - the batch cap still held per tick.
            expect(batches.length).toBeGreaterThanOrEqual(1);
            expect(Math.max(...batches)).toBeLessThanOrEqual(3);
            expect(session.trialRun).toBeNull(); // finalized cleanly

            // The banner: one goal-reached outcome, honest fields.
            expect(unsolved).toHaveLength(0);
            expect(errors).toHaveLength(0);
            expect(outcomes).toHaveLength(1);
            const outcome = outcomes[0];
            expect(outcome.outcome).toBe('reached');
            expect(outcome.elapsed).toBeGreaterThan(0);
            expect(outcome.elapsed).toBeLessThan(5000); // latched, not budgeted out
            expect(outcome.elapsed).toBe(FIXED_STEP_MS * Math.round(outcome.elapsed / FIXED_STEP_MS)); // whole quanta
            expect(outcome.distance).toBeLessThan(80); // the ball sits in the zone

            // The HUD streamed live rows with timestamps, verdict emphasized.
            expect(events).toHaveLength(outcome.events.length); // the run's log arrived as it happened
            expect(events.map((r) => r.text)).toContain('ball caught by bucket-goal');
            expect(events.some((r) => r.landmark && /goal reached/.test(r.text))).toBe(true);
            events.forEach((r) => expect(r.t).toMatch(/^\d+\.\d{2}$/)); // seconds string, 2dp

            // The painter saw the live board across the cycle.
            expect(frames.length).toBeGreaterThanOrEqual(2); // the board before and during the run
            expect(frames.every((n) => n >= 0)).toBe(true);
        },
    );

    it(
        'the watched run IS trial() over the solver placements, and repeated cycles land identically',
        { timeout: 120000 },
        async () => {
            function runCycle() {
                const ticker = makeTicker();
                const session = new AgentSession({ seed: null });
                const outcomes = [];
                flow = new WatchFlow({
                    session,
                    schedule: ticker.schedule,
                fetchImpl: diskFetch('level-01'),
                    listeners: {
                        onWatchOutcome: (result) => outcomes.push(result),
                        onEvent: () => {},
                        onFrame: () => {},
                    },
                });
                return { ticker, session, outcomes, begin: () => flow.start().then(() => { pumpSolving(ticker); return ticker; }) };
            }

            const a = runCycle();
            await a.begin();
            let now = 0;
            while (flow.status === 'watching') a.ticker.pump((now += 17));
            expect(flow.status).toBe('ended');
            const resA = flow.result;
            const placementsA = flow.solverReport.placements;
            flow.cancel();

            // A second cycle, fresh session, same level: same world, same run.
            const b = runCycle();
            await b.begin();
            while (flow.status === 'watching') b.ticker.pump((now += 17));
            expect(b.outcomes[0].outcome).toBe('reached');
            flow.cancel(); // the other live session's checker must not co-fire on the shared bus
            expect(b.outcomes[0].outcome).toBe(a.outcomes[0].outcome);
            expect(b.outcomes[0].elapsed).toBe(a.outcomes[0].elapsed); // determinism: the same trial, re-watched
            expect(b.outcomes[0].events).toEqual(a.outcomes[0].events);
            expect(poses(b.outcomes[0].snapshot)).toEqual(poses(a.outcomes[0].snapshot));

            // The reference: trial() on the same placements, fresh session -
            // what the watched run judged and what trial() judges are one.
            const refSession = new AgentSession({ seed: null });
            await refSession.loadLevel('level-01');
            for (const p of placementsA) expect(place(refSession, p.type, p.x, p.y, { angle: p.angle }).ok).toBe(true);
            const refResult = refSession.trial({ seconds: 5 });
            refSession.dispose();

            expect(resA.outcome).toBe(refResult.outcome);
            expect(resA.distance).toBe(refResult.distance);
            expect(resA.elapsed).toBe(refResult.elapsed);
            expect(resA.events.map((r) => [r.t, r.text])).toEqual(refResult.events.map((r) => [r.t, r.text])); // timestamps included
            expect(poses(resA.snapshot)).toEqual(poses(refResult.snapshot));
        },
    );

    it(
        'an unwinning search ends unsolved with the diagnosis - reported, not run',
        { timeout: 30000 },
        async () => {
            const ticker = makeTicker();
            const statuses = [];
            const outcomes = [];
            const unsolved = [];
            flow = new WatchFlow({
                session: new AgentSession({ seed: null }),
                schedule: ticker.schedule,
                fetchImpl: diskFetch('level-01'),
                // level-01 with a 200px lattice and 2-frame budget: no
                // candidate can touch the bucket, so the search judges and
                // reports - the same bound the solver suite drives.
                maxTrials: 8,
                secondsPerTrial: 1 / 30,
                lattice: 200,
                listeners: {
                    onStatus: (text) => statuses.push(text),
                    onWatchOutcome: (result) => outcomes.push(result),
                    onSolverUnsolved: (report) => unsolved.push(report),
                    onEvent: () => {},
                    onFrame: () => {},
                },
            });

            await flow.start();
            pumpSolving(ticker);
            expect(flow.status).toBe('unsolved');
            expect(unsolved).toHaveLength(1);
            expect(unsolved[0].diagnosis).toMatch(/^unsolved - /);
            expect(statuses[statuses.length - 1]).toContain(unsolved[0].diagnosis); // the page says it, too
            expect(outcomes).toHaveLength(0); // no run to banner: the solver never found a win
            expect(flow.result).toBeNull();
        },
    );

    it('a failed level fetch surfaces a readable error - the flow ends, nothing scheduled on', async () => {
        const ticker = makeTicker();
        const errors = [];
        flow = new WatchFlow({
            session: new AgentSession({ seed: null }),
            schedule: ticker.schedule,
            fetchImpl: () => Promise.resolve({ ok: false, status: 404 }),
            listeners: { onError: (message) => errors.push(message), onStatus: () => {}, onEvent: () => {}, onFrame: () => {} },
        });

        await expect(flow.start()).resolves.toBeUndefined(); // never rejects out of the flow
        expect(flow.status).toBe('error');
        expect(errors[0]).toMatch(/HTTP 404/);
        expect(ticker.size()).toBe(0);
    });

    it('cancel stops the cycle and disposes its session - a late fetch lands on nothing', async () => {
        const ticker = makeTicker();
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        const session = new AgentSession({ seed: null });
        flow = new WatchFlow({
            session,
            schedule: ticker.schedule,
            fetchImpl: () => gate.then(() => ({ ok: true, status: 200, json: () => Promise.resolve(readLevelJson('level-01')) })),
            listeners: { onStatus: () => {}, onEvent: () => {}, onFrame: () => {} },
        });

        const starting = flow.start();
        flow.cancel();
        expect(flow.status).toBe('cancelled');
        release();
        await expect(starting).resolves.toBeUndefined(); // the late fetch resolves onto a cancelled flow
        let pumpThrew = null;
        try { ticker.pump(); } catch (e) { pumpThrew = e; }
        expect(pumpThrew).toBeNull();
    });
    it(
        'a longer winning run unwraps over many ticks - the fall lands mid-watch, every batch capped, rows streamed before the banner',
        { timeout: 60000 },
        async () => {
            const ticker = makeTicker();
            const session = new AgentSession({ seed: null });
            const events = [];
            const frames = [];
            const outcomes = [];
            const order = [];
            // No solver here: the level is installed and a deep drop is
            // watched directly (startWatch - the cycle's watch phase and the
            // page's rewatch seam). The classic (700, 100) drop is ~1s of
            // sim time - the case the "never blocking" contract is about.
            await session.loadLevel(readLevelJson('level-01'));
            flow = new WatchFlow({
                session,
                schedule: ticker.schedule,
                listeners: {
                    onStatus: () => {},
                    onEvent: (rows) => {
                        events.push(...rows);
                        order.push(...rows.map(() => 'event'));
                    },
                    onFrame: () => {
                        frames.push(session.engine ? [...session.engine.getObjects()].length : -1);
                        order.push('frame');
                    },
                    onWatchOutcome: (result) => {
                        outcomes.push(result);
                        order.push('outcome');
                    },
                },
            });

            flow.startWatch([{ type: 'ball', x: 700, y: 100, angle: 0 }]); // the known deep drop
            expect(flow.status).toBe('watching');
            expect(session.trialRun).not.toBeNull(); // the #61 run view is open between ticks

            let now = 0;
            const batches = [];
            while (flow.status === 'watching') {
                const before = session.trialRun.stepped;
                now += 17;
                ticker.pump(now);
                if (flow.status === 'watching') {
                    batches.push(session.trialRun.stepped - before);
                    expect(batches[batches.length - 1]).toBeLessThanOrEqual(3); // small batches
                    expect(session.trialRun.done).toBe(false); // the run is never finished inside one tick's read
                }
            }

            expect(flow.status).toBe('ended');
            expect(batches.length).toBeGreaterThan(20); // ~1s of sim unwrapped over dozens of ticks
            expect(Math.max(...batches)).toBeLessThanOrEqual(3); // never the whole trial in one call
            expect(outcomes).toHaveLength(1);
            expect(outcomes[0].outcome).toBe('reached');
            expect(events.map((r) => r.text)).toContain('ball caught by bucket-goal'); // streamed as it happened
            expect(order.lastIndexOf('event')).toBe(order.indexOf('outcome') - 1); // the row arrived before the banner
            expect(frames.length).toBeGreaterThanOrEqual(batches.length); // every tick painted
            expect(session.trialRun).toBeNull();
        },
    );
});

describe('the watch HUD vocabulary (issue #62)', () => {
    it('renders an event row the way trial observations do - the seconds timestamp and the sentence', () => {
        expect(formatEventRow({ t: '0.42', text: 'ball caught by bucket-goal' })).toBe('t=0.42s  ball caught by bucket-goal');
        expect(formatEventRow({ t: '1.00', text: 'goal reached (level-01 <- GOAL REACHED)' })).toBe('t=1.00s  goal reached (level-01 <- GOAL REACHED)');
    });

    it('composes the run banner per outcome - reached names the time, timeout the budget, failed the reason', () => {
        const reached = bannerForRunResult({ outcome: 'reached', elapsed: 1234.5 });
        expect(reached.label).toMatch(/reached/i);
        expect(reached.text).toMatch(/1\.23s/);
        const timeout = bannerForRunResult({ outcome: 'timeout', elapsed: 5000 });
        expect(timeout.label).toMatch(/timeout/i);
        const failed = bannerForRunResult({ outcome: 'failed', elapsed: 900, failureReason: 'The target fell off the playfield.' });
        expect(failed.label).toMatch(/failed/i);
        expect(failed.text).toContain('The target fell off the playfield.');
    });

    it('fetchLevelDocument reads the served level JSON the campaign loader also fetches', async () => {
        const seen = [];
        const doc = await fetchLevelDocument('level-01', {
            fetchImpl: (url) => {
                seen.push(url);
                const data = readLevelJson('level-01');
                return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
            },
        });
        expect(seen).toEqual([levelUrlFor('level-01')]); // the same URL the campaign loader points at
        expect(doc.id).toBe('level-01');
        expect(doc.goal).toBeDefined();
    });
});






