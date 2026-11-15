import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTurnServer } from '../../agent/server.js';

/**
 * Integration tests over REAL HTTP: the service starts on an ephemeral
 * port, every turn goes through the wire, failures come back as
 * structured JSON - never stack traces.
 */

/** @type {{ url: string, port: number, close(): Promise<void>}|null} */
let service = null;

beforeAll(async () => {
    service = await startTurnServer({ port: 0 });
});

beforeEach(async () => {
    // every test starts on level-01 with a clean board
    await post('/level', { level: 'level-01' });
    await post('/turn', { action: 'reset' });
});

afterAll(async () => {
    await service?.close();
    service = null;
});

/** Fetch JSON, parse from raw text so malformed bodies stay assertable. */
async function post(path, body) {
    const res = await fetch(`${service.url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body ?? null),
    });
    const text = await res.text();
    return { status: res.status, text, body: JSON.parse(text) };
}

describe('turn service - POST /turn over real HTTP', () => {
    it(
        'drives the win over REAL HTTP: place a ball, run a trial, level-01 goal reached',
        { timeout: 30000 },
        async () => {
            const place = await post('/turn', { action: 'place', type: 'ball', x: 700, y: 100 });
            expect(place.status).toBe(200);
            expect(place.body.result).toMatchObject({ ok: true, type: 'ball', x: 700, y: 100 });
            expect(place.body.observation).toContain('level-01');

            const trial = await post('/turn', { action: 'trial', seconds: 5 });
            expect(trial.status).toBe(200);
            // THE acceptance: the level-01 goal reached via the response payload.
            expect(trial.body.result.outcome).toBe('reached');
            expect(trial.body.observation).toMatch(/events:/);
        },
    );
});

describe('turn service - structured errors, never stack traces', () => {
    it('a malformed body returns machine-readable JSON with a structured error (400)', async () => {
        const res = await fetch(`${service.url}/turn`, { method: 'POST', body: 'not json {' });
        const text = await res.text();
        expect(res.status).toBe(400);
        expect(JSON.parse(text).result).toMatchObject({ ok: false });
        expect(text).not.toMatch(/stack/i);
        const envelope = JSON.parse(text);
        expect(typeof envelope.observation).toBe('string');
    });

    it('an empty body is malformed too - never a 500 or a hang', async () => {
        const res = await fetch(`${service.url}/turn`, { method: 'POST' });
        expect(res.status).toBe(400);
        expect((await res.json()).result.ok).toBe(false);
    });

    it('an unknown action returns a structured 400 naming the known set', async () => {
        const res = await post('/turn', { action: 'teleport', x: 1 });
        expect(res.status).toBe(400);
        expect(res.body.result.error).toMatch(/unknown action/);
        expect(res.body.result.error).toMatch(/teleport/);
    });

    it('a KNOWN action rejected by game rules is still a 200 with the phase-1 result', async () => {
        const off = await post('/turn', { action: 'place', type: 'ball', x: 1400, y: 100 });
        expect(off.status).toBe(200);
        expect(off.body.result.ok).toBe(false);
        expect(off.body.result.error).toMatch(/off-playfield/);
        expect(off.body.result.clampedTo.x).toBeLessThanOrEqual(1000); // clamp info rides the wire
    });

    it('an over-budget placement is a 200 with the budget rejection', async () => {
        await post('/turn', { action: 'place', type: 'ball', x: 700, y: 100 });
        const second = await post('/turn', { action: 'place', type: 'ball', x: 300, y: 100 });
        expect(second.status).toBe(200);
        expect(second.body.result.ok).toBe(false);
        expect(second.body.result.error).toMatch(/no budget left for ball/);
        expect(second.body.result.remaining).toMatchObject({ ball: 0 });
    });
});

describe('turn service - standalone observation endpoint', () => {
    it('GET /observation returns the observation block with the current level', async () => {
        const res = await fetch(`${service.url}/observation`);
        const body = await res.json();
        expect(res.status).toBe(200);
        expect(body.level).toBe('level-01');
        expect(body.observation).toContain('level-01');
        expect(body.observation).toContain('state:');
        expect(body.observation).toContain('legend:');
        expect(body.observation).toContain('relations');
    });

    it('the observation reflects turns made through /turn - grid, state and trial events', async () => {
        await post('/turn', { action: 'place', type: 'ball', x: 700, y: 100 });
        await post('/turn', { action: 'trial', seconds: 2 });

        const body = await (await fetch(`${service.url}/observation`)).json();

        expect(body.observation).toMatch(/events:/);
        expect(body.observation).toMatch(/goal reached/);
    });

    it('GET /observation?cell=full forces the precise 8px map', async () => {
        const body = await (await fetch(`${service.url}/observation?cell=full`)).json();
        expect(body.observation).toMatch(/cell 8px/);
    });
});

describe('turn service - level selection', () => {
    it('POST /level selects the session scope and reports the level observation', async () => {
        const res = await post('/level', { level: 'level-02' });

        expect(res.status).toBe(200);
        expect(res.body.level).toBe('level-02');
        expect(res.body.observation).toContain('level-02');

        // the scope persists: a plain /turn now plays level-02
        const place = await post('/turn', { action: 'place', type: 'ball', x: 500, y: 100 });
        expect(place.body.result.ok).toBe(true);
        const obs = await (await fetch(`${service.url}/observation`)).json();
        expect(obs.level).toBe('level-02');
    });

    it('a level id in the /turn body switches the scope too', async () => {
        const res = await post('/turn', { level: 'level-02', action: 'observe' });

        expect(res.status).toBe(200);
        expect(res.body.observation).toContain('level-02');
        const obs = await (await fetch(`${service.url}/observation`)).json();
        expect(obs.level).toBe('level-02');
    });

    it('an unknown level id is a structured 400 - and the service survives', async () => {
        const bad = await post('/level', { level: 'level-99' });

        expect(bad.status).toBe(400);
        expect(bad.body.result.ok).toBe(false);
        expect(bad.body.result.error).toMatch(/cannot load level "level-99"/);

        const ok = await post('/turn', { action: 'reset' });
        expect(ok.status).toBe(200);
        expect(ok.body.result.ok).toBe(true);
    });

    it('a path-like level id is refused, never read from disk', async () => {
        const bad = await post('/level', { level: '../js/EventBus' });

        expect(bad.status).toBe(400);
        expect(bad.body.result.error).toMatch(/invalid level id/);
    });
});

describe('turn service - routing discipline', () => {
    it('GET /health reports ok and the current level', async () => {
        const res = await fetch(`${service.url}/health`);

        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ ok: true, level: 'level-01' });
    });

    it('GET /turn is a structured 405 - the endpoint exists, the method is wrong', async () => {
        const res = await fetch(`${service.url}/turn`);

        expect(res.status).toBe(405);
        const body = await res.json();
        expect(body.result.ok).toBe(false);
        expect(body.result.error).toMatch(/method GET not allowed on \/turn/);
    });

    it('unknown endpoints are structured 404s with named paths', async () => {
        const res = await fetch(`${service.url}/nope`);

        expect(res.status).toBe(404);
        const body = await res.json();
        expect(body.result.ok).toBe(false);
        expect(body.result.error).toMatch(/unknown endpoint: GET \/nope/);
    });
});

describe('turn service - concurrency and request hardening', () => {
    it('concurrent place + trial stay ordered: the trial sees the placement', { timeout: 30000 }, async () => {
        const [place, trial] = await Promise.all([
            post('/turn', { action: 'place', type: 'ball', x: 700, y: 100 }),
            post('/turn', { action: 'trial', seconds: 5 }),
        ]);

        expect(place.status).toBe(200);
        expect(trial.status).toBe(200);
        expect(trial.body.result.outcome).toBe('reached'); // only reachable if the requests were serialized
    });

    it('absurd trial seconds are refused with a structured 400, not a hang', async () => {
        const res = await post('/turn', { action: 'trial', seconds: 1000000 });

        expect(res.status).toBe(400);
        expect(res.body.result.error).toMatch(/seconds/);
    });

    it('a non-numeric seconds is refused with a structured 400', async () => {
        const res = await post('/turn', { action: 'trial', seconds: 'lots' });

        expect(res.status).toBe(400);
        expect(res.body.result.error).toMatch(/seconds/);
    });

    it('a non-positive or huge dt is refused with a structured 400', async () => {
        for (const dt of [0, -5, 100000]) {
            const res = await post('/turn', { action: 'trial', dt });
            expect(res.status, `dt=${dt}`).toBe(400);
            expect(res.body.result.error, `dt=${dt}`).toMatch(/dt/);
        }
    });
});
