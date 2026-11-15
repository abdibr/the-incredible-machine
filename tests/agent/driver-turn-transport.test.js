import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentSession } from '../../agent/session.js';
import { runTurn } from '../../agent/turn.js';
import { startTurnServer } from '../../agent/server.js';
import { resolveDriverConfig, runDriver, DRIVER_ENV } from '../../agent/driver.js';
import { startStubServer, makeWinPolicy, makeJammerPolicy } from '../helpers/stub-provider.js';

/**
 * Turn-boundary transport tests (phase-2 ticket 5/6): the driver's tools
 * talk to a turn service over HTTP when TIM_AGENT_TURN_BASE_URL says so,
 * and stay in-process when it does not. This file pins (1) the config
 * surface - the container-mode switch is env-first, CLI-won, unambiguous -
 * and (2) the transport itself: driver turns served by real turn services
 * over real HTTP behind the env var, while the default path stays today's
 * in-process runTurn, byte-for-byte.
 */

describe('resolveDriverConfig - TIM_AGENT_TURN_BASE_URL (the container-mode switch)', () => {
    it('reads the turn base URL from env, exposing it as config.turnBaseUrl', () => {
        const { errors, config } = resolveDriverConfig({
            argv: ['--model', 'm'],
            env: { [DRIVER_ENV.TURN_BASE_URL]: 'http://127.0.0.1:8787' },
        });
        expect(errors).toEqual([]);
        expect(config.turnBaseUrl).toBe('http://127.0.0.1:8787');
    });

    it('CLI --turn-base-url overrides the env var (CLI wins, house rule)', () => {
        const { errors, config } = resolveDriverConfig({
            argv: ['--model', 'm', '--turn-base-url', 'http://127.0.0.1:9999'],
            env: { [DRIVER_ENV.TURN_BASE_URL]: 'http://127.0.0.1:8787' },
        });
        expect(errors).toEqual([]);
        expect(config.turnBaseUrl).toBe('http://127.0.0.1:9999');
    });

    it('an unset TIM_AGENT_TURN_BASE_URL leaves turnBaseUrl undefined - host mode byte-for-byte', () => {
        const { errors, config } = resolveDriverConfig({ argv: ['--model', 'm'], env: {} });
        expect(errors).toEqual([]);
        expect(config.turnBaseUrl).toBeUndefined();
    });

    it('a non-http(s) turn base URL is a config error naming the env var', () => {
        const { errors, config } = resolveDriverConfig({
            argv: ['--model', 'm'],
            env: { [DRIVER_ENV.TURN_BASE_URL]: 'ftp://127.0.0.1:8787' },
        });
        expect(config).toBeNull();
        expect(errors.join(' ')).toContain(DRIVER_ENV.TURN_BASE_URL);
        expect(errors).toHaveLength(1);
        expect(errors.join(' ')).toMatch(/an http\(s\):\/\/ URL is required/);
    });
});


/** @type {import('../../agent/session.js').AgentSession|null} the in-test stub SERVICE owns this session (never the driver). */
let serviceSession = null;
let dir = null;
const stubs = [];
/** @type {Array<{ close(): Promise<void> }>} */
const services = [];

afterEach(async () => {
    serviceSession?.dispose();
    serviceSession = null;
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
    for (const s of stubs.splice(0)) await s.close();
    for (const s of services.splice(0)) await s.close();
});

/**
 * In-test TURN SERVICE stub: a real HTTP server that answers POST /turn
 * exactly like agent/server.js does (runTurn over its own AgentSession -
 * the same seam the container runs) but COUNTS every request, so the test
 * can prove the driver's tool calls travel the wire instead of calling
 * in-process runTurn.
 */
function startCountingTurnService() {
    const posts = [];
    let session = null;
    let currentLevel = null;
    function respond(res, status, payload) {
        const body = JSON.stringify(payload);
        res.writeHead(status, {
            'content-type': 'application/json; charset=utf-8',
            'content-length': Buffer.byteLength(body),
        });
        res.end(body);
    }
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', async () => {
            let actionJson = null;
            try { actionJson = raw ? JSON.parse(raw) : null; } catch { actionJson = null; }
            posts.push({ method: req.method, url: req.url, actionJson });
            if (req.method !== 'POST' || req.url !== '/turn') {
                return respond(res, 404, { observation: '(no session)', result: { ok: false, error: 'unknown endpoint: ' + req.method + ' ' + req.url } });
            }
            const level = typeof actionJson?.level === 'string' ? actionJson.level : 'level-01';
            if (!session || currentLevel !== level) {
                serviceSession?.dispose();
                serviceSession = null;
                const next = new AgentSession();
                try {
                    await next.loadLevel(level);
                } catch {
                    next.dispose();
                    return respond(res, 400, { observation: '(no session)', result: { ok: false, error: 'cannot load level "' + level + '"' } });
                }
                session = next;
                serviceSession = next;
                currentLevel = level;
            }
            respond(res, 200, runTurn(actionJson, session));
        });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve({
            port: server.address().port,
            url: 'http://127.0.0.1:' + server.address().port,
            posts,
            close: () => new Promise((r) => server.close(r)),
        }));
    }).then((svc) => (services.push(svc), svc));
}

/**
 * Fixture: temp transcript dir + stub LLM provider + a config that points
 * the driver at a turn service purely through TIM_AGENT_TURN_BASE_URL. NO
 * host session is involved - container mode must not need one.
 */
async function containerFixture(policy, turnServiceUrl, { argv = [] } = {}) {
    dir = await mkdtemp(join(tmpdir(), 'tim-turn-transport-'));
    const transcriptPath = join(dir, 'transcript.txt');
    const stub = await startStubServer(policy);
    stubs.push(stub);
    const { errors, config } = resolveDriverConfig({
        argv: [...argv, '--transcript', transcriptPath],
        env: {
            [DRIVER_ENV.MODEL]: 'stub-model',
            [DRIVER_ENV.BASE_URL]: 'http://127.0.0.1:' + stub.port + '/v1', // the LLM stub (provider seam)
            [DRIVER_ENV.TURN_BASE_URL]: turnServiceUrl, // the GAME seam under test
        },
    });
    return { stub, errors, config, transcriptPath };
}

describe('driver turn transport - TIM_AGENT_TURN_BASE_URL routes every tool turn over HTTP', () => {
    it(
        'runs the driver with NO host session: the tools win level-01 against the real /turn wire, the level rides every payload, every round-trip is counted',
        { timeout: 90000 },
        async () => {
            const service = await startCountingTurnService();
            const { errors, config } = await containerFixture(makeWinPolicy(), service.url);
            expect(errors).toEqual([]);

            const res = await runDriver(config, null); // no session: the world lives behind HTTP only

            // the acceptance shape: win, cleanly, through the service boundary
            expect(res.outcome).toBe('goal-reached');
            expect(res.turns).toBe(2);

            // every phase of the run traveled the wire: opening observation + place + trial
            expect(service.posts.length).toBe(3);
            expect(service.posts.map((p) => p.actionJson.action)).toEqual(['observe', 'place', 'trial']);

            // the level is SELECTED AGAINST THE SERVICE BY CONFIG: config.level
            // rides on every turn payload (the service scopes its session per
            // request) - no separate handshake.
            for (const p of service.posts) expect(p.actionJson.level).toBe('level-01');

            // the transcript names the mode so the artifact is self-auditing
            expect(res.transcript).toContain('turn service: ' + service.url);
        },
    );

    it(
        'runs the whole thing against the REAL turn service (agent/server.js) - the exact code the container runs',
        { timeout: 90000 },
        async () => {
            const service = await startTurnServer(); // production module, ephemeral port
            services.push(service);
            const { errors, config } = await containerFixture(makeWinPolicy(), service.url);
            expect(errors).toEqual([]);

            const res = await runDriver(config, null);

            expect(res.outcome).toBe('goal-reached');
            expect(res.turns).toBe(2);
            expect(res.transcript).toContain('turn service: ' + service.url);
        },
    );

    it(
        'config.level scopes the session on the service even when the service boots with a different default level',
        { timeout: 90000 },
        async () => {
            const service = await startTurnServer({ defaultLevel: 'level-02' });
            services.push(service);
            const { errors, config } = await containerFixture(makeWinPolicy(), service.url, { argv: ['--level', 'level-01'] });
            expect(errors).toEqual([]);

            const res = await runDriver(config, null);

            expect(res.outcome).toBe('goal-reached');
            // the served world is the configured one, not the server default:
            // the transcript observation excerpt opens with level-01's header line
            expect(res.transcript).toMatch(/level-01 — First Steps/);
        },
    );

    it(
        'a dead turn service is structured data, never a throw: turns report unreachable and the run ends at the cap',
        { timeout: 90000 },
        async () => {
            const ghost = await startTurnServer(); // take a port, then close it: guaranteed-refused endpoint
            const deadUrl = ghost.url;
            await ghost.close();
            const { errors, config } = await containerFixture(makeJammerPolicy(), deadUrl, { argv: ['--max-turns', '2'] });
            expect(errors).toEqual([]);

            const res = await runDriver(config, null); // no throw may escape this line

            expect(res.outcome).toBe('turn-cap');
            expect(res.turns).toBe(2);
            expect(res.transcript).toContain('turn service unreachable');
            expect(res.transcript).toContain('outcome: turn-cap');
        },
    );

    it('keeps the default path today\'s: without the env var there is no turnBaseUrl and runDriver demands a host session', async () => {
        const { errors, config } = resolveDriverConfig({ argv: ['--model', 'm'], env: {} });
        expect(errors).toEqual([]);
        expect(config.turnBaseUrl).toBeUndefined();
        await expect(runDriver(config, null)).rejects.toThrow(/loaded level/);
    });

    it(
        'every phase-1 verb travels /turn as the EXACT action JSON, one POST per driver turn (ticket #94)',
        { timeout: 90000 },
        async () => {
            const service = await startCountingTurnService();
            // A model persona exercising ALL SIX action verbs in order, one tool call per
            // driver turn - the shapes the per-verb definitions build, including the
            // defaults the model may omit (angle, dt) and the slot it may pass.
            const moves = [
                { name: 'place', args: { type: 'ball', x: 260, y: 40 } },
                { name: 'rotate', args: { type: 'ball', radians: 0.25, slot: 0 } },
                { name: 'nudge', args: { type: 'ball', dx: 1, dy: 2, slot: 0 } },
                { name: 'remove', args: { type: 'ball', slot: 0 } },
                { name: 'reset', args: {} },
                { name: 'trial', args: { seconds: 5 } },
            ];
            let step = 0;
            const { errors, config } = await containerFixture(
                () => {
                    // one tool call per driver turn, in the six-verb order above; when the run
                    // ends cleanly the loop is already at the cap, so the fallback text is dead code.
                    const move = step < moves.length ? moves[step++] : null;
                    return move ? { calls: [move] } : { text: 'done.' };
                },
                service.url,
                { argv: ['--max-turns', String(moves.length)] },
            );
            expect(errors).toEqual([]);

            await runDriver(config, null); // no session: the world lives behind HTTP only

            // post[0] is the opening observe; then ONE POST per verb carrying the
            // exact phase-1 action JSON each verb definition builds, config.level stamped on.
            expect(service.posts.map((p) => p.actionJson)).toEqual([
                { action: 'observe', level: 'level-01' },
                { action: 'place', type: 'ball', x: 260, y: 40, level: 'level-01' },
                { action: 'rotate', type: 'ball', radians: 0.25, slot: 0, level: 'level-01' },
                { action: 'nudge', type: 'ball', dx: 1, dy: 2, slot: 0, level: 'level-01' },
                { action: 'remove', type: 'ball', slot: 0, level: 'level-01' },
                { action: 'reset', level: 'level-01' },
                { action: 'trial', seconds: 5, level: 'level-01' },
            ]);
        },
    );
});
