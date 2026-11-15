import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

/** The worktree root this suite runs from - the child probe loads levels like the main suite. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Absolute file URL of the service module - the child probe imports it directly. */
const SERVER_MODULE_URL = pathToFileURL(join(REPO_ROOT, 'agent', 'server.js')).href;

/** The probe body: one throwaway real service, one fetch, one JSON verdict line. */
const PROBE_SCRIPT = `
import { startTurnServer } from ${JSON.stringify(SERVER_MODULE_URL)};
const service = await startTurnServer({ port: 0 });
const res = await fetch(service.url + process.env.PROBE_TARGET, { signal: AbortSignal.timeout(3000) });
const body = await res.json();
console.log(JSON.stringify({ status: res.status, level: body.level, observation: body.observation.slice(0, 60) }));
await service.close();
`;

/**
 * A one-request /observation probe in a THROWAWAY child process. A child
 * on purpose: the pinned bug (a client action key reaching the trial loop
 * through /observation) wedges the serialized session chain forever - run
 * in-process, a regression would hang this whole suite worker; in a child
 * it just fails this one pin fast.
 * @param {string} target the request path incl. the query string
 * @returns {Promise<{ status: number, level: string, observation: string }>}
 */
function runObservationProbe(target) {
    return new Promise((resolve, reject) => {
        const child = spawn(
            process.execPath,
            ['--input-type=module', '-e', PROBE_SCRIPT],
            { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PROBE_TARGET: target } },
        );
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        let out = '';
        let err = '';
        child.stdout.on('data', (chunk) => { out += chunk; });
        child.stderr.on('data', (chunk) => { err += chunk; });
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`observation probe wedged: no answer within 12s (stderr: ${err.slice(-200)})`));
        }, 12000);
        child.on('error', (e) => { clearTimeout(timer); reject(e); });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (code !== 0) {
                reject(new Error(`observation probe failed (exit ${code}): ${err.slice(-200)}`));
                return;
            }
            try {
                resolve(JSON.parse(out));
            } catch {
                reject(new Error(`observation probe printed no verdict: ${out.slice(0, 200)}`));
            }
        });
    });
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
describe('turn service - /observation rides the same option builder as the turn path (ticket #95)', () => {
    it('a POST /observation body carries the same five options as a /turn action JSON', async () => {
        // the JSON body maps into the builder exactly like an action turn:
        // real booleans, real cell values, describeWorld defaults when absent
        const res = await post('/observation', { cell: 'full', key: false, graph: false, state: false });

        expect(res.status).toBe(200);
        expect(res.body.observation).toMatch(/cell 8px/);
        expect(res.body.observation).not.toMatch(/legend:/);
        expect(res.body.observation).not.toMatch(/relations/);
        expect(res.body.observation).not.toMatch(/state:/);
    });

    it('query params ride the same composition: key/state/graph are honored from the query too', async () => {
        // `?state=&graph=&key=` reads the empty string - falsy like a JSON
        // `false`, so the whole trio turns off from the query string alone.
        const res = await fetch(`${service.url}/observation?state=&graph=&key=`);
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.observation).toContain('level-01'); // still a complete observation
        expect(body.observation).not.toMatch(/state:/);
        expect(body.observation).not.toMatch(/relations/);
        expect(body.observation).not.toMatch(/legend:/);
    });

    it('a query cell still wins over the body cell - the raw-params merge order is pinned', async () => {
        const res = await post('/observation?cell=full', { cell: 'auto' });

        expect(res.status).toBe(200);
        expect(res.body.observation).toMatch(/cell 8px/);
    });

    it('the raw falsy spellings read OFF from the query too: grid=0, key=false, state=0', async () => {
        // a query string has no types: the empty strings the sibling pin
        // uses read OFF, and so must the other raw falsy spellings '0' and
        // 'false' - a `"grid": false` body and a `?grid=false` query must
        // not disagree (a non-empty string is not automatically ON)
        const res = await fetch(`${service.url}/observation?grid=0&key=false&state=0&graph=false`);
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.observation).toContain('level-01'); // still a complete observation
        expect(body.observation).not.toMatch(/world \d+x\d+, cell/); // grid off
        expect(body.observation).not.toMatch(/legend:/); // key off
        expect(body.observation).not.toMatch(/state:/); // state off
        expect(body.observation).not.toMatch(/relations/); // graph off
    });
});

describe('turn service - the pinned observe verb: /observation is never an action path (ticket #95)', () => {
    it('an action key in the POST body cannot reach the action dispatch: nothing placed, read-only envelope', async () => {
        const obs = await post('/observation', { action: 'place', type: 'ball', x: 700, y: 100 });

        expect(obs.status).toBe(200);
        expect(obs.body, 'an observation answers with the observation only').not.toHaveProperty('result');
        expect(obs.body.observation).toContain('level-01');

        // the body "place" bought nothing: the ball budget is untouched
        const place = await post('/turn', { action: 'place', type: 'ball', x: 300, y: 100 });
        expect(place.status).toBe(200);
        expect(place.body.result, 'the /observation body action must not consume the ball budget').toMatchObject({ ok: true });
    });

    it('an action key in the GET query cannot reach the world: ?action=reset mutates nothing', async () => {
        await post('/turn', { action: 'place', type: 'ball', x: 700, y: 100 });
        const before = await (await fetch(`${service.url}/observation`)).json();

        const res = await fetch(`${service.url}/observation?action=reset`);
        const after = await res.json();

        expect(res.status).toBe(200);
        expect(after.observation, '?action=reset must be ignored - the board is untouched').toBe(before.observation);

        // the placed ball survived: a REAL reset clears exactly 1
        const reset = await post('/turn', { action: 'reset' });
        expect(reset.body.result).toMatchObject({ ok: true, cleared: 1 });
    });

    it(
        'an action key in the GET query cannot reach the trial loop: the wedging ?action=trial&dt= stays an observation',
        { timeout: 30000 },
        async () => {
            // dt='' is the wedging input: through a verb hole the merged
            // action would run a trial with dt '' -> steps = Infinity ->
            // the single-session promise chain wedges forever (and with it
            // this suite's service). The probe child isolates exactly that.
            const verdict = await runObservationProbe('/observation?action=trial&dt=');

            expect(verdict.status).toBe(200);
            expect(verdict.level).toBe('level-01');
            expect(verdict.observation, 'still an observation, never a trial').toContain('level-01');
        },
    );
});
