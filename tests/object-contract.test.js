/**
 * Object lifecycle conformance tests (candidate C3 / ADR 0003).
 *
 * BaseObject declares the lifecycle create → play (onBeforeUpdate per step)
 * → restore (restoreState across a play/reset cycle) → dispose, with
 * restoreState as an optional default no-op. The registry sweep pins the
 * contract for EVERY registered type (a new object type must satisfy it or
 * this suite fails); the parity tests pin the behavioral restoreState
 * semantics that closed the same-instance physics-restore gaps
 * (Bucket._caught, Spring trigger trio, Trampoline._stretch, Gear's
 * mesh-reversal drive); the routing tests pin LevelManager.loadCustom() as
 * the only seam for editor-imported levels.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { PhysicsEngine } from '../js/engine/PhysicsEngine.js';
import { objectRegistry } from '../js/objects/ObjectRegistry.js';
import { registerAllObjects } from '../js/objects/registerAllObjects.js';
import BaseObject from '../js/objects/BaseObject.js';
import { eventBus } from '../js/EventBus.js';
import { levelManager } from '../js/levels/LevelManager.js';
import Bucket from '../js/objects/Bucket.js';
import Spring from '../js/objects/Spring.js';
import Trampoline from '../js/objects/Trampoline.js';
import Gear from '../js/objects/Gear.js';
import Mouse from '../js/objects/Mouse.js';

registerAllObjects();

const ALL_TYPES = objectRegistry.getAll().map(({ type }) => type);

/** Total subscriptions across the singleton bus (leak detector). */
const totalBusListeners = () =>
    [...eventBus._listeners.values()].reduce((n, set) => n + set.size, 0);

describe('Object lifecycle contract (C3 / ADR 0003)', () => {
    const engines = [];
    afterEach(() => {
        for (const engine of engines) engine.dispose();
        engines.length = 0;
    });

    function createEngine(width = 800, height = 600) {
        const engine = new PhysicsEngine(width, height);
        engines.push(engine);
        return engine;
    }

    describe('registry sweep — every type honors the contract', () => {
        it('declares the optional restoreState seam as a no-op on BaseObject', () => {
            expect(typeof BaseObject.prototype.restoreState).toBe('function');
            expect(typeof BaseObject.prototype.onBeforeUpdate).toBe('function');
            const probe = objectRegistry.create('ball', 100, 200);
            expect(probe).toBeInstanceOf(BaseObject);
            expect(() => probe.restoreState({ options: {} })).not.toThrow();
        });

        it('every registered type round-trips serialize → deserialize → serialize', () => {
            for (const type of ALL_TYPES) {
                const original = objectRegistry.create(type, 150, 250);
                const data = original.serialize();
                const rebuilt = objectRegistry.deserialize(data);
                expect(rebuilt, `${type}: deserialize must rebuild a BaseObject`)
                    .toBeInstanceOf(BaseObject);
                expect(rebuilt.type, `${type}: rebuilt type must match`).toBe(type);
                expect(rebuilt.serialize(), `${type}: serialize round-trip must be stable`)
                    .toEqual(data);
            }
        });

        it('every registered type accepts restoreState with its own serialize() record', () => {
            for (const type of ALL_TYPES) {
                const original = objectRegistry.create(type, 150, 250);
                const rebuilt = objectRegistry.deserialize(original.serialize());
                expect(typeof rebuilt.restoreState, `${type}: missing restoreState seam`)
                    .toBe('function');
                expect(() => rebuilt.restoreState(original.serialize()), `${type}: restoreState threw`)
                    .not.toThrow();
            }
        });

        it('attaching and detaching every type leaks no eventBus listeners', () => {
            const engine = createEngine();
            const baseline = totalBusListeners();
            for (const type of ALL_TYPES) {
                const obj = objectRegistry.create(type, 150, 250);
                engine.addObject(obj);
                engine.removeObject(obj);
                expect(totalBusListeners(), `${type}: listener count drifted after attach/detach`)
                    .toBe(baseline);
            }
        });
    });

    describe('restoreState parity — behavioral state on a same-instance physics restore', () => {
        it('Bucket: mid-play catches do not survive a restore; the dedupe key is released', () => {
            const bucket = new Bucket(400, 300);
            expect(bucket.registerCatch({ id: 42, type: 'ball' })).toBe(true);
            expect(bucket.caughtCount).toBe(1);
            // The same instance replaying the attempt must be able to re-catch
            bucket.restoreState({});
            expect(bucket.caughtCount).toBe(0);
            expect(bucket.registerCatch({ id: 42, type: 'ball' })).toBe(true);
        });

        it('Spring: trigger/compression/cooldown restart armed-fresh', () => {
            const spring = new Spring(200, 300);
            spring.armLaunch();
            // Mid-decay values the engine's per-step ticks would have produced
            spring._compression = 0.4;
            spring._cooldown = 17;
            expect(spring._triggered).toBe(true);
            spring.restoreState({});
            expect(spring._triggered).toBe(false);
            expect(spring._compression).toBe(0);
            expect(spring._cooldown).toBe(0);
        });

        it('Trampoline: a mid-decay stretch flattens', () => {
            const trampoline = new Trampoline(200, 300);
            trampoline.stretch();
            expect(trampoline._stretch).toBe(1);
            trampoline.restoreState({});
            expect(trampoline._stretch).toBe(0);
        });

        it('Gear: a meshing reversal does not survive a restore (snapshot-faithful drive)', () => {
            const gear = new Gear(200, 300, { angularSpeed: 0.05 });
            const playStartRecord = gear.serialize(); // snapshots are pre-play
            gear.applyGearDrive(0.02); // gear ✕ gear mesh — reversed to -0.02
            expect(gear._angularSpeed).toBe(-0.02);
            gear.restoreState(playStartRecord);
            expect(gear._angularSpeed).toBe(0.05); // snapshot-time drive

            // A default-drive gear falls back to the deserialize idiom
            const plain = new Gear(500, 300);
            plain.applyGearDrive(0.09);
            plain.restoreState({});
            expect(plain._angularSpeed).toBe(0.03);
        });

        it('the Mouse contract stays pinned: direction re-applies, cooldowns start clean', () => {
            const mouse = new Mouse(400, 300);
            mouse.restoreState({ options: { direction: -1 } });
            expect(mouse._direction).toBe(-1);
            expect(mouse._reversalCooldown).toBe(0);
            expect(mouse._edgeProbeCooldown).toBe(0);
        });

        it('the Scissors contract stays pinned: a mid-play snap reopens per the play-start snapshot', () => {
            const scissors = objectRegistry.create('scissors', 200, 300);
            const playStartRecord = scissors.serialize(); // open
            scissors.snapShut();
            expect(scissors._closed).toBe(true);
            scissors.restoreState(playStartRecord);
            expect(scissors._closed).toBe(false);
        });

        it('the Pulley contract stays pinned: pose caches clear and a resync is flagged', () => {
            const pulley = objectRegistry.create('pulley', 200, 300);
            pulley.restoreState({ options: {} });
            expect(pulley._pendingResync).toBe(true);
        });

        it('engine restoreSnapshot resets behavioral state across matching instances', () => {
            const engine = createEngine();
            const bucket = objectRegistry.create('bucket', 400, 300);
            const spring = objectRegistry.create('spring', 150, 400);
            const gear = objectRegistry.create('gear', 600, 200, { angularSpeed: 0.05 });
            const trampoline = objectRegistry.create('trampoline', 100, 550);
            for (const obj of [bucket, spring, gear, trampoline]) engine.addObject(obj);

            engine.takeSnapshot(); // GameLoop.play does this at play start

            // Mid-play mutations on the SAME instances
            bucket.registerCatch({ id: 7, type: 'ball' });
            spring.armLaunch();
            spring._cooldown = 5;
            gear.applyGearDrive(0.02);
            trampoline.stretch();

            engine.restoreSnapshot(); // GameLoop.reset path: poses + restoreState, no rebuild

            expect(bucket.caughtCount).toBe(0);
            expect(spring._triggered).toBe(false);
            expect(spring._compression).toBe(0);
            expect(spring._cooldown).toBe(0);
            expect(gear._angularSpeed).toBe(0.05);
            expect(trampoline._stretch).toBe(0);
        });

        it('a mid-play removed object is skipped by the seam (body-id identity rule)', () => {
            const engine = createEngine();
            const spring = objectRegistry.create('spring', 150, 400);
            engine.addObject(spring);
            engine.takeSnapshot();
            spring.armLaunch();
            engine.removeObject(spring); // disposed: its body-id set is gone
            expect(() => engine.restoreSnapshot()).not.toThrow();
            // Its state was never touched — the snapshot no longer applies to it
            expect(spring._triggered).toBe(true);
        });
    });

    describe('loadCustom routing — ad-hoc levels go through LevelManager (C3-adjacent)', () => {
        it('installing an editor-imported level sets _currentLevel and emits level:loaded', () => {
            const received = [];
            const unsubscribe = eventBus.on('level:loaded', (data) => received.push(data));
            const custom = {
                name: 'Imported sandbox scene',
                goal: { type: 'ball', zoneId: 'zone-1' },
                fixedObjects: [],
                availableParts: {},
            };
            const returned = levelManager.loadCustom(custom);
            expect(returned).toBe(custom);
            expect(levelManager.getCurrentLevel()).toBe(custom);
            expect(received).toEqual([custom]); // toolbox/goal-checker still observe the load
            unsubscribe();
        });

        it('goal progression ignores a loaded level without an id (no undefined in the set)', () => {
            levelManager.init(); // registers the goal:reached completion listener
            levelManager.loadCustom({ name: 'Anonymous imported scene' });
            eventBus.emit('goal:reached', {});
            expect([...levelManager._completedLevels]).not.toContain(undefined);
        });
    });
});