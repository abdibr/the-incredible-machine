/**
 * Unit tests for playfield placement clamping.
 *
 * Bug: parts could be dropped half-buried in the boundary floor (or entirely
 * outside the side walls, e.g. when released over the toolbox panel) — the
 * static boundary walls coincide with the playfield edges, so embedded parts
 * were violently displaced / flung out of the world when play started.
 *
 * Seams under test (public interface):
 * - clampObjectToPlayfield(obj, x, y, w, h) — named export on BaseObject,
 *   shared by DragDropManager (_placeObject / move / rotate) and Renderer (ghost),
 * - object bounds getters (Ball / Domino / Ramp) as the clamped footprint,
 * - PhysicsEngine static boundary geometry (floor top edge = world height),
 * - a flush floor drop staying put through physics steps (no ejection).
 */

import { describe, it, expect } from 'vitest';
import Matter from 'matter-js';
import { clampObjectToPlayfield } from '../js/objects/BaseObject.js';
import Ball from '../js/objects/Ball.js';
import Domino from '../js/objects/Domino.js';
import Ramp from '../js/objects/Ramp.js';
import { PhysicsEngine } from '../js/engine/PhysicsEngine.js';

const W = 1000; // world width  (playfield canvas backing)
const H = 600;  // world height (top edge of the engine's boundary floor)

/** AABB convenience view of an object's bounds ({x,y,width,height}). */
const aabb = (b) => ({ left: b.x, top: b.y, right: b.x + b.width, bottom: b.y + b.height });

/** Apply the clamp exactly the way DragDropManager._placeObject does. */
function placeClamped(obj, x, y) {
    const { x: cx, y: cy } = clampObjectToPlayfield(obj, x, y, W, H);
    obj.setPosition(cx, cy);
    return obj;
}

describe('clampObjectToPlayfield', () => {
    it('leaves interior positions untouched', () => {
        const ball = new Ball(500, 300);
        const clamped = clampObjectToPlayfield(ball, 500, 300, W, H);
        expect(clamped).toEqual({ x: 500, y: 300 });
    });

    it('clamps a ball dropped past the bottom edge so it rests on the floor top edge', () => {
        const ball = placeClamped(new Ball(500, 620), 500, 620); // 20px below the floor line

        const a = aabb(ball.bounds);
        expect(a.bottom).toBe(H);                    // lying on the floor, not inside it
        expect(ball.y).toBe(H - 18);                 // center = radius above the floor
        expect(ball.x).toBe(500);                    // x untouched by the y clamp
    });

    it('clamps a domino dropped with its bottom below the floor line to sit flush on it', () => {
        const domino = placeClamped(new Domino(700, 599), 700, 599);
        const a = aabb(domino.bounds);
        expect(a.bottom).toBe(H);
        expect(domino.y).toBeLessThan(599);          // center pulled up
    });

    it('clamps a drop released over the toolbox panel (x < 0) inside the left wall', () => {
        const ball = placeClamped(new Ball(-30, 300), -30, 300);
        const a = aabb(ball.bounds);
        expect(a.left).toBeGreaterThanOrEqual(0);    // fully inside the left wall
        expect(ball.x).toBe(18);                     // center = radius from the wall
        expect(a.right).toBeGreaterThan(0);
    });

    it('clamps against the ceiling and the right wall symmetrically', () => {
        const high = placeClamped(new Ball(500, -30), 500, -30);
        expect(aabb(high.bounds).top).toBe(0);

        const right = placeClamped(new Ball(1020, 300), 1020, 300);
        expect(aabb(right.bounds).right).toBe(W);
    });

    it('clamps rotated objects against their rotated AABB (ramp swung across the right wall)', () => {
        // A diagonal ramp at x=990 pokes past x=1000 with its rotated AABB
        const ramp = placeClamped(new Ramp(990, 300, { angle: Math.PI / 4 }), 990, 300);
        const a = aabb(ramp.bounds);
        expect(a.right).toBeLessThanOrEqual(W + 0.001);
        expect(a.left).toBeGreaterThanOrEqual(-0.001);
        expect(a.top).toBeGreaterThanOrEqual(-0.001);
        expect(a.bottom).toBeLessThanOrEqual(H + 0.001);
    });
});

describe('playfield boundaries match the clamp rectangle', () => {
    it('static boundary walls coincide with the world edges', () => {
        const engine = new PhysicsEngine(W, H);
        try {
            const statics = Matter.Composite.allBodies(engine.world).filter((b) => b.isStatic);
            expect(statics.length).toBeGreaterThan(0);
            // Floor: its top edge is exactly the bottom of the playfield
            expect(statics.some((b) => b.bounds.min.y === H)).toBe(true);
            // Left wall: right edge at x=0; right wall: left edge at x=W
            expect(statics.some((b) => b.bounds.max.x === 0)).toBe(true);
            expect(statics.some((b) => b.bounds.min.x === W)).toBe(true);
            // Ceiling: bottom edge at y=0
            expect(statics.some((b) => b.bounds.max.y === 0)).toBe(true);
        } finally {
            engine.dispose();
        }
    });
});

describe('clamped placement is play-safe (no wall ejection)', () => {
    it('a domino clamped flush onto the floor stays put through 60 physics steps', () => {
        const engine = new PhysicsEngine(W, H);
        try {
            const domino = placeClamped(new Domino(700, 700), 700, 700); // drop request under the floor
            engine.addObject(domino);

            for (let i = 0; i < 60; i++) engine.step(1000 / 60);

            const p = domino.bodies[0].position;
            expect(Math.abs(p.x - domino.x)).toBeLessThan(3);   // no sideways shove
            expect(Math.abs(p.y - domino.y)).toBeLessThan(3);   // no upward ejection
            // A flush drop may settle into resting contact slop (<1px), but
            // must never end up embedded in the floor like the unclamped bug.
            expect(aabb(domino.bounds).bottom).toBeLessThan(H + 1);
        } finally {
            engine.dispose();
        }
    });
});