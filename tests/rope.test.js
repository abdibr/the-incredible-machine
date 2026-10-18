/**
 * Unit tests for rope severing (GitHub issue #2):
 * severing a rope must physically detach it — its Matter constraints are
 * removed from the physics world, the freed segments fall, and the visual
 * draw agrees with the physics.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Matter from 'matter-js';

const { Composite } = Matter;

describe('Rope severing — physical detachment', () => {
    let PhysicsEngine;
    let Rope;

    beforeEach(async () => {
        const engineMod = await import('../js/engine/PhysicsEngine.js');
        const ropeMod = await import('../js/objects/Rope.js');
        PhysicsEngine = engineMod.PhysicsEngine;
        Rope = ropeMod.default;
    });

    it('should remove a severed rope\u2019s constraints from the physics world', () => {
        const physics = new PhysicsEngine(800, 600);
        const rope = new Rope(200, 100);
        physics.addObject(rope);

        // Intact rope: every constraint is in the world
        let worldConstraints = Composite.allConstraints(physics.world);
        for (const constraint of rope.constraints) {
            expect(worldConstraints).toContain(constraint);
        }

        rope.sever();

        // Severed rope: all of its constraints are gone from the world
        worldConstraints = Composite.allConstraints(physics.world);
        for (const constraint of rope.constraints) {
            expect(worldConstraints).not.toContain(constraint);
        }

        physics.dispose();
    });

    it('should keep the rope hanging until severed, then let the freed piece fall', () => {
        const physics = new PhysicsEngine(800, 600);
        const rope = new Rope(200, 100);
        physics.addObject(rope);

        const initialY = rope.bodies.map(b => b.position.y);

        // Intact: the rope hangs near its laid-out positions (soft constraints
        // sag ~20px under gravity; free fall would displace 100px+)
        for (let i = 0; i < 20; i++) physics.step(16.67);
        for (const [i, body] of rope.bodies.entries()) {
            expect(Math.abs(body.position.y - initialY[i])).toBeLessThan(45);
        }

        rope.sever();

        // Severed: the freed segments drop under gravity (static anchor stays)
        for (let i = 0; i < 60; i++) physics.step(16.67);
        for (const [i, body] of rope.bodies.entries()) {
            if (body.isStatic) {
                expect(body.position.y).toBe(initialY[i]);
            } else {
                expect(body.position.y).toBeGreaterThan(initialY[i] + 30);
            }
        }

        physics.dispose();
    });

    it('should sever and physically detach when a candle flame touches the rope', async () => {
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

        // Collision dispatch: flame sensor pair -> Rope.onCollision -> sever,
        // and the engine consumer drops the constraints in the same beat
        expect(rope.isSevered).toBe(true);
        const worldConstraints = Composite.allConstraints(physics.world);
        for (const constraint of rope.constraints) {
            expect(worldConstraints).not.toContain(constraint);
        }

        physics.dispose();
    });

    it('should draw an intact rope attached to its anchor', () => {
        const rope = new Rope(200, 100);

        const ctx = makeRecordingCtx();
        rope.draw(ctx);

        // Attached curve starts at the anchor position
        expect(ctx.moveTo.mock.calls[0]).toEqual([200, 100]);

        rope.dispose();
    });

    it('should draw a severed rope detached from its anchor', () => {
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
    });

    it('should sever and physically detach when scissors touch the rope', async () => {
        const { default: Scissors } = await import('../js/objects/Scissors.js');

        const physics = new PhysicsEngine(800, 600);
        // Rope hangs from (400, 40): segment centers at y = 45, 55, ..., 95
        const rope = new Rope(400, 40, { length: 60 });
        // Scissors blade rect (30x8) covers the rope segment at y=55
        const scissors = new Scissors(400, 55);

        physics.addObject(rope);
        physics.addObject(scissors);
        physics.step(16.67);

        expect(rope.isSevered).toBe(true);
        const worldConstraints = Composite.allConstraints(physics.world);
        for (const constraint of rope.constraints) {
            expect(worldConstraints).not.toContain(constraint);
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