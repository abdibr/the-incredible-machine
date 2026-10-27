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