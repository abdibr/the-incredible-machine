/**
 * Rope-family conformance alarm (C1, issue #75, ADR 0007 decision 1).
 *
 * The family fact lives once on the rope module (Rope.ROPE_FAMILY_TYPES).
 * This alarm walks the object registry, creates every registered type and
 * partitions by Rope inheritance, then asserts the exact two-way
 * equivalence with the exported list — so a future `extends Rope` part
 * registered without joining the family fails loudly instead of silently
 * falling out of narration, cutting, tying, or anchor refusal.
 *
 * Predicates must express the same fact string-keyed (no class or registry
 * help): they are what the gate sites actually call.
 *
 * Issue #83 adds the family's whole-roster QUERY seam: Rope.queryRopeFamily
 * (engine, opts). The two consumers that need the roster - the scissors
 * blade-fan cut scan (js/objects/Scissors.js) and the observe state scan
 * (agent/observe/state.js) - ask it instead of fanning queryObjectsByType
 * over type keys, so a roster append flows into both with no consumer edit.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import Rope, { ROPE_FAMILY_TYPES, isRopeFamily, isRopeFamilyType, queryRopeFamily } from '../js/objects/Rope.js';
import Scissors from '../js/objects/Scissors.js';
import Ball from '../js/objects/Ball.js';
import { objectId, stateRows } from '../agent/observe/state.js';
import { PhysicsEngine } from '../js/engine/PhysicsEngine.js';
import { objectRegistry } from '../js/objects/ObjectRegistry.js';
import { registerAllObjects } from '../js/objects/registerAllObjects.js';

registerAllObjects();

describe('rope family conformance (C1, issue #75)', () => {
    it('the family list is exactly the registry types that derive from Rope', () => {
        const ropeDerived = [];
        const notRopeDerived = [];
        for (const { type } of objectRegistry.getAll()) {
            const instance = objectRegistry.create(type, 300, 300);
            (instance instanceof Rope ? ropeDerived : notRopeDerived).push(type);
        }
        expect([...ROPE_FAMILY_TYPES].sort()).toEqual([...ropeDerived].sort());
        expect(notRopeDerived).not.toContain('rope');
        expect(notRopeDerived).not.toContain('free-rope');
    });

    it('the predicates express the same fact string-keyed, no registry help', () => {
        for (const type of ROPE_FAMILY_TYPES) {
            expect(isRopeFamilyType(type)).toBe(true);
            expect(isRopeFamily(objectRegistry.create(type, 300, 300))).toBe(true);
        }
        expect(isRopeFamilyType(null)).toBe(false);
        expect(isRopeFamilyType(undefined)).toBe(false);
        expect(isRopeFamilyType('')).toBe(false);
        expect(isRopeFamilyType('candle')).toBe(false);
        expect(isRopeFamily(null)).toBe(false);
        expect(isRopeFamily({ type: 'free-rope' })).toBe(true);
        expect(isRopeFamily(objectRegistry.create('candle', 300, 300))).toBe(false);
    });
});

describe('rope-family query seam (issue #83) - collapse the two-query rope/free-rope fan', () => {
    const engines = [];

    afterEach(() => {
        for (const engine of engines) engine.dispose();
        engines.length = 0;
    });

    function makeEngine(width = 800, height = 600) {
        const engine = new PhysicsEngine(width, height);
        engines.push(engine);
        return engine;
    }

    it('the family query returns exactly the union over ROPE_FAMILY_TYPES - the expectation is derived from the roster, never a hardcoded pair', () => {
        // Issue #83: the roster (ROPE_FAMILY_TYPES, ADR 0007 decision 1) is
        // the single membership fact and queryRopeFamily must DERIVE its
        // answer from it. The expectation below iterates the exported
        // roster instead of spelling ['rope', 'free-rope']: when a third
        // family member joins - the C1 conformance alarm above holds the
        // roster to the registry's rope-derived types, so that append is
        // loud - this expectation covers it with no edit, and a helper
        // that hardcodes the pair instead of reading the roster can never
        // sneak the family back down to two members.
        const engine = makeEngine();
        const ropeA = new Rope(300, 300, { length: 60 });
        const ropeB = new Rope(500, 300, { length: 60 });
        const candle = objectRegistry.create('candle', 700, 300); // a non-member, registered between the two ropes
        const freeBundle = objectRegistry.create('free-rope', 400, 400); // length-less: the inert coil is still a family member
        engine.addObject(ropeA);
        engine.addObject(candle);
        engine.addObject(ropeB);
        engine.addObject(freeBundle);

        const family = queryRopeFamily(engine);
        // The roster-derived expectation: the helper's own single source.
        const expected = [];
        for (const type of ROPE_FAMILY_TYPES) {
            expected.push(...engine.queryObjectsByType(type));
        }
        expect(family).toEqual(expected);
        // Concrete shape: members grouped per roster type, discovery order
        // within each - ropeA and ropeB stay roped together across the
        // candle interleaved between their registrations, and the non-member
        // lands in nobody's bucket.
        expect(family).toHaveLength(3);
        expect(family[0]).toBe(ropeA);
        expect(family[1]).toBe(ropeB);
        expect(family[2]).toBe(freeBundle);
        expect(family).not.toContain(candle);
    });

    it('opts ride through to every member query like queryObjectsByType - excludeOwner excludes from the family answer', () => {
        // The same options queryObjectsByType takes (spec decision 8): the
        // helper forwards `opts` per member query, so excludeOwner keeps an
        // object from fetching itself out of the whole-roster answer - no
        // family member may bypass the member queries' shared contract.
        const engine = makeEngine();
        const ropeA = new Rope(300, 300, { length: 60 });
        const ropeB = new Rope(500, 300, { length: 60 });
        const bundle = objectRegistry.create('free-rope', 400, 400);
        engine.addObject(ropeA);
        engine.addObject(ropeB);
        engine.addObject(bundle);

        const family = queryRopeFamily(engine, { excludeOwner: ropeB });
        expect(family).toHaveLength(2);
        expect(family[0]).toBe(ropeA);
        expect(family[1]).toBe(bundle);
        expect(family).not.toContain(ropeB);
    });

    it('the scissors blade-fan cut scan cuts a free-rope through the family query', () => {
        // Spec test 7: the scan is a whole-roster query now - the spawned
        // free chain (issue #55) rides the same seam the pinned rope does.
        // Geometry mirrors the pinned cut: the knot hangs at chain top, the
        // open fan overlays the chain's upper segments, a tennis ball drops
        // onto the handle to snap the blades shut.
        const engine = makeEngine();
        const balloon = objectRegistry.create('balloon', 425, 60 - 25.6, { isFixed: true }); // knot ≈ (425, 60)
        const freeRope = objectRegistry.create('free-rope', 425, 60, { length: 80 }); // authored span: the chain lays at addObject
        const scissors = new Scissors(400, 85);
        const ball = new Ball(379, 58, { variant: 'tennis' });
        engine.addObject(balloon);
        engine.addObject(freeRope);
        engine.addObject(scissors);
        engine.addObject(ball);
        freeRope.attachEndpoint('anchor', balloon, 'knot'); // re-roots the authored chain at the knot
        expect(freeRope.bodies.length, 'the authored chain hangs from the knot').toBeGreaterThan(0);

        let severed = false;
        for (let i = 0; i < 90 && !severed; i++) {
            engine.step(16.67);
            severed = freeRope.isSevered;
        }

        expect(severed).toBe(true);
        expect(scissors.isClosed).toBe(true);
    });

    it('the state table ropes its extras through family membership - the family line is shared, member-specific lines stay explicit', () => {
        // Issue #83: extrasOf asks isRopeFamily(obj), not a per-type string
        // fan. SEVERED/intact is the family-wide fact any member gets free
        // with membership; BUNDLED/TIED stay the free-rope member's own
        // explicit lines. A synthetic member cannot literally join this
        // table at runtime - ROPE_FAMILY_TYPES is a frozen ESM export read
        // by module-internal predicates - so the stub rows below pin the
        // gate to membership on shapeless rows, and the lint test after
        // this one holds state.js to the roster seam so a future member's
        // line follows from the roster append alone.
        const engine = makeEngine();
        const rope = new Rope(300, 100, { length: 60 });
        const severedRope = new Rope(400, 100, { length: 60, severed: true });
        const bundle = objectRegistry.create('free-rope', 500, 100); // length-less: the inert coil
        const tiedFree = objectRegistry.create('free-rope', 600, 100, { length: 60 }); // authored span: the chain lays at addObject
        const severedFree = objectRegistry.create('free-rope', 650, 100, { length: 60, severed: true });
        const candle = objectRegistry.create('candle', 700, 100); // a non-member of the family
        engine.addObject(rope);
        engine.addObject(severedRope);
        engine.addObject(bundle);
        engine.addObject(tiedFree);
        engine.addObject(severedFree);
        engine.addObject(candle);
        // Shapeless synthetic rows exercise exactly what the gate sees:
        // type + the family's own public flags (isSevered, isFree,
        // isFreeBundle), nothing else (ADR 0003 lifecycle contract - public
        // getters only, no reach-ins).
        const stubRope = { type: 'rope', isSevered: false, bodies: [], constraints: [], x: 100, y: 100, angle: 0, customId: 'stub-rope' };
        const stubBundle = { type: 'free-rope', isSevered: false, isFree: true, isFreeBundle: true, bodies: [], constraints: [], x: 150, y: 100, angle: 0, customId: 'stub-bundle' };
        const stubSevered = { type: 'free-rope', isSevered: true, isFree: true, isFreeBundle: false, bodies: [], constraints: [], x: 200, y: 100, angle: 0, customId: 'stub-severed' };
        const stubStranger = { type: 'wrapper', isSevered: false, bodies: [], constraints: [], x: 250, y: 100, angle: 0, customId: 'stub-stranger' };
        engine.addObject(stubRope);
        engine.addObject(stubBundle);
        engine.addObject(stubSevered);
        engine.addObject(stubStranger);

        const rows = stateRows(engine);
        const extraOf = (o) => rows.find((r) => r.id === objectId(o)).extra;
        expect(extraOf(rope)).toBe('intact');
        expect(extraOf(severedRope)).toBe('SEVERED');
        expect(extraOf(bundle)).toBe('BUNDLED');
        expect(extraOf(tiedFree)).toBe('TIED');
        expect(extraOf(severedFree)).toBe('SEVERED');
        expect(extraOf(candle), 'a non-member gets no rope extras').toBe('—');
        expect(extraOf(stubRope)).toBe('intact');
        expect(extraOf(stubBundle)).toBe('BUNDLED');
        expect(extraOf(stubSevered)).toBe('SEVERED');
        expect(extraOf(stubStranger), 'a non-member stub gets no rope extras').toBe('—');
    });

    it('lint: the roster seam is the only family switch in the cut scan and the observe extras - no per-type fan left', () => {
        // Issue #83's migration contract, stated where it lives. The two
        // whole-roster consumers - Scissors's blade-fan cut scan and
        // state.js's extrasOf - hold no 'rope'/'free-rope' string fan: the
        // scan asks the one roster query (Rope.queryRopeFamily), the extras
        // ask the one predicate (Rope.isRopeFamily), and both read the
        // frozen roster inside the rope module. A third family member joins
        // them with the roster append alone - no consumer edit can be
        // missed, because there is no type-keyed line left to forget.
        const cutScanSrc = readFileSync(new URL('../js/objects/Scissors.js', import.meta.url), 'utf8');
        expect(cutScanSrc).toContain('queryRopeFamily('); // the scan asks the family seam
        expect(cutScanSrc).not.toMatch(/queryObjectsByType\(\s*'(?:rope|free-rope)'/); // the two-query fan is gone
        const stateSrc = readFileSync(new URL('../agent/observe/state.js', import.meta.url), 'utf8');
        expect(stateSrc).toContain('isRopeFamily('); // the extras gate asks the family predicate
        expect(stateSrc).not.toMatch(/\.type === '(?:rope|free-rope)'/); // no per-type extras fan
    });
});