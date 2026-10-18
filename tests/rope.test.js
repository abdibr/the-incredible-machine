/**
 * Unit tests for rope severing (GitHub issue #2):
 * severing a rope must physically detach it — its Matter constraints are
 * removed from the physics world, the freed segments fall, and the visual
 * draw agrees with the physics.
 */

import { describe, it, expect, beforeEach } from 'vitest';
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
});