import { it } from 'vitest';
import { readFileSync } from 'node:fs';
import { AgentSession } from '../../agent/session.js';
import { WatchFlow } from '../../js/watch/watchFlow.js';

it('probe', { timeout: 60000 }, async () => {
    function readLevelJson(id) {
        return JSON.parse(readFileSync(new URL(`../../js/levels/puzzles/${id}.json`, import.meta.url), 'utf8'));
    }
    const session = new AgentSession({ seed: null });
    const flow = new WatchFlow({
        session,
        schedule: () => 0,
        fetchImpl: () => {
            const doc = readLevelJson('level-01');
            return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(doc) });
        },
        listeners: { onError: (m) => console.log('ONERROR:', m) },
    });
    await flow.start();
    console.log('status:', flow.status);
    session.dispose();
});
