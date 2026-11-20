/**
 * Knots are saved and restored by seat role — GitHub issues #88 + #90.
 *
 * A placed rope's saved knots record their seat as the ROLE it plays —
 * `anchor` / `mid` / `end` (the rope's own named-seat answer, issue #84) —
 * and binding re-ties each knot to the same seat of the restored chain,
 * whatever that chain's count: a mid token restored onto a chain with a
 * different count lands on the restored chain's middle body. Since #90 the
 * role is the ONLY seat address: every token carries a role name, the
 * legacy numeric forms (`segment`, issue #56; `endpoint`, issue 04) load
 * no more and are refused with a clear warning apiece, and nothing throws.
 *
 * Seams under test:
 * - serializePlacedBoard (levelReset) — the save side: rope rows carry
 *   `{ seat: 'anchor'|'mid'|'end', targetType, targetOrdinal, pointId }`
 *   tokens, carried straight from the rope's own role-keyed refs.
 * - Rope.bindAttachment / its token migration — the restore side: seat
 *   tokens bind at the seat the restored chain gives that role; a
 *   non-role seat name or a legacy numeric token drops with a warning,
 *   nothing throws.
 * - restorePlacedFromSnapshot — the full two-phase round-trip.
 *
 * Companion suites: rope-seat-keeps (#87 — live knots keep their seats
 * across re-counts), connector-reset (the 04 token seam), rope-ties
 * (role ties + one knot per seat).
 */

import { describe, it, expect, vi } from 'vitest';
import { serializePlacedBoard, restorePlacedFromSnapshot } from '../js/reset/levelReset.js';
import { objectRegistry } from '../js/objects/ObjectRegistry.js';
import { registerAllObjects } from '../js/objects/registerAllObjects.js';
import Rope from '../js/objects/Rope.js';
import Balloon from '../js/objects/Balloon.js';
import Bucket from '../js/objects/Bucket.js';

registerAllObjects();

/** A spy over console.warn for refusal-warning counts. */
function spyWarns() {
    const warns = vi.fn();
    const origWarn = console.warn;
    console.warn = warns;
    return { warns, restore: () => { console.warn = origWarn; } };
}

// Balloon knot offset: radius 18 → 18·1.2 + 4 = 25.6 px below the centre.
const KNOT_OFFSET = 25.6;
const balloonWithKnotAt = (x, knotY) => new Balloon(x, knotY - KNOT_OFFSET);

describe('Seat-role tokens — the save side (serializePlacedBoard, issue #88)', () => {
    it('a rope with anchor, mid and end knots saves three tokens naming their seats', () => {
        // A 420px pinned rope lays 11 segments: mid covering 210, end 400.
        // Ties sit inside their coverings — nothing grows, so the seat
        // identity is all the test exercises.
        const bucket = new Bucket(760, 500, { isFixed: true, isScene: true });
        const balloonMid = balloonWithKnotAt(300, 265.6); // 165.6 from the anchor
        const balloonEnd = balloonWithKnotAt(300, 445.6); // 345.6 from the anchor
        const rope = new Rope(300, 100, { length: 420 });
        expect(rope._segments.length).toBe(11); // precondition: mid 5, end 10

        rope.attachEndpoint('anchor', bucket, 'rim');
        rope.attachEndpoint('mid', balloonMid, 'knot');
        rope.attachEndpoint('end', balloonEnd, 'knot');
        expect(rope.getAttachmentRefs().map((r) => r.seat)).toEqual(['anchor', 'mid', 'end']);

        const rows = serializePlacedBoard([bucket, rope, balloonMid, balloonEnd]);
        expect(rows[1].attachments).toEqual([
            { seat: 'anchor', targetType: 'bucket', targetOrdinal: 0, pointId: 'rim' },
            { seat: 'mid', targetType: 'balloon', targetOrdinal: 2, pointId: 'knot' },
            { seat: 'end', targetType: 'balloon', targetOrdinal: 3, pointId: 'knot' },
        ]);
        // No token carries a numeric seat any more (issue #90).
        expect(rows[1].attachments.every((t) => t.segment === undefined && t.endpoint === undefined)).toBe(true);

        rope.dispose();
        for (const obj of [bucket, balloonMid, balloonEnd]) obj.dispose();
    });

    it('tokens carry the seat role and nothing numeric, whatever the seat', () => {
        // The connect flow ties through the three named seats and the API
        // ties nothing else (issue #90) — every knot is one of the three
        // roles, so every token is the role name. Slot check with a single
        // mid knot: no segment/endpoint key may ride along.
        const balloon = balloonWithKnotAt(300, 141.6); // 41.6 from the anchor ≤ 41.7
        const rope = new Rope(300, 100, { length: 100 });
        rope.attachEndpoint('mid', balloon, 'knot');
        expect(rope.getAttachmentRefs().map((r) => r.seat)).toEqual(['mid']);

        const rows = serializePlacedBoard([balloon, rope]);
        expect(rows[1].attachments).toEqual([
            { seat: 'mid', targetType: 'balloon', targetOrdinal: 0, pointId: 'knot' },
        ]);

        rope.dispose();
        balloon.dispose();
    });
});

describe('Seat-role tokens — the restore side (bindAttachment, issue #88)', () => {
    it('restores all three named seats onto the same seats of the restored chain', () => {
        const bucket = new Bucket(760, 500, { isFixed: true, isScene: true });
        const balloonMid = balloonWithKnotAt(300, 265.6);
        const balloonEnd = balloonWithKnotAt(300, 445.6);
        const rope = new Rope(300, 100, { length: 420 });
        rope.attachEndpoint('anchor', bucket, 'rim');
        rope.attachEndpoint('mid', balloonMid, 'knot');
        rope.attachEndpoint('end', balloonEnd, 'knot');
        const rows = serializePlacedBoard([bucket, rope, balloonMid, balloonEnd]);

        // Fixed object rebuilt from level data first, placed rows restored
        // in snapshot order (the two-phase ordinal bind's board shape).
        const fresh = [objectRegistry.deserialize(rows[0])];
        const restored = restorePlacedFromSnapshot(fresh, rows);
        const rope2 = restored.find((o) => o.type === 'rope');
        const balloonMid2 = restored.find((o) => o.type === 'balloon'
            && o.getAttachmentWorldPoint('knot').y < 400);
        const balloonEnd2 = restored.find((o) => o.type === 'balloon'
            && o.getAttachmentWorldPoint('knot').y > 400);

        expect(rope2.getAttachmentRefs().map(({ seat, target, pointId }) => ({ seat, target, pointId }))).toEqual([
            { seat: 'anchor', target: fresh[0], pointId: 'rim' },
            { seat: 'mid', target: balloonMid2, pointId: 'knot' },
            { seat: 'end', target: balloonEnd2, pointId: 'knot' },
        ]);
        // The restored rope's own named seats hold the knots.
        expect(rope2.getTieSeats().map((s) => s.role)).toEqual(['anchor', 'mid', 'end']);
        expect(rope2.getTieSeats()[2].body).toBe(rope2.bodies[rope2.bodies.length - 1]); // the end knot is on the tail
        expect(rope2.bodies.length - 1).toBe(11);

        rope2.dispose();
        for (const obj of [...fresh, ...restored]) obj.dispose();
    });

    it('a mid token restored onto a chain with a different count lands on the middle body', () => {
        // The saved chain laid 6 segments (its mid was seg 2, its end seg
        // 5); the restored row lays 7. The ROLE tokens must follow the
        // restored count — mid → the 7-chain's middle body — not any
        // literal saved index.
        const bucket = new Bucket(760, 500, { isFixed: true, isScene: true });
        const balloonMid = balloonWithKnotAt(300, 141.6); // 41.6 from the anchor
        const balloonEnd = balloonWithKnotAt(300, 191.6); // 91.6 from the anchor
        const rope = new Rope(300, 100, { length: 100 });
        expect(rope._segments.length).toBe(6);
        rope.attachEndpoint('anchor', bucket, 'rim');
        rope.attachEndpoint('mid', balloonMid, 'knot');
        rope.attachEndpoint('end', balloonEnd, 'knot');
        const rows = serializePlacedBoard([bucket, rope, balloonMid, balloonEnd]);
        expect(rows[1].attachments.map((t) => t.seat)).toEqual(['anchor', 'mid', 'end']);

        // The restored chain's count differs (a hand-edit or a corruption —
        // the seam is the row's span, which a hand can stretch: the count
        // re-derives from it, issue #89 — there is no persisted count to
        // hand-edit any more).
        rows[1].options.length = 280;

        const fresh = [objectRegistry.deserialize(rows[0])];
        const restored = restorePlacedFromSnapshot(fresh, rows);
        const rope2 = restored.find((o) => o.type === 'rope');
        expect(rope2.bodies.length - 1).toBe(7); // segmentsForSpan(280)
        expect(rope2.getAttachmentRefs().map((r) => r.seat)).toEqual(['anchor', 'mid', 'end']);
        // The mid knot's body IS the restored chain's middle body (seg 3
        // of 7 — bodies[4] past the anchor).
        const [, mid] = rope2.getTieSeats();
        expect(mid.body).toBe(rope2.bodies[4]);
        expect(rope2._length).toBeCloseTo(280, 3); // the binds grew nothing

        rope2.dispose();
        for (const obj of [...fresh, ...restored]) obj.dispose();
    });

    it('a spawned free rope restores its three seat tokens through the birth-at-bind', () => {
        // A free rope restored as a coil has no chain until a tie births
        // one: the anchor token binds first (spawning the chain at the
        // span's rule, issue #89 — the row carries no chain count), and the
        // mid/end tokens then resolve against the birthed chain.
        const anchorB = balloonWithKnotAt(300, 125.6);
        const midB = balloonWithKnotAt(300, 160);  // 34.4 from the knot ≤ 41.7
        const endB = balloonWithKnotAt(300, 210);  // 84.4 from the knot ≤ 91.7
        const rope = objectRegistry.create('free-rope', 300, 100);
        rope.attachEndpoint('anchor', anchorB, 'knot'); // spawns the 6-chain
        rope.attachEndpoint('mid', midB, 'knot');
        rope.attachEndpoint('end', endB, 'knot');
        expect(rope.bodies.length - 1).toBe(6);

        const rows = serializePlacedBoard([anchorB, midB, endB, rope]);
        expect(rows[3].attachments.map((t) => t.seat)).toEqual(['anchor', 'mid', 'end']);

        const board2 = [];
        const restored = restorePlacedFromSnapshot(board2, rows);
        const rope2 = restored.find((o) => o.type === 'free-rope');
        expect(rope2.bodies.length - 1).toBe(6); // the birth-at-bind spawned it
        expect(rope2.getAttachmentRefs().map((r) => r.seat)).toEqual(['anchor', 'mid', 'end']);
        const [, mid] = rope2.getTieSeats();
        expect(mid.body).toBe(rope2.bodies[3]); // seg 2's body

        rope.dispose();
        for (const obj of [anchorB, midB, endB]) obj.dispose();
        for (const obj of board2) obj.dispose();
    });
});

describe('Seat-role tokens — anything that is not a role name is refused (issue #90)', () => {
    it('legacy segment tokens drop with one clear warning apiece; nothing throws, the board still restores', () => {
        const data = {
            type: 'rope', x: 300, y: 100, angle: 0, isFixed: false,
            options: { length: 100 },
            attachments: [
                { segment: -1, targetType: 'bucket', targetOrdinal: 0, pointId: 'rim' },
                { segment: 5, targetType: 'balloon', targetOrdinal: 1, pointId: 'knot' },
                { segment: 1, targetType: 'balloon', targetOrdinal: 2, pointId: 'knot' },
            ],
        };
        const rope = Rope.deserialize(data);
        const bucket = new Bucket(760, 500, { isFixed: true, isScene: true });
        const balloonA = balloonWithKnotAt(300, 191.6);
        const balloonB = balloonWithKnotAt(300, 155);

        const { warns, restore } = spyWarns();
        try {
            expect(() => rope.bindAttachment([bucket, balloonA, balloonB])).not.toThrow();
        } finally {
            restore();
        }
        // Three legacy tokens, three clear refusal warnings (one apiece —
        // no migration, no nearest-seat collapse); nothing threw and
        // nothing bound: a pre-#90 board reloads without its knots and is
        // invited to re-tie and re-save.
        expect(warns).toHaveBeenCalledTimes(3);
        expect(warns.mock.calls.every(([m]) => m.includes("not a seat role"))).toBe(true);
        expect(rope.getAttachmentRefs()).toEqual([]);

        rope.dispose();
        for (const obj of [bucket, balloonA, balloonB]) obj.dispose();
    });

    it('legacy endpoint tokens refuse the same way, with one warning apiece', () => {
        const data = {
            type: 'rope', x: 200, y: 100, angle: 0, isFixed: false,
            options: { length: 100 },
            attachments: [
                { endpoint: 0, targetType: 'balloon', targetOrdinal: 0, pointId: 'knot' },
                { endpoint: 1, targetType: 'balloon', targetOrdinal: 0, pointId: 'knot' },
            ],
        };
        const rope = Rope.deserialize(data);
        const balloon = balloonWithKnotAt(320, 125.6);
        const { warns, restore } = spyWarns();
        try {
            expect(() => rope.bindAttachment([balloon])).not.toThrow();
        } finally {
            restore();
        }
        expect(warns).toHaveBeenCalledTimes(2);
        expect(rope.getAttachmentRefs()).toEqual([]);
        rope.dispose();
        balloon.dispose();
    });

    it('a garbage seat name refuses with the same clear error; restore stays a no-throw warn-drop', () => {
        const data = {
            type: 'rope', x: 200, y: 100, angle: 0, isFixed: false,
            options: { length: 100 },
            attachments: [
                { seat: 'left', targetType: 'balloon', targetOrdinal: 0, pointId: 'knot' },
                { seat: 3, targetType: 'balloon', targetOrdinal: 0, pointId: 'knot' },
            ],
        };
        const rope = Rope.deserialize(data);
        const balloon = balloonWithKnotAt(320, 125.6);
        const { warns, restore } = spyWarns();
        try {
            expect(() => rope.bindAttachment([balloon])).not.toThrow();
        } finally {
            restore();
        }
        expect(warns).toHaveBeenCalledTimes(2);
        expect(warns.mock.calls.every(([m]) => m.includes("not a seat role"))).toBe(true);
        expect(rope.getAttachmentRefs()).toEqual([]);
        rope.dispose();
        balloon.dispose();
    });

    it('two tokens naming the same seat cannot share it: the second refuses with a warning, nothing throws', () => {
        // The one-knot-per-seat gate (#85) is the rope-side guard on every
        // path — a restore included: even a row (corrupt or hand-edited)
        // carrying two tokens for the same role holds only the first, and
        // the refusal is the bind's ordinary warn-drop.
        const balloon = balloonWithKnotAt(300, 150); // 50px from the anchor: inside the end seat too
        const ropeRow = {
            ...new Rope(300, 100, { length: 100 }).serialize(),
            attachments: [
                { seat: 'end', targetType: 'balloon', targetOrdinal: 0, pointId: 'knot' },
                { seat: 'end', targetType: 'balloon', targetOrdinal: 0, pointId: 'knot' },
            ],
        };
        const rows = [balloon.serialize(), ropeRow];
        const board2 = [];
        const { warns, restore } = spyWarns();
        try {
            expect(() => restorePlacedFromSnapshot(board2, rows)).not.toThrow();
        } finally {
            restore();
        }
        const rope2 = board2.find((o) => o.type === 'rope');
        expect(rope2.getAttachmentRefs()).toHaveLength(1); // one knot per seat through restore too
        expect(warns).toHaveBeenCalledTimes(1); // the refused duplicate
        expect(warns.mock.calls[0][0]).toContain('already holds a knot');

        balloon.dispose();
        for (const obj of board2) obj.dispose();
    });

    it('the role tokens are a fixed point: save → load → save re-uses the tokens warning-free', () => {
        const bucket = new Bucket(760, 500, { isFixed: true, isScene: true });
        const balloon = new Balloon(300, 141.6); // 41.6 from the anchor ≤ 41.7: the mid of the 6-chain
        const rope = new Rope(300, 100, { length: 100 });
        rope.attachEndpoint('anchor', bucket, 'rim');
        rope.attachEndpoint('mid', balloon, 'knot');

        // Board order bucket(0), rope(1), balloon(2): the knots re-save
        // as their roles.
        const rows = serializePlacedBoard([bucket, rope, balloon]);
        expect(rows[1].attachments).toEqual([
            { seat: 'anchor', targetType: 'bucket', targetOrdinal: 0, pointId: 'rim' },
            { seat: 'mid', targetType: 'balloon', targetOrdinal: 2, pointId: 'knot' },
        ]);

        const fresh = [objectRegistry.deserialize(rows[0])];
        const { warns, restore } = spyWarns();
        try {
            restorePlacedFromSnapshot(fresh, rows);
        } finally {
            restore();
        }
        expect(warns).not.toHaveBeenCalled(); // nothing to refuse
        const rope2 = fresh.find((o) => o.type === 'rope');
        expect(rope2.getAttachmentRefs().map((r) => r.seat)).toEqual(['anchor', 'mid']);

        rope.dispose();
        for (const obj of [bucket, balloon]) obj.dispose();
        for (const obj of fresh) obj.dispose();
    });
});

describe('Seat-role tokens — a rope that restored without a chain (issue #88)', () => {
    it('a chain-seat token on a rope without a chain is dropped with a warning; the rest of the board still restores', () => {
        const balloon = new Balloon(500, 200);
        const bundle = objectRegistry.create('free-rope', 300, 300);
        const ropeRow = {
            ...bundle.serialize(),
            attachments: [
                { seat: 'mid', targetType: 'balloon', targetOrdinal: 0, pointId: 'knot' },
                { seat: 'end', targetType: 'balloon', targetOrdinal: 0, pointId: 'knot' },
            ],
        };
        expect(ropeRow.options.spawned).toBe(false); // precondition: the coil restored

        const rows = [balloon.serialize(), ropeRow];
        const board2 = [];
        const { warns, restore } = spyWarns();
        try {
            restorePlacedFromSnapshot(board2, rows);
        } finally {
            restore();
        }
        expect(warns).toHaveBeenCalledTimes(2); // one refused chain-seat token each
        const bundle2 = board2.find((o) => o.type === 'free-rope');
        expect(bundle2.getAttachmentRefs()).toEqual([]); // both drops
        expect(bundle2.isFreeBundle).toBe(true); // still the coil it restored as
        expect(board2.find((o) => o.type === 'balloon')).toBeDefined(); // the rest restored

        bundle.dispose();
        balloon.dispose();
        for (const obj of board2) obj.dispose();
    });
});
