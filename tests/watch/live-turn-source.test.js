import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { runTurn } from '../../agent/turn.js';
import { AgentSession } from '../../agent/session.js';
import {
    resolveLiveDriverConfig,
    createChatModelTransport,
    createLocalTurnTransport,
} from '../../js/watch/liveFlow.js';

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
