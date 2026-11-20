/**
 * Scene-content lock (ADR 0009, docs/adr/0009-scene-lock-and-solution-scenes.md):
 * authored scene content is player-locked in the player postures.
 *
 * The cheat this pins: solving a campaign level, an anchored scene part (the
 * level-06 target ball) kept its anchor handle outside the sandbox — once
 * un-anchored it became a movable player part and could be dragged straight
 * into the goal bucket. The fix is a fourth part state, `isScene`: authored
 * rows (all fixedObjects rebuilds) offer NOTHING outside SANDBOX authoring —
 * no move, no delete, no unpin, no un-anchor — while player-authored
 * pinned/anchored/movable parts keep their own affordances (a player may
 * still pin/unpin their own parts in EDITING).
 *
 * Seams under test:
 * - partHandleState / selectionHandleSet (the shared policy table).
 * - levelObjectOptions stamps isScene on every fixedObjects rebuild seam.
 * - BaseObject round-trip: serialize writes isScene explicitly (true AND
 *   false) so a row's scene-ness is decided; deserialize restores it.
 * - restorePlacedFromSnapshot's level-branch skip rule: newly marked scene
 *   rows skip, legacy rows keep the old furniture rule, and a player-pinned
 *   part (isFixed:true, isScene:false) survives a play/reset rebuild.
 */

import { describe, it, expect } from 'vitest';
import Ball from '../js/objects/Ball.js';
import Bucket from '../js/objects/Bucket.js';
import Ramp from '../js/objects/Ramp.js';
import { objectRegistry } from '../js/objects/ObjectRegistry.js';
import { registerAllObjects } from '../js/objects/registerAllObjects.js';
import {
    SELECTION_HANDLES,
    isAnchorCapable,
    levelObjectOptions,
    partHandleState,
    selectionHandleSet,
} from '../js/ui/selectionHandles.js';
import { restorePlacedFromSnapshot } from '../js/reset/levelReset.js';

registerAllObjects();

const SCENE_BUCKET_ROW = { type: 'bucket', x: 700, y: 480, angle: 0, id: 'bucket-goal' };
const ANCHORED_BALL_ROW = { type: 'ball', x: 608, y: 289, angle: 0, isFixed: false, isAnchored: true, options: { variant: 'bowling' } };

describe('part state classification (ADR 0009)', () => {
    it('scene classification beats the pin flags', () => {
        const scene = objectRegistry.create('bucket', 100, 100, levelObjectOptions(SCENE_BUCKET_ROW));
        scene.isFixed = true;
        expect(partHandleState(scene)).toBe('scene');

        const anchoredSceneBall = objectRegistry.create('ball', 100, 100, levelObjectOptions(ANCHORED_BALL_ROW));
        expect(partHandleState(anchoredSceneBall)).toBe('scene');
    });

    it('part states still classify without the scene flag', () => {
        const pinned = new Bucket(100, 100, { isFixed: true });
        expect(partHandleState(pinned)).toBe('pinned');
        const anchored = new Ball(100, 100, { isAnchored: true });
        expect(partHandleState(anchored)).toBe('anchored');
        const movable = new Ball(100, 100, {});
        expect(partHandleState(movable)).toBe('movable');
    });
});

describe('selectionHandleSet: scene parts are locked outside sandbox authoring', () => {
    it('a scene part offers NO handles in every player posture (the level-06 cheat closes)', () => {
        // The exact shape of level-06's authored anchored ball
        const ball = objectRegistry.create('ball', 100, 100, levelObjectOptions(ANCHORED_BALL_ROW));
        for (const posture of ['EDITING', 'PLAYING', 'PAUSED', 'WON', 'MENU', null]) {
            expect(selectionHandleSet(ball, posture)).toEqual([]);
        }
    });

    it('a scene part keeps the FULL handle set in sandbox authoring (#66/#67 stand)', () => {
        const bucket = objectRegistry.create('bucket', 100, 100, levelObjectOptions(SCENE_BUCKET_ROW));
        expect(selectionHandleSet(bucket, 'SANDBOX')).toEqual(SELECTION_HANDLES);
    });

    it('a player-authored pinned part keeps its unpin escape outside sandbox', () => {
        const pinned = new Bucket(100, 100, { isFixed: true }); // no scene stamp
        expect(selectionHandleSet(pinned, 'EDITING')).toEqual(['pin']);
        expect(selectionHandleSet(pinned, 'SANDBOX')).toEqual(SELECTION_HANDLES);
    });

    it('a player-authored anchored part keeps its un-anchor escape outside sandbox', () => {
        const anchored = new Ball(100, 100, { isAnchored: true }); // no scene stamp
        expect(selectionHandleSet(anchored, 'EDITING')).toEqual(['anchor']);
        expect(selectionHandleSet(anchored, 'SANDBOX')).toEqual(SELECTION_HANDLES);
    });

    it('a movable player part offers everything everywhere (building a machine IS the puzzle)', () => {
        const movable = new Ball(100, 100, {});
        for (const posture of ['SANDBOX', 'EDITING', 'PLAYING', null]) {
            expect(selectionHandleSet(movable, posture)).toEqual(SELECTION_HANDLES);
        }
    });

    it('rope-family parts still never offer the anchor handle (issue #67 scope)', () => {
        // anchor capability is type-keyed; a scene row of a rope-family type
        // must stay anchorless wherever the row lands (nothing ships rope
        // scenery today, but the rule must not regress silently).
        // isAnchorCapableType is exported and rope types come from the family list.
        expect(isAnchorCapable('rope')).toBe(false);
        expect(isAnchorCapable('free-rope')).toBe(false);
    });
});

describe('levelObjectOptions stamps scene authorship on the rebuild seams', () => {
    it('every fixedObjects row rebuilds as scene content', () => {
        const opts = levelObjectOptions(ANCHORED_BALL_ROW);
        expect(opts.isScene).toBe(true);
        // legacy row (no explicit isFixed) stays forced-fixed ...
        expect(levelObjectOptions(SCENE_BUCKET_ROW).isFixed).toBe(true);
        // and an anchored row carries its anchor mark
        expect(opts.isAnchored).toBe(true);
        expect(opts.isFixed).toBe(false);
        expect(opts.customId).toBeUndefined();
        expect(levelObjectOptions({ type: 'bucket', x: 1, y: 2, id: 'bucket-goal' }).customId).toBe('bucket-goal');
    });
});

describe('isScene round-trips through serialize/deserialize', () => {
    it('serialize writes isScene explicitly (true AND false)', () => {
        const scene = objectRegistry.create('bucket', 100, 100, levelObjectOptions(SCENE_BUCKET_ROW));
        expect(scene.serialize().isScene).toBe(true);

        const player = new Ramp(100, 100, { angle: 0.2 });
        expect(player.serialize().isScene).toBe(false);
    });

    it('deserialize restores the marking for scene and player parts', () => {
        const scene = objectRegistry.create('ramp', 100, 100, levelObjectOptions({ type: 'ramp', x: 100, y: 100, angle: 0.2 }));
        const restoredScene = Ramp.deserialize({ ...scene.serialize() });
        expect(restoredScene.isScene).toBe(true);

        const player = new Ball(100, 100, {});
        const restoredPlayer = Ball.deserialize({ ...player.serialize() });
        expect(restoredPlayer.isScene).toBe(false);
        expect(restoredPlayer.isFixed).toBe(false);
    });
});

describe('restorePlacedFromSnapshot: the skip rule keys on scene authorship', () => {
    it('skips scene-marked rows, keeps the legacy furniture rule, and restores player-authored pinned parts', () => {
        // A play-start style snapshot: level furniture rows + a player part
        // the player pinned mid-session + an ordinary placed part.
        const sceneRow = objectRegistry.create('bucket', 700, 480, levelObjectOptions(SCENE_BUCKET_ROW)).serialize();
        const legacyRow = new Bucket(400, 300, { isFixed: true }).serialize(); // pre-ADR-0009 shape: no isScene key
        delete legacyRow.isScene;
        const playerPinnedRow = new Ramp(200, 200, { isFixed: true }).serialize(); // isScene:false present
        const placedRow = new Ball(300, 100, {}).serialize();

        const board = [];
        restorePlacedFromSnapshot(board, [sceneRow, legacyRow, playerPinnedRow, placedRow]);

        // Scene row (explicit marker): skipped — rebuilt from level JSON elsewhere.
        // Legacy row (no key, isFixed): skipped — old furniture behavior stands.
        // Player-pinned row (isScene:false): RESTORED — the player keeps their
        // pinned part across a play/reset rebuild.
        // Placed row: restored as before.
        expect(board.length).toBe(2);
        expect(board.some((b) => b.type === 'ramp' && b.isFixed && !b.isScene)).toBe(true); // the player's pinned ramp
        expect(board.some((b) => b.type === 'ball')).toBe(true);
    });
});
