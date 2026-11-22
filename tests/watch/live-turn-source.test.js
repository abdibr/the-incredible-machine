import { describe, it, expect } from 'vitest';
import { runTurn } from '../../agent/turn.js';
import { AgentSession } from '../../agent/session.js';

/**
 * The live LLM turn source in the watch page (issue #65).
 *
 * The page's driver becomes the real phase-2 agent: a browser driver loop
 * speaks the same protocol agent/driver.js speaks (the instructions, the
 * stall nudge, the opening directive, the action-tool table) and drives
 * the game through the headless turn service's /turn envelope. This suite
 * pins the client-side contract piece by piece; the flows that make the
 * watch page (WatchFlow from #62, SandboxFlow from #64) are the scripted
 * fallback that stays usable when the service degrades.
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

