import { describe, it, expect, afterEach } from 'vitest';
import { AgentSession } from '../../agent/session.js';
import { renderGraph } from '../../agent/observe/graph.js';
import { place, trial } from '../../agent/actions.js';

/** @type {import('../../agent/session.js').AgentSession|null} */
let session = null;

afterEach(() => {
    session?.dispose();
    session = null;
});

/** Ad-hoc level: ball + spring (a dormant pairing) with nothing in contact. */
const AD_HOC = {
    id: 'adhoc-graph',
    name: 'Graph Fixture',
    goal: { type: 'object_in_zone', targetType: 'ball', zoneId: 'z1' },
    fixedObjects: [{ type: 'ball', x: 120, y: 120, id: 'the-ball' }],
    availableParts: { spring: 1 },
};

describe('observe/graph', () => {
    it('resolves the goal edge to named instances and reports the last outcome', { timeout: 30000 }, async () => {
        session = new AgentSession();
        await session.loadLevel('level-01');
        place(session, 'ball', 700, 100);
        trial(session, { seconds: 5 });

        const lines = renderGraph(session).join('\n');
        expect(lines).toMatch(/relations/);
        expect(lines).toMatch(/goal\s+ball-\d+ ──▶ bucket-goal\s+\(object_in_zone, zone=bucket-goal\)\s+status: reached/);
        expect(lines).toMatch(/fired\s+bucket-catch\s+ball ⇄ bucket-goal\s+1x/);
    });

    it('marks goal edges unmet before any trial and skips absent goal data', async () => {
        session = new AgentSession();
        await session.loadLevel('level-01');
        // No placement yet → no target instance in the world → no goal edge.
        expect(renderGraph(session).join('\n')).not.toMatch(/─▶/);

        // Place the target without trialing → goal edge at its pre-trial state.
        place(session, 'ball', 700, 100);
        session._rebuild();
        const lines = renderGraph(session).join('\n');
        expect(lines).toMatch(/status: unmet/);
        expect(lines).not.toMatch(/status: reached/);
    });

    it('lists dormant interaction rows whose types are both present', { timeout: 30000 }, async () => {
        session = new AgentSession();
        await session.loadLevel(AD_HOC);
        place(session, 'spring', 800, 200);
        trial(session, { seconds: 0.5 }); // rebuild leaves a live world

        const lines = renderGraph(session).join('\n');
        expect(lines).toMatch(/dormant\s+spring-trigger\s+spring-\d+ ── the-ball/);
        // goal edge for the ad-hoc zone: the fixed ball is the only 'z1' zone? No —
        // the zone object does not exist here, so no goal line is printed.
        expect(lines).not.toMatch(/─▶/);
    });
});