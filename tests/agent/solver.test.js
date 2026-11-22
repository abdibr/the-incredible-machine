import { describe, it, expect, afterEach } from 'vitest';
import { AgentSession } from '../../agent/session.js';
import { solve, candidatePlacements } from '../../agent/solver.js';

/** @type {import('../../agent/session.js').AgentSession} */
let session = null;

afterEach(() => {
    session?.dispose();
    session = null;
});

describe('solver — the phase-1 proof', () => {
    it(
        'beats level-01 using only place() + trial()',
        { timeout: 90000 },
        async () => {
            session = new AgentSession();
            await session.loadLevel('level-01');

            const report = solve(session, { maxTrials: 800, secondsPerTrial: 5 });

            expect(report.outcome).toBe('reached');
            expect(report.trials).toBeGreaterThan(0);
            expect(report.trials).toBeLessThanOrEqual(800);
            // The winning placements are real, budgeted placements.
            for (const p of report.placements) expect(p.type).toMatch(/^(ball|ramp)$/);
            // Deterministic replay of the winning trial ends near the zone.
            expect(report.result.distance).toBeLessThan(80);
        },
    );

    it(
        'on a level it cannot win it fails CLEANLY with a bounded trial count and a diagnosis',
        { timeout: 90000 },
        async () => {
            session = new AgentSession();
            await session.loadLevel('level-04');

            const report = solve(session, { maxTrials: 50, secondsPerTrial: 2 });

            expect(['reached', 'unsolved']).toContain(report.outcome); // never hangs, never throws
            expect(report.trials).toBeLessThanOrEqual(50);
            if (report.outcome === 'unsolved') {
                expect(typeof report.diagnosis).toBe('string');
                expect(report.diagnosis).toMatch(/unsolved/);
            }
        },
    );

    it(
        'a level whose goal TARGET is not placeable reports that cause, not "no valid candidate placements"',
        async () => {
            // Level-02 is the ramp-only posture: the ball is scene furniture
            // (fixed + anchored), availableParts carries ramps alone. Every
            // candidate the generator yields contains a `place <target>` -
            // refused for want of budget - so nothing is ever judged.
            session = new AgentSession();
            await session.loadLevel('level-02');
            expect(session.budget().ball).toBeUndefined(); // the target is not in availableParts

            const report = solve(session, { maxTrials: 5, secondsPerTrial: 2 });

            expect(report.outcome).toBe('unsolved');
            expect(report.diagnosis).toMatch(/unsolved/);
            // The old wording blamed the candidate list for a search that
            // never ran; the honest one names the real limit: the target is
            // already in the scene, so no build can add it.
            expect(report.diagnosis).not.toMatch(/no valid candidate placements/);
            expect(report.diagnosis).toMatch(/ball/);
            expect(report.diagnosis).toMatch(/already in the scene|not placeable|no .*budget/i);
        },
    );

    it('the target drop is the tutorial lesson only - a non-tutorial level refuses it and says why', async () => {
        session = new AgentSession();
        await session.loadLevel('level-03'); // ball budgeted, but dropping it in is not the level
        const report = solve(session);
        expect(report.outcome).toBe('unsolved');
        expect(report.trials).toBe(0); // nothing was even judged
        expect(report.diagnosis).toMatch(/tutorial/);
        expect(report.diagnosis).toMatch(/#104/); // the open gap, named
    });

    it('a non-tutorial level yields no candidates at all - not even the helper+target pair', async () => {
        session = new AgentSession();
        await session.loadLevel('level-05'); // target is a mouse, and still not the lesson
        expect(candidatePlacements(session, { lattice: 50 }).next().done).toBe(true);
    });

    it('enumerates candidates deterministically, target-alone first', async () => {
        session = new AgentSession();
        await session.loadLevel('level-01');
        const gen = candidatePlacements(session, { lattice: 50 });
        const first = gen.next().value;
        expect(first).toHaveLength(1);
        expect(first[0].type).toBe('ball'); // goal.targetType drives the target
        // Same request → identical first candidate (deterministic order).
        const again = candidatePlacements(session, { lattice: 50 }).next().value;
        expect(again[0]).toEqual(first[0]);
    });
});