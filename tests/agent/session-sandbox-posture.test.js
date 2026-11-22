import { describe, it, expect, afterEach } from 'vitest';
import { AgentSession } from '../../agent/session.js';
import { levelManager } from '../../js/levels/LevelManager.js';

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
