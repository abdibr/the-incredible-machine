import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { runTurn } from '../../agent/turn.js';
import { AgentSession } from '../../agent/session.js';
import {
    resolveLiveDriverConfig,
    createChatModelTransport,
    createLocalTurnTransport,
    createHttpTurnTransport,
    LiveFlow,
} from '../../js/watch/liveFlow.js';
import { startStubServer, makeWinPolicy } from '../helpers/stub-provider.js';
import { startTurnServer } from '../../agent/server.js';
import { readFileSync as readLevelFileSync } from 'node:fs';

/**
 * The live LLM turn source in the watch page (issue #65).
 *
 * The page's driver becomes the real phase-2 agent: a browser driver loop
 * speaks the same protocol agent/driver.js speaks (the instructions, the
 * stall nudge, the opening directive, the action-tool table) and drives
 * the game through the headless turn service's /turn envelope - while the
 * page's own session (the #62/#64 posture) stays the WATCHED world, the
 * same one the steppable seam animates. This suite pins the client-side
 * contract piece by piece; the flows that make the watch page (WatchFlow
 * from #62, SandboxFlow from #64) are the scripted fallback that stays
 * usable when the service degrades.
 *
 * This first slice - THE ONE PROTOCOL: the model-facing contract lives in
 * ONE leaf module (agent/driver-protocol.js) that both drivers import, so
 * the browser driver and the Node driver cannot drift apart. Nothing in
 * the game bundle reads it (the ADR 0010 grant covers the watch sidecar
 * only).
 */

describe('agent/driver-protocol.js - the one protocol leaf (issue #65)', () => {
    it('exists at agent/driver-protocol.js and exports the model-facing contract', async () => {
        const protocol = await import('../../agent/driver-protocol.js');
        expect(protocol.INSTRUCTIONS).toBeTypeOf('string');
        expect(protocol.STALL_NUDGE).toBeTypeOf('string');
        expect(protocol.OPENING_DIRECTIVE).toBeTypeOf('string');
        expect(protocol.ACTION_TOOLS).toBeTypeOf('object');
        expect(typeof protocol.createHttpTurnTransport).toBe('function');
    });

    it('drift guard: driver.js speaks the exact same protocol objects - one import, no copies', async () => {
        const driver = await import('../../agent/driver.js');
        const protocol = await import('../../agent/driver-protocol.js');
        expect(driver.INSTRUCTIONS).toBe(protocol.INSTRUCTIONS);
        expect(driver.STALL_NUDGE).toBe(protocol.STALL_NUDGE);
        expect(driver.OPENING_DIRECTIVE).toBe(protocol.OPENING_DIRECTIVE);
        expect(driver.ACTION_TOOLS).toBe(protocol.ACTION_TOOLS);
        expect(driver.createHttpTurnTransport).toBe(protocol.createHttpTurnTransport);
    });

    it('the action-tool table carries the observation entry point + the six phase-1 verbs in phase-1 order', async () => {
        const protocol = await import('../../agent/driver-protocol.js');
        const names = protocol.ACTION_TOOLS.map((row) => row.verb);
        expect(names).toEqual(['place', 'remove', 'rotate', 'nudge', 'reset', 'trial']);
    });

    it('the HTTP turn transport still answers runTurn envelopes over the wire, level stamped on every payload', async () => {
        const { startTurnServer } = await import('../../agent/server.js');
        const protocol = await import('../../agent/driver-protocol.js');
        const service = await startTurnServer();
        try {
            const transport = protocol.createHttpTurnTransport(service.url, 'level-01');
            const opening = await transport.turn({ action: 'observe' });
            expect(opening.observation).toContain('level-01 — First Steps');
            expect(opening.result).toBeTypeOf('object');

            const placed = await transport.turn({ action: 'place', type: 'ball', x: 700, y: 100 });
            expect(placed.result.ok).toBe(true);
            expect(placed.observation).toContain('state:');
        } finally {
            await service.close();
        }
    });

    it('runTurn stays the turn boundary the protocol feeds (the never-throw envelope is unchanged)', () => {
        const session = new AgentSession({ seed: null });
        try {
            const turn = runTurn({}, session); // not an action object - structurally refused
            expect(turn.result.ok).toBe(false);
            expect(turn.result.error).toMatch(/malformed request/);
            expect(turn.observation).toBeTypeOf('string');
        } finally {
            session.dispose();
        }
    });
});

/**
 * A capture model server: an OpenAI-compatible chat-completions endpoint
 * whose requests are recorded (url, body, headers) so the transport tests
 * pin the exact request shape. handler(body) answers { text } or { calls }
 * (the stub-provider policy shape); { status: n } forces a provider error.
 */
const modelServers = [];
afterEach(async () => {
    for (const s of modelServers.splice(0)) await s.close();
});

/** The node-only level fetches of the flow tests (the served file, from disk). */
function diskFetch(id = 'level-01') {
    return () => Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve(JSON.parse(readLevelFileSync(new URL('../js/levels/puzzles/' + id + '.json', import.meta.url), 'utf8'))),
    });
}

/** A manual animation-frame scheduler - the page's cadence, unwrapped. */
function makeTicker() {
    const queue = [];
    return {
        schedule: (cb) => { queue.push(cb); return queue.length; },
        size: () => queue.length,
        pump: (times) => {
            const n = queue.length;
            for (let i = 0; i < n && queue.length > 0; i++) queue.shift()(times);
        },
    };
}

/** Drive one live cycle: pump the ticker (the trial animation's cadence) and let the awaited transports advance between pumps. */
async function driveLive(ticker, target) {
    let now = 0;
    let guard = 0;
    while (!target.done && guard++ < 4000) {
        if (ticker.size() > 0) ticker.pump((now += 17));
        await new Promise((resolve) => setImmediate(resolve));
    }
    expect(guard).toBeLessThan(4000); // the live cycle is bounded
}

/**
 * A counting FAKE turn service (the transport seam): real HTTP, real
 * AgentSession, real runTurn envelopes - posts counted for wire assertions.
 */
const countingServices = [];
async function startCountingTurnService() {
    const posts = [];
    let session = null;
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            let actionJson = null;
            try { actionJson = raw ? JSON.parse(raw) : null; } catch { actionJson = null; }
            posts.push({ method: req.method, url: req.url, actionJson });
            if (req.method !== 'POST' || req.url !== '/turn') {
                const body = JSON.stringify({ observation: '(no session)', result: { ok: false, error: 'unknown endpoint: ' + req.method + ' ' + req.url } });
                res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
                res.end(body);
                return;
            }
            if (!session) {
                session = new AgentSession();
                session.loadLevel('level-01');
            }
            const envelope = JSON.stringify(runTurn(actionJson, session));
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(envelope) });
            res.end(envelope);
        });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve({
            port: server.address().port,
            url: 'http://127.0.0.1:' + server.address().port,
            posts,
            close: () => new Promise((r) => { session?.dispose(); session = null; server.close(r); }),
        }));
    }).then((s) => (countingServices.push(s), s));
}

/** Listeners that collect every seam's traffic + the arrival order. */
function liveListeners(extra = {}) {
    return {
        onStatus: (t) => extra.statuses?.push(t),
        onObservation: (t) => extra.observations?.push(t),
        onEvent: (rows) => { extra.events?.push(...rows); extra.order?.push(...rows.map(() => 'event')); },
        onFrame: () => { extra.frames?.push(1); extra.order?.push('frame'); },
        onWatchOutcome: (r) => { extra.outcomes?.push(r); extra.order?.push('outcome'); },
        onSandboxRunEnded: (r, m) => extra.sandboxEnds?.push({ result: r, meta: m }),
        onLiveEnded: (p) => extra.liveEnds?.push(p),
        onDriverError: (p) => extra.errors?.push(p),
        onServiceUnreachable: (p) => extra.unreachables?.push(p),
    };
}

/** @type {InstanceType<typeof import('../../js/watch/liveFlow.js').LiveFlow>|null} */
let live = null;
const stubs = [];
const services = [];

afterEach(async () => {
    live?.cancel();
    live = null;
    for (const s of stubs.splice(0)) await s.close();
    for (const s of services.splice(0)) await s.close();
    for (const s of countingServices.splice(0)) await s.close();
});

function startCaptureModelServer(handler) {
    const requests = [];
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            const body = raw ? JSON.parse(raw) : null;
            requests.push({ url: req.url, body, headers: req.headers });
            const choice = handler(body);
            if (choice.status !== undefined) {
                res.writeHead(choice.status, { 'content-type': 'text/plain' });
                res.end('provider exploded');
                return;
            }
            const message = choice.text !== undefined
                ? { role: 'assistant', content: choice.text }
                : {
                    role: 'assistant', content: null,
                    tool_calls: choice.calls.map((c, i) => ({
                        id: `call_${i}`, type: 'function',
                        function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
                    })),
                };
            const payload = {
                id: 'resp', object: 'chat.completion', created: 0, model: body.model ?? 'stub-model',
                choices: [{ index: 0, message, finish_reason: choice.text !== undefined ? 'stop' : 'tool_calls' }],
                usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            };
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify(payload));
        });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve({
            port: server.address().port,
            url: 'http://127.0.0.1:' + server.address().port,
            requests,
            close: () => new Promise((r) => server.close(r)),
        }));
    }).then((s) => (modelServers.push(s), s));
}

describe('resolveLiveDriverConfig - the browser driver\'s configuration contract', () => {
    it('resolves model + model endpoint + the optional turn service and level; the page defaults ride', () => {
        const { errors, config } = resolveLiveDriverConfig({
            model: 'devstral-small-2:latest',
            modelBaseUrl: 'http://127.0.0.1:11434/v1',
            turnBaseUrl: 'http://127.0.0.1:8787',
        });
        expect(errors).toEqual([]);
        expect(config).toEqual({
            model: 'devstral-small-2:latest',
            modelBaseUrl: 'http://127.0.0.1:11434/v1',
            turnBaseUrl: 'http://127.0.0.1:8787',
            apiKey: undefined,
            maxTurns: 20,
            level: 'level-01',
        });
        expect(Object.isFrozen(config)).toBe(true);
    });

    it('no turnBaseUrl is the in-page posture: a valid config with turnBaseUrl undefined', () => {
        const { errors, config } = resolveLiveDriverConfig({
            model: 'm',
            modelBaseUrl: 'http://127.0.0.1:11434/v1',
        });
        expect(errors).toEqual([]);
        expect(config.turnBaseUrl).toBeUndefined();
    });

    it('a missing model or a missing model endpoint are config errors naming the gap; config is null', () => {
        const { errors, config } = resolveLiveDriverConfig({});
        expect(config).toBeNull();
        expect(errors.join(' ')).toMatch(/model/i);
        expect(errors.join(' ')).toMatch(/endpoint/i);
    });

    it('non-http(s) settings are config errors (the same shape the driver resolver answers)', () => {
        const badTurn = resolveLiveDriverConfig({ model: 'm', modelBaseUrl: 'http://a/v1', turnBaseUrl: 'ftp://x' });
        expect(badTurn.config).toBeNull();
        expect(badTurn.errors.join(' ')).toMatch(/turn base URL/i);
        const badModel = resolveLiveDriverConfig({ model: 'm', modelBaseUrl: 'localhost:11434/v1' });
        expect(badModel.config).toBeNull();
        expect(badModel.errors.join(' ')).toMatch(/model base URL/i);
    });

    it('maxTurns must be a number >= 1 when set', () => {
        expect(resolveLiveDriverConfig({ model: 'm', modelBaseUrl: 'http://a/v1', maxTurns: 0 }).errors.join(' ')).toMatch(/max turns/i);
        expect(resolveLiveDriverConfig({ model: 'm', modelBaseUrl: 'http://a/v1', maxTurns: 'x' }).errors.join(' ')).toMatch(/max turns/i);
        const ok = resolveLiveDriverConfig({ model: 'm', modelBaseUrl: 'http://a/v1', maxTurns: 3 });
        expect(ok.config.maxTurns).toBe(3);
    });

    it('apiKey and level ride along', () => {
        const { errors, config } = resolveLiveDriverConfig({
            model: 'm', modelBaseUrl: 'http://a/v1', apiKey: 'k', level: 'level-02',
        });
        expect(errors).toEqual([]);
        expect(config.apiKey).toBe('k');
        expect(config.level).toBe('level-02');
    });
});

describe('createChatModelTransport - the OpenAI-compatible chat-completions seam', () => {
    it('asks once: posts model + messages + the seven advertised tools, and parses the tool calls', async () => {
        const server = await startCaptureModelServer(() => ({ calls: [{ name: 'place', args: { type: 'ball', x: 700, y: 180 } }] }));
        const transport = createChatModelTransport({ baseUrl: server.url + '/v1', model: 'stub-model' });
        const messages = [{ role: 'user', content: 'the brief' }];
        const answer = await transport.ask(messages);
        expect(answer.error).toBeUndefined();
        expect(answer.calls).toEqual([{ name: 'place', args: { type: 'ball', x: 700, y: 180 } }]);
        expect(answer.text).toBeUndefined();

        expect(server.requests).toHaveLength(1);
        const req = server.requests[0];
        expect(req.url).toBe('/v1/chat/completions');
        expect(req.body.model).toBe('stub-model');
        expect(req.body.messages).toEqual(messages);
        expect(req.body.tools.map((t) => t.function.name)).toEqual([
            'observe', 'place', 'remove', 'rotate', 'nudge', 'reset', 'trial',
        ]);
        for (const t of req.body.tools) {
            expect(t.type).toBe('function');
            expect(t.function.description).toBeTypeOf('string');
            expect(t.function.parameters).toBeTypeOf('object');
        }
    });

    it('a text-only choice reads as a stall: text rides, calls empty', async () => {
        const server = await startCaptureModelServer(() => ({ text: 'goal reached; done.' }));
        const transport = createChatModelTransport({ baseUrl: server.url + '/v1', model: 'stub-model' });
        const answer = await transport.ask([{ role: 'user', content: 'b' }]);
        expect(answer.text).toBe('goal reached; done.');
        expect(answer.calls).toEqual([]);
    });

    it('the api key rides the Authorization header', async () => {
        const server = await startCaptureModelServer(() => ({ calls: [] }));
        const transport = createChatModelTransport({ baseUrl: server.url + '/v1', model: 'stub-model', apiKey: 'secret-k' });
        await transport.ask([]);
        expect(server.requests[0].headers.authorization).toBe('Bearer secret-k');
    });

    it('a provider error status is structured data, never a throw', async () => {
        const server = await startCaptureModelServer(() => ({ status: 500 }));
        const transport = createChatModelTransport({ baseUrl: server.url + '/v1', model: 'stub-model' });
        const answer = await transport.ask([]);
        expect(answer.calls).toEqual([]);
        expect(answer.error).toMatch(/model provider HTTP 500/);
    });

    it('an unreachable provider is structured data, never a throw', async () => {
        const { startTurnServer } = await import('../../agent/server.js');
        const ghost = await startTurnServer();
        const deadAddress = ghost.url;
        await ghost.close();
        const transport = createChatModelTransport({ baseUrl: deadAddress + '/v1', model: 'stub-model' });
        const answer = await transport.ask([]);
        expect(answer.calls).toEqual([]);
        expect(answer.error).toMatch(/model provider unreachable/);
    });
});

describe('createLocalTurnTransport - the in-page posture (the session IS the turn boundary)', () => {
    it('drives the session through runTurn: the mutating action applies and the observation rides back', async () => {
        const session = new AgentSession({ seed: null });
        try {
            await session.loadLevel('level-01');
            const transport = createLocalTurnTransport(session);
            expect(transport.local).toBe(true);
            const turn = await transport.turn({ action: 'place', type: 'ball', x: 700, y: 100 });
            expect(turn.result.ok).toBe(true);
            expect(turn.observation).toContain('level-01'); // the post-action observation
            expect(session.placements).toHaveLength(1); // the action API applied it
        } finally {
            session.dispose();
        }
    });

    it('never throws: a malformed or unknown action answers the structured envelope', async () => {
        const session = new AgentSession({ seed: null });
        try {
            await session.loadLevel('level-01');
            const transport = createLocalTurnTransport(session);
            const malformed = await transport.turn({});
            expect(malformed.result.ok).toBe(false);
            expect(malformed.result.error).toMatch(/malformed request/);
            const unknown = await transport.turn({ action: 'teleport' });
            expect(unknown.result.ok).toBe(false);
            expect(unknown.result.error).toMatch(/unknown action/);
        } finally {
            session.dispose();
        }
    });
});

describe('LiveFlow - the live LLM turn source in the watch page (issue #65)', () => {
    it(
        'the served model plays level-01 under observation: turns ride the service, each placement lands live, the model\'s observations render in the panel thread, the watched trial streams rows before the goal-reached banner',
        { timeout: 120000 },
        async () => {
            const ticker = makeTicker();
            const service = await startTurnServer();
            services.push(service);
            const stub = await startStubServer(makeWinPolicy());
            stubs.push(stub);
            const { errors, config } = resolveLiveDriverConfig({
                model: 'stub-model',
                modelBaseUrl: 'http://127.0.0.1:' + stub.port + '/v1',
                turnBaseUrl: service.url,
                maxTurns: 5,
            });
            expect(errors).toEqual([]);

            const collected = { statuses: [], observations: [], events: [], frames: [], outcomes: [], sandboxEnds: [], liveEnds: [], errors: [], unreachables: [], order: [] };
            live = new LiveFlow({
                levelId: 'level-01',
                fetchImpl: diskFetch('level-01'),
                model: createChatModelTransport({ baseUrl: config.modelBaseUrl, model: config.model }),
                turns: createHttpTurnTransport(config.turnBaseUrl, config.level),
                schedule: ticker.schedule,
                listeners: liveListeners(collected),
            });

            await live.start(); // setup + the opening observation; the loop rides on
            await driveLive(ticker, live);

            expect(live.status).toBe('ended');
            expect(collected.errors).toHaveLength(0);
            expect(collected.unreachables).toHaveLength(0);
            expect(collected.sandboxEnds).toHaveLength(0);
            // the driver outcome vocabulary, exactly the phase-2 shapes
            expect(collected.liveEnds).toEqual([expect.objectContaining({ outcome: 'goal-reached', turns: 2 })]);

            // the banner: one goal-reached outcome, honest fields (the judged run's)
            expect(collected.outcomes).toHaveLength(1);
            const outcome = collected.outcomes[0];
            expect(outcome.outcome).toBe('reached');
            expect(outcome.elapsed).toBeGreaterThan(0);
            expect(outcome.elapsed).toBeLessThan(5000);

            // the watched session mirrored the model's move through the action API
            expect(live.session.placements).toEqual([{ type: 'ball', x: 700, y: 180, angle: 0 }]);
            expect(live.liveObjects().some((o) => o.type === 'ball')).toBe(true);

            // AC2: the panel thread holds the model's readings; the last one carries the trial's story
            expect(collected.observations.length).toBeGreaterThanOrEqual(3);
            expect(collected.observations[0]).toContain('level-01 — First Steps');
            expect(collected.observations[0]).toContain('state:');
            expect(collected.observations[collected.observations.length - 1]).toContain('events:');
            expect(collected.observations[collected.observations.length - 1]).toMatch(/goal reached/);

            // the HUD streamed the run's rows as they happened, then the banner
            expect(collected.events.map((r) => r.text)).toContain('ball caught by bucket-goal');
            expect(collected.events.some((r) => r.landmark && /goal reached/.test(r.text))).toBe(true);
            for (const row of collected.events) expect(row.t).toMatch(/^\d+\.\d{2}$/);
            expect(collected.order.lastIndexOf('event')).toBe(collected.order.indexOf('outcome') - 1); // rows before the banner
            expect(collected.frames.length).toBeGreaterThanOrEqual(2); // the board painted across the cycle

            // the model's chat history: the brief carries the opening observation + the directive
            expect(stub.requests).toHaveLength(2);
            expect(stub.requests[0].body.messages[0].content).toContain('level-01 — First Steps');
            expect(stub.requests[0].body.messages[0].content).toContain('Choose exactly one tool call now');
            // the continuation carries the tool result the model decided from
            const continuation = stub.requests[1].body.messages;
            expect(continuation[2].role).toBe('tool');
            const toolPayload = JSON.parse(continuation[2].content);
            expect(toolPayload.action).toBe('place');
            expect(toolPayload.result.ok).toBe(true);
            expect(toolPayload.observation).toContain('state:');
        },
    );

    it(
        'the wire the sidecar drives: one POST /turn per model turn with the level stamped and the moves executed in order',
        { timeout: 120000 },
        async () => {
            const ticker = makeTicker();
            const counting = await startCountingTurnService();
            services.push(counting);
            const stub = await startStubServer(makeWinPolicy());
            stubs.push(stub);
            const collected = { statuses: [], observations: [], events: [], frames: [], outcomes: [], liveEnds: [], errors: [], unreachables: [], order: [] };
            live = new LiveFlow({
                levelId: 'level-01',
                fetchImpl: diskFetch('level-01'),
                model: createChatModelTransport({ baseUrl: 'http://127.0.0.1:' + stub.port + '/v1', model: 'stub-model' }),
                turns: createHttpTurnTransport(counting.url, 'level-01'),
                schedule: ticker.schedule,
                maxTurns: 5,
                listeners: liveListeners(collected),
            });

            await live.start();
            await driveLive(ticker, live);

            expect(collected.outcomes[0]?.outcome).toBe('reached');
            // opening observe, then exactly one POST per executed call - level stamped on every payload
            expect(counting.posts.map((p) => p.actionJson)).toEqual([
                { action: 'observe', level: 'level-01' },
                { action: 'place', type: 'ball', x: 700, y: 180, level: 'level-01' },
                { action: 'trial', seconds: 5, level: 'level-01' },
            ]);
            expect(collected.liveEnds).toEqual([expect.objectContaining({ outcome: 'goal-reached', turns: 2 })]);
        },
    );
});
