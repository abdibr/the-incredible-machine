/**
 * Knots are saved and restored by seat role — GitHub issue #88.
 *
 * A placed rope's saved knots record their seat as the ROLE it plays —
 * `anchor` / `mid` / `end` (the rope's own named-seat answer, issue #84) —
 * instead of a count-bound segment index. Restoring a board re-binds each
 * knot to the same seat of the restored chain, whatever that chain's
 * count: a mid knot restored onto a chain with a different count lands on
 * the restored chain's middle body. Boards saved under the old
 * segment/endpoint token forms still load — the anchor stays the anchor,
 * the chain end stays the end, any other seat collapses to the nearest of
 * the three with a warning — and save → load → save is idempotent.
 *
 * Seams under test:
 * - serializePlacedBoard (levelReset) — the save side: rope rows carry
 *   `{ seat: 'anchor'|'mid'|'end', targetType, targetOrdinal, pointId }`
 *   tokens, named through the rope's own getTieSeats() answer; a knot on a
 *   seat the rope does not name keeps the legacy numeric token.
 * - Rope.bindAttachment / its token migration — the restore side: seat
 *   tokens resolve to the live chain's seat indices; legacy segment and
 *   endpoint tokens migrate (anchor → anchor, chain end → end, any other
 *   seat → nearest role) each with a warning; nothing throws.
 * - restorePlacedFromSnapshot — the full two-phase round-trip.
 *
 * Companion suites: rope-seat-keeps (#87 — live knots keep their seats
 * across re-counts, live refs stay segment-indexed), connector-reset (the
 * 04 token seam), rope-ties (legacy endpoint tokens, segment ties).
 */

import { describe, it, expect, vi } from 'vitest';
import { serializePlacedBoard, restorePlacedFromSnapshot } from '../js/reset/levelReset.js';
import { objectRegistry } from '../js/objects/ObjectRegistry.js';
import { registerAllObjects } from '../js/objects/registerAllObjects.js';
import Rope from '../js/objects/Rope.js';
import Balloon from '../js/objects/Balloon.js';
import Bucket from '../js/objects/Bucket.js';

registerAllObjects();

/** A spy over console.warn for migration-warning counts. */
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
        // A 420px pinned rope lays 11 segments: mid seat 5 (covering 210),
        // end seat 10 (covering 400). Ties sit inside their coverings —
        // nothing grows, so the seat identity is all the test exercises.
        const bucket = new Bucket(760, 500, { isFixed: true });
        const balloonMid = balloonWithKnotAt(300, 265.6); // 165.6 from the anchor
        const balloonEnd = balloonWithKnotAt(300, 445.6); // 345.6 from the anchor
        const rope = new Rope(300, 100, { length: 420 });
        expect(rope._segments.length).toBe(11); // precondition: mid 5, end 10

        rope.attachEndpoint(-1, bucket, 'rim');
        rope.attachEndpoint(5, balloonMid, 'knot');
        rope.attachEndpoint(10, balloonEnd, 'knot');
        expect(rope.getAttachmentRefs().map((r) => r.segment)).toEqual([-1, 5, 10]);

        const rows = serializePlacedBoard([bucket, rope, balloonMid, balloonEnd]);
        expect(rows[1].attachments).toEqual([
            { seat: 'anchor', targetType: 'bucket', targetOrdinal: 0, pointId: 'rim' },
            { seat: 'mid', targetType: 'balloon', targetOrdinal: 2, pointId: 'knot' },
            { seat: 'end', targetType: 'balloon', targetOrdinal: 3, pointId: 'knot' },
        ]);

        rope.dispose();
        for (const obj of [bucket, balloonMid, balloonEnd]) obj.dispose();
    });

    it('a knot on a seat the rope does not name keeps the legacy numeric token', () => {
        // The connect flow can only reach the three named seats; the
        // segment-index API (a test, a future caller) cannot. A knot on a
        // seat none of the named-seat answers covers (seat 3 of 6 — the mid
        // is seat 2) must not silently masquerade as a role: it saves
        // numerically and migrates on the next load.
        const balloon = balloonWithKnotAt(300, 150); // 50 from the anchor ≤ 58.3
        const rope = new Rope(300, 100, { length: 100 });
        rope.attachEndpoint(3, balloon, 'knot');
        expect(rope.getAttachmentRefs().map((r) => r.segment)).toEqual([3]);

        const rows = serializePlacedBoard([balloon, rope]);
        expect(rows[1].attachments).toEqual([
            { segment: 3, targetType: 'balloon', targetOrdinal: 0, pointId: 'knot' },
        ]);

        rope.dispose();
        balloon.dispose();
    });
});

describe('Seat-role tokens — the restore side (bindAttachment, issue #88)', () => {
    it('restores all three named seats onto the same seats of the restored chain', () => {
        const bucket = new Bucket(760, 500, { isFixed: true });
        const balloonMid = balloonWithKnotAt(300, 265.6);
        const balloonEnd = balloonWithKnotAt(300, 445.6);
        const rope = new Rope(300, 100, { length: 420 });
        rope.attachEndpoint(-1, bucket, 'rim');
        rope.attachEndpoint(5, balloonMid, 'knot');
        rope.attachEndpoint(10, balloonEnd, 'knot');
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

        expect(rope2.getAttachmentRefs()).toEqual([
            { segment: -1, target: fresh[0], pointId: 'rim' },
            { segment: 5, target: balloonMid2, pointId: 'knot' },
            { segment: 10, target: balloonEnd2, pointId: 'knot' },
        ]);
        // The restored rope's own named-seat answer still names them.
        expect(rope2.getTieSeats().map((s) => s.segment)).toEqual([-1, 5, 10]);
        expect(rope2.bodies.length - 1).toBe(11);

        rope2.dispose();
        for (const obj of [...fresh, ...restored]) obj.dispose();
    });

    it('a mid token restored onto a chain with a different count lands on the middle body', () => {
        // The saved chain laid 6 segments (its mid was seat 2, its end seat
        // 5); the restored row lays 12. The ROLE tokens must follow the
        // restored count — mid → seat 5, end → seat 11 — not the literal
        // saved indices.
        const bucket = new Bucket(760, 500, { isFixed: true });
        const balloonMid = balloonWithKnotAt(300, 141.6); // 41.6 from the anchor
        const balloonEnd = balloonWithKnotAt(300, 191.6); // 91.6 from the anchor
        const rope = new Rope(300, 100, { length: 100 });
        expect(rope._segments.length).toBe(6);
        rope.attachEndpoint(-1, bucket, 'rim');
        rope.attachEndpoint(2, balloonMid, 'knot');
        rope.attachEndpoint(5, balloonEnd, 'knot');
        const rows = serializePlacedBoard([bucket, rope, balloonMid, balloonEnd]);
        expect(rows[1].attachments.map((t) => t.seat)).toEqual(['anchor', 'mid', 'end']);

        // The restored chain's count differs (a hand-edit or a corruption —
        // the seam is the row's persisted count).
        rows[1].options.segments = 12;

        const fresh = [objectRegistry.deserialize(rows[0])];
        const restored = restorePlacedFromSnapshot(fresh, rows);
        const rope2 = restored.find((o) => o.type === 'rope');
        expect(rope2.bodies.length - 1).toBe(12);
        expect(rope2.getAttachmentRefs().map((r) => r.segment)).toEqual([-1, 5, 11]);
        // The mid knot's body IS the restored chain's middle body.
        const [, mid] = rope2.getTieSeats();
        expect(mid.segment).toBe(5);
        expect(mid.body).toBe(rope2.bodies[6]);
        expect(rope2._length).toBeCloseTo(100, 3); // the binds grew nothing

        rope2.dispose();
        for (const obj of [...fresh, ...restored]) obj.dispose();
    });

    it('a spawned free rope restores its three seat tokens through the birth-at-bind', () => {
        // A free rope restored as a coil has no chain until a tie births
        // one: the anchor token binds first (spawning the chain from the
        // row's persisted count), and the mid/end tokens then resolve
        // against the birthed chain.
        const anchorB = balloonWithKnotAt(300, 125.6);
        const midB = balloonWithKnotAt(300, 160);  // 34.4 from the knot ≤ 41.7
        const endB = balloonWithKnotAt(300, 210);  // 84.4 from the knot ≤ 91.7
        const rope = objectRegistry.create('free-rope', 300, 100);
        rope.attachEndpoint(-1, anchorB, 'knot'); // spawns the 6-chain
        rope.attachEndpoint(2, midB, 'knot');
        rope.attachEndpoint(5, endB, 'knot');
        expect(rope.bodies.length - 1).toBe(6);

        const rows = serializePlacedBoard([anchorB, midB, endB, rope]);
        expect(rows[3].attachments.map((t) => t.seat)).toEqual(['anchor', 'mid', 'end']);

        const board2 = [];
        const restored = restorePlacedFromSnapshot(board2, rows);
        const rope2 = restored.find((o) => o.type === 'free-rope');
        expect(rope2.bodies.length - 1).toBe(6); // the birth-at-bind spawned it
        expect(rope2.getAttachmentRefs().map((r) => r.segment)).toEqual([-1, 2, 5]);
        const [, mid] = rope2.getTieSeats();
        expect(mid.body).toBe(rope2.bodies[3]); // seat 2's body

        rope.dispose();
        for (const obj of [anchorB, midB, endB]) obj.dispose();
        for (const obj of board2) obj.dispose();
    });
});

describe('Seat-role tokens — legacy numeric tokens migrate (issue #88)', () => {
    it('legacy segment tokens migrate: anchor stays, end stays, mid-chain collapses to nearest — each with a warning, nothing throws', () => {
        const data = {
            type: 'rope', x: 300, y: 100, angle: 0, isFixed: false,
            options: { length: 100 },
            attachments: [
                { segment: -1, targetType: 'bucket', targetOrdinal: 0, pointId: 'rim' },
                { segment: 5, targetType: 'balloon', targetOrdinal: 1, pointId: 'knot' }, // the chain end
                { segment: 1, targetType: 'balloon', targetOrdinal: 2, pointId: 'knot' }, // → mid (2)
                { segment: 4, targetType: 'balloon', targetOrdinal: 3, pointId: 'knot' }, // → end (5) — taken
            ],
        };
        const rope = Rope.deserialize(data);
        const bucket = new Bucket(760, 500, { isFixed: true });
        const balloonA = balloonWithKnotAt(300, 191.6); // the end tie's target
        const balloonB = balloonWithKnotAt(300, 141.6); // the mid-collapse target
        const balloonC = balloonWithKnotAt(300, 155);   // would tie seat 5 too

        const { warns, restore } = spyWarns();
        try {
            expect(() => rope.bindAttachment([bucket, balloonA, balloonB, balloonC])).not.toThrow();
        } finally {
            restore();
        }
        // Four legacy migrations warned — anchor, end, and two collapses —
        // and the seat-4 collapse's refused tie (seat 5 already holds a
        // knot) warned as a drop. Nothing threw.
        expect(warns).toHaveBeenCalledTimes(5);
        expect(rope.getAttachmentRefs()).toEqual([
            { segment: -1, target: bucket, pointId: 'rim' },
            { segment: 2, target: balloonB, pointId: 'knot' }, // 1 → mid
            { segment: 5, target: balloonA, pointId: 'knot' }, // 5 → the chain end
        ]);

        rope.dispose();
        for (const obj of [bucket, balloonA, balloonB, balloonC]) obj.dispose();
    });

    it('a seat exactly between mid and end collapses anchor-ward', () => {
        // A 500px rope lays 13 segments: mid 6, end 12. Seat 9 sits exactly
        // between them (3 seats each way) — the tie resolves anchor-ward,
        // the same rule the mid seat itself ties by on even counts.
        const data = {
            type: 'rope', x: 300, y: 100, angle: 0, isFixed: false,
            options: { length: 500 },
            attachments: [
                { segment: 9, targetType: 'balloon', targetOrdinal: 0, pointId: 'knot' },
            ],
        };
        const rope = Rope.deserialize(data);
        const balloon = balloonWithKnotAt(300, 335.6); // 235.6 ≤ 250 covered

        const { warns, restore } = spyWarns();
        try {
            rope.bindAttachment([balloon]);
        } finally {
            restore();
        }
        expect(warns).toHaveBeenCalledTimes(1);
        expect(rope.getAttachmentRefs().map((r) => r.segment)).toEqual([6]);

        rope.dispose();
        balloon.dispose();
    });

    it('the migrated state is a fixed point: save → load → save re-uses the tokens warning-free', () => {
        const data = {
            type: 'rope', x: 300, y: 100, angle: 0, isFixed: false,
            options: { length: 100 },
            attachments: [
                { segment: -1, targetType: 'bucket', targetOrdinal: 0, pointId: 'rim' },
                { segment: 1, targetType: 'balloon', targetOrdinal: 2, pointId: 'knot' },
            ],
        };
        const rope = Rope.deserialize(data);
        const bucket = new Bucket(760, 500, { isFixed: true });
        const balloon = new Balloon(300, 141.6);
        rope.bindAttachment([bucket, rope, balloon]); // 1 → mid (2), warned

        // Board order bucket(0), rope(1), balloon(2): the migrated knots
        // re-save as named seats.
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
        expect(warns).not.toHaveBeenCalled(); // nothing to migrate
        const rope2 = fresh.find((o) => o.type === 'rope');
        expect(rope2.getAttachmentRefs().map((r) => r.segment)).toEqual([-1, 2]);

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
        expect(ropeRow.options.segments).toBe(0); // precondition: the coil restored

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
