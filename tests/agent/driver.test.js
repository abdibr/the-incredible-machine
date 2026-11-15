import { describe, it, expect, afterEach } from 'vitest';
import { describeWorld } from '../../agent/observe/describe.js';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AgentSession } from '../../agent/session.js';
import { resolveDriverConfig, runDriver, DRIVER_ENV } from '../../agent/driver.js';
import { startStubServer, makeWinPolicy, makeFailPolicy, makeJammerPolicy, makeBadThenWinPolicy, bucketZone, latestObservation } from '../helpers/stub-provider.js';

/**
 * LLM driver tests (phase-2 ticket 3/6) - driver-loop integration tests
 * over a STUBBED provider: the stub is a local OpenAI-compatible fake
 * chat-completions server behind the driver's configurable base URL. It
 * stands in for the LLM ONLY at the provider seam and decides its next
 * action FROM the observation text through the same tools the driver
 * exposes - so the driver runs its real loop (the stub server and the model
 * personas are shared with the turn-transport tests: tests/helpers/
 * stub-provider.js). No scripted solver lives
 * here: the win policy simply reads the goal bucket's position out of the
 * observation the way a model would. Pinned: max-turns cap termination,
 * clean termination on goal-reached and on goal-failed, the
 * tool-over-runTurn wiring, and transcript file creation + shape.
 */

/** @type {import('../../agent/session.js').AgentSession|null} */
let session = null;
let dir = null;
const stubs = [];

afterEach(async () => {
    session?.dispose();
    session = null;
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
    for (const s of stubs.splice(0)) await s.close();
});

/**
 * Build the fixture for one driver integration test: temp transcript dir,
 * a REAL level-01 session, a fresh stub endpoint, and a config resolved
 * through TIM_AGENT_* env vars + a transcript argv override.
 */
async function driverFixture(policy, { argv = [] } = {}) {
    dir = await mkdtemp(join(tmpdir(), 'tim-driver-'));
    const transcriptPath = join(dir, 'transcript.txt');
    session = new AgentSession();
    await session.loadLevel('level-01');
    const stub = await startStubServer(policy);
    stubs.push(stub);
    const { errors, config } = resolveDriverConfig({
        argv: [...argv, '--transcript', transcriptPath],
        env: {
            [DRIVER_ENV.MODEL]: 'stub-model',
            [DRIVER_ENV.BASE_URL]: `http://127.0.0.1:${stub.port}/v1`,
        },
    });
    return { stub, errors, config, transcriptPath };
}

describe('llm driver - driver loop over a stubbed provider', () => {
    it(
        'runs the REAL loop: the stub model wins level-01 through observation + action tools only',
        { timeout: 90000 },
        async () => {
            const { stub, errors, config } = await driverFixture(makeWinPolicy());
            expect(errors).toEqual([]);

            const res = await runDriver(config, session);

            // the acceptance shape: win, cleanly, through the tools.
            expect(res.outcome).toBe('goal-reached');
            expect(res.turns).toBe(2);

            // the wire advertises exactly the phase-1 action set + the observation entry point
            const advertised = stub.requests[0].body.tools.map((t) => t.function.name).sort();
            expect(advertised).toEqual(['nudge', 'observe', 'place', 'remove', 'reset', 'rotate', 'trial']);

            // the model READ the world: turn 2's request carries the post-place observation text
            const second = stub.requests[1].body.messages;
            expect(second.some((m) => m.role === 'tool' && String(m.content).includes('bucket-goal'))).toBe(true);
        },
    );

    it(
        'terminates cleanly when the goal fails mid-loop',
        { timeout: 90000 },
        async () => {
            const { stub, config } = await driverFixture(makeFailPolicy());

            const res = await runDriver(config, session);

            expect(res.outcome).toBe('goal-failed');
            expect(res.turns).toBe(2);
            // the loop STOPPED at the failure: no further model request happened
            expect(stub.requests.length).toBe(2);
            // the failing trial's result is on the transcript, with the clean reason
            expect(res.transcript).toContain('"outcome":"failed"');
            expect(res.transcript).toMatch(/fell off the playfield/i);
        },
    );

    it(
        'enforces the hard max-turns cap and still terminates cleanly',
        { timeout: 90000 },
        async () => {
            const { stub, config } = await driverFixture(makeJammerPolicy(), { argv: ['--max-turns', '3'] });

            const res = await runDriver(config, session);

            expect(res.outcome).toBe('turn-cap');
            expect(res.turns).toBe(3);
            expect(stub.requests.length).toBe(3);
            const markers = res.transcript.match(/=== turn \d+ ===/g) ?? [];
            expect(markers.length).toBe(3);
            expect(res.transcript).toContain('outcome: turn-cap');
        },
    );

    it(
        'surfaces a model-chosen impossible action as a structured runTurn failure (never a throw), then keeps playing',
        { timeout: 90000 },
        async () => {
            const { config } = await driverFixture(makeBadThenWinPolicy());

            const res = await runDriver(config, session);

            // the wiring pin: the model's bad move came back as runTurn's never-throw result,
            // byte-identical in shape to the phase-1 action contract, and the loop continued.
            expect(res.transcript).toContain('"error":"unknown type: unicorn"');
            expect(res.outcome).toBe('goal-reached');
            expect(res.turns).toBe(3);
            // order sanity: the structured failure precedes the win on the transcript
            expect(res.transcript.indexOf('unknown type: unicorn')).toBeLessThan(res.transcript.indexOf('"outcome":"reached"'));
        },
    );

    it(
        'writes the transcript to the configured file, byte-identical to the printed transcript',
        { timeout: 90000 },
        async () => {
            const { config } = await driverFixture(makeWinPolicy());

            const res = await runDriver(config, session);

            const onDisk = await readFile(config.transcriptPath, 'utf8');
            expect(onDisk).toBe(res.transcript);
            expect(onDisk).toContain('level: level-01');
            expect(onDisk).toContain('model: stub-model');
            expect(onDisk).toContain('outcome: goal-reached');
            expect(onDisk).toContain('=== turn 1 ===');
            expect(onDisk).toContain('=== turn 2 ===');
            // each turn shows the chosen action (JSON) and the result that came back
            expect(onDisk).toMatch(/action:\n\s*place \{"type":"ball"/);
            expect(onDisk).toContain('"ok":true');
        },
    );
    it(
        'every transcript row shows the decision-relevant observation: goal header, state table, relations (ticket #48 AC-3)',
        { timeout: 90000 },
        async () => {
            const { config } = await driverFixture(makeWinPolicy());

            const res = await runDriver(config, session);

            const rows = res.transcript.split(/(?==== turn \d+ ===)/).filter((r) => r.startsWith('=== turn'));
            expect(rows.length).toBe(res.turns);
            for (const row of rows) {
                // the observation the model DECIDED from: the goal header + state table + relations
                expect(row).toContain('observation (excerpt):');
                expect(row).toContain('First Steps');
                expect(row).toContain('state:');
                expect(row).toMatch(/bucket-goal\s+bucket/);
                expect(row).toContain('relations');
                // the excerpt stays honest and compact: the cut is NAMED, the row bounded
                expect(row).toContain('elided');
                expect(row.split('\n').length).toBeLessThanOrEqual(30);
            }
        },
    );
});

describe('resolveDriverConfig - provider-agnostic env configuration', () => {
    it('reads model / base URL / max turns / transcript from TIM_AGENT_* env vars', () => {
        const { errors, config } = resolveDriverConfig({
            argv: [],
            env: {
                [DRIVER_ENV.MODEL]: 'env-model',
                [DRIVER_ENV.BASE_URL]: 'http://127.0.0.1:11434/v1',
                [DRIVER_ENV.MAX_TURNS]: '7',
                [DRIVER_ENV.TRANSCRIPT]: 'out.txt',
            },
        });
        expect(errors).toEqual([]);
        expect(config.model).toBe('env-model');
        expect(config.baseUrl).toBe('http://127.0.0.1:11434/v1');
        expect(config.maxTurns).toBe(7);
        expect(config.transcriptPath).toBe('out.txt');
        expect(config.level).toBe('level-01');
    });

    it('CLI flags override env vars', () => {
        const { errors, config } = resolveDriverConfig({
            argv: ['--model', 'cli-model', '--max-turns', '3', '--level', 'level-02', '--transcript', 'cli.txt'],
            env: {
                [DRIVER_ENV.MODEL]: 'env-model',
                [DRIVER_ENV.MAX_TURNS]: '7',
                [DRIVER_ENV.TRANSCRIPT]: 'env.txt',
            },
        });
        expect(errors).toEqual([]);
        expect(config.model).toBe('cli-model');
        expect(config.maxTurns).toBe(3);
        expect(config.level).toBe('level-02');
        expect(config.transcriptPath).toBe('cli.txt');
    });

    it('a missing model is a config error naming the env var - never a silent default', () => {
        const { errors, config } = resolveDriverConfig({ argv: [], env: {} });
        expect(config).toBeNull();
        expect(errors.join(' ')).toContain(DRIVER_ENV.MODEL);
    });

    it('an unparseable max turns is a config error', () => {
        const { errors, config } = resolveDriverConfig({
            argv: ['--model', 'm', '--max-turns', 'lots'],
            env: {},
        });
        expect(config).toBeNull();
        expect(errors.join(' ')).toMatch(/max.turns/i);
    });

    it('OPENAI_API_KEY is NOT required: local/alternative providers need no key', () => {
        const { errors, config } = resolveDriverConfig({ argv: ['--model', 'm'], env: {} });
        expect(errors).toEqual([]);
        expect(config.apiKey).toBeUndefined();
    });

    it('picks up OPENAI_API_KEY when present (kept out of logs; never echoed as a flag)', () => {
        const { errors, config } = resolveDriverConfig({
            argv: ['--model', 'm'],
            env: { [DRIVER_ENV.API_KEY]: 'sk-test-not-a-real-secret' },
        });
        expect(errors).toEqual([]);
        expect(config.apiKey).toBe('sk-test-not-a-real-secret');
        expect(DRIVER_ENV.API_KEY).toBe('OPENAI_API_KEY');
    });

    it('defaults: turn cap 20, transcript under the gitignored .agent-transcripts/ dir', () => {
        const { errors, config } = resolveDriverConfig({ argv: ['--model', 'm'], env: {} });
        expect(errors).toEqual([]);
        expect(config.maxTurns).toBe(20);
        expect(config.transcriptPath.startsWith('.agent-transcripts/')).toBe(true);
    });

    it('exposes the env var names as constants (the documented configuration contract)', () => {
        expect(DRIVER_ENV).toEqual({
            MODEL: 'TIM_AGENT_MODEL',
            BASE_URL: 'TIM_AGENT_BASE_URL',
            MAX_TURNS: 'TIM_AGENT_MAX_TURNS',
            TRANSCRIPT: 'TIM_AGENT_TRANSCRIPT',
            TURN_BASE_URL: 'TIM_AGENT_TURN_BASE_URL',
            API_KEY: 'OPENAI_API_KEY',
        });
    });
});

describe('driver static boundary (turn-boundary + browser-bundle discipline)', () => {
    it('the driver composes only the agent layer: it calls runTurn and never imports js/ engine modules', () => {
        const src = readFileSync(fileURLToPath(new URL('../../agent/driver.js', import.meta.url)), 'utf8');
        expect(src).toMatch(/from ['"]\.\/turn\.js['"]/);
        expect(src).not.toMatch(/['"]\.\.\/js\//);
    });
});






describe('driver structured turn log - the eval-seam return (ticket #50 feeds on this)', () => {
    it(
        'returns turnLog: per-turn calls (parsed args) + outputs (structured results)',
        { timeout: 90000 },
        async () => {
            const { config } = await driverFixture(makeBadThenWinPolicy());

            const res = await runDriver(config, session);

            // bad-then-win: turn 1 impossible place, turn 2 the winning place, turn 3 the trial verdict
            expect(res.turnLog).toHaveLength(3);
            const [first, second, third] = res.turnLog;
            expect(res.outcome).toBe('goal-reached');

            expect(first.turn).toBe(1);
            expect(first.note).toBeNull();
            expect(first.calls).toEqual([{ name: 'place', args: { type: 'unicorn', x: 500, y: 100 } }]);
            expect(first.outputs).toHaveLength(1);
            expect(first.outputs[0].action).toBe('place');
            expect(first.outputs[0].result.ok).toBe(false);
            expect(first.outputs[0].result.error).toContain('unknown type: unicorn');

            // the turnLog mirrors the model's EXACT read: it placed relative to the
            // bucket's state-table position (the observation's truth), not level-JSON's
            const zone = bucketZone(describeWorld(session));
            expect(second.calls).toEqual([{ name: 'place', args: { type: 'ball', x: zone.x, y: zone.y - 300 } }]);
            expect(second.outputs[0].result.ok).toBe(true);

            expect(third.calls).toEqual([{ name: 'trial', args: { seconds: 5 } }]);
            expect(third.outputs[0].result.outcome).toBe('reached');
        },
    );

    it(
        'logs stall turns as note-only entries (no calls, no outputs)',
        { timeout: 90000 },
        async () => {
            // a model that answers text only twice, then plays the level-01 win by the book:
            // turns 1-2 stall, turn 3 observe, turn 4 place, turn 5 the winning trial.
            let stalled = 0;
            const { config } = await driverFixture((body) => {
                stalled += 1;
                if (stalled <= 2) return { text: 'thinking...' };
                if (stalled === 3) return { calls: [{ name: 'observe', args: {} }] };
                if (stalled === 4) {
                    const zone = bucketZone(latestObservation(body.messages));
                    return { calls: [{ name: 'place', args: { type: 'ball', x: zone.x, y: zone.y - 300 } }] };
                }
                return { calls: [{ name: 'trial', args: { seconds: 5 } }] };
            }, { argv: ['--max-turns', '5'] });

            const res = await runDriver(config, session);

            expect(res.outcome).toBe('goal-reached');
            expect(res.turns).toBe(5);
            expect(res.turnLog).toHaveLength(5);
            const [stall1, stall2, obsTurn, placeTurn, trialTurn] = res.turnLog;
            expect(stall1.calls).toEqual([]);
            expect(stall1.outputs).toEqual([]);
            expect(stall1.note).toBe('stall: no tool call');
            expect(stall2.note).toBe('stall: no tool call');
            expect(obsTurn.note).toBeNull();
            expect(obsTurn.calls).toEqual([{ name: 'observe', args: {} }]);
            expect(placeTurn.calls[0].name).toBe('place');
            expect(trialTurn.outputs[0].result.outcome).toBe('reached');
        },
    );
});


