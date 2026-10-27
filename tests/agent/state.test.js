import { describe, it, expect, afterEach } from 'vitest';
import { AgentSession } from '../../agent/session.js';
import { stateRows, renderState } from '../../agent/observe/state.js';
import { place, trial } from '../../agent/actions.js';

/** @type {import('../../agent/session.js').AgentSession|null} */
let session = null;

afterEach(() => {
    session?.dispose();
    session = null;
});

describe('observe/state', () => {
    it('lists fixed level objects with their named ids and goal-zone flags', async () => {
        session = new AgentSession();
        await session.loadLevel('level-01');
        const rows = stateRows(session.engine, session.goal);

        const bucket = rows.find((r) => r.id === 'bucket-goal');
        expect(bucket).toBeTruthy();
        expect(bucket.type).toBe('bucket');
        expect(bucket.flags).toBe('fixed');
        expect(bucket.extra).toMatch(/goal-zone/);
        expect(bucket.extra).toMatch(/caught:0/);
    });

    it('describes a placed ball as dynamic, with a motion verdict and target flag', { timeout: 30000 }, async () => {
        session = new AgentSession();
        await session.loadLevel('level-01');
        place(session, 'ball', 700, 100);
        trial(session, { seconds: 5 });

        const rows = stateRows(session.engine, session.goal);
        const ball = rows.find((r) => r.type === 'ball');
        expect(ball).toBeTruthy();
        expect(ball.flags).toBe('dynamic');
        expect(ball.extra).toMatch(/target-type/);

        const bucket = rows.find((r) => r.id === 'bucket-goal');
        expect(bucket.extra).toMatch(/caught:1/); // the goal bucket caught it
    });

    it('renders aligned columns with a fixed header', async () => {
        session = new AgentSession();
        await session.loadLevel('level-01');
        const lines = renderState(session.engine, session.goal);
        expect(lines[0]).toContain('id');
        expect(lines[0]).toContain('type');
        expect(lines[0]).toContain('pos');
        expect(lines[0]).toContain('flags');
        expect(lines[0]).toContain('motion');
        expect(lines[0]).toContain('extra');
        expect(lines[1]).toMatch(/^-+ {2}-+/); // separator line
        expect(lines.length).toBeGreaterThanOrEqual(3); // header + sep + ≥1 object
    });
});