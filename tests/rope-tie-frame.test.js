/**
 * Tie points answer the body's rotation (issue #100) — the frame-coincidence probe.
 *
 * A tie point answers body.position + rotate(offset, body.angle): the
 * attachment offset is BODY-LOCAL, so the dashed tie square, the knot ring,
 * the knot tooltip and the balloon's drawn knot triangle — all painted from
 * BaseObject.getAttachmentWorldPoint — sit on the same point the realized
 * engine link pins. Matter carries the knot link's stored pointB along with
 * the bearer body's rotation (Constraint.solve re-rotates the endpoint in
 * place, ADR 0005's "Matter pins worth knowing"), so the pin swings with a
 * spinning balloon or a tipped bucket while the square used to sit at the
 * unrotated offset — the growing wedge the ticket's probe measured
 * (10.8–17.7 px over 400 beats).
 *
 * Probe style (the ticket's acceptance criterion): tie, spin the body
 * directly, compare within 1 px. A balloon knot's square vs the pin; the
 * balloon's drawn knot triangle (path-pinned through a recording ctx); then
 * the same coincidence against a tipped bucket rim (a dynamic container
 * rotated rigidly — buckets fall on their side during play, and the rim
 * offset is floor-local).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import Matter from 'matter-js';
import Rope from '../js/objects/Rope.js';
import Balloon from '../js/objects/Balloon.js';
import Bucket from '../js/objects/Bucket.js';
import { PhysicsEngine } from '../js/engine/PhysicsEngine.js';

const { Body } = Matter;
const DT = 1000 / 60;
// The spin class both defects share: balloons turn under collision torque and
// falling buckets tip — a right-ish half of the probe's measured 11-18 deg
// class, large enough that the old 1 px budget cannot hide the wedge.
const SPIN = Math.PI / 4;

/** Rotate p by angle a — the body-local frame contract the seam fixes. */
const rotate = (p, a) => ({
    x: p.x * Math.cos(a) - p.y * Math.sin(a),
    y: p.x * Math.sin(a) + p.y * Math.cos(a),
});

/** Distance in px between two world points. */
const px = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * The realized pin world point on the side of `body` — Matter's
 * Constraint.pointA/pointBWorld shape: body position + the tracked endpoint
 * offset (the stored pointB is re-rotated in place by every solve, so it IS
 * the current world offset at read time).
 */
function realizedPinAt(link, body) {
    if (link.bodyA === body) {
        return { x: link.bodyA.position.x + link.pointA.x, y: link.bodyA.position.y + link.pointA.y };
    }
    return { x: link.bodyB.position.x + link.pointB.x, y: link.bodyB.position.y + link.pointB.y };
}

/** Tie a fresh rope's end seat to `target`/`pointId`, step once (the reconcile realizes the knot link). */
function tieAndRealize(physics, rope, target, pointId, spot) {
    const ropePart = new Rope(...rope);
    const targetPart = new target(...spot);
    physics.addObject(ropePart);
    physics.addObject(targetPart);
    ropePart.attachEndpoint('end', targetPart, pointId);
    physics.step(DT); // realize
    return { ropePart, targetPart };
}

describe('Tie points answer the body\'s rotation (issue #100) — frame coincidence', () => {
    const engines = [];
    afterEach(() => {
        for (const engine of engines) engine.dispose();
        engines.length = 0;
    });

    it('a rope tied to a balloon knot: the tie square and the realized pin spin with the body', () => {
        const physics = new PhysicsEngine(800, 600);
        engines.push(physics);
        const { ropePart, targetPart } = tieAndRealize(
            physics, [350, 300, { length: 100 }], Balloon, 'knot', [420, 380, { radius: 20 }]);

        const knotBody = targetPart.attachmentPoints.find((p) => p.id === 'knot').body;
        const links = physics.getAttachedConstraints();
        expect(links).toHaveLength(1); // the knot link — object-owned welds do not register here
        expect(links[0].bodyA).toBe(ropePart.bodies[ropePart.bodies.length - 1]); // the end seat bears it
        Body.setAngle(knotBody, SPIN); // the balloon spins under collision — set the angle directly
        physics.step(DT);
        physics.step(DT);
        expect(knotBody.angle).toBeGreaterThan(0.3); // the body really spun (solver nudges may drift it)

        // The dashed square / knot ring / tooltip all paint from
        // getAttachmentWorldPoint; the realized pin is the link's endpoint on
        // the knot body's side. They must be the same point at every angle.
        const square = targetPart.getAttachmentWorldPoint('knot');
        expect(square).not.toBe(null);
        const pin = realizedPinAt(links[0], knotBody);
        expect(px(square, pin)).toBeLessThanOrEqual(1);
    });

    it('the drawn knot triangle spins with the body, onto the realized pin', () => {
        const physics = new PhysicsEngine(800, 600);
        engines.push(physics);
        const { targetPart } = tieAndRealize(
            physics, [350, 300, { length: 100 }], Balloon, 'knot', [420, 380, { radius: 20 }]);

        const knotBody = targetPart.attachmentPoints.find((p) => p.id === 'knot').body;
        Body.setAngle(knotBody, SPIN);
        physics.step(DT);
        physics.step(DT);

        // Independent truth: the offset is the public attachment point's, the
        // angle the body's own — the knot triangle's tip draws at the rotated
        // point. (No tail below it: the balloon paints no decorative string at
        // all - issue #101 - the rope's own drawn tail is the only string.)
        const offset = targetPart.attachmentPoints.find((p) => p.id === 'knot').offset;
        const tipLocal = rotate(offset, knotBody.angle);

        const ctx = makeRecordingCtx();
        targetPart.draw(ctx);

        const apex = ctx.lineTo.mock.calls.filter(([x, y]) =>
            Math.abs(x - tipLocal.x) <= 0.5 && Math.abs(y - tipLocal.y) <= 0.5);
        expect(apex).toHaveLength(1); // the drawn knot tip rides the rotated knot point

        // ...and the drawn tip is the realized pin (the acceptance chain's
        // drawn-knot leg), read at the same instant the pin is.
        const link = physics.getAttachedConstraints()
            .find((l) => l.bodyA === knotBody || l.bodyB === knotBody);
        expect(link).toBeTruthy();
        const pin = realizedPinAt(link, knotBody);
        const drawnTip = { x: knotBody.position.x + apex[0][0], y: knotBody.position.y + apex[0][1] };
        expect(px(drawnTip, pin)).toBeLessThanOrEqual(1);
    });

    it('a rope tied to a bucket rim stays on the rim when the container tips (square ≈ pin)', () => {
        const physics = new PhysicsEngine(800, 600);
        engines.push(physics);
        const { ropePart, targetPart } = tieAndRealize(
            physics, [500, 220, { length: 60 }], Bucket, 'rim', [500, 300]);

        const rimBody = targetPart.attachmentPoints.find((p) => p.id === 'rim').body;
        const links = physics.getAttachedConstraints();
        expect(links).toHaveLength(1);
        // Tip the whole container rigidly about its center (the welds stay
        // satisfied — the shape a falling bucket lands in).
        const pivot = { x: targetPart.x, y: targetPart.y };
        for (const body of targetPart.bodies) Body.rotate(body, SPIN, pivot);
        physics.step(DT);
        physics.step(DT);
        expect(rimBody.angle).toBeGreaterThan(0.3);

        const square = targetPart.getAttachmentWorldPoint('rim');
        expect(square).not.toBe(null);
        const pin = realizedPinAt(links[0], rimBody);
        expect(px(square, pin)).toBeLessThanOrEqual(1);
    });
});

/**
 * Minimal canvas 2D-context stub that records calls (no DOM/canvas in Node) —
 * the recording shape tests/rope-knots.test.js established, with the path
 * verbs Balloon.draw needs (translate/ellipse/quadraticCurveTo).
 */
function makeRecordingCtx() {
    const ctx = {};
    for (const fn of [
        'save', 'restore', 'translate', 'beginPath', 'moveTo', 'lineTo',
        'quadraticCurveTo', 'arc', 'ellipse', 'fill', 'stroke',
    ]) ctx[fn] = vi.fn();
    return ctx;
}
