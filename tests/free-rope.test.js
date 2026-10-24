/**
 * Free Rope lifecycle tests (issue #55).
 *
 * A free rope is born as an inert, bodyless coiled bundle. The FIRST tie
 * spawns the hanging chain into the physics world; untying the last knot
 * collapses it back. The suite pins: bundle construction, the
 * spawn/revert event contract, serialize round-trip stability with the
 * derived `spawned` discriminator, snapshot rewinds, the board-load
 * re-spawn path (deserialize → bind → spawn), sandbox reset, and the
 * recorder topic tables.
 */
import { describe, it, expect, afterEach } from 'vitest';
import Matter from 'matter-js';
import { PhysicsEngine } from '../js/engine/PhysicsEngine.js';
import { objectRegistry } from '../js/objects/ObjectRegistry.js';
import { registerAllObjects } from '../js/objects/registerAllObjects.js';
import Balloon from '../js/objects/Balloon.js';
import { eventBus } from '../js/EventBus.js';
import { PLAY_TOPICS, REPLAYABLE_TOPICS } from '../js/recorder/schema.js';
import { serializePlacedBoard, resetSandboxBoard } from '../js/reset/levelReset.js';

registerAllObjects();

const DT = 1000 / 60;
const engines = [];
const unsubscribers = [];

afterEach(() => {
    for (const off of unsubscribers.splice(0)) off();
    for (const engine of engines) engine.dispose();
    engines.length = 0;
});

function makeEngine(width = 800, height = 600) {
    const engine = new PhysicsEngine(width, height);
    engines.push(engine);
    return engine;
}

/** Subscribe to a module-singleton bus event for one test only. */
function trackEvent(name) {
    const events = [];
    unsubscribers.push(eventBus.on(name, (payload) => events.push(payload ?? null)));
    return events;
}

const ropeSegs = (rope) => rope.bodies.filter((b) => b.label?.startsWith('rope-seg'));

describe('Free Rope (issue #55) — the bodyless bundle', () => {
    it('constructs inert: zero bodies, zero constraints, never pre-severed', () => {
        const rope = objectRegistry.create('free-rope', 220, 200, { length: 60 });
        expect(rope.type).toBe('free-rope');
        expect(rope.bodies).toEqual([]);
        expect(rope.constraints).toEqual([]);
        expect(rope.isSevered).toBe(false);
    });

    it('a bundle ignores sever() — the coil has nothing to burn through', () => {
        const rope = objectRegistry.create('free-rope', 220, 200, { length: 60 });
        rope.sever();
        expect(rope.isSevered).toBe(false);
    });

    it('the first tie births the chain: it hangs straight down from the tie point', () => {
        const engine = makeEngine();
        const balloon = new Balloon(220, 140);
        const rope = objectRegistry.create('free-rope', 220, 200, { length: 60 });
        engine.addObject(balloon);
        engine.addObject(rope);
        expect(rope.bodies).toEqual([]);

        const spawned = trackEvent('rope:chain-spawned');
        rope.attachEndpoint(0, balloon, 'knot');

        expect(spawned.length, 'exactly one spawn per first tie').toBe(1);
        expect(spawned[0].rope).toBe(rope);
        expect(rope.bodies.length).toBeGreaterThan(0);
        expect(rope.constraints.length).toBeGreaterThan(0);

        // The newborn chain hangs from the tie point, vertical: every
        // segment sits at the anchor's x, ordered top-to-bottom.
        const anchor = rope.bodies.find((b) => b.label === 'rope-anchor');
        expect(anchor).toBeTruthy();
        const segs = ropeSegs(rope);
        expect(segs.length).toBeGreaterThan(0);
        for (const seg of segs) {
            expect(Math.abs(seg.position.x - anchor.position.x), 'chain must hang straight down').toBeLessThan(1);
        }
        for (let i = 1; i < segs.length; i++) {
            expect(segs[i].position.y).toBeGreaterThan(segs[i - 1].position.y);
        }
    });

    it('untying the last knot collapses the chain with the full dying packet', () => {
        const engine = makeEngine();
        const balloon = new Balloon(220, 140);
        const rope = objectRegistry.create('free-rope', 220, 200, { length: 60 });
        engine.addObject(balloon);
        engine.addObject(rope);
        rope.attachEndpoint(0, balloon, 'knot');
        const bodyCount = rope.bodies.length;
        const constraintCount = rope.constraints.length;
        expect(bodyCount).toBeGreaterThan(0);

        const unbundled = trackEvent('rope:unbundled');
        expect(rope.detachEndpoint(0, balloon, 'knot')).toBe(true);

        expect(unbundled.length, 'the engine consumer un-bundles the world').toBe(1);
        expect(unbundled[0].rope).toBe(rope);
        expect(unbundled[0].previous.length).toBe(constraintCount);
        expect(unbundled[0].bodies.length).toBe(bodyCount);
        expect(rope.bodies).toEqual([]);
        expect(rope.constraints).toEqual([]);
        expect(rope.isSevered, 'collapsing is not severing').toBe(false);
    });

    it('a wholesale clearAttachments untie also collapses back to the bundle', () => {
        const engine = makeEngine();
        const balloon = new Balloon(220, 140);
        const rope = objectRegistry.create('free-rope', 220, 200, { length: 60 });
        engine.addObject(balloon);
        engine.addObject(rope);
        rope.attachEndpoint(0, balloon, 'knot');
        expect(rope.bodies.length).toBeGreaterThan(0);

        const unbundled = trackEvent('rope:unbundled');
        rope.clearAttachments();
        expect(unbundled.length).toBe(1);
        expect(rope.bodies).toEqual([]);
        expect(rope.constraints).toEqual([]);
    });
});

describe('Free Rope (issue #55) — serialize round-trip', () => {
    it('a bundle round-trips with the derived spawned:false discriminator', () => {
        const rope = objectRegistry.create('free-rope', 150, 250, { length: 60 });
        const data = rope.serialize();
        expect(data.options.spawned).toBe(false);

        const rebuilt = objectRegistry.deserialize(data);
        expect(rebuilt.type).toBe('free-rope');
        expect(rebuilt).not.toBe(rope);
        expect(rebuilt.serialize()).toEqual(data);
        expect(rebuilt.bodies).toEqual([]);
    });

    it('a spawned chain serializes spawned:true; deserialize always rebuilds the bundle', () => {
        const balloon = new Balloon(260, 240);
        const rope = objectRegistry.create('free-rope', 260, 300, { length: 60 });
        rope.attachEndpoint(0, balloon, 'knot');
        const data = rope.serialize();
        expect(data.options.spawned, 'spawned is derived from live segments').toBe(true);

        // The discriminator is never stored: deserialize returns the bundle
        // and the chain is reborn through the bind pass over the tokens.
        const rebuilt = objectRegistry.deserialize(data);
        expect(rebuilt.bodies).toEqual([]);
        expect(rebuilt.serialize().options.spawned).toBe(false);
        expect(rebuilt.serialize(), 'bundle state round-trips stably').toEqual(
            objectRegistry.deserialize(data).serialize(),
        );
    });
});

describe('Free Rope (issue #55) — snapshot rewinds', () => {
    it('rewinding to a pre-tie snapshot collapses the spawned chain (spawned:false record)', () => {
        const engine = makeEngine();
        const balloon = new Balloon(300, 120);
        const rope = objectRegistry.create('free-rope', 300, 200, { length: 80 });
        engine.addObject(balloon);
        engine.addObject(rope);
        engine.takeSnapshot(); // board at play start: the rope is a bundle

        rope.attachEndpoint(0, balloon, 'knot');
        expect(rope.bodies.length).toBeGreaterThan(0);
        for (let i = 0; i < 60; i += 1) engine.step(DT); // the chain lives in the world
        expect(rope.bodies.length).toBeGreaterThan(0);

        const unbundled = trackEvent('rope:unbundled');
        engine.restoreSnapshot();

        expect(unbundled.length, 'the rewind collapse must un-bundle the world').toBe(1);
        expect(rope.bodies).toEqual([]);
        expect(rope.constraints).toEqual([]);
        expect(rope.isSevered).toBe(false);
    });

    it('a spawned-era record restored onto a collapsed rope stays a bundle (intentional one-way)', () => {
        // The snapshot catches the rope as a spawned chain; by restore time
        // the chain has collapsed back to a bundle (its bodies are gone).
        // The surviving bundle is NOT resurrected by the stale spawned-era
        // record — the same philosophy as severed ropes keeping their
        // severed flag.
        const engine = makeEngine();
        const balloon = new Balloon(300, 120);
        const rope = objectRegistry.create('free-rope', 300, 200, { length: 80 });
        engine.addObject(balloon);
        engine.addObject(rope);
        rope.attachEndpoint(0, balloon, 'knot'); // a spawn-era chain…
        for (let i = 0; i < 10; i += 1) engine.step(DT);
        engine.takeSnapshot(); // …caught alive by the snapshot…
        rope.clearAttachments(); // …has already collapsed (its world is gone)
        expect(rope.bodies).toEqual([]);

        const unbundled = trackEvent('rope:unbundled');
        engine.restoreSnapshot();
        expect(unbundled.length, 'no collapse event for a rope already at bundle').toBe(0);
        expect(rope.bodies, 'resurrection is skipped by design').toEqual([]);
        expect(rope.constraints).toEqual([]);
    });
});

describe('Free Rope (issue #55) — board-load re-spawn', () => {
    it('deserialize → bind re-spawns the chain into a fresh physics world', () => {
        const balloon = new Balloon(260, 240);
        const rope = objectRegistry.create('free-rope', 260, 300, { length: 80 });
        rope.attachEndpoint(0, balloon, 'knot');
        // Board order is what the ordinals index: balloon first, rope second.
        const rows = serializePlacedBoard([balloon, rope]);
        expect(rows[1].type).toBe('free-rope');
        expect(rows[1].attachments).toEqual([
            { endpoint: 0, targetType: 'balloon', targetOrdinal: 0, pointId: 'knot' },
        ]);

        // The fresh-engine board load: deserialize (bundle) → addObject →
        // the bind pass realizes the pending knot, the first tie re-fires
        // the spawn, and the engine's registration guard accepts the chain.
        const engine = makeEngine();
        const spawned = trackEvent('rope:chain-spawned');
        // Mirror the production board load (resetSandboxBoard): every placed
        // object joins the engine BEFORE the bind pass — the per-step
        // reconcile only respects knots whose target object is registered
        // in the engine; an unregistered target gets pruned on the first
        // step and the fresh chain collapses.
        const balloonRow = objectRegistry.deserialize(rows[0]);
        const rebuilt = objectRegistry.deserialize(rows[1]);
        expect(rebuilt.bodies).toEqual([]);
        engine.addObject(balloonRow);
        engine.addObject(rebuilt);
        rebuilt.bindAttachment([balloonRow, rebuilt]);

        expect(spawned.length).toBe(1);
        expect(rebuilt.bodies.length).toBeGreaterThan(0);
        // A perfectly vertical hanging chain is in gravitational equilibrium
        // (and enableSleeping freezes it), so instead of a passive motion
        // probe, perturb the tail and prove only an in-world constraint
        // solver can pull it back off the perturbed point.
        const { Body } = Matter;
        const segs = ropeSegs(rebuilt);
        const tail = segs[segs.length - 1];
        const perturbed = { x: tail.position.x + 40, y: tail.position.y };
        engine.wakeBodies(rebuilt.bodies);
        Body.setPosition(tail, perturbed);
        for (let i = 0; i < 20; i += 1) engine.step(DT);
        expect(rebuilt.bodies.length, 'the chain survives simulation').toBeGreaterThan(0);
        expect(
            Math.hypot(tail.position.x - perturbed.x, tail.position.y - perturbed.y),
            'the re-spawned chain hangs live in the world (constraints + gravity act)',
        ).toBeGreaterThan(10);
    });

    it('the knot travels with its tied target — no fixed anchor (ADR 0007 decision 5)', () => {
        // Regression for the tied-free-rope bug: the spawned chain froze its
        // endpoint-0 body as a static nail at the tie point, pinning the
        // first balloon 25.6px out from a fixed center (bugfile
        // bug-20261024T134016Z-96df). The anchor is a dynamic knot hauled by
        // the realized endpoint-0 knot link instead.
        const engine = makeEngine();
        const balloon = new Balloon(220, 140);
        const rope = objectRegistry.create('free-rope', 220, 200, { length: 60 });
        engine.addObject(balloon);
        engine.addObject(rope);
        rope.attachEndpoint(0, balloon, 'knot');

        const anchor = rope.bodies.find((b) => b.label === 'rope-anchor');
        expect(anchor.isStatic, "the free rope's anchor is a dynamic knot").toBe(false);
        const spawnAt = { x: anchor.position.x, y: anchor.position.y };

        // Statics measured against a released-from-rest tie (probe:
        // .scratch/probe-knot-follow.mjs, mirrors this setup): the spawned
        // chain — 6 segments of r=3 at density 0.001 plus the r=4 anchor,
        // ≈0.206 mass — outweighs the balloon's net lift (buoyancy
        // 0.0015·m up vs own gravity 0.001·m down ⇒ ≈0.00015 net force
        // units), so the tied assembly DRIFTS DOWN at a ~1px/tick terminal
        // velocity (17–22px at t=40; a lone balloon rises instead — ~122px
        // over 40 ticks — its own ceiling-rest behavior unchanged). What
        // ADR 0007 decision 5 pins is the HAUL, not the direction: a static
        // nail holds its spawn point forever in either direction, while the
        // hauled knot rides the realized link. Over the longer horizon the
        // hauled drift is unambiguous (measured ≈207px at 240 ticks, stable
        // run to run) and the ride gap still holds under a few px.
        engine.wakeBodies(rope.bodies);
        for (let i = 0; i < 240; i += 1) engine.step(DT);

        expect(
            Math.hypot(anchor.position.x - spawnAt.x, anchor.position.y - spawnAt.y),
            'the knot leaves its spawn point instead of pinning the tie',
        ).toBeGreaterThan(100);
        expect(
            Math.hypot(anchor.position.x - balloon.getAttachmentWorldPoint('knot').x,
                anchor.position.y - balloon.getAttachmentWorldPoint('knot').y),
            'the knot rides the realized knot link',
        ).toBeLessThan(6);
    });
});

describe('Free Rope (issue #55) — sandbox reset', () => {
    it('reset resurrects a tied free rope from the placed snapshot', () => {
        const balloon = new Balloon(260, 240);
        const rope = objectRegistry.create('free-rope', 260, 300, { length: 60 });
        rope.attachEndpoint(0, balloon, 'knot');
        const rows = serializePlacedBoard([balloon, rope]);

        const engine = makeEngine();
        const restored = resetSandboxBoard(engine, [], rows);
        expect(restored.map((o) => o.type)).toEqual(['balloon', 'free-rope']);
        const rope2 = restored[1];
        expect(rope2.bodies.length, 'the bind pass re-spawns the chain').toBeGreaterThan(0);
        expect(rope2.constraints.length).toBeGreaterThan(0);
    });

    it('reset rolls an untied board back to the inert bundle', () => {
        const balloon = new Balloon(260, 240);
        const rope = objectRegistry.create('free-rope', 260, 300, { length: 60 });
        const rows = serializePlacedBoard([balloon, rope]);
        expect(rows[1].attachments, 'a bundle carries no knots to serialize').toBeUndefined();

        const engine = makeEngine();
        const restored = resetSandboxBoard(engine, [], rows);
        const rope2 = restored[1];
        expect(rope2.type).toBe('free-rope');
        expect(rope2.bodies).toEqual([]);
        expect(rope2.constraints).toEqual([]);
    });
});

describe('Free Rope (issue #55) — recorder topic tables', () => {
    it('chain-spawned is recorded but not replayable; unbundled is both', () => {
        expect(PLAY_TOPICS).toContain('rope:chain-spawned');
        expect(PLAY_TOPICS).toContain('rope:unbundled');
        expect(REPLAYABLE_TOPICS, 'a spawn rides the deserialize/bind path, not replay')
            .not.toContain('rope:chain-spawned');
        expect(REPLAYABLE_TOPICS).toContain('rope:unbundled');
    });
});