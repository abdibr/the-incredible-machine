import { describe, it, expect, afterEach } from 'vitest';
import { AgentSession } from '../../agent/session.js';
import { runTurn } from '../../agent/turn.js';

/** @type {import('../../agent/session.js').AgentSession|null} */
let session = null;

afterEach(() => {
    session?.dispose();
    session = null;
});

describe('runTurn - the one agent-side seam', () => {
    it('applies a place action and returns { observation, result }', async () => {
        session = new AgentSession();
        await session.loadLevel('level-01');

        const turn = runTurn({ action: 'place', type: 'ball', x: 700, y: 100 }, session);

        // result is the phase-1 never-throw action result, untouched.
        expect(turn.result).toMatchObject({ ok: true, type: 'ball', x: 700, y: 100, budgetLeft: 0 });
        // observation is the prompt-ready describeWorld block naming the level.
        expect(typeof turn.observation).toBe('string');
        expect(turn.observation).toContain('level-01');
        expect(turn.observation).toContain('state:');
    });

    it(
        'returns the envelope for EVERY action type - accepted or rejected',
        { timeout: 30000 },
        async () => {
            session = new AgentSession();
            await session.loadLevel('level-01');

            const turns = {};
            // place (accepted here; rejection covered by the next test)
            turns.place = runTurn({ action: 'place', type: 'ramp', x: 300, y: 200 }, session);
            turns.remove = runTurn({ action: 'remove', type: 'ramp', slot: 0 }, session);
            turns.place2 = runTurn({ action: 'place', type: 'ball', x: 500, y: 100 }, session);
            turns.rotate = runTurn({ action: 'rotate', type: 'ball', slot: 0, radians: 0.5 }, session);
            turns.nudge = runTurn({ action: 'nudge', type: 'ball', dx: 20, dy: -10 }, session);
            turns.reset = runTurn({ action: 'reset' }, session);
            turns.trial = runTurn({ action: 'trial', seconds: 2 }, session);
            turns.observe = runTurn({ action: 'observe' }, session);

            for (const [name, turn] of Object.entries(turns)) {
                expect(turn.observation.length, `${name} must carry an observation`).toBeGreaterThan(0);
                expect(turn.result, `${name} must carry a result`).toBeTypeOf('object');
            }
            expect(turns.remove.result).toMatchObject({ ok: true });
            expect(turns.rotate.result).toMatchObject({ ok: true, angle: 0.5 });
            expect(turns.nudge.result).toMatchObject({ ok: true, x: 520, y: 90 });
            expect(turns.reset.result).toMatchObject({ ok: true, cleared: 1 });
            expect(turns.trial.result).toMatchObject({ outcome: 'timeout' }); // empty world: clean timeout, no throw
            expect(turns.observe.result).toMatchObject({ ok: true });
        },
    );

    it('returns the SAME envelope for a REJECTED action - clamp info intact', async () => {
        session = new AgentSession();
        await session.loadLevel('level-01');

        const turn = runTurn({ action: 'place', type: 'ball', x: 1400, y: 100 }, session);

        expect(turn.result).toMatchObject({ ok: false });
        expect(turn.result.error).toMatch(/off-playfield/);
        expect(turn.result.clampedTo.x).toBeLessThanOrEqual(1000);
        // the envelope is complete even on rejection
        expect(turn.observation).toContain('level-01');
    });
});

describe('runTurn - bad input never throws', () => {
    it('rejects unknown actions with a structured error naming the known set', async () => {
        session = new AgentSession();
        await session.loadLevel('level-01');

        const turn = runTurn({ action: 'teleport', x: 1 }, session);

        expect(turn.result.ok).toBe(false);
        expect(turn.result.error).toMatch(/unknown action/);
        expect(turn.result.error).toMatch(/teleport/);
        expect(turn.result.error).toMatch(/place/); // names the known actions
        expect(turn.observation).toContain('level-01'); // envelope complete
    });

    it('rejects malformed payloads with a structured error - never throws', async () => {
        session = new AgentSession();
        await session.loadLevel('level-01');

        for (const bad of [null, undefined, '', '  ', 'place', 42, [], { type: 'ball' }]) {
            let turn;
            expect(() => { turn = runTurn(bad, session); }, `malformed payload: ${JSON.stringify(bad)}`).not.toThrow();
            expect(turn.result.ok).toBe(false);
            expect(typeof turn.result.error).toBe('string');
            expect(turn.result.error).toMatch(/malformed request/);
            expect(turn.observation).toContain('level-01');
        }
        // the missing-action case says precisely what is missing
        const noAction = runTurn({ type: 'ball' }, session);
        expect(noAction.result.error).toMatch(/"action"/);
    });

    it('handles a missing session with a structured error - never throws', () => {
        let turn;
        expect(() => { turn = runTurn({ action: 'place', type: 'ball', x: 1, y: 1 }, null); }).not.toThrow();
        expect(turn.result.ok).toBe(false);
        expect(turn.result.error).toMatch(/session/i);
        expect(turn.observation.length).toBeGreaterThan(0);
    });
});
describe('runTurn - observation composition', () => {
    it(
        'a TRIAL turn narrates events into the observation and the result',
        { timeout: 30000 },
        async () => {
            session = new AgentSession();
            await session.loadLevel('level-01');
            runTurn({ action: 'place', type: 'ball', x: 700, y: 100 }, session);

            const turn = runTurn({ action: 'trial', seconds: 5 }, session);

            expect(turn.result.outcome).toBe('reached');
            expect(turn.result.events.length).toBeGreaterThan(0); // result stays the phase-1 trial result
            expect(turn.observation).toMatch(/events:/);
            expect(turn.observation).toMatch(/caught by bucket-goal/);
        },
    );

    it(
        'an OBSERVE turn carries the last trial events standalone',
        { timeout: 30000 },
        async () => {
            session = new AgentSession();
            await session.loadLevel('level-01');
            runTurn({ action: 'place', type: 'ball', x: 700, y: 100 }, session);
            runTurn({ action: 'trial', seconds: 5 }, session);

            const turn = runTurn({ action: 'observe' }, session);

            expect(turn.result).toMatchObject({ ok: true });
            expect(turn.observation).toMatch(/events:/); // observation block includes events
            expect(turn.observation).toMatch(/goal reached/);
        },
    );

    it('a PLACE turn does not narrate stale events from a previous trial', async () => {
        session = new AgentSession();
        await session.loadLevel('level-01');
        runTurn({ action: 'place', type: 'ball', x: 700, y: 100 }, session);
        runTurn({ action: 'trial', seconds: 2 }, session);

        const turn = runTurn({ action: 'place', type: 'ball', x: 300, y: 100 }, session); // rejected: no budget

        expect(turn.observation).not.toMatch(/events:/);
    });
});

describe('runTurn - observation options', () => {
    it('cell and section toggles ride along on the action JSON', async () => {
        session = new AgentSession();
        await session.loadLevel('level-01');

        const turn = runTurn({ action: 'observe', cell: 'full', key: false, graph: false }, session);

        expect(turn.observation).toMatch(/cell 8px/); // full forces the precise 8px map
        expect(turn.observation).not.toMatch(/legend:/); // key off
        expect(turn.observation).not.toMatch(/relations/); // graph off
    });
});
describe('trialGuardError - THE one trial clamp (server 400 refusal + driver tool pre-validation share it)', () => {
    it('agent/turn.js exposes the shared clamp constants and the documented refusal strings', async () => {
        // dynamic import so the pin is the red: the exports do not exist yet
        const turnMod = await import('../../agent/turn.js');
        expect(turnMod.MAX_TRIAL_SECONDS).toBe(120);
        expect(turnMod.MAX_TRIAL_DT).toBe(1000);
        const { trialGuardError } = turnMod;
        expect(trialGuardError({ seconds: 1000000 })).toBe('trial seconds must be a number between 0 and 120 (got 1000000)');
        expect(trialGuardError({ seconds: 0 })).toBe('trial seconds must be a number between 0 and 120 (got 0)');
        expect(trialGuardError({ seconds: 120.5 })).toBe('trial seconds must be a number between 0 and 120 (got 120.5)');
        expect(trialGuardError({ seconds: 'lots' })).toBe('trial seconds must be a number between 0 and 120 (got "lots")');
        expect(trialGuardError({ dt: 0 })).toBe('trial dt must be a number between 1 and 1000 ms (got 0)');
        expect(trialGuardError({ dt: -5 })).toBe('trial dt must be a number between 1 and 1000 ms (got -5)');
        expect(trialGuardError({ dt: 1001 })).toBe('trial dt must be a number between 1 and 1000 ms (got 1001)');
        expect(trialGuardError({})).toBeNull();
        expect(trialGuardError({ seconds: 5, dt: 1000 })).toBeNull();
        expect(trialGuardError({ seconds: undefined, dt: 16.67 })).toBeNull();
        expect(trialGuardError({ seconds: 120, dt: 1 })).toBeNull();
    });
});
