import { describe, it, expect, afterEach } from 'vitest';
import { eventBus } from '../../js/EventBus.js';
import { FIXED_STEP_MS } from '../../js/engine/GameLoop.js';
import { AgentSession } from '../../agent/session.js';
import { place } from '../../agent/actions.js';
import { levelManager } from '../../js/levels/LevelManager.js';


/**
 * The agent session consumes the loop's run-lifecycle facts (issue #78).
 *
 * The trial run is framed exactly the way the browser loop frames one:
 * loop:play opens it (the begin fact), one loop:frame {dt, elapsed} is
 * published per engine step in the step -> elapsed -> emit order (ADR 0008
 * decision 2), and loop:reset closes it (the owned end fact, #76/#77).
 * GoalChecker and the EventRecorder consume the same fact stream the
 * sandbox sees, so headless boundary semantics are identical to live play
 * by construction - no private {dt, t} pre-step spelling, no hand-made
 * run ends.
 */

/** @type {import('../../agent/session.js').AgentSession|null} */
let session = null;

afterEach(() => {
    session?.dispose();
    session = null;
});

/**
 * Tap the loop's published run facts (plus the mode rows) for the duration
 * of one trial. Every subscription is drained by stop().
 * @returns {{ facts: Array<{topic: string, packet: object}>, stop: () => void }}
 */
function tapFacts() {
    const facts = [];
    const topics = ['loop:play', 'loop:frame', 'loop:reset', 'mode:changed'];
    const unsubs = topics.map((topic) => {
        const listener = (packet) => facts.push({ topic, packet });
        eventBus.on(topic, listener);
        return () => eventBus.off(topic, listener);
    });
    return { facts, stop: () => unsubs.forEach((unsub) => unsub()) };
}

const FRAME_TOPICS = (facts) => facts.filter((f) => f.topic === 'loop:frame');

describe('AgentSession.trial publishes the loop run facts (issue #78)', () => {
    it(
        'frames a full trial: loop:play -> one loop:frame {dt,elapsed} per step AFTER the step -> loop:reset',
        { timeout: 30000 },
        async () => {
            session = new AgentSession();
            await session.loadLevel('level-01'); // idle world: no verdict, full-length run
            const { facts, stop } = tapFacts();
            try {
                const result = session.trial({ seconds: 1 });
                const frames = FRAME_TOPICS(facts);

                // 1s of fixed steps = one begin fact + one fact per step + one end fact.
                expect(facts[0]).toMatchObject({ topic: 'loop:play', packet: { elapsed: 0 } });
                expect(facts[facts.length - 1]).toMatchObject({ topic: 'loop:reset', packet: { elapsed: 0 } });
                expect(frames).toHaveLength(60);
                expect(facts.filter((f) => f.topic === 'loop:play')).toHaveLength(1);
                expect(facts.filter((f) => f.topic === 'loop:reset')).toHaveLength(1);

                // The published step-to packet - {dt, elapsed}, post-step: the
                // FIRST frame already carries exactly one step of sim time
                // (a pre-step emission would carry 0 and the private `t` key).
                expect(frames[0].packet).toEqual({ dt: FIXED_STEP_MS, elapsed: FIXED_STEP_MS });
                expect(frames[0].packet).not.toHaveProperty('t');
                // The last frame's elapsed is the trial's final sim time, exactly.
                expect(frames[frames.length - 1].packet.elapsed).toBe(result.elapsed);
                // Elapsed advances in whole-step increments.
                frames.forEach((f, i) => expect(f.packet.elapsed).toBeCloseTo((i + 1) * FIXED_STEP_MS, 9));
            } finally {
                stop();
            }
        },
    );

    it('the dt default is the loop export itself - the identical double, one owner', { timeout: 30000 }, async () => {
        session = new AgentSession();
        await session.loadLevel('level-01');
        const { facts, stop } = tapFacts();
        try {
            session.trial({ seconds: 1 / 60 }); // exactly one step
            const frames = FRAME_TOPICS(facts);
            expect(frames).toHaveLength(1);
            expect(frames[0].packet.dt).toBe(FIXED_STEP_MS);
        } finally {
            stop();
        }
    });

    it(
        'a verdict stops stepping and the run still closes with its one end fact',
        { timeout: 30000 },
        async () => {
            session = new AgentSession();
            await session.loadLevel('level-01');
            place(session, 'ball', 700, 100); // the known drop that reaches the bucket
            const { facts, stop } = tapFacts();
            try {
                const result = session.trial({ seconds: 5 });
                const frames = FRAME_TOPICS(facts);

                expect(result.outcome).toBe('reached');
                // The verdict latched mid-run: fewer frames than the 5s budget...
                expect(frames.length).toBeLessThan(300);
                // ...and the run is still framed end to end: begin, frames, one end.
                expect(facts[0].topic).toBe('loop:play');
                expect(facts[facts.length - 1].topic).toBe('loop:reset');
                expect(facts.filter((f) => f.topic === 'loop:reset')).toHaveLength(1);
            } finally {
                stop();
            }
        },
    );

    it('the play boundary row lands between the begin fact and the first step fact - sandbox order', { timeout: 30000 }, async () => {
        session = new AgentSession();
        await session.loadLevel('level-01');
        const { facts, stop } = tapFacts();
        try {
            const result = session.trial({ seconds: 1 });
            const playIdx = facts.findIndex((f) => f.topic === 'loop:play');
            const rowIdx = facts.findIndex((f) => f.topic === 'mode:changed');
            const frameIdx = facts.findIndex((f) => f.topic === 'loop:frame');

            expect(result.outcome).toBe('timeout'); // sanity: the full run did happen
            expect(facts[rowIdx].packet).toMatchObject({ oldMode: 'EDITING', newMode: 'PLAYING' });
            // The sandbox publishes play() before its setMode(PLAYING) row,
            // and the first step fact follows both.
            expect(playIdx).toBeLessThan(rowIdx);
            expect(rowIdx).toBeLessThan(frameIdx);
        } finally {
            stop();
        }
    });
});


describe('AgentSession bootstrap consumes the level owner (issue #78)', () => {
    it(
        'loadLevel installs the level through the LevelManager seam - level:loaded from one owner',
        async () => {
            session = new AgentSession();
            await session.loadLevel('level-01');
            // The owner carries the loaded level (the same install editor
            // imports ride through loadCustom) - the session never emits
            // level:loaded by hand.
            expect(levelManager.getCurrentLevel()?.id).toBe('level-01');
        },
    );

    it('answers to the one level schema: a document without a solution scene is refused', async () => {
        session = new AgentSession();
        await expect(
            session.loadLevel({
                id: 'bare-fixture', name: 'Bare Fixture',
                goal: { type: 'object_in_zone', targetType: 'ball', zoneId: 'z' },
                fixedObjects: [], availableParts: {},
            }),
        ).rejects.toThrow(/\[LevelManager\].*solution/);
    });

    it('the level owner wording surfaces on an incomplete document - no session mirror', async () => {
        session = new AgentSession();
        await expect(session.loadLevel({ id: 'bare-2' })).rejects.toThrow(/\[LevelManager\] Level missing required field: "name"/);
    });
});
