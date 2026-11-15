import { describe, it, expect, afterEach } from 'vitest';
import { AgentSession } from '../../agent/session.js';
import { place } from '../../agent/actions.js';
import { stateRows } from '../../agent/observe/state.js';
import { renderGrid } from '../../agent/observe/grid.js';

/**
 * Seeded determinism for agent trials (phase-2 ticket 4/6).
 *
 * The only construction-time randomness in the sim is Math.random inside
 * object ctors - Balloon color/bob phase, Candle flicker phase. Agent
 * sessions get an opt-in seeded PRNG over that construction window: same
 * seed -> repeated builds of the same level + placements produce identical
 * event logs and identical world/state output. With no seed configured,
 * behavior is exactly today's.
 */

const SEED_A = 1337;
const SEED_B = 424242;

/** @type {import('../../agent/session.js').AgentSession|null} */
let session = null;

afterEach(() => {
    session?.dispose();
    session = null;
});

// Fixture worlds (ad-hoc level data - loadLevel accepts full documents).
// The bucket is the goal zone, named exactly like the shipped levels name it.
const BALLOON_LEVEL = {
    id: 'seeded-balloon-fixture',
    name: 'seeded determinism fixture - balloon',
    goal: { type: 'object_in_zone', targetType: 'ball', zoneId: 'bucket-goal' },
    fixedObjects: [{ type: 'bucket', x: 700, y: 480, id: 'bucket-goal' }],
    availableParts: { balloon: 2, ball: 1 },
};

// Instance ids (`balloon-3`) are process-lifetime counters (BaseObject
// _nextId) - not world state, never cross-session stable. The stable
// cross-session reference is customId or type@<board ordinal> (GLOSSARY
// RefId rule), which is what the capture normalizes each row to.
const INSTANCE_ID = /^([a-z0-9-]+)-(\d+)$/;
const ref = (id, type, i) => (INSTANCE_ID.test(id) ? `${type}@${i}` : id);

/** Full-precision live body state, read through the same public getters the
 *  observation layer uses (obj.bodies -> Matter position/velocity), but
 *  UNROUNDED: the bob-phase noise lives in these low decimals, so these are
 *  the bytes that distinguish seeds. */
function liveState(session) {
    return [...session.engine.getObjects()].map((obj, i) => ({
        ref: ref(obj.customId ?? `${obj.type}-${obj.id}`, obj.type, i),
        type: obj.type,
        bodies: obj.bodies.map((b) => (b && b.position ? { x: b.position.x, y: b.position.y, vx: b.velocity.x, vy: b.velocity.y } : null)),
    }));
}

/**
 * Byte-comparable trial record: verdict + event log + world/state output,
 * with instance-id noise normalized away. Everything else compared
 * verbatim - same seed MUST reproduce these bytes exactly.
 */
function stableRecord(session, { seconds = 3 } = {}) {
    const result = session.trial({ seconds });
    return JSON.stringify({
        outcome: result.outcome,
        elapsed: result.elapsed,
        distance: result.distance,
        failureReason: result.failureReason,
        events: result.events,
        snapshot: result.snapshot.map((r, i) => ({ ...r, id: ref(r.id, r.type, i) })),
        state: stateRows(session.engine, session.goal).map((r, i) => ({ ...r, id: ref(r.id, r.type, i) })),
        live: liveState(session),
        grid: renderGrid(session.engine, { cell: 16 }).lines,
    });
}

/** One full balloon-bearing trial in a fresh seeded session; assert the record is non-vacuous first. */
async function balloonRun(seed) {
    const s = new AgentSession({ seed });
    try {
        await s.loadLevel(BALLOON_LEVEL);
        expect(place(s, 'balloon', 150, 250)).toMatchObject({ ok: true });
        expect(place(s, 'ball', 700, 500)).toMatchObject({ ok: true }); // the known level-01-shaped win drop
        const record = stableRecord(s);
        // Guard richness: the trial must contain its catch + verdict events,
        // so byte-equality can never pass over an accidentally-empty record.
        expect(record).toContain('caught by bucket-goal');
        expect(record).toContain('goal reached');
        return record;
    } finally {
        s.dispose();
    }
}

describe('seeded determinism - reproducible agent trials through the session seam', () => {
    it('same seed, two fresh sessions: byte-identical trial output (balloon-bearing)', async () => {
        const first = await balloonRun(SEED_A);
        const second = await balloonRun(SEED_A);
        expect(second).toBe(first);
    });
});