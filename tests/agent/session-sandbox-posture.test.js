import { describe, it, expect, afterEach } from 'vitest';
import { AgentSession } from '../../agent/session.js';
import { place, trial } from '../../agent/actions.js';
import { levelManager } from '../../js/levels/LevelManager.js';
import { eventBus } from '../../js/EventBus.js';

/**
 * The sandbox posture (issue #63).
 *
 * A sandbox AgentSession mirrors the game's Sandbox mode: an ad-hoc,
 * goal-less session where placements draw from the parts palette (the
 * registered roster) and trials run to a result with NO goal verdicts
 * or goal events ever firing. The posture relaxes exactly two rules -
 * the typed-goal requirement and the level scarcity budget - and never
 * weakens puzzle rules: puzzle documents still answer to the same
 * `_validate` the campaign loader runs, byte for byte.
 */

/** @type {import('../../agent/session.js').AgentSession|null} */
let session = null;

afterEach(() => {
    session?.dispose();
    session = null;
});

// A goal-less ad-hoc sandbox document: id, name and the (empty) board are
// its structural fields - no goal, no availableParts budget, no ADR 0009
// solution proof. A sandbox build is not a winnable puzzle, so it ships
// none of the puzzle's own furniture.
const EMPTY_SANDBOX = {
    id: 'sandbox-empty-fixture',
    name: 'sandbox posture fixture - an empty board',
    fixedObjects: [],
};

describe('the sandbox gate - goal-less documents (issue #63)', () => {
    it('accepts a goal-less document for the sandbox posture', async () => {
        session = new AgentSession({ sandbox: true });
        await session.loadLevel(EMPTY_SANDBOX);
        // The level owner still owns the install (issue #78): the session
        // consumes the levelManager seam, never hand-feeds its own world.
        expect(levelManager.getCurrentLevel()?.id).toBe('sandbox-empty-fixture');
        expect(session.goal).toBeNull();
        // The board builds: the empty playfield is real.
        expect(session.engine).not.toBeNull();
    });

    it('keeps requiring the structural fields (id, name, fixedObjects)', async () => {
        session = new AgentSession({ sandbox: true });
        await expect(session.loadLevel({ id: 'sandbox-x', fixedObjects: [] })).rejects.toThrow(
            /\[LevelManager\] Level missing required field: "name"/,
        );
        session = new AgentSession({ sandbox: true });
        await expect(session.loadLevel({ id: 'sandbox-x', name: 'no board' })).rejects.toThrow(
            /\[LevelManager\] Level missing required field: "fixedObjects"/,
        );
    });

    it('refuses a ride-along goal without a type with the puzzle wording', async () => {
        session = new AgentSession({ sandbox: true });
        await expect(
            session.loadLevel({
                ...EMPTY_SANDBOX,
                goal: { targetType: 'ball', zoneId: 'bucket-goal' },
            }),
        ).rejects.toThrow(/\[LevelManager\] Level goal must have a "type" field/);
    });

    it('puzzle documents still require a typed goal', async () => {
        // The same goal-less document that the sandbox posture accepts is
        // refused by the puzzle gate: the relaxation is the posture's, and
        // only the posture's. Exact pre-existing wording ([LevelManager] is
        // the document schema owner's voice, issue #78 convention).
        const puzzle = new AgentSession();
        await expect(puzzle.loadLevel(EMPTY_SANDBOX)).rejects.toThrow(
            /\[LevelManager\] Level missing required field: "goal"/,
        );
        puzzle.dispose();
    });
});


/**
 * Tap the bus for the duration of one run: the loop facts the run seam
 * publishes plus the goal family the posture must keep silent. Every
 * subscription is drained by stop().
 */
function tapEvents(topics) {
    const rows = [];
    const unsubs = topics.map((topic) => {
        const listener = (packet) => rows.push({ topic, packet });
        eventBus.on(topic, listener);
        return () => eventBus.off(topic, listener);
    });
    return { rows, stop: () => unsubs.forEach((unsub) => unsub()) };
}

// A sandbox document that carries a goal shape (the sandbox gate tolerates
// the ride-along) and a reachable catch: the level-01 geometry - the named
// bucket at (700, 480), the known drop at (700, 100). The carried
// availableParts count is large enough that the placement law of BOTH
// postures (level budget before the palette cycle, roster palette after)
// admits it, so this test never hinges on the budget source.
const JUDGED_BOARD = {
    id: 'sandbox-judged-fixture',
    name: 'sandbox posture fixture - a goal rides along',
    goal: { type: 'object_in_zone', targetType: 'ball', zoneId: 'bucket-goal' },
    fixedObjects: [{ type: 'bucket', x: 700, y: 480, id: 'bucket-goal' }],
    availableParts: { ball: 10 },
};

describe('sandbox runs never judge a goal (issue #63)', () => {
    it('judge no goal even when the document carries one - a catch is recorded, the run still times out', async () => {
        session = new AgentSession({ sandbox: true });
        await session.loadLevel(JUDGED_BOARD);
        const tap = tapEvents(['goal:reached', 'goal:failed']);
        // The known-winning drop (level-01 geometry): the ball falls into
        // the named bucket. The catch is real; the verdict must not be.
        expect(place(session, 'ball', 700, 100).ok).toBe(true);
        const result = trial(session, { seconds: 5 });
        tap.stop();
        // The catch is real physics - the recorder row says so - but the
        // posture never turns it into a verdict: no goal:* row ever hits the
        // bus, the run rides to its budget and times out.
        expect(result.outcome).toBe('timeout');
        expect(result.events.some((row) => /caught by bucket-goal/.test(row.text))).toBe(true);
        expect(tap.rows).toEqual([]);
    });

    it('goal-less trials ride the same loop facts to a timeout (the #78 stream, zero goal rows)', async () => {
        session = new AgentSession({ sandbox: true });
        await session.loadLevel(EMPTY_SANDBOX);
        const tap = tapEvents(['loop:play', 'loop:frame', 'loop:reset', 'mode:changed', 'goal:reached', 'goal:failed']);
        const result = trial(session, { seconds: 1 });
        tap.stop();
        expect(result.outcome).toBe('timeout');
        expect(result.events).toEqual([]);
        expect(result.distance).toBe(Infinity);
        expect(tap.rows.filter((r) => r.topic === 'goal:reached' || r.topic === 'goal:failed')).toEqual([]);
        const frames = tap.rows.filter((r) => r.topic === 'loop:frame');
        expect(frames.length).toBe(60);
        expect(tap.rows[0].topic).toBe('loop:play');
        expect(tap.rows[tap.rows.length - 1].topic).toBe('loop:reset');
        expect(tap.rows.filter((r) => r.topic === 'loop:play').length).toBe(1);
        expect(tap.rows.filter((r) => r.topic === 'loop:reset').length).toBe(1);
    });
});


describe('sandbox placements draw from the parts palette (issue #63)', () => {
    it('the palette is the registered roster at the default count: ten place, the eleventh is over-palette', async () => {
        session = new AgentSession({ sandbox: true });
        await session.loadLevel(EMPTY_SANDBOX);
        for (let i = 0; i < 10; i++) {
            const result = place(session, 'ball', 100 + i * 40, 100);
            expect(result.ok).toBe(true);
            expect(result.budgetLeft).toBe(9 - i);
        }
        const refused = place(session, 'ball', 100, 100);
        // The same never-throw refusal shape a puzzle session's exhausted
        // budget returns - wording, error key and remaining map alike.
        expect(refused.ok).toBe(false);
        expect(refused.error).toBe('no budget left for ball');
        expect(refused.remaining.ball).toBe(0);
    });

    it('a type outside the roster is refused as unknown - the roster is the palette', async () => {
        session = new AgentSession({ sandbox: true });
        await session.loadLevel(EMPTY_SANDBOX);
        expect(place(session, 'unregistered-widget', 500, 300)).toEqual({
            ok: false,
            error: 'unknown type: unregistered-widget',
        });
    });

    it('the level document carries no budget - a scarce availableParts map cannot constrain the sandbox', async () => {
        session = new AgentSession({ sandbox: true });
        await session.loadLevel({ ...EMPTY_SANDBOX, availableParts: { ball: 1 } });
        expect(place(session, 'ball', 100, 100).ok).toBe(true);
        // A puzzle budget would refuse here (ball: 1) - the palette answers.
        expect(place(session, 'ball', 140, 100).ok).toBe(true);
    });

    it('the off-playfield refusal keeps the puzzle shape', async () => {
        session = new AgentSession({ sandbox: true });
        await session.loadLevel(EMPTY_SANDBOX);
        const result = place(session, 'ball', 2000, 300);
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/off-playfield/);
        expect(result.clampedTo.x).toBeLessThanOrEqual(1000);
    });
});
