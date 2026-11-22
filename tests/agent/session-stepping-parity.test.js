import { describe, it, expect, afterEach } from 'vitest';
import { eventBus } from '../../js/EventBus.js';
import { FIXED_STEP_MS } from '../../js/engine/GameLoop.js';
import { AgentSession } from '../../agent/session.js';
import { place } from '../../agent/actions.js';

/**
 * The steppable trial seam (issue #61).
 *
 * A trial no longer has to run all-at-once: beginTrial() opens a run with
 * the exact begin facts trial() frames, advanceTrial() steps arbitrary
 * frame increments with arbitrary pauses between them, the run view reads
 * the latched verdict and event log at any point, and finalizeTrial()
 * returns the same result object trial() returns. Stepping parity is the
 * contract: stepping to completion must produce the identical outcome,
 * event rows (timestamps included), final poses, distance and the
 * identical loop-fact stream as the all-at-once trial on the same level
 * and placements - because trial() itself is now that composition, the
 * tests below prove the composition, the reads, and the framing.
 */

/** @type {import('../../agent/session.js').AgentSession|null} */
let session = null;

afterEach(() => {
    session?.dispose();
    session = null;
});

/**
 * Tap the loop's published run facts (plus the mode rows) for the duration
 * of one run. Every subscription is drained by stop().
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

// Instance ids (`ball-17`) are process-lifetime counter values (BaseObject
// _nextId) - not world state, never stable between two builds of the same
// level (the seeded-determinism suite's own convention). The stable
// in-board reference is customId or type@<board ordinal>, which is what
// the parity comparisons normalize each snapshot row to; customId-bearing
// rows pass through untouched. Poses, timestamps and distances are never
// normalized - those bytes must agree outright.
const INSTANCE_ID = /^([a-z0-9-]+)-(\d+)$/;
const ref = (id, type, i) => (INSTANCE_ID.test(id) ? `${type}@${i}` : id);
const poses = (snapshot) => snapshot.map((row, i) => ({ ...row, id: ref(row.id, row.type, i) }));
const parityView = (result) => ({ ...result, snapshot: poses(result.snapshot) });

// Ad-hoc level doc (loadLevel accepts full documents): the goal zone is
// the named bucket, and the TARGET is authored scenery already fallen
// below the playfield - the off-world rule judges it ON THE FIRST FRAME,
// a deterministic clean failure (known-broken mechanics are reported, not
// fixed). Two-scene document per ADR 0009, scene rows as authored.
const FALLEN_TARGET_LEVEL = {
    id: 'fallen-target-fixture',
    name: 'stepping parity fixture - the target starts fallen',
    goal: { type: 'object_in_zone', targetType: 'ball', zoneId: 'bucket-goal' },
    fixedObjects: [
        { type: 'bucket', x: 700, y: 480, id: 'bucket-goal' },
        { type: 'ball', x: 700, y: 700, id: 'target' },
    ],
    availableParts: {},
    solution: {
        scene: [
            { type: 'bucket', x: 700, y: 480, id: 'bucket-goal' },
            { type: 'ball', x: 700, y: 700, id: 'target' },
        ],
    },
};

// Seeded parity fixture: a balloon rides the seeded build window (its ctor
// is the one Math.random consumer), so two builds of this world reproduce
// the balloon's bob phase exactly - and its pose in every snapshot.
const BALLOON_DROP_LEVEL = {
    id: 'balloon-drop-fixture',
    name: 'stepping parity fixture - seeded balloon beside the drop',
    goal: { type: 'object_in_zone', targetType: 'ball', zoneId: 'bucket-goal' },
    fixedObjects: [{ type: 'bucket', x: 700, y: 480, id: 'bucket-goal' }],
    availableParts: { balloon: 1, ball: 1 },
    solution: { scene: [{ type: 'bucket', x: 700, y: 480, id: 'bucket-goal' }] },
};

/** The chunk chant: arbitrary frame increments, over-budget last. */
const CHUNKS = [1, 60, 7, 1000, 5, 99];

describe('stepping parity - the steppable trial is the same trial (issue #61)', () => {
    it(
        'stepped to completion (arbitrary increments, pauses between) returns the EXACT result object the all-at-once trial returns',
        { timeout: 30000 },
        async () => {
            session = new AgentSession();
            await session.loadLevel('level-01');
            place(session, 'ball', 700, 100); // the known drop that reaches the bucket

            const allAtOnce = session.trial({ seconds: 5 });
            expect(allAtOnce.outcome).toBe('reached'); // sanity: this placement reaches

            const run = session.beginTrial({ seconds: 5 });
            expect(run.steps).toBe(300); // the all-at-once budget arithmetic, readable
            expect(run.done).toBe(false);
            expect(run.verdict).toBeNull();
            expect(run.events).toEqual([]); // no events latched before any frame

            // Arbitrary increments with pauses between: read the verdict and
            // the log between chunks - mid-run reads are live, not stale.
            const responses = [];
            let i = 0;
            while (!run.done && i < 50) {
                const response = session.advanceTrial(CHUNKS[i++ % CHUNKS.length]);
                responses.push(response);
                // every pause is inspectable: the clock and the log never run away
                expect(run.elapsed).toBeCloseTo(run.stepped * FIXED_STEP_MS, 9);
                expect(run.stepsLeft).toBe(run.verdict === null ? run.steps - run.stepped : 0); // 0 once latched: advance would step nothing
            }
            expect(i).toBeLessThan(50); // the verdict latches well inside the budget

            // A latched or exhausted run refuses further frames... and the
            // verdict + the log are readable through the run view at any point.
            const last = responses[responses.length - 1];
            expect(last.verdict).toBe('reached');
            expect(last.done).toBe(true);
            expect(responses.some((r) => r.verdict === null)).toBe(true); // some pauses pre-latch
            expect(run.verdict).toBe('reached');
            expect(run.events.length).toBeGreaterThan(0); // bucket:caught + goal reached, logged live

            const stepped = session.finalizeTrial();

            // THE contract: the trial() result on the same run - identical
            // except the one documented non-world field (instance ids).
            expect(parityView(stepped)).toEqual(parityView(allAtOnce));
            // the read-latch log survives finalize (it is the same buffer, copied)
            expect(run.events).toEqual(stepped.events);
            expect(stepped.events.map((r) => r.t)).toEqual(allAtOnce.events.map((r) => r.t)); // timestamps included
            expect(poses(stepped.snapshot)).toEqual(poses(allAtOnce.snapshot)); // final poses
            expect(stepped.distance).toBe(allAtOnce.distance); // target-to-zone
            expect(stepped.outcome).toBe(allAtOnce.outcome); // identical verdict
        },
    );

    it(
        'parity on a clean timeout: over-budget advances clamp to the run budget and a spent run never steps again',
        { timeout: 30000 },
        async () => {
            session = new AgentSession();
            await session.loadLevel('level-01'); // idle world: nothing reaches in the budget

            const allAtOnce = session.trial({ seconds: 5 });
            expect(allAtOnce.outcome).toBe('timeout'); // sanity: the reference is a full run
            expect(allAtOnce.elapsed).toBeCloseTo(300 * FIXED_STEP_MS, 9);

            const run = session.beginTrial({ seconds: 5 });
            let stepped = 0;
            for (const chunk of [120, 120, 120, 999999]) {
                const response = session.advanceTrial(chunk);
                stepped += response.stepped;
            }
            expect(stepped).toBe(300); // 441 asked, 300 stepped - the budget rules
            expect(run.done).toBe(true);
            expect(run.verdict).toBeNull(); // a budgeted timeout latches nothing
            expect(run.events).toEqual(allAtOnce.events); // both logs: empty

            const spent = session.advanceTrial(50); // a done run is a no-op, never extra frames
            expect(spent.stepped).toBe(0);
            expect(spent.done).toBe(true);

            const result = session.finalizeTrial();
            expect(result.elapsed).toBe(allAtOnce.elapsed);
            expect(result).toEqual(allAtOnce);
        },
    );

    it(
        'the steppable run publishes the SAME fact stream - loop:play, one {dt,elapsed} per step, mode row, one loop:reset',
        { timeout: 30000 },
        async () => {
            session = new AgentSession();
            await session.loadLevel('level-01');

            // The reference stream: the all-at-once trial's published facts.
            const ref = tapFacts();
            const allAtOnce = session.trial({ seconds: 1 });
            ref.stop();

            // The steppable spelling of the same run, chunked arbitrarily.
            const tap = tapFacts();
            const run = session.beginTrial({ seconds: 1 });
            session.advanceTrial(30);
            session.advanceTrial(80); // clamps at the 60-frame budget
            const result = session.finalizeTrial();
            tap.stop();

            expect(result).toEqual(allAtOnce);
            expect(tap.facts).toEqual(ref.facts); // identical topics, identical packets, identical order

            // The framing details, read off the steppable stream directly
            // (the same pins session-run-lifecycle pins for trial()):
            const frames = FRAME_TOPICS(tap.facts);
            expect(tap.facts[0]).toMatchObject({ topic: 'loop:play', packet: { elapsed: 0 } });
            expect(tap.facts[tap.facts.length - 1]).toMatchObject({ topic: 'loop:reset', packet: { elapsed: 0 } });
            expect(frames).toHaveLength(60);
            expect(tap.facts.filter((f) => f.topic === 'loop:play')).toHaveLength(1); // exactly one begin
            expect(tap.facts.filter((f) => f.topic === 'loop:reset')).toHaveLength(1); // exactly one end
            expect(frames[0].packet).toEqual({ dt: FIXED_STEP_MS, elapsed: FIXED_STEP_MS });
            expect(frames[0].packet).not.toHaveProperty('t'); // no private timeline spelling
            expect(frames[frames.length - 1].packet.elapsed).toBe(result.elapsed);
            frames.forEach((f, i) => expect(f.packet.elapsed).toBeCloseTo((i + 1) * FIXED_STEP_MS, 9));

            // The play boundary row keeps its sandbox order through the seam.
            const playIdx = tap.facts.findIndex((f) => f.topic === 'loop:play');
            const rowIdx = tap.facts.findIndex((f) => f.topic === 'mode:changed');
            const frameIdx = tap.facts.findIndex((f) => f.topic === 'loop:frame');
            expect(playIdx).toBeLessThan(rowIdx);
            expect(rowIdx).toBeLessThan(frameIdx);
            expect(tap.facts[rowIdx].packet).toMatchObject({ oldMode: 'EDITING', newMode: 'PLAYING' });
        },
    );

    it(
        'parity on a failed verdict - the fallen target judged on the first frame, stepping stops, no extra frames ever',
        { timeout: 30000 },
        async () => {
            session = new AgentSession();
            await session.loadLevel(FALLEN_TARGET_LEVEL);

            const allAtOnce = session.trial({ seconds: 5 });
            expect(allAtOnce.outcome).toBe('failed'); // the off-world rule latched
            expect(allAtOnce.failureReason).toBe('The target fell off the playfield.');
            expect(allAtOnce.elapsed).toBe(FIXED_STEP_MS); // exactly one step, honestly reported
            expect(allAtOnce.events).toHaveLength(1); // the one goal-failed row

            const run = session.beginTrial({ seconds: 5 });
            expect(run.verdict).toBeNull();
            expect(run.failureReason).toBeNull(); // the rebuild reset the reason, not the seam
            const first = session.advanceTrial(1);
            expect(first.verdict).toBe('failed'); // latched on the frame, readable immediately
            expect(run.failureReason).toBe('The target fell off the playfield.'); // readable at the pause
            expect(run.events[0]).toMatchObject({ landmark: true }); // the failed verdict is already logged

            const wasted = session.advanceTrial(100); // a latched run refuses further frames
            expect(wasted.stepped).toBe(0);
            expect(wasted.done).toBe(true);

            const result = session.finalizeTrial();
            expect(result).toEqual(allAtOnce);
        },
    );

    it(
        'parity holds under the seeded build window - construction randomness (the balloon) rides both runs identically',
        { timeout: 30000 },
        async () => {
            session = new AgentSession({ seed: 1337 }); // the one seed the seeded-determinism suite reads
            await session.loadLevel(BALLOON_DROP_LEVEL);
            place(session, 'balloon', 300, 300);
            place(session, 'ball', 700, 100);

            const allAtOnce = session.trial({ seconds: 5 });
            expect(allAtOnce.outcome).toBe('reached');
            expect(allAtOnce.snapshot.length).toBe(3); // zone + balloon + ball

            const run = session.beginTrial({ seconds: 5 });
            let i = 0;
            while (!run.done && i < 50) session.advanceTrial(CHUNKS[i++ % CHUNKS.length]);
            expect(i).toBeLessThan(50); // latched well inside the budget, as the reference did
            const result = session.finalizeTrial();

            expect(parityView(result)).toEqual(parityView(allAtOnce)); // balloon bob phase, verdict, log, poses, distance - all identical
        },
    );
});

describe('the steppable lifecycle - begin, pause, read, finalize (issue #61)', () => {
    it('guards its own lifecycle: begin twice, advance/finalize without a run throw, and trialRun is the one handle', async () => {
        session = new AgentSession();
        await session.loadLevel('level-01');

        expect(session.trialRun).toBeNull(); // nothing open before begin
        expect(() => session.advanceTrial(1)).toThrow(/advanceTrial: no trial run is open/);
        expect(() => session.finalizeTrial()).toThrow(/finalizeTrial: no trial run is open/);

        const run = session.beginTrial({ seconds: 1 });
        expect(session.trialRun).toBe(run); // the getter hands back the same run view
        expect(() => session.beginTrial({ seconds: 1 })).toThrow(/beginTrial: a trial run is already open/);

        expect(() => session.advanceTrial(0)).not.toThrow(); // a zero-frame advance is a pause, not an error
        expect(() => session.advanceTrial(-3)).not.toThrow(); // negative asks step nothing
        expect(run.stepped).toBe(0); // ...and nothing was stepped

        const result = session.finalizeTrial(); // closes the run cleanly
        expect(result.outcome).toBe('timeout');
        expect(session.trialRun).toBeNull(); // closed: the handle is gone from the session
        expect(run.open).toBe(false); // ...and knows it
    });

    it(
        'trial() called over an open steppable run abandons that run and still delivers its exact full-run result',
        { timeout: 30000 },
        async () => {
            session = new AgentSession();
            await session.loadLevel('level-01');
            place(session, 'ball', 700, 100);

            const plain = session.trial({ seconds: 5 }); // the reference full run
            expect(plain.outcome).toBe('reached');

            const run = session.beginTrial({ seconds: 5 });
            session.advanceTrial(10); // a paused seam run... then trial() arrives
            const mixed = session.trial({ seconds: 5 }); // abandons the open run (no merge), runs its own trial

            expect(parityView(mixed)).toEqual(parityView(plain)); // the all-at-once contract stands regardless
            expect(session.trialRun).toBeNull(); // nothing left open behind trial()
            expect(run.open).toBe(false); // the abandoned run knows it
        },
    );
});
