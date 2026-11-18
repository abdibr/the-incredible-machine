/**
 * Unit tests for rope severing:
 * GitHub issue #2 founded the physical-detachment contract; GitHub issue #58
 * (ADR 0007 decision 7) replaces the whole-rope demolition with PIECE
 * severing - a cut lands exactly where it hit, only the chain constraint at
 * the cut dies, and the surviving connected components (the pieces) keep
 * their segments, their knots and their payloads. A sever call with no hit
 * information (sever() bare) stays the wholesale fallback for producers
 * that cannot locate the cut, and for restoring legacy rows.
 *
 * The deep piece contracts (pieces API, edge cases, round-trips, free-rope)
 * live in tests/rope-pieces.test.js; this suite pins the physical
 * detachment story end to end: world state, hangs and falls, the candle
 * and scissors rigs, and the draw agreement.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Matter from 'matter-js';

const { Composite } = Matter;

describe('Rope severing - piece splitting', () => {
    let PhysicsEngine;
    let Rope;

    beforeEach(async () => {
        const engineMod = await import('../js/engine/PhysicsEngine.js');
        const ropeMod = await import('../js/objects/Rope.js');
        PhysicsEngine = engineMod.PhysicsEngine;
        Rope = ropeMod.default;
    });

    it('removes exactly the cut constraint from the physics world; the surviving pieces stand', () => {
        const physics = new PhysicsEngine(800, 600);
        const rope = new Rope(200, 100);
        physics.addObject(rope);

        // Intact rope: every constraint is in the world
        let worldConstraints = Composite.allConstraints(physics.world);
        for (const constraint of rope.constraints) {
            expect(worldConstraints).toContain(constraint);
        }

        rope.sever(2); // a mid-chain cut: only the cut constraint dies

        worldConstraints = Composite.allConstraints(physics.world);
        expect(rope.constraints).toHaveLength(5); // six links minus the cut
        // The survivors stand; the two pieces are each held by their parts.
        expect(worldConstraints).toEqual(rope.constraints);
        expect(rope.getPieces()).toHaveLength(2);

        physics.dispose();
    });

    it('keeps the rope hanging until cut, then the anchor piece holds while the falling piece drops', () => {
        const physics = new PhysicsEngine(800, 600);
        const rope = new Rope(200, 100);
        physics.addObject(rope);

        const initialY = rope.bodies.map((b) => b.position.y);

        // Intact: the rope hangs near its laid-out positions (soft constraints
        // sag ~20px under gravity; free fall would displace 100px+)
        for (let i = 0; i < 20; i++) physics.step(16.67);
        for (const [i, body] of rope.bodies.entries()) {
            expect(Math.abs(body.position.y - initialY[i])).toBeLessThan(45);
        }

        rope.sever(0); // cut at the first segment: [anchor, seg0] | [seg1..seg5]

        // The anchor piece hangs from the nail; the falling piece drops as
        // one chain segment-set, each of its bodies displaced by gravity.
        for (let i = 0; i < 60; i++) physics.step(16.67);
        expect(rope.bodies[0].isStatic).toBe(true);
        expect(rope.bodies[0].position.y).toBe(initialY[0]);
        expect(rope.bodies[1].position.y).toBeLessThan(initialY[1] + 45); // still hung
        const segLength = 100 / 6;
        for (let i = 2; i < rope.bodies.length; i++) {
            expect(rope.bodies[i].position.y).toBeGreaterThan(initialY[i] + 30);
        }
        // ... and the falling piece never disintegrates: its own links hold.
        for (let i = 2; i < rope.bodies.length - 1; i++) {
            const gap = Math.hypot(
                rope.bodies[i + 1].position.x - rope.bodies[i].position.x,
                rope.bodies[i + 1].position.y - rope.bodies[i].position.y,
            );
            expect(gap).toBeLessThan(segLength * 2);
        }

        physics.dispose();
    });

    it('splits the chain into pieces when a candle flame touches the rope', async () => {
        const { default: Candle } = await import('../js/objects/Candle.js');

        const physics = new PhysicsEngine(800, 600);
        // Rope hangs from (200, 40): segment centers at y = 45, 55, 65, ... 95
        const rope = new Rope(200, 40, { length: 60 });
        // Flame sensor (r=10) centers exactly on the rope segment at y=55
        const candle = new Candle(200, 80);

        physics.addObject(rope);
        physics.addObject(candle);

        expect(rope.isSevered).toBe(false);

        physics.step(16.67);

        // Collision dispatch: flame sensor pair -> interaction row
        // `rope-candle-flame` -> the cut lands at the pair's hit segment, and
        // the engine consumer detaches exactly that constraint in the same
        // beat: the chain is two pieces, not confetti.
        expect(rope.isSevered).toBe(true);
        expect(rope.getPieces()).toHaveLength(2);
        expect(rope.constraints).toHaveLength(5);
        const worldConstraints = Composite.allConstraints(physics.world);
        expect(worldConstraints).toEqual(rope.constraints);

        physics.dispose();
    });

    it('draws an intact rope attached to its anchor', () => {
        const rope = new Rope(200, 100);

        const ctx = makeRecordingCtx();
        rope.draw(ctx);

        // Attached curve starts at the anchor position
        expect(ctx.moveTo.mock.calls[0]).toEqual([200, 100]);

        rope.dispose();
    });

    it('draws a piece-cut rope in gray, one polyline per piece, the anchor-side starting at the nail', () => {
        const rope = new Rope(200, 100);
        const anchor = rope.bodies[0];            // public body order: anchor first
        const fallingPieceStart = rope.bodies[4]; // the second piece's first segment (sever(2) keeps seg2 with the anchor side)

        rope.sever(2); // pieces: [anchor, seg0, seg1, seg2] | [seg3, seg4, seg5]

        const ctx = makeRecordingCtx();
        rope.draw(ctx);

        // One polyline per piece: the hung piece starts at the nail, the
        // falling one at its own first segment. The nail is only ever the
        // start of its own piece.
        expect(ctx.moveTo.mock.calls[0]).toEqual([anchor.position.x, anchor.position.y]);
        expect(ctx.moveTo.mock.calls[1]).toEqual([
            fallingPieceStart.position.x, fallingPieceStart.position.y,
        ]);
        for (const call of ctx.moveTo.mock.calls.slice(2)) {
            expect(call).not.toEqual([anchor.position.x, anchor.position.y]);
        }
        // Gray tone marks the severed rope
        expect(ctx.strokeStyles).toContain('#aaa');
        rope.dispose();
    });

    it('draws a wholesale-severed rope detached from its anchor', () => {
        const rope = new Rope(200, 100);
        const anchor = rope.bodies[0];       // public body order: anchor first
        const firstSegment = rope.bodies[1];

        rope.sever();

        const ctx = makeRecordingCtx();
        rope.draw(ctx);

        // Physics has no constraint to the anchor after severing, so the
        // polyline must start on the first segment, never on the anchor
        expect(ctx.moveTo.mock.calls[0]).toEqual([firstSegment.position.x, firstSegment.position.y]);
        for (const call of ctx.moveTo.mock.calls) {
            expect(call).not.toEqual([anchor.position.x, anchor.position.y]);
        }
        // Gray tone marks the severed rope
        expect(ctx.strokeStyles).toContain('#aaa');
        rope.dispose();
    });

    it('should stay intact under open scissors resting in the blade fan', async () => {
        const { default: Scissors } = await import('../js/objects/Scissors.js');

        const physics = new PhysicsEngine(800, 600);
        // Rope hangs from (400, 40): segment centers at y = 45, 55, ..., 95
        const rope = new Rope(400, 40, { length: 60 });
        // Open scissors straddle the rope - a segment rests in the blade
        // fan, but open blades never cut (nor trigger on rope contact)
        const scissors = new Scissors(400, 55);

        physics.addObject(rope);
        physics.addObject(scissors);
        for (let i = 0; i < 10; i++) physics.step(16.67);

        expect(scissors.isClosed).toBe(false);
        expect(rope.isSevered).toBe(false);
        const worldConstraints = Composite.allConstraints(physics.world);
        for (const constraint of rope.constraints) {
            expect(worldConstraints).toContain(constraint);
        }

        physics.dispose();
    });

    it('splits the rope into its pieces when a weight snaps the scissors shut on it', async () => {
        const { default: Scissors } = await import('../js/objects/Scissors.js');
        const { default: Ball } = await import('../js/objects/Ball.js');

        const physics = new PhysicsEngine(800, 600);
        // Rope hangs from (400, 40): segment centers at y = 45, 55, ..., 95
        const rope = new Rope(400, 40, { length: 60 });
        // Open scissors straddle the rope (segment at y=55 rests in the
        // blade fan). A tennis ball dropped onto the raised handle snaps
        // the blades shut and cuts it at the fan.
        const scissors = new Scissors(400, 55);
        const ball = new Ball(379, 28, { variant: 'tennis' });

        physics.addObject(rope);
        physics.addObject(scissors);
        physics.addObject(ball);

        let severedStep = -1;
        for (let i = 0; i < 90; i++) {
            physics.step(16.67);
            if (rope.isSevered) {
                severedStep = i;
                break;
            }
        }
        expect(severedStep).toBeGreaterThanOrEqual(0);
        expect(scissors.isClosed).toBe(true);

        // The cut is one constraint at the fan: [anchor, seg0, seg1] hangs,
        // [seg2..seg5] falls; the survivors never resurrect.
        expect(rope.getPieces()).toHaveLength(2);
        expect(rope.constraints).toHaveLength(5);
        for (let i = 0; i < 30; i++) physics.step(16.67);
        const worldConstraints = Composite.allConstraints(physics.world);
        expect(worldConstraints).toEqual(rope.constraints);

        physics.dispose();
    });

    it('should not resurrect a severed rope\u2019s constraints when it is re-added to a physics world', () => {
        const physics = new PhysicsEngine(800, 600);
        const rope = new Rope(200, 100);
        physics.addObject(rope);
        physics.dispose();

        const rope2 = new Rope(200, 100);
        rope2.sever();
        expect(rope2.constraints).toEqual([]);

        const physics2 = new PhysicsEngine(800, 600);
        physics2.addObject(rope2);
        expect(Composite.allConstraints(physics2.world)).toEqual([]);

        physics2.dispose();
        rope2.dispose();
    });

    it('builds chain links that rest at the laid spacing (no contraction yank)', () => {
        const physics = new PhysicsEngine(800, 600);
        const rope = new Rope(200, 100);
        physics.addObject(rope);

        // Rest lengths equal the laid distances (segLength = 100/6):
        // anchor↔seg-0 half a segment, seg↔seg the full segment
        const segLength = 100 / 6;
        expect(rope.constraints).toHaveLength(6);
        expect(rope.constraints[0].length).toBeCloseTo(segLength * 0.5, 6);
        for (let i = 1; i < rope.constraints.length; i++) {
            expect(rope.constraints[i].length).toBeCloseTo(segLength, 6);
        }

        // Hanging intact under its own weight: links settle AT their rest
        // lengths (± solver slop), not contracted inboard by shorter
        // constraints (the bug file 2026-10-23 contraction yank)
        for (let i = 0; i < 60; i++) physics.step(16.67);
        const bodies = rope.bodies;
        for (let i = 1; i < bodies.length; i++) {
            const rest = i === 1 ? segLength * 0.5 : segLength;
            const gap = Math.hypot(
                bodies[i].position.x - bodies[i - 1].position.x,
                bodies[i].position.y - bodies[i - 1].position.y,
            );
            expect(gap).toBeGreaterThan(rest - 1);
            expect(gap).toBeLessThan(rest + 4);
        }

        physics.dispose();
    });
});

/** Minimal canvas 2D-context stub that records calls (no DOM/canvas in Node). */
function makeRecordingCtx() {
    const ctx = {};
    const strokeStyleLog = [];
    for (const fn of [
        'save', 'restore', 'beginPath', 'moveTo', 'lineTo', 'quadraticCurveTo',
        'arc', 'ellipse', 'closePath', 'fill', 'stroke', 'fillRect', 'strokeRect',
    ]) {
        ctx[fn] = vi.fn();
    }
    // draw() assigns strokeStyle several times per frame; keep the history
    Object.defineProperty(ctx, 'strokeStyle', {
        set(v) { strokeStyleLog.push(v); },
        get() { return strokeStyleLog[strokeStyleLog.length - 1]; },
    });
    ctx.strokeStyles = strokeStyleLog;
    return ctx;
}