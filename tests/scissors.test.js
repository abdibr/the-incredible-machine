/**
 * Unit tests for the reworked Scissors (user report: "scissors opens then cuts").
 *
 * Scissors now rest open as two crossed levers: blade sensors fan open,
 * solid handles sit behind the pivot. A dynamic weight landing on a
 * handle snaps the levers shut (one-shot) and severs any rope resting
 * in the open blade fan; closed blades keep cutting ropes that touch
 * them afterwards. Open blades never cut.
 */

import { describe, it, expect, afterEach } from 'vitest';
import Matter from 'matter-js';
import Scissors from '../js/objects/Scissors.js';
import Rope from '../js/objects/Rope.js';
import Ball from '../js/objects/Ball.js';
import PhysicsEngine from '../js/engine/PhysicsEngine.js';

const { Composite } = Matter;

describe('Scissors - open until a weight snaps them shut', () => {
    const engines = [];

    afterEach(() => {
        for (const engine of engines) engine.dispose();
        engines.length = 0;
    });

    function createEngine() {
        const engine = new PhysicsEngine(800, 600);
        engines.push(engine);
        return engine;
    }

    const bladesOf = (scissors) => scissors.bodies.filter((b) => b.label === 'scissors-blade');
    const handlesOf = (scissors) => scissors.bodies.filter((b) => b.label === 'scissors-handle');

    it('spawns open with two blade sensors and two solid handles', () => {
        const scissors = new Scissors(200, 200);

        expect(scissors.isOpen).toBe(true);
        expect(scissors.isClosed).toBe(false);

        const blades = bladesOf(scissors);
        const handles = handlesOf(scissors);
        expect(blades.length).toBe(2);
        expect(handles.length).toBe(2);
        blades.forEach((b) => expect(b.isSensor).toBe(true));
        handles.forEach((b) => expect(b.isSensor).toBe(false));

        // Splayed open, blades fan forward (+x), handles behind the pivot
        const [topAngle, bottomAngle] = blades.map((b) => b.angle).sort((a, b) => a - b);
        expect(topAngle).toBeLessThan(-0.3);
        expect(bottomAngle).toBeGreaterThan(0.3);
        expect(scissors.splayAngle).toBeGreaterThan(0.4);
        expect(blades.every((b) => b.position.x > 200)).toBe(true);
        expect(handles.every((b) => b.position.x < 200)).toBe(true);
        expect(handles.every((b) => Math.abs(b.position.y - 200) > 5)).toBe(true);
    });

    it('follows setPosition/setAngle with repositioned levers', () => {
        const scissors = new Scissors(400, 300);
        scissors.setPosition(500, 250);
        // Point the blades straight down (+x rotated 90° onto +y)
        scissors.setAngle(Math.PI / 2);

        const blades = bladesOf(scissors);
        const [topBlade, bottomBlade] = blades;
        // Blades now reach "down" (+y), fanned either side of that axis
        expect(topBlade.position.y).toBeGreaterThan(255);
        expect(bottomBlade.position.y).toBeGreaterThan(255);
        expect(topBlade.position.x).toBeGreaterThan(500);
        expect(bottomBlade.position.x).toBeLessThan(500);
        handlesOf(scissors).forEach((h) => expect(h.position.y).toBeLessThan(245));
        expect(topBlade.angle).toBeCloseTo(Math.PI / 2 - scissors.splayAngle, 5);
        expect(bottomBlade.angle).toBeCloseTo(Math.PI / 2 + scissors.splayAngle, 5);
    });

    it('a rope resting between the open blades is neither cut nor triggered', () => {
        const engine = createEngine();
        // Segments overlap the open blade sensors but never reach the handles
        const rope = new Rope(415, 30, { length: 80 });
        const scissors = new Scissors(400, 55);
        engine.addObject(rope);
        engine.addObject(scissors);

        for (let i = 0; i < 12; i++) engine.step(16.67);

        expect(scissors.isClosed).toBe(false);
        expect(rope.isSevered).toBe(false);
    });

    it('severs a rope resting in the blade fan when a weight snaps the handle', () => {
        const engine = createEngine();
        // Rope just beyond blade-sensor reach, segments inside the open fan
        const rope = new Rope(425, 30, { length: 80 });
        const farRope = new Rope(650, 40, { length: 80 });
        const scissors = new Scissors(400, 55);
        // Tennis ball dropped onto the raised handle just left of the pivot
        const ball = new Ball(379, 28, { variant: 'tennis' });
        engine.addObject(rope);
        engine.addObject(farRope);
        engine.addObject(scissors);
        engine.addObject(ball);

        let severed = false;
        for (let i = 0; i < 90 && !severed; i++) {
            engine.step(16.67);
            severed = rope.isSevered;
        }

        expect(severed).toBe(true);
        expect(scissors.isClosed).toBe(true);

        // Freed segments stay detached; the far rope is untouched
        for (let i = 0; i < 30; i++) engine.step(16.67);
        const worldConstraints = Composite.allConstraints(engine.world);
        for (const constraint of rope.constraints) {
            expect(worldConstraints).not.toContain(constraint);
        }
        expect(farRope.isSevered).toBe(false);
    });

    it('closes into a near-parallel pose and stays shut', () => {
        const engine = createEngine();
        const scissors = new Scissors(400, 55);
        const ball = new Ball(379, 28, { variant: 'tennis' });
        engine.addObject(scissors);
        engine.addObject(ball);

        let closed = false;
        for (let i = 0; i < 90 && !closed; i++) {
            engine.step(16.67);
            closed = scissors.isClosed;
        }
        expect(closed).toBe(true);

        // Close animation finishes into the near-parallel pose
        for (let i = 0; i < 20; i++) engine.step(16.67);
        expect(scissors.isClosed).toBe(true);
        expect(scissors.splayAngle).toBeCloseTo(0.06, 2);
        bladesOf(scissors).forEach((b) => expect(Math.abs(b.angle)).toBeLessThan(0.08));
    });

    it('only handle contact with a dynamic body triggers the snap', () => {
        const scissors = new Scissors(400, 300);
        const [handleUpper, handleLower] = handlesOf(scissors);
        const fakeDynamic = { isStatic: false };
        const fakeStatic = { isStatic: true };

        // Rope touching either handle never snaps them shut
        scissors.onCollision({ type: 'rope' }, { bodyA: handleUpper, bodyB: fakeDynamic });
        scissors.onCollision({ type: 'rope' }, { bodyA: fakeDynamic, bodyB: handleLower });
        // Static bodies can't "fall" onto a handle
        scissors.onCollision({ type: 'ramp' }, { bodyA: handleUpper, bodyB: fakeStatic });
        // Weight landing on a blade sensor doesn't trigger either
        scissors.onCollision({ type: 'ball' }, { bodyA: bladesOf(scissors)[1], bodyB: fakeDynamic });
        expect(scissors.isClosed).toBe(false);

        // A dynamic body landing on the handle does
        scissors.onCollision({ type: 'ball' }, { bodyA: handleLower, bodyB: fakeDynamic });
        expect(scissors.isClosed).toBe(true);
    });

    it('serialize/restoreState round-trips the closed state and re-applies poses', () => {
        const scissors = new Scissors(400, 300);
        expect(scissors.serialize().options.closed).toBe(false);

        const [, handleLower] = handlesOf(scissors);
        scissors.onCollision({ type: 'ball' }, { bodyA: handleLower, bodyB: { isStatic: false } });
        expect(scissors.isClosed).toBe(true);

        const data = scissors.serialize();
        expect(data.options.closed).toBe(true);

        const restored = new Scissors(400, 300);
        restored.restoreState(data);
        expect(restored.isClosed).toBe(true);
        expect(restored.splayAngle).toBeCloseTo(0.06, 2);
        const [topBlade, bottomBlade] = bladesOf(restored);
        expect(topBlade.angle).toBeCloseTo(-0.06, 3);
        expect(bottomBlade.angle).toBeCloseTo(0.06, 3);

        restored.restoreState({ options: {} });
        expect(restored.isOpen).toBe(true);
        expect(restored.splayAngle).toBeGreaterThan(0.4);
    });

    it('snapshot restore reopens a snapped-shut scissors', () => {
        const engine = createEngine();
        const scissors = new Scissors(400, 55);
        engine.addObject(scissors);
        engine.step(16.67);
        engine.takeSnapshot();

        // Snap shut during play...
        const ball = new Ball(379, 28, { variant: 'tennis' });
        engine.addObject(ball);
        let closed = false;
        for (let i = 0; i < 90 && !closed; i++) {
            engine.step(16.67);
            closed = scissors.isClosed;
        }
        expect(closed).toBe(true);

        // ...then reset must reopen them with the open lever poses
        engine.restoreSnapshot();
        expect(scissors.isOpen).toBe(true);
        expect(scissors.splayAngle).toBeGreaterThan(0.4);
        const [topBlade, bottomBlade] = bladesOf(scissors);
        expect(topBlade.angle).toBeCloseTo(-scissors.splayAngle, 5);
        expect(bottomBlade.angle).toBeCloseTo(scissors.splayAngle, 5);
    });
});