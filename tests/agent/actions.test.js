import { describe, it, expect, afterEach } from 'vitest';
import { AgentSession } from '../../agent/session.js';
import { place, remove, rotate, nudge, reset, trial } from '../../agent/actions.js';

/** @type {import('../../agent/session.js').AgentSession|null} */
let session = null;

afterEach(() => {
    session?.dispose();
    session = null;
});

describe('actions.place', () => {
    it('places within the availableParts budget and reports what is left', async () => {
        session = new AgentSession();
        await session.loadLevel('level-01');
        const first = place(session, 'ball', 300, 100);
        expect(first).toMatchObject({ ok: true, budgetLeft: 0 });
        expect(session.placements).toHaveLength(1);

        const second = place(session, 'ball', 300, 200); // budget exhausted
        expect(second.ok).toBe(false);
        expect(second.error).toMatch(/no budget left for ball/);
        expect(session.placements).toHaveLength(1);
    });

    it('rejects an unknown type without throwing', async () => {
        session = new AgentSession();
        await session.loadLevel('level-01');
        const result = place(session, 'wrench', 300, 300);
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/unknown type/);
    });

    it('rejects NaN coordinates and off-playfield centers with clamp info', async () => {
        session = new AgentSession();
        await session.loadLevel('level-01');
        expect(place(session, 'ball', Number.NaN, 100).ok).toBe(false);
        const off = place(session, 'ball', 1100, 100);
        expect(off.ok).toBe(false);
        expect(off.error).toMatch(/off-playfield/);
        expect(off.clampedTo.x).toBeLessThanOrEqual(1000);
    });
});

describe('actions editing', () => {
    it('remove / rotate / nudge address placements by type + slot', async () => {
        session = new AgentSession();
        await session.loadLevel('level-01'); // budget: ball×1, ramp×1
        place(session, 'ramp', 400, 200);
        place(session, 'ball', 500, 100);
        expect(session.placements.map((p) => p.type)).toEqual(['ramp', 'ball']);

        const removed = remove(session, 'ramp', 0);
        expect(removed.ok).toBe(true);
        expect(removed.removed.y).toBe(200);
        expect(session.placements.map((p) => p.type)).toEqual(['ball']);

        expect(rotate(session, 'ball', 0, 0.35)).toMatchObject({ ok: true, angle: 0.35 });
        expect(session.placements[0].angle).toBeCloseTo(0.35);

        const nudged = nudge(session, 'ball', 25, -10);
        expect(nudged).toMatchObject({ ok: true, x: 525, y: 90 });

        const missing = remove(session, 'ball', 1);
        expect(missing.ok).toBe(false);
        expect(missing.error).toMatch(/no placed ball #1/);
    });

    it('reset wipes only the placements, not the level', async () => {
        session = new AgentSession();
        await session.loadLevel('level-01');
        place(session, 'ball', 300, 100);
        place(session, 'ramp', 400, 250);
        const cleared = reset(session);
        expect(cleared).toMatchObject({ ok: true, cleared: 2 });
        expect(session.placements).toHaveLength(0);
        expect(session.levelData.id).toBe('level-01');
    });
});

describe('actions.trial', () => {
    it('runs a direct drop above the goal bucket and REACHES', { timeout: 30000 }, async () => {
        session = new AgentSession();
        await session.loadLevel('level-01');
        const placed = place(session, 'ball', 700, 100);
        expect(placed.ok).toBe(true);

        const result = trial(session, { seconds: 5 });
        expect(result.outcome).toBe('reached');
        // Event narrative contains the catch, with a timestamp.
        const caught = result.events.find((row) => row.who === 'ball');
        expect(caught).toBeTruthy();
        expect(Number(caught.t)).toBeGreaterThan(0);
        // Snapshot carries named + generated ids, public getters only.
        const bucket = result.snapshot.find((s) => s.id === 'bucket-goal');
        expect(bucket).toBeTruthy();
        expect(result.distance).toBeLessThan(40); // ball rests inside the zone, ~0-ish
    });

    it('times out (not throws) when nothing happens', { timeout: 30000 }, async () => {
        session = new AgentSession();
        await session.loadLevel('level-01');
        place(session, 'ball', 100, 100); // ball far from the bucket, lands on floor
        const result = trial(session, { seconds: 2 });
        expect(['timeout', 'failed']).toContain(result.outcome);
        expect(result.elapsed).toBeGreaterThan(0);
    });
});