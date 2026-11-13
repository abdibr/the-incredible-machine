/**
 * Free Rope lifecycle tests (issue #55).
 *
 * A free rope is born as an inert, bodyless coiled bundle. The FIRST tie
 * spawns the hanging chain into the physics world; untying the last knot
 * collapses it back. Since issue #56 the family splits on the LENGTH
 * option: a free rope created WITH a length is an authored span and lays
 * its chain as it enters a world (then re-roots it at its first tie),
 * while a length-less one keeps the coil contract below — so the coil
 * cases here pin the length-less rope and the issue-#56 suite pins the
 * authored one. The suite pins: bundle construction, the spawn/revert
 * event contract, serialize round-trip stability with the derived
 * `spawned` discriminator, snapshot rewinds, the board-load chain, sandbox
 * reset, and the recorder topic tables.
 */
import { describe, it, expect, afterEach } from 'vitest';
import Matter from 'matter-js';
import { PhysicsEngine } from '../js/engine/PhysicsEngine.js';
import { objectRegistry } from '../js/objects/ObjectRegistry.js';
import { registerAllObjects } from '../js/objects/registerAllObjects.js';
import Balloon from '../js/objects/Balloon.js';
import Bucket from '../js/objects/Bucket.js';
import Rope from '../js/objects/Rope.js';
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
        // Length-less free rope: issue #56 splits the family by the LENGTH
        // option — an authored span lays its chain as it enters the world
        // (`birthAuthoredChain`, covered in the issue-#56 suite below),
        // while a length-less rope keeps issue #55's inert coil and births
        // its chain at the first tie. This is the coil contract, so it is
        // the length-less rope that pins it.
        const rope = objectRegistry.create('free-rope', 220, 200);
        engine.addObject(balloon);
        engine.addObject(rope);
        expect(rope.bodies).toEqual([]);

        const spawned = trackEvent('rope:chain-spawned');
        rope.attachEndpoint(-1, balloon, 'knot');

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
        rope.attachEndpoint(-1, balloon, 'knot');
        const bodyCount = rope.bodies.length;
        const constraintCount = rope.constraints.length;
        expect(bodyCount).toBeGreaterThan(0);

        const unbundled = trackEvent('rope:unbundled');
        expect(rope.detachEndpoint(-1, balloon, 'knot')).toBe(true);

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
        rope.attachEndpoint(-1, balloon, 'knot');
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
        rope.attachEndpoint(-1, balloon, 'knot');
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
        // Length-less (issue #56): the rewind-to-pre-tie collapse is the
        // COIL contract — the chain that must vanish is the one a tie
        // birthed. An authored free rope has its chain from addObject on,
        // so its play-start snapshot records spawned:true and there is
        // nothing for the rewind to collapse.
        const rope = objectRegistry.create('free-rope', 300, 200);
        engine.addObject(balloon);
        engine.addObject(rope);
        engine.takeSnapshot(); // board at play start: the rope is a bundle

        rope.attachEndpoint(-1, balloon, 'knot');
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
        rope.attachEndpoint(-1, balloon, 'knot'); // a spawn-era chain…
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

describe('Free Rope (issue #55/#56) — board-load chain', () => {
    it('deserialize → addObject lays the authored chain; the bind pass re-roots it at the knot', () => {
        const balloon = new Balloon(260, 240);
        const rope = objectRegistry.create('free-rope', 260, 300, { length: 80 });
        rope.attachEndpoint(-1, balloon, 'knot');
        // Board order is what the ordinals index: balloon first, rope second.
        const rows = serializePlacedBoard([balloon, rope]);
        expect(rows[1].type).toBe('free-rope');
        expect(rows[1].attachments).toEqual([
            { segment: -1, targetType: 'balloon', targetOrdinal: 0, pointId: 'knot' },
        ]);

        // The fresh-engine board load: deserialize (a coil until a world
        // takes it) → addObject (the row's authored span lays the chain,
        // issue #56) → the bind pass realizes the pending knot and RE-ROOTS
        // that chain at the balloon's knot. One birth, no re-spawn: the
        // chain belongs to addObject now, so nothing rides
        // `rope:chain-spawned` (which is the tie-born path's world-add seam).
        const engine = makeEngine();
        const spawned = trackEvent('rope:chain-spawned');
        // Mirror the production board load (resetSandboxBoard): every placed
        // object joins the engine BEFORE the bind pass — the per-step
        // reconcile only respects knots whose target object is registered
        // in the engine; an unregistered target gets pruned on the first
        // step and the chain collapses.
        const balloonRow = objectRegistry.deserialize(rows[0]);
        const rebuilt = objectRegistry.deserialize(rows[1]);
        expect(rebuilt.bodies, 'a deserialized rope is a coil until a world takes it').toEqual([]);
        engine.addObject(balloonRow);
        engine.addObject(rebuilt);
        expect(rebuilt.bodies.length, 'the authored span laid its chain at addObject').toBeGreaterThan(0);
        rebuilt.bindAttachment([balloonRow, rebuilt]);

        expect(spawned.length, 'the birth was addObject\'s; the bind only re-roots').toBe(0);
        expect(rebuilt.bodies.length).toBeGreaterThan(0);
        // The re-rooted chain hangs from the balloon's knot, not from the
        // rope's stored drop point.
        const knot = balloonRow.getAttachmentWorldPoint('knot');
        expect(rebuilt.bodies[0].position.x).toBeCloseTo(knot.x, 5);
        expect(rebuilt.bodies[0].position.y).toBeCloseTo(knot.y, 5);
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
        rope.attachEndpoint(-1, balloon, 'knot');

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
        rope.attachEndpoint(-1, balloon, 'knot');
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

describe('Free Rope (issue #56) — unlimited span', () => {
    it('ties far: a distant first tie spawns straight to the click — no reach circle anywhere', () => {
        const engine = makeEngine();
        const balloon = new Balloon(600, 200);
        const rope = objectRegistry.create('free-rope', 260, 300, { length: 60 });
        engine.addObject(balloon);
        engine.addObject(rope);

        // ~384px from the spawn point: the free family answers true for any
        // distance — issue #56 takes the reach-freeze/refusal bookkeeping
        // off free ropes entirely (only pinned ropes refuse beyond reach).
        expect(rope.isPointWithinReach(600, 200, 14), 'no reach circle exists to refuse').toBe(true);
        rope.attachEndpoint(-1, balloon, 'knot');

        expect(ropeSegs(rope), 'the spawn always births the fresh-drop count').toHaveLength(6);
        expect(ropeSegs(rope)).toHaveLength(Rope.segmentsForSpan(60)); // count-honest spawn
        expect(rope.isFreeBundle).toBe(false);
        // The chain hangs from exactly the knot point that was clicked.
        const knotPoint = balloon.getAttachmentWorldPoint('knot');
        expect(rope.bodies[0].position.x).toBeCloseTo(knotPoint.x, 5);
        expect(rope.bodies[0].position.y).toBeCloseTo(knotPoint.y, 5);
    });

    it('stays tie-able anywhere after the first tie: a spawned rope re-ties far and re-spans', () => {
        const engine = makeEngine();
        const balloon = new Balloon(260, 240);
        const bucket = new Bucket(420, 200);
        const rope = objectRegistry.create('free-rope', 260, 300, { length: 60 });
        engine.addObject(balloon);
        engine.addObject(bucket);
        engine.addObject(rope);

        rope.attachEndpoint(-1, balloon, 'knot'); // spawns 6 segments
        const rim = bucket.getAttachmentWorldPoint('rim');
        const knot = balloon.getAttachmentWorldPoint('knot');
        // ~165px tie at mid-chain seat 2: in-schema (count-capped range),
        // past the bundle, and the reach predicate answers yes — the tie's
        // covering grow re-lays the chain so its rest lengths span the
        // demanded distance (the free rope's unlimited span, decision 4).
        expect(rope.isPointWithinReach(rim.x, rim.y, 14), 'a spawn stays unlimited after the first tie').toBe(true);
        rope.attachEndpoint(2, bucket, 'rim');

        const tied = Math.hypot(rim.x - knot.x, rim.y - knot.y);
        // Seat 2 sits (2+0.5)/6 of the span from the anchor, so the span
        // grows to demanded / (2.5/6) and the count re-derives from it.
        expect(rope._length).toBeCloseTo(tied * 6 / 2.5, 5);
        const count = ropeSegs(rope).length;
        expect(count).toBe(Rope.segmentsForSpan(rope._length));
        expect(count).toBeGreaterThan(6);
        // The tie was the MID seat: the knot keeps its seat, so the
        // re-count re-seats it onto the re-counted chain's own middle
        // (issue #87 — the literal seat-2 body survives but is mid no more).
        engine.step(DT);
        const link = engine.getAttachedConstraints().find(
            (c) => c.bodyB === bucket.bodies[2]
        );
        expect(link, 'the mid-seat knot survives the re-segmentation').toBeTruthy();
        const [, midSeat] = rope.getTieSeats(); // the re-counted chain's middle
        expect(midSeat.segment).toBeGreaterThan(2); // the middle drew outboard of seat 2
        expect(link.bodyA).toBe(rope.bodies[midSeat.segment + 1]);
        expect(link.bodyA).toBe(midSeat.body); // the knot is ON the mid square
    });

    it('the hand re-lays a tied spawned rope to any span — no length freeze after the first tie', () => {
        const engine = makeEngine();
        const balloon = new Balloon(260, 240);
        const rope = objectRegistry.create('free-rope', 260, 300, { length: 60 });
        engine.addObject(balloon);
        engine.addObject(rope);
        rope.attachEndpoint(-1, balloon, 'knot'); // first tie (a pinned rope: this freezes)

        // A pinned rope re-lays tied along its frozen reach circle; a free
        // rope takes the demanded span straight away (relayFreeEnd's
        // free-family branch skips the frozen clamp).
        const anchor = rope.bodies[0].position; // parked on the knot point
        const before = ropeSegs(rope).length; // 6 at the spawn
        const dx = 220;
        const dy = -160;
        const demanded = Math.hypot(dx, dy); // ≈272px
        rope.relayFreeEnd(anchor.x + dx, anchor.y + dy);
        // One re-lay lays the span that backs the tail square to the
        // demand at the CURRENT count — demanded·c/(c−0.5) ≈ 296.7px —
        // and setEndpoints re-derives the count from that grown span.
        expect(rope._length).toBeCloseTo(demanded * before / (before - 0.5), 5);
        expect(ropeSegs(rope)).toHaveLength(Rope.segmentsForSpan(rope._length));
        // The anchor knot stays parked; the tail rides the demand within
        // the half-segment gap the under-span pays for.
        expect(anchor.x).toBeCloseTo(260, 5);
        const tail = rope.bodies[rope.bodies.length - 1].position;
        expect(Math.hypot(tail.x - (anchor.x + dx), tail.y - (anchor.y + dy))).toBeLessThan(30);
    });
});

describe('Free Rope (issue #56) — the authored span lays at addObject', () => {
    it('an authored free rope births count-honest at addObject; a length-less one stays a coil', () => {
        const engine = makeEngine();
        const authored = objectRegistry.create('free-rope', 260, 300, { length: 300 });
        const bundled = objectRegistry.create('free-rope', 260, 300);
        // The length option is the discriminator, and only an EXPLICIT one
        // counts (the ctor's `|| 100` default makes the number itself
        // useless as a test).
        expect(authored.hasExplicitSpan, 'a supplied length is authored').toBe(true);
        expect(bundled.hasExplicitSpan, 'the coil default is not').toBe(false);
        expect(authored.isFreeBundle).toBe(true); // a coil until it enters a world

        const spawned = trackEvent('rope:chain-spawned');
        engine.addObject(authored);
        engine.addObject(bundled);

        // Count-honest birth (300px → 8), straight along the rope's own
        // drop, in the world from the same pass — and no spawn event: the
        // engine's addObject is the world-add, so nothing has to be
        // reconciled afterwards.
        expect(ropeSegs(authored)).toHaveLength(Rope.segmentsForSpan(300));
        expect(ropeSegs(authored)).toHaveLength(8);
        expect(authored.isFreeBundle).toBe(false);
        expect(spawned, 'the birth belongs to addObject, not to an event').toHaveLength(0);
        const world = new Set(Matter.Composite.allBodies(engine.world).map((b) => b.id));
        for (const body of authored.bodies) {
            expect(world.has(body.id), 'the whole chain joins the world with its rope').toBe(true);
        }
        for (const constraint of authored.constraints) {
            expect(
                Matter.Composite.allConstraints(engine.world).some((c) => c.id === constraint.id),
                'the chain constraints join too',
            ).toBe(true);
        }
        // The free family's anchor is a mobile knot, never a nail.
        expect(authored.bodies[0].isStatic).toBe(false);

        // A length-less free rope is issue #55's inert coil until a tie.
        expect(bundled.bodies).toEqual([]);
        expect(bundled.constraints).toEqual([]);
        expect(bundled.isFreeBundle).toBe(true);
    });

    it('a pre-#56 bundle row restores as the coil it was; a chain row still lays', () => {
        const engine = makeEngine();
        // A row written before #56 carries no `segments` key at all, and
        // `serialize` has always written `length` — so the number cannot
        // say whether the span was authored. `spawned` can: it is
        // FreeRope's own derived discriminator (issue #55), and a restore
        // must not contradict it (a coil is not a chain).
        const legacyCoil = objectRegistry.deserialize({
            type: 'free-rope', x: 240, y: 220,
            options: { length: 100, spawned: false },
        });
        engine.addObject(legacyCoil);
        expect(legacyCoil.bodies, 'the pre-#56 bundle row stays a bundle').toEqual([]);
        expect(legacyCoil.constraints).toEqual([]);
        expect(legacyCoil.isFreeBundle).toBe(true);
        // …and its first tie still births the chain the normal way.
        const balloon = new Balloon(240, 260);
        engine.addObject(balloon);
        legacyCoil.attachEndpoint(-1, balloon, 'knot');
        expect(ropeSegs(legacyCoil).length).toBeGreaterThan(0);

        // The other half of the contract: a row that WAS a chain lays one
        // at addObject. It saved no count, so the span derives it.
        const legacyChain = objectRegistry.deserialize({
            type: 'free-rope', x: 500, y: 220,
            options: { length: 200, spawned: true },
        });
        engine.addObject(legacyChain);
        expect(ropeSegs(legacyChain)).toHaveLength(Rope.segmentsForSpan(200));

        for (const obj of [legacyCoil, legacyChain, balloon]) obj.dispose();
    });

    it('its first anchor tie re-roots the pre-laid chain at the clicked knot', () => {
        const engine = makeEngine();
        const balloon = new Balloon(600, 200);
        const rope = objectRegistry.create('free-rope', 260, 300, { length: 60 });
        engine.addObject(balloon);
        engine.addObject(rope);
        expect(ropeSegs(rope)).toHaveLength(6);
        const firstSeat = rope.bodies[1]; // the chain is born on the rope's own drop

        const converge = trackEvent('rope:chain-converge');
        const spawned = trackEvent('rope:chain-spawned');
        rope.attachEndpoint(-1, balloon, 'knot');

        // A re-root, not a second birth: no spawn event, one converge packet
        // (the engine swaps the rebuilt chain in), no tail trade.
        expect(spawned).toHaveLength(0);
        expect(converge).toHaveLength(1);
        expect(converge[0].rope).toBe(rope);
        expect(converge[0].added).toEqual([]);
        expect(converge[0].dropped).toEqual([]);
        // Same bodies and the same span: the chain moved, it did not re-count.
        expect(rope.bodies[1]).toBe(firstSeat);
        expect(ropeSegs(rope)).toHaveLength(6);
        expect(rope._length).toBeCloseTo(60, 5);
        // …and it hangs from exactly the knot that was clicked.
        const knot = balloon.getAttachmentWorldPoint('knot');
        expect(rope.bodies[0].position.x).toBeCloseTo(knot.x, 5);
        expect(rope.bodies[0].position.y).toBeCloseTo(knot.y, 5);
        const constraints = new Set(Matter.Composite.allConstraints(engine.world).map((c) => c.id));
        for (const constraint of rope.constraints) {
            expect(constraints.has(constraint.id), 'the re-rooted chain is the one in the world').toBe(true);
        }
    });
});