/**
 * stub-provider - the OpenAI-compatible fake chat-completions endpoint the
 * LLM driver integration tests (tickets #48/#49) run against: the stub
 * stands in for the LLM ONLY at the provider seam and decides its next
 * action FROM the observation text through the same tools the driver
 * exposes - so the driver runs its REAL loop. No scripted solver lives
 * here: the win policy simply reads the goal bucket's position out of the
 * observation the way a model would (the model works from observations
 * and actions alone - parent spec design rules).
 *
 * Stateless on purpose: each test owns the startStubServer() record
 * ({ port, requests, close }) and closes it in its own afterEach.
 */

import http from 'node:http';

/**
 * Fake OpenAI chat-completions endpoint. `policy(body)` inspects the exact
 * request the model would see (messages) and decides the response:
 * { text } for a plain final message, or { calls: [{ name, args }] } for
 * tool calls. Every request is captured for wiring assertions.
 */
export function startStubServer(policy) {
    const requests = [];
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            const body = JSON.parse(raw);
            requests.push({ url: req.url, body });
            const choice = policy(body);
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
                id: `resp_${requests.length}`, object: 'chat.completion', created: 0, model: body.model ?? 'stub-model',
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
            requests,
            close: () => new Promise((r) => server.close(r)),
        }));
    });
}

/** The latest observation text the model received (tool read-back or the initial brief). */
export function latestObservation(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        const content = typeof m.content === 'string'
            ? m.content
            : Array.isArray(m.content) ? m.content.map((p) => p?.text ?? '').join('') : '';
        if (m.role === 'tool') {
            try {
                const parsed = JSON.parse(content);
                if (parsed.observation) return parsed.observation;
            } catch { /* fall through to raw content */ }
            return content;
        }
        if (m.role === 'user') return content;
    }
    return '';
}

/** Whether some tool read-back already reports the trial outcome. @private */
function sawOutcome(messages, want) {
    return messages.some((m) => m.role === 'tool' && String(m.content).includes(`"outcome":"${want}"`));
}

/** Read the goal bucket's x,y straight out of the observation's state table - the model's way. */
export function bucketZone(obs) {
    const m = /^bucket-goal\s+bucket\s+(-?[\d.]+),\s?(-?[\d.]+)/m.exec(obs);
    return { x: Math.round(Number(m?.[1])), y: Math.round(Number(m?.[2])) };
}

/** Stub policy that WINS level-01 from observations alone: drop the ball just above the zone. */
export function makeWinPolicy() {
    let placed = false;
    return (body) => {
        const obs = latestObservation(body.messages);
        if (sawOutcome(body.messages, 'reached')) return { text: 'goal reached; done.' };
        if (!placed) {
            const zone = bucketZone(obs);
            placed = true;
            return { calls: [{ name: 'place', args: { type: 'ball', x: zone.x, y: zone.y - 300 } }] };
        }
        return { calls: [{ name: 'trial', args: { seconds: 5 } }] };
    };
}

/** Stub policy that MISSES entirely and hits the goal:failed stop (dt=100 tunnels the ball). */
export function makeFailPolicy() {
    let placed = false;
    return (body) => {
        if (sawOutcome(body.messages, 'failed')) return { text: 'goal failed; stopping.' };
        if (!placed) {
            placed = true;
            return { calls: [{ name: 'place', args: { type: 'ball', x: 300, y: 100 } }] };
        }
        return { calls: [{ name: 'trial', args: { seconds: 5, dt: 100 } }] };
    };
}

/** Stub policy that never advances toward the goal: only observes (forces the cap hit). */
export function makeJammerPolicy() {
    return () => ({ calls: [{ name: 'observe', args: {} }] });
}

/** Stub policy whose first move is an impossible placement, then it wins anyway. */
export function makeBadThenWinPolicy() {
    let step = 0;
    return (body) => {
        const obs = latestObservation(body.messages);
        if (sawOutcome(body.messages, 'reached')) return { text: 'done.' };
        step += 1;
        if (step === 1) return { calls: [{ name: 'place', args: { type: 'unicorn', x: 500, y: 100 } }] };
        if (step === 2) {
            const zone = bucketZone(obs);
            return { calls: [{ name: 'place', args: { type: 'ball', x: zone.x, y: zone.y - 300 } }] };
        }
        return { calls: [{ name: 'trial', args: { seconds: 5 } }] };
    };
}

/**
 * Policy that WINS the levels named in `winLevels` (win-policy shape,
 * fresh per protocol run) and observe-jams every other level - the
 * gated-eval shape: level-01 solved, level-02/03 stuck. One stub server
 * serves many protocol runs in one test, so state resets whenever a run's
 * opening brief arrives (messages = [system, user] only).
 * @param {string[]} winLevels level ids this persona can solve
 */
export function makeLevelSelectivePolicy(winLevels) {
    const state = new Map();
    return (body) => {
        const firstLine = String(latestObservation(body.messages) ?? '').split('\n')[0] ?? '';
        const m = /^(level-\d+)/.exec(firstLine);
        const level = m ? m[1] : '(unknown)';
        if (body.messages.length === 2) state.set(level, { placed: false }); // a fresh run begins
        if (!winLevels.includes(level)) return { calls: [{ name: 'observe', args: {} }] }; // jam
        if (sawOutcome(body.messages, 'reached')) return { text: 'goal reached; done.' };
        const levelState = state.get(level) ?? { placed: false };
        if (!levelState.placed) {
            const zone = bucketZone(latestObservation(body.messages));
            levelState.placed = true;
            return { calls: [{ name: 'place', args: { type: 'ball', x: zone.x, y: zone.y - 300 } }] };
        }
        return { calls: [{ name: 'trial', args: { seconds: 5 } }] };
    };
}
