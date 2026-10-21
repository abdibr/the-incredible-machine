/**
 * Round-trip tests for rope attachment tokens across the board snapshot
 * seam (GitHub issue 04): serializePlacedBoard annotates rope rows with
 * ordinal tokens; restorePlacedFromSnapshot re-binds them two-phase.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { serializePlacedBoard, restorePlacedFromSnapshot, beginPlay } from '../js/reset/levelReset.js';
import { PhysicsEngine } from '../js/engine/PhysicsEngine.js';
import { objectRegistry } from '../js/objects/ObjectRegistry.js';
import { registerAllObjects } from '../js/objects/registerAllObjects.js';
import Rope from '../js/objects/Rope.js';
import Balloon from '../js/objects/Balloon.js';
import Bucket from '../js/objects/Bucket.js';

/** Board: fixed bucket pinned + rope tied at both ends (rim / knot). */
function buildTiedBoard() {
    const fixedBucket = new Bucket(800, 300, { isFixed: true });
    const rope = new Rope(800, 260, { length: 80 });
    const balloon = new Balloon(300, 300);
    rope.attachEndpoint(0, fixedBucket, 'rim');
    rope.attachEndpoint(1, balloon, 'knot');
    return { board: [fixedBucket, rope, balloon], fixedBucket, rope, balloon };
}

describe('connector snapshot seam — serializePlacedBoard (issue 04)', () => {
    beforeEach(() => {
        registerAllObjects();
    });

    it('annotates rope rows with ordinal tokens; other rows stay clean', () => {
        const { board } = buildTiedBoard();
        const entries = serializePlacedBoard(board);

        expect(entries[0].attachments).toBeUndefined();
        expect(entries[2].attachments).toBeUndefined();
        expect(entries[1].attachments).toEqual([
            { endpoint: 0, targetType: 'bucket', targetOrdinal: 0, pointId: 'rim' },
            { endpoint: 1, targetType: 'balloon', targetOrdinal: 2, pointId: 'knot' },
        ]);
    });

    it('emits no attachment key for an untied rope', () => {
        const board = [new Rope(200, 100), new Balloon(400, 300)];
        const entries = serializePlacedBoard(board);
        expect(entries[0].attachments).toBeUndefined();
        // rope.serialize() carries no knot data at all (tokens are owned
        // by the annotator)
        expect(JSON.stringify(board[0].serialize())).not.toContain('attachments');
    });

    it('drops tokens for targets that are off the board', () => {
        const stray = new Balloon(900, 500);
        const rope = new Rope(200, 100);
        rope.attachEndpoint(1, stray, 'knot');
        const entries = serializePlacedBoard([rope]); // stray balloon NOT on the board
        expect(entries[0].attachments).toBeUndefined();
    });

    it('beginPlay returns the annotated snapshot and re-adds bodies', () => {
        const { board } = buildTiedBoard();
        const physics = new PhysicsEngine(1000, 600);
        const snapshot = beginPlay(physics, board);
        expect(snapshot[1].attachments).toHaveLength(2);
        expect(physics.getObjects().size).toBe(3);
        physics.dispose();
    });
});

describe('connector snapshot seam — restorePlacedFromSnapshot (issue 04)', () => {
    beforeEach(() => {
        registerAllObjects();
    });

    it('re-binds tokens two-phase to the fresh instances', () => {
        const { board } = buildTiedBoard();
        const rows = serializePlacedBoard(board);

        // Fresh board: fixed object rebuilt from level data first…
        const freshBoard = [
            objectRegistry.deserialize(rows.find((r) => r.type === 'bucket' && r.isFixed)),
        ];
        // …then the placed rows restored in snapshot order
        const restored = restorePlacedFromSnapshot(freshBoard, rows);

        const restoredRope = restored.find((o) => o.type === 'rope');
        const restoredBalloon = restored.find((o) => o.type === 'balloon');
        expect(restoredRope).toBeDefined();
        expect(restoredBalloon).toBeDefined();

        const refs = restoredRope.getAttachmentRefs();
        expect(refs).toEqual([
            { endpoint: 0, target: freshBoard[0], pointId: 'rim' },
            { endpoint: 1, target: restoredBalloon, pointId: 'knot' },
        ]);
    });

    it('binds tokens to fixed targets too (rope pinned to a fixed bucket)', () => {
        const fixedBucket = new Bucket(750, 300, { isFixed: true });
        const rope = new Rope(750, 260, { length: 80 });
        rope.attachEndpoint(0, fixedBucket, 'rim');
        const rows = serializePlacedBoard([fixedBucket, rope]);

        const freshBoard = [objectRegistry.deserialize(rows[0])];
        const restored = restorePlacedFromSnapshot(freshBoard, rows);
        expect(restored[0].getAttachmentRefs()).toEqual([
            { endpoint: 0, target: freshBoard[0], pointId: 'rim' },
        ]);
    });

    it('drops every token (with a warning) when rows and board disagree', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { board } = buildTiedBoard();
        const rows = serializePlacedBoard(board);
        // Corrupt: the board carries an extra pre-existing object the snapshot
        // never saw — 2 (pre) + 2 (restored) = 4 live objects vs 3 rows
        const freshBoard = [
            objectRegistry.deserialize(rows[0]),
            new Balloon(500, 500),
        ];
        const restored = restorePlacedFromSnapshot(freshBoard, rows);
        expect(freshBoard.length).toBe(4);

        const restoredRope = restored.find((o) => o.type === 'rope');
        expect(restoredRope.getAttachmentRefs()).toEqual([]);
        expect(warnSpy).toHaveBeenCalled();
        warnSpy.mockRestore();
    });

    it('drops only the out-of-range token in a truncated snapshot, still binding the rest', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { board } = buildTiedBoard();
        const rows = serializePlacedBoard(board);
        // The balloon row went missing: 2 rows left; with the fixed object
        // rebuilt (1) + the rope restored (1) the counts still align (2 == 2),
        // but the endpoint-1 token's ordinal (2) now points past the board
        const rowsMinusBalloon = rows.filter((r) => r.type !== 'balloon');

        const freshBoard = [objectRegistry.deserialize(rows[0])];
        const restored = restorePlacedFromSnapshot(freshBoard, rowsMinusBalloon);
        expect(freshBoard.length).toBe(rowsMinusBalloon.length);

        const restoredRope = restored.find((o) => o.type === 'rope');
        // endpoint 0's token (fixed bucket, ordinal 0) still binds…
        expect(restoredRope.getAttachmentRefs()).toEqual([
            { endpoint: 0, target: freshBoard[0], pointId: 'rim' },
        ]);
        // …and the dangling endpoint-1 token was dropped with a warning
        expect(warnSpy).toHaveBeenCalled();
        warnSpy.mockRestore();
    });

    it('restores a severed rope severed, without binding its tokens', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const fixedBucket = new Bucket(750, 300, { isFixed: true });
        const balloon = new Balloon(400, 300);
        const rope = new Rope(750, 260, { length: 80, severed: true });
        // tokens written anyway (the annotator is dumb); a severed rope drops them
        rope.attachEndpoint(1, balloon, 'knot');
        const rows = serializePlacedBoard([fixedBucket, rope, balloon]);
        expect(rows[1].attachments).toHaveLength(1);

        const freshBoard = [objectRegistry.deserialize(rows[0])];
        const restored = restorePlacedFromSnapshot(freshBoard, rows);
        const restoredRope = restored.find((o) => o.type === 'rope');
        expect(restoredRope.isSevered).toBe(true);
        expect(restoredRope.getAttachmentRefs()).toEqual([]); // severed binds nothing
        warnSpy.mockRestore();
    });
});