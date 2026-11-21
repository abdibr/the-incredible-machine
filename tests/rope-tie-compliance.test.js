/**
 * Knot-link compliance stays a recorded bound, not a tuning change -
 * GitHub issue #102 (Implementation Decision 5 of the rope-ties group
 * spec): the knot link keeps its realize values (length 0, stiffness
 * 0.9 against the chain's 0.8 links, damping 0.1) because raising them
 * re-introduces the solver instability the current values were chosen
 * for. This suite changes nothing; it PINS the measured bound so a
 * future tuning change cannot silently worsen the drift the decision
 * records - the values are revisited only with a new stability
 * measurement (the "tie compliance under sustained load" paragraph of
 * the ADR 0007 amendment, docs/adr/0007-rope-connection-redesign.md).
 *
 * Scenario (the untracked evidence probe .scratch/rope-viz-probe.mjs
 * scenario 2, reproduced faithfully): a fixed peg bucket, a pinned rope
 * born span 300, a mid tie to a bucket rim past the mid seat's covering
 * circle - the tie covering-grows the span to ~746 and the re-lay puts
 * the seat on the knot (issues #86/#89, #98's re-seat), then 230 beats
 * of the probe's settle with the payload either held static or falling
 * and dragging the chain under sustained load.
 *
 * Measured at the settled tip this suite was pinned against: the static
 * payload settles at ~0.4px seat-to-knot, the heavy payload's
 * sustained-load settle at ~0.25px (max sampled transient ~1.4px), and
 * the ticket's historical 77.3px drift predates #98's re-seat - it no
 * longer occurs at settle. The pin is deliberately the loose recorded
 * ceiling (80px), not the tight measured value: a tuning change that
 * worsens the drift past the ceiling reopens the decision loudly.
 *
 * Seam under test: Rope.getTieSeats()'s mid-seat world point vs the
 * target's getAttachmentWorldPoint('rim') - the same two points the tie
 * square and the knot ring draw from. Companion suites: rope-tie-reseat
 * (tie-time seat geometry, the 2px settle budget), rope-span (the
 * covering grow), rope-ties (realization).
 */

import { describe, it, expect, afterEach } from 'vitest';
import Rope from '../js/objects/Rope.js';
import Bucket from '../js/objects/Bucket.js';
import { PhysicsEngine } from '../js/engine/PhysicsEngine.js';
import { registerAllObjects } from '../js/objects/registerAllObjects.js';

registerAllObjects();

const DT = 1000 / 60;
// The probe's settle protocol: 30 beats realize the ties (its "reconcile"
// run), then 200 more of the payload dragging before the settled read
// (its "settled for 230 beats").
const RECONCILE_BEATS = 30;
const SETTLE_BEATS = 200;
// The settled read is the worst of the final sample window - the payload
// rests by beat 230, so any late-window spike is unsettledness.
const SETTLE_SAMPLE_WINDOW = 10;
// The recorded compliance ceiling (ADR 0007 amendment, issue #102).
const COMPLIANCE_BOUND_PX = 80;
// The settle budget every static tie holds (rope-tie-reseat's budget).
const STATIC_SETTLE_BUDGET_PX = 2;

const engines = [];

afterEach(() => {
    for (const engine of engines) engine.dispose();
    engines.length = 0;
});

function makeEngine() {
    const engine = new PhysicsEngine(800, 600);
    engines.push(engine);
    return engine;
}

/** Seat-to-knot distance: the two points the tie square and knot ring draw from. */
function seatGap(rope, target) {
    const seat = rope.getTieSeats().find((s) => s.role === 'mid');
    const knot = target.getAttachmentWorldPoint('rim');
    return Math.hypot(seat.worldPoint.x - knot.x, seat.worldPoint.y - knot.y);
}

/**
 * The probe scenario verbatim: fixed peg at (200,100), rope born span 300
 * at (210,130), a bucket at (500,300) tied mid at its rim; its rim sits
 * past the mid seat's covering circle, so the tie grows the span (~746)
 * and the re-lay seats the chain with the seat on the knot before any
 * beat runs. Reconcile beats realized, so the caller's steps are all
 * settle.
 */
function tieTheProbeScenario(engine, { fixedPayload }) {
    const peg = new Bucket(200, 100, { isFixed: true });
    engine.addObject(peg);
    const rope = new Rope(210, 130, { length: 300 });
    engine.addObject(rope);
    const bucket = new Bucket(500, 300, fixedPayload ? { isFixed: true } : {});
    engine.addObject(bucket);

    rope.attachEndpoint('anchor', peg, 'rim');
    rope.attachEndpoint('mid', bucket, 'rim');
    for (let i = 0; i < RECONCILE_BEATS; i++) engine.step(DT);
    return { rope, bucket };
}

/**
 * The probe's 230-beat settle, read as the worst seat-to-knot distance of
 * the final sample window.
 */
function settledGap(engine, rope, bucket) {
    let worst = 0;
    for (let i = 1; i <= SETTLE_BEATS; i++) {
        engine.step(DT);
        if (i > SETTLE_BEATS - SETTLE_SAMPLE_WINDOW) {
            worst = Math.max(worst, seatGap(rope, bucket));
        }
    }
    return worst;
}

describe('Knot-link compliance stays a recorded bound under the probe scenario (issue #102)', () => {
    it('a heavy payload dragged under sustained load settles within the recorded 80px compliance bound', () => {
        const engine = makeEngine();
        const { rope, bucket } = tieTheProbeScenario(engine, { fixedPayload: false });

        // The recorded ceiling, not the tight measured value: the values are
        // kept deliberately (ADR 0007 "tie compliance under sustained load"),
        // and a tuning change that worsens the settle past 80px reopens the
        // decision loudly instead of silently.
        expect(settledGap(engine, rope, bucket)).toBeLessThanOrEqual(COMPLIANCE_BOUND_PX);

        // Drift is compliance, not loss: both ties survive the settle.
        const refs = rope.getAttachmentRefs();
        expect(refs.map((r) => r.seat)).toEqual(['anchor', 'mid']);
        expect(refs.every((r) => r.pointId === 'rim')).toBe(true);
    });

    it('a static payload in the same tie settles within the settle budget', () => {
        const engine = makeEngine();
        const { rope, bucket } = tieTheProbeScenario(engine, { fixedPayload: true });

        // The static half of the recorded bound: with nothing dragging the
        // chain, the seat holds the knot inside rope-tie-reseat's settle
        // budget for the whole late window.
        expect(settledGap(engine, rope, bucket)).toBeLessThanOrEqual(STATIC_SETTLE_BUDGET_PX);

        const refs = rope.getAttachmentRefs();
        expect(refs.map((r) => r.seat)).toEqual(['anchor', 'mid']);
    });
});
