/**
 * Unit tests for the custom-id prefactor (GitHub issue #5):
 * named ids from level JSON survive deserialize / level setup and
 * serialize → deserialize round-trips, while BaseObject's
 * auto-increment physics id stays untouched in its own id space.
 */

import { describe, it, expect } from 'vitest';

/** The 15 level-loadable object classes (js/objects) */
const CLASSES = [
    'Ball', 'Balloon', 'Bucket', 'Candle', 'Conveyor', 'Domino', 'Fan',
    'Gear', 'Mouse', 'Pulley', 'Ramp', 'Rope', 'Scissors', 'Spring', 'Trampoline',
];

const NAMED_ID = 'bucket-goal'; // known-good literal from js/levels/puzzles/level-01.json

/** Level-JSON-shaped fixedObject spec (see level-01.json) */
function levelSpec(type, namedId = NAMED_ID) {
    return { type, x: 100, y: 200, angle: 0, id: namedId, options: {} };
}

describe('custom ids survive level load (issue #5)', () => {
    it.each(CLASSES)('%s deserialize() carries the named id from the level spec', async (className) => {
        const { default: ObjectClass } = await import(`../js/objects/${className}.js`);

        const obj = ObjectClass.deserialize(levelSpec('unused-type'));

        expect(obj.customId).toBe(NAMED_ID);
    });

    it('physics id stays auto-increment and never collides with custom ids', async () => {
        const { default: Bucket } = await import('../js/objects/Bucket.js');

        const named = Bucket.deserialize(levelSpec('bucket'));
        const plain = Bucket.deserialize({ type: 'bucket', x: 100, y: 200 });

        expect(named.customId).toBe(NAMED_ID);
        expect(plain.customId).toBeNull();
        expect(typeof named.id).toBe('number');
        expect(typeof plain.id).toBe('number');
        expect(plain.id).toBe(named.id + 1); // auto-increment generator untouched by named ids
    });

    it('serialize → deserialize round-trip preserves the custom id', async () => {
        const { default: Bucket } = await import('../js/objects/Bucket.js');

        const data = new Bucket(700, 480, { catchType: 'ball', customId: NAMED_ID }).serialize();

        expect(data.id).toBe(NAMED_ID); // same key level JSON uses

        const restored = Bucket.deserialize(data);
        expect(restored.customId).toBe(NAMED_ID);
    });

    it('objects without a named level id serialize without an id key', async () => {
        const { default: Bucket } = await import('../js/objects/Bucket.js');

        const data = new Bucket(700, 480, { catchType: 'ball' }).serialize();

        expect('id' in data).toBe(false);
    });

    it('objectRegistry.create passes customId (the seam _setupLevel and the editor use)', async () => {
        const { objectRegistry } = await import('../js/objects/ObjectRegistry.js');
        const { registerAllObjects } = await import('../js/objects/registerAllObjects.js');

        registerAllObjects();

        const created = objectRegistry.create('bucket', 700, 480, { isFixed: true, customId: NAMED_ID });

        expect(created.customId).toBe(NAMED_ID);
        expect(typeof created.id).toBe('number'); // id spaces stay separate through the registry seam
    });

    it('objectRegistry.deserialize carries the custom id (editor-saved level path)', async () => {
        const { objectRegistry } = await import('../js/objects/ObjectRegistry.js');
        const { registerAllObjects } = await import('../js/objects/registerAllObjects.js');

        registerAllObjects();

        const restored = objectRegistry.deserialize(levelSpec('bucket'));

        expect(restored.customId).toBe(NAMED_ID);
    });
});