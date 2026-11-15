import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { AgentSession } from '../../agent/session.js';
import { resolveSeed, createSeedRng, SEED_ENV_VAR } from '../../agent/rng.js';
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

beforeEach(() => {
    delete process.env[SEED_ENV_VAR]; // no ambient seed leaks between tests
});

afterEach(() => {
    session?.dispose();
    session = null;
    vi.unstubAllEnvs();
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

// Candle-bearing world: the fixed candle is the only construction-random
// object beyond the placed balloon (Candle ctor draws its flicker phase).
// The balloon rises into the flame, so the trial carries a real event.
const CANDLE_LEVEL = {
    id: 'seeded-candle-fixture',
    name: 'seeded determinism fixture - candle',
    goal: { type: 'object_in_zone', targetType: 'ball', zoneId: 'bucket-goal' },
    fixedObjects: [{ type: 'bucket', x: 200, y: 480, id: 'bucket-goal' }, { type: 'candle', x: 500, y: 470 }],
    availableParts: { balloon: 1 },
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

/** One full candle-bearing trial (place a balloon under the candle flame). */
async function candleRun(seed) {
    const s = new AgentSession({ seed });
    try {
        await s.loadLevel(CANDLE_LEVEL);
        expect(place(s, 'balloon', 500, 560)).toMatchObject({ ok: true });
        const record = stableRecord(s);
        // Guard richness: the balloon must actually reach the flame, so the
        // record covers the event log, not an accidentally-empty world.
        expect(record).toContain('balloon popped');
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

    it('same session, repeated build of the same level + placements: byte-identical output', async () => {
        session = new AgentSession({ seed: SEED_A });
        await session.loadLevel(BALLOON_LEVEL);
        expect(place(session, 'balloon', 150, 250)).toMatchObject({ ok: true });
        expect(place(session, 'ball', 700, 500)).toMatchObject({ ok: true });

        const first = stableRecord(session);
        const second = stableRecord(session); // trial() rebuilds the world every call
        expect(second).toBe(first);
    });

    it('different seeds produce different trial records (the pin can discriminate)', async () => {
        const seeded = await balloonRun(SEED_A);
        const other = await balloonRun(SEED_B);
        expect(other).not.toBe(seeded);
    });

    it('same seed, two fresh sessions: byte-identical trial output (candle-bearing)', async () => {
        const first = await candleRun(SEED_A);
        const second = await candleRun(SEED_A);
        expect(second).toBe(first);
    });
});
describe('seed source - option, or TIM_AGENT_SEED env var (session ctor seam)', () => {
    it('env var seeds the session when no option is given, and reproduces the option-seeded run', async () => {
        vi.stubEnv(SEED_ENV_VAR, '4242');
        session = new AgentSession();
        expect(session.seed).toBe(4242);
        await session.loadLevel(BALLOON_LEVEL);
        expect(place(session, 'balloon', 150, 250)).toMatchObject({ ok: true });
        expect(place(session, 'ball', 700, 500)).toMatchObject({ ok: true });
        const envRecord = stableRecord(session);
        const id = session; session = null; id.dispose();

        // The option-spelled constructor with the same value must produce the
        // same bytes - the two spellings are one seam.
        expect(envRecord).toBe(await balloonRun(4242));
    });

    it('invalid env value: warns loudly, session stays unseeded', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            vi.stubEnv(SEED_ENV_VAR, 'not-a-number');
            session = new AgentSession();
            expect(session.seed).toBeNull();
            expect(warnSpy).toHaveBeenCalled();
        } finally {
            warnSpy.mockRestore();
        }
    });

    it('invalid option seed (even with an env fallback set): warns, stays unseeded', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            vi.stubEnv(SEED_ENV_VAR, '65536');
            session = new AgentSession({ seed: 'banana' });
            expect(session.seed).toBeNull();
            expect(warnSpy).toHaveBeenCalled();
        } finally {
            warnSpy.mockRestore();
        }
    });

    it('seed 0 is configured (falsy but valid)', () => {
        vi.stubEnv(SEED_ENV_VAR, '0');
        session = new AgentSession();
        expect(session.seed).toBe(0);
    });
});

describe('agent/rng - resolveSeed + generator', () => {
    it('refuses unusable values with a warning, normalizes usable ones', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            expect(resolveSeed(undefined)).toBeNull();
            expect(resolveSeed(null)).toBeNull();
            expect(resolveSeed('')).toBeNull();
            expect(resolveSeed('   ')).toBeNull();
            expect(resolveSeed(0)).toBe(0);
            expect(resolveSeed('1337')).toBe(1337);
            expect(resolveSeed(12.75)).toBe(12);
            expect(resolveSeed(4294967303)).toBe(7); // wraps like a uint32
            expect(resolveSeed(-1)).toBeNull();
            expect(resolveSeed('banana')).toBeNull();
            expect(resolveSeed(Infinity)).toBeNull();
            expect(warnSpy).toHaveBeenCalledTimes(3);
        } finally {
            warnSpy.mockRestore();
        }
    });

    it('same seed -> identical draw sequence; different seeds diverge; draws stay in [0,1)', () => {
        const draws = (seed, n) => {
            const rng = createSeedRng(seed);
            return Array.from({ length: n }, () => rng());
        };
        expect(draws(1337, 8)).toEqual(draws(1337, 8));
        expect(draws(1337, 8)).not.toEqual(draws(1338, 8));
        for (const v of draws(1337, 8)) {
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThan(1);
        }
    });
});

describe('no seed configured - the byte-identical-by-default constraint', () => {
    it('unseeded construction still consumes the global Math.random, as today', async () => {
        const original = Math.random;
        const probe = vi.fn(() => 0.5); // pin the external generator
        Math.random = probe;
        try {
            session = new AgentSession();
            await session.loadLevel(BALLOON_LEVEL);
            expect(place(session, 'balloon', 150, 250)).toMatchObject({ ok: true });
            expect(place(session, 'ball', 700, 500)).toMatchObject({ ok: true });

            // With the external generator pinned, repeated builds are exact -
            // proving Math.random is the pipeline's only construction entropy.
            expect(stableRecord(session)).toBe(stableRecord(session));
        } finally {
            Math.random = original;
        }
        expect(probe).toHaveBeenCalled(); // the default path really drew from it
    });

    it('seeded build bypasses the global and restores it after the construction window', async () => {
        const original = Math.random;
        const probe = vi.fn(original);
        Math.random = probe;
        try {
            session = new AgentSession({ seed: SEED_A });
            await session.loadLevel(BALLOON_LEVEL);
            expect(place(session, 'balloon', 150, 250)).toMatchObject({ ok: true });
            // place() builds a THROWAWAY clamp probe outside any window (an
            // ambient draw with zero effect on results - bounds never consult
            // the random options); clear it so the assertion below audits
            // exactly the seeded BUILD.
            probe.mockClear();

            session.trial({ seconds: 1 }); // trial() rebuilds: the seeded window

            expect(probe).not.toHaveBeenCalled(); // build draws came from the session PRNG
            expect(Math.random).toBe(probe); // the swap-out cannot leak past the window
        } finally {
            Math.random = original;
        }
    });
});