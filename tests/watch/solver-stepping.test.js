import { describe, it, expect, afterEach } from 'vitest';
import { AgentSession } from '../../agent/session.js';
import { solve, solveTrials } from '../../agent/solver.js';

/**
 * The solver's steppable facade (issue #62).
 *
 * The watch page must never block: it drives the scripted solver through
 * an incremental facade - the same search loop solve() owns, yielded one
 * judged candidate at a time so a page can spread the search over frames -
 * and solve() is the composition of it (the #61 pattern: the all-at-once
 * spelling cannot drift from the steppable one). Parity is the contract:
 * stepping the solver to the end returns the exact report solve() returns
 * on the same level and options.
 */

/** @type {import('../../agent/session.js').AgentSession|null} */
let session = null;

afterEach(() => {
    session?.dispose();
    session = null;
});

// Instance ids (`ball-17`) are process-lifetime counter values - never
// stable between two builds; the stable in-board reference is customId or
// type@<board ordinal>, the parity suite's own normalization. Poses,
// timestamps and distances are never normalized - those bytes must agree.
const INSTANCE_ID = /^([a-z0-9-]+)-(\d+)$/;
const ref = (id, type, i) => (INSTANCE_ID.test(id) ? `${type}@${i}` : id);
const poses = (snapshot) => snapshot.map((row, i) => ({ ...row, id: ref(row.id, row.type, i) }));
const parityView = (report) =>
    report.result ? { ...report, result: { ...report.result, snapshot: poses(report.result.snapshot) } } : report;

const SOLVE_OPTIONS = { maxTrials: 800, secondsPerTrial: 5, lattice: 50 };

describe('solveTrials - the solver is steppable one candidate at a time (issue #62)', () => {
    it(
        'solve() is the composition: stepping the solver to the end returns the exact report solve() returns',
        { timeout: 90000 },
        async () => {
            session = new AgentSession();
            await session.loadLevel('level-01');
            const reportA = solve(session, SOLVE_OPTIONS);
            expect(reportA.outcome).toBe('reached'); // sanity: the script beats level-01
            session.dispose();
            session = null;

            // The steppable spelling of the same search, one session later.
            session = new AgentSession();
            await session.loadLevel('level-01');
            const iterator = solveTrials(session, SOLVE_OPTIONS);
            let reportB = null;
            for (;;) {
                const next = iterator.next();
                if (next.done) {
                    reportB = next.value;
                    break;
                }
            }

            expect(parityView(reportB)).toEqual(parityView(reportA)); // outcome, trials, placements, result - identical
            expect(session.trialRun).toBeNull(); // the composition leaves no open run
        },
    );

    it(
        'each judged candidate yields a progress report a page can render, with the best-so-far ranking riding along',
        { timeout: 90000 },
        async () => {
            // level-01 with a 200px lattice and a 2-frame budget: the lattice
            // points sit 200px away from the bucket, so no candidate can even
            // touch the sensor - every candidate is judged and yielded, never
            // reached (maxTrials caps the search; the reach case is the parity
            // test above). A real session, real physics, no geometry roulette.
            session = new AgentSession();
            await session.loadLevel('level-01');
            const iterator = solveTrials(session, { maxTrials: 8, secondsPerTrial: 1 / 30, lattice: 200 });
            const progress = [];
            for (;;) {
                const next = iterator.next();
                if (next.done) {
                    expect(next.value.outcome).toBe('unsolved'); // the clean failure, as solve() judges it
                    expect(next.value.trials).toBe(8); // the maxTrials budget is honored (8 target-alone candidates at lattice 200)
                    break;
                }
                progress.push(next.value);
            }

            expect(progress).toHaveLength(8); // one yield per judged candidate
            let bestScore = Infinity;
            progress.forEach((p, i) => {
                expect(p.trials).toBe(i + 1); // trials judged so far, 1-based
                expect(Array.isArray(p.candidate)).toBe(true); // the placements this trial judged
                expect(p.candidate[0].type).toBe('ball'); // the goal's targetType drives the target
                expect(p.result.outcome).toBe('timeout'); // nothing reaches: every trial is a clean timeout
                expect(Number.isFinite(p.result.distance)).toBe(true); // the ranking signal is real
                expect(p.best.score).toBeLessThanOrEqual(bestScore); // the best-so-far never worsens
                bestScore = p.best.score;
            });
            expect(session.trialRun).toBeNull(); // between yields: trial() composition, never an open run
        },
    );
});


