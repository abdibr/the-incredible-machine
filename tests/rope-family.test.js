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
 */
import { describe, expect, it } from 'vitest';
import Rope, { ROPE_FAMILY_TYPES, isRopeFamily, isRopeFamilyType } from '../js/objects/Rope.js';
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