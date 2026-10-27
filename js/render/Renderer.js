/**
 * Renderer — Canvas 2D drawing orchestrator
 *
 * Manages the <canvas> element, draws all game objects each frame,
 * handles selection UI and ghost drag previews, and provides
 * hit-testing for click-to-select.
 */

import { eventBus } from '../EventBus.js';
import { objectRegistry } from '../objects/ObjectRegistry.js';
import { clampObjectToPlayfield } from '../objects/BaseObject.js';
import { resolveGoalZoneObject } from '../goals/GoalChecker.js';
import { ROPE_TOO_SHORT } from '../ui/ConnectFlow.js';
import { selectionHandleSet } from '../ui/selectionHandles.js';

/**
 * The anchor color (issue #67): the handle dot and the field badge share it —
 * violet, visibly distinct from the amber pin.
 */
const ANCHOR_COLOR = '#7a52c7';

/**
 * Fixed on-canvas slots for the selection handles, relative to the part's
 * `bounds`: move above the bounds, rotate to its right, delete to its
 * left, pin below (the pin slot mirroring the move slot). The offered
 * NAMES come from the state-driven selectionHandles table (issue #68);
 * this maps each name to its slot.
 */
const HANDLE_SLOTS = Object.freeze({
    move: (b) => [b.x + b.width / 2, b.y - 14],
    rotate: (b) => [b.x + b.width + 14, b.y + b.height / 2],
    delete: (b) => [b.x - 14, b.y + b.height / 2],
    pin: (b) => [b.x + b.width / 2, b.y + b.height + 14],
    anchor: (b) => [b.x + b.width / 2, b.y + b.height + 32], // stacked below the pin
});

class Renderer {
    constructor() {
        /** @type {HTMLCanvasElement} */
        this.canvas = null;
        /** @type {CanvasRenderingContext2D} */
        this.ctx = null;

        /** Currently selected object (or null) */
        this.selectedObject = null;

        /** Drag ghost state: { type, x, y } or null */
        this.ghostState = null;

        /** Ghost object instance for drawing */
        this._ghostObj = null;

        /** Current application mode */
        this._mode = 'MENU';

        /** Connect-flow board (ADR 0007 decision 2), injected via setConnectFlow */
        this._connectFlow = null;

        /**
         * Current level goal (level JSON `goal` field), tracked the same seam
         * GoalChecker uses. Null in a goal-less sandbox (#63) — cleared on
         * SANDBOX entry so the GOAL-zone marker marks what the next Save
         * would stamp, never a stale zone from a previous visit (issue #66).
         * @type {object|null}
         */
        this._goal = null;

        /** Cursor canvas position for hover-reveal squares (set by DragDropManager) */
        this.hoverPoint = null;

        /** Objects list reference (set each frame) */
        this._objects = [];

        /** Animation frame ID */
        this._rafId = null;

        /** Playfield background color (TIM warm off-white) */
        this.BG_COLOR = '#e8e0d0';

        /** Selection handle colors */
        this.HANDLE_COLORS = {
            move: '#4080ff',
            rotate: '#40c040',
            delete: '#e04040',
            pin: '#c98c1c',
            anchor: ANCHOR_COLOR, // issue #67
        };
    }

    /**
     * Initialize the renderer with the canvas element.
     * @param {HTMLCanvasElement} canvas
     */
    init(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');

        // Listen for mode changes
        eventBus.on('mode:changed', ({ oldMode, newMode }) => {
            this._mode = newMode;
            if (newMode === 'PLAYING' || newMode === 'PAUSED') {
                this.selectedObject = null;
            }
            if (newMode === 'SANDBOX') {
                // Sandbox with no level load is goal-less (#63): drop a stale
                // level goal so the GOAL-zone marker marks what the next Save
                // would stamp, not a zone from a previous visit (issue #66).
                // A SANDBOX entry arriving from the run family (PLAYING/
                // PAUSED/WON) is the reset path returning to the posture the
                // run was born in — the same visit, so the loaded goal keeps
                // marking its zone (issue #71).
                const returningFromRun =
                    oldMode === 'PLAYING' || oldMode === 'PAUSED' || oldMode === 'WON';
                if (!returningFromRun) {
                    this._goal = null;
                }
            }
        });

        // Track the current level goal for the GOAL-zone marker (issue #66) —
        // the same level:loaded seam GoalChecker re-arms on.
        eventBus.on('level:loaded', (levelData) => {
            this._goal = levelData?.goal ?? null;
        });

        // Listen for object selection
        eventBus.on('object:selected', (obj) => {
            this.selectedObject = obj;
        });

        // Listen for drag ghost
        eventBus.on('drag:ghost-update', (state) => {
            this.ghostState = state;
            if (state && state.type) {
                try {
                    if (!this._ghostObj || this._ghostObj.type !== state.type) {
                        this._ghostObj = objectRegistry.create(state.type, state.x, state.y);
                    } else {
                        this._ghostObj.setPosition(state.x, state.y);
                    }
                } catch (e) {
                    this._ghostObj = null;
                }
            } else {
                this._ghostObj = null;
            }
        });

        eventBus.on('drag:ghost-clear', () => {
            this.ghostState = null;
            this._ghostObj = null;
        });

        console.log('[Renderer] Initialized');
    }

    /**
     * Set the objects list to render each frame.
     * @param {BaseObject[]} objects
     */
    setObjects(objects) {
        this._objects = objects;
    }

    /**
     * Wire the click-to-connect flow this renderer draws from — the same
     * instance the drag-drop handler delegates square clicks to.
     * @param {import('../ui/ConnectFlow.js').default|null} flow
     */
    setConnectFlow(flow) {
        this._connectFlow = flow;
    }

    /**
     * Main render call — draw one frame.
     * @param {BaseObject[]} [objects] - Optional override
     */
    render(objects) {
        const objs = objects || this._objects;
        const ctx = this.ctx;
        const w = this.canvas.width;
        const h = this.canvas.height;

        // 1. Clear with background
        ctx.fillStyle = this.BG_COLOR;
        ctx.fillRect(0, 0, w, h);

        // 2. Draw subtle grid for visual reference (edit/sandbox mode only)
        if (this._mode === 'EDITING' || this._mode === 'SANDBOX') {
            this._drawGrid(ctx, w, h);
        }

        // 2.5. Draw the playfield boundary lines (floor + side walls), every
        // frame and in every mode: the physics boundary walls coincide with
        // the world edges (the boundary floor's top edge is exactly y = h),
        // so drawing them keeps the limits of the play area visible.
        this._drawBoundaries(ctx, w, h);

        // 3. Draw all placed objects. Each object draws inside its own
        // guard: one misbehaving part — e.g. a disposed-but-still-boarded
        // zombie crashing on its nulled bodies, as the sandbox reset used to
        // leave behind (bug-20261025T193755Z, Bug B) — must not kill the
        // whole frame and, with it, every other object's paint. save/restore
        // are bracketed in finally so a throwing draw cannot leak a
        // transform/clip state that shifts all subsequent painting; the
        // failure is logged, not swallowed silently.
        for (const obj of objs) {
            ctx.save();
            try {
                obj.draw(ctx);
            } catch (e) {
                console.error(`[Renderer] draw failed for ${obj?.type ?? 'object'} #${obj?.id ?? '?'}:`, e);
            } finally {
                ctx.restore();
            }
        }

        this._drawAnchorBadges(ctx, objs);

        // 4. Draw selection handles on the selected object (edit modes only)
        if (this.selectedObject && (this._mode === 'EDITING' || this._mode === 'SANDBOX')) {
            this._drawSelectionHandles(ctx, this.selectedObject);
        }

        // 4.5. Rope knot markers (issue 04, edit modes only): a small ring
        // on every attachment point a rope is tied to, so ties survive as
        // visible machine structure between play cycles.
        if (this._mode === 'EDITING' || this._mode === 'SANDBOX') {
            this._drawRopeKnots(ctx, objs);
        }

        // 4.6. Goal-zone marker (issue #66, edit modes only): highlight the
        // object that plays the win zone — a loaded level's goal.zoneId
        // bucket, or in sandbox the bucket Save would stamp. The drawer
        // gates itself, so PLAY boards draw nothing.
        this._drawGoalZoneMarker(ctx, objs);

        // 5. Draw drag ghost
        if (this._ghostObj && this.ghostState) {
            ctx.save();
            ctx.globalAlpha = 0.5;
            // Preview exactly where the part will land — same clamp the
            // placement applies on mouseup, so the ghost never hangs over
            // the boundary walls during the drag.
            const gpos = clampObjectToPlayfield(
                this._ghostObj, this.ghostState.x, this.ghostState.y, w, h
            );
            this._ghostObj.setPosition(gpos.x, gpos.y);
            this._ghostObj.draw(ctx);
            ctx.restore();
        }

        // 5.6. Click-to-connect squares (ADR 0007 decision 2): rope endpoint
        // handles, target squares, seek preview and glow — edit modes only
        // (the drawer gates itself, so PLAY boards draw nothing).
        this._drawConnectSquares(ctx, objs);
    }

    /**
     * Start the render loop.
     */
    startLoop() {
        const loop = () => {
            this.render();
            this._rafId = requestAnimationFrame(loop);
        };
        this._rafId = requestAnimationFrame(loop);
    }

    /**
     * Stop the render loop.
     */
    stopLoop() {
        if (this._rafId) {
            cancelAnimationFrame(this._rafId);
            this._rafId = null;
        }
    }

    /**
     * Hit-test: find the topmost object at a canvas point.
     * @param {number} x - Canvas x
     * @param {number} y - Canvas y
     * @param {BaseObject[]} [objects]
     * @returns {BaseObject|null}
     */
    getObjectAtPoint(x, y, objects) {
        const objs = objects || this._objects;
        // Iterate in reverse so topmost (last-drawn) objects are tested first
        for (let i = objs.length - 1; i >= 0; i--) {
            const obj = objs[i];
            const b = obj.bounds;
            if (x >= b.x && x <= b.x + b.width &&
                y >= b.y && y <= b.y + b.height) {
                return obj;
            }
        }
        return null;
    }

    /**
     * Convert page coordinates to canvas coordinates.
     * @param {number} pageX
     * @param {number} pageY
     * @returns {{ x: number, y: number }}
     */
    pageToCanvas(pageX, pageY) {
        const rect = this.canvas.getBoundingClientRect();
        const scaleX = this.canvas.width / rect.width;
        const scaleY = this.canvas.height / rect.height;
        return {
            x: (pageX - rect.left) * scaleX,
            y: (pageY - rect.top) * scaleY,
        };
    }

    /**
     * Get the selection handle hit at a canvas point.
     * @param {number} x
     * @param {number} y
     * @returns {'move'|'rotate'|'delete'|'pin'|'anchor'|null}
     */
    getHandleAtPoint(x, y) {
        if (!this.selectedObject) return null;
        const handles = this._getHandlePositions(this.selectedObject);
        for (const [name, hx, hy] of handles) {
            const dx = x - hx, dy = y - hy;
            if (dx * dx + dy * dy <= 12 * 12) {
                return name;
            }
        }
        return null;
    }

    // ── Private helpers ──────────────────────────

    _drawGrid(ctx, w, h) {
        ctx.save();
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.04)';
        ctx.lineWidth = 1;
        const step = 40;
        for (let x = step; x < w; x += step) {
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, h);
            ctx.stroke();
        }
        for (let y = step; y < h; y += step) {
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(w, y);
            ctx.stroke();
        }
        ctx.restore();
    }

    /**
     * Draw the playfield boundary: a solid ground line along the bottom edge
     * (the physics floor's top edge coincides with y = h, so objects resting
     * on the floor sit on this line) plus subtle lines marking the side walls
     * and the ceiling, so the limits of the play area are visible.
     * @param {CanvasRenderingContext2D} ctx
     * @param {number} w - canvas width (world px)
     * @param {number} h - canvas height (world px)
     */
    _drawBoundaries(ctx, w, h) {
        ctx.save();

        // Ground — a solid line exactly at the floor surface, with a faint
        // support band above it for depth
        ctx.fillStyle = 'rgba(90, 81, 66, 0.25)';
        ctx.fillRect(0, h - 6, w, 6);
        ctx.strokeStyle = '#5a5142';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(0, h - 1.5);
        ctx.lineTo(w, h - 1.5);
        ctx.stroke();

        // Side walls + ceiling — 1px subtle lines at the world edges
        ctx.strokeStyle = 'rgba(64, 64, 64, 0.35)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0.5, 0);
        ctx.lineTo(0.5, h);
        ctx.moveTo(w - 0.5, 0);
        ctx.lineTo(w - 0.5, h);
        ctx.moveTo(0, 0.5);
        ctx.lineTo(w, 0.5);
        ctx.stroke();

        ctx.restore();
    }

    /**
     * Draw the dashed selection box plus the offered selection handles —
     * the offered set is state-driven (issue #68): _getHandlePositions
     * derives it from the shared selectionHandles table.
     * @param {CanvasRenderingContext2D} ctx
     * @param {BaseObject} obj - the selected object
     * @private
     */
    _drawSelectionHandles(ctx, obj) {
        const b = obj.bounds;

        // Dashed selection box
        ctx.save();
        ctx.strokeStyle = '#ffd700';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(b.x - 4, b.y - 4, b.width + 8, b.height + 8);
        ctx.setLineDash([]);

        // Handles
        const handles = this._getHandlePositions(obj);
        for (const [name, hx, hy] of handles) {
            ctx.beginPath();
            ctx.arc(hx, hy, 8, 0, Math.PI * 2);
            ctx.fillStyle = this.HANDLE_COLORS[name];
            ctx.fill();
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 2;
            ctx.stroke();

            // Icons inside handles
            ctx.fillStyle = '#fff';
            ctx.font = 'bold 10px Arial';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            if (name === 'move') ctx.fillText('✥', hx, hy);
            else if (name === 'rotate') ctx.fillText('↻', hx, hy);
            else if (name === 'delete') ctx.fillText('✕', hx, hy);
            // The pin handle (issue #66 follow-up): amber dot + pushpin —
            // click toggles the object's pinned state.
            else if (name === 'pin') ctx.fillText('📌', hx, hy);
            // The anchor handle (issue #67): violet dot + anchor — click
            // toggles the object's anchored state.
            else if (name === 'anchor') ctx.fillText('⚓', hx, hy);
        }

        ctx.restore();
    }

    /**
     * The selection handles offered for an object, in draw order, as
     * [name, hx, hy] slots. The offered set is state-driven (issue #68):
     * derived from the part's state × the stage posture via the shared
     * selectionHandles table — the same rows getHandleAtPoint filters
     * over and the drag-drop manager gates its verbs against, so draw,
     * hit-test and interaction can never disagree. Issue #67's anchored
     * parts extend that table without touching this method.
     * @param {BaseObject} obj
     * @returns {Array<[string, number, number]>} [name, x, y] slots
     * @private
     */
    _getHandlePositions(obj) {
        const b = obj.bounds;
        return selectionHandleSet(obj, this._mode)
            .map((name) => [name, ...HANDLE_SLOTS[name](b)]);
    }

    /**
     * Draw a small ring on every attachment point a rope is tied to
     * (issue 04, edit modes only): knots show as machine structure while
     * editing and are realized physically by the engine at play.
     * @param {CanvasRenderingContext2D} ctx
     * @param {BaseObject[]} objs
     * @private
     */
    _drawRopeKnots(ctx, objs) {
        ctx.save();
        for (const obj of objs) {
            if ((obj.type !== 'rope' && obj.type !== 'free-rope') || typeof obj.getAttachmentRefs !== 'function') continue;
            for (const ref of obj.getAttachmentRefs()) {
                const world = ref.target.getAttachmentWorldPoint?.(ref.pointId);
                if (!world) continue;
                ctx.beginPath();
                ctx.arc(world.x, world.y, 7, 0, Math.PI * 2);
                ctx.fillStyle = 'rgba(184, 134, 11, 0.35)';
                ctx.fill();
                ctx.strokeStyle = '#8a6508';
                ctx.lineWidth = 2;
                ctx.stroke();
                // Solid core — the ring reads as a knot, not a decoration
                ctx.beginPath();
                ctx.arc(world.x, world.y, 2, 0, Math.PI * 2);
                ctx.fillStyle = '#8a6508';
                ctx.fill();
            }
        }
        ctx.restore();
    }

    /**
     * The click-to-connect squares (ADR 0007 decision 2): rope endpoint
     * handles, attachment-point target squares, and — while a seek is in
     * flight — the preview line to the cursor and the glow on in-reach
     * targets (glow = tieable, issue #54). A refused tie flashes its
     * seeking handle red plus a "rope too short" badge at the refused aim.
     * Edit modes only (EDITING/SANDBOX): gates itself so PLAY
     * boards draw nothing.
     *
     * Geometry comes from the flow (getEndpointSquares/getTieSquares — one
     * source for clicks and pixels); this method only paints it.
     * @param {CanvasRenderingContext2D} ctx
     * @param {BaseObject[]} objs
     * @private
     */
    _drawConnectSquares(ctx, objs) {
        if (this._mode !== 'EDITING' && this._mode !== 'SANDBOX') return;
        if (!this._connectFlow) return;
        const squares = this._connectFlow.getEndpointSquares(objs, this.hoverPoint);
        const targets = this._connectFlow.getTieSquares(objs, this.hoverPoint);

        ctx.save();

        // The seek preview: the seeking square aims a dashed tie-green line
        // at the cursor.
        const seeking = squares.find((s) => s.seeking);
        if (seeking && this._connectFlow.preview) {
            ctx.beginPath();
            ctx.moveTo(seeking.x, seeking.y);
            ctx.lineTo(this._connectFlow.preview.x, this._connectFlow.preview.y);
            ctx.strokeStyle = '#2f9e2f';
            ctx.lineWidth = 2;
            ctx.setLineDash([6, 4]);
            ctx.stroke();
            ctx.setLineDash([]);
        }

        // Target squares: glow green during a seek when in reach (glow =
        // tieable, issue #54), faint on bare hover.
        for (const target of targets) {
            if (!target.visible) continue;
            const half = target.glows ? 9 : 7;
            ctx.fillStyle = target.glows
                ? 'rgba(64, 192, 64, 0.25)'
                : 'rgba(64, 192, 64, 0.08)';
            ctx.strokeStyle = target.glows
                ? '#2f9e2f'
                : 'rgba(47, 158, 47, 0.5)';
            ctx.lineWidth = target.glows ? 2 : 1;
            ctx.fillRect(target.x - half, target.y - half, half * 2, half * 2);
            ctx.strokeRect(target.x - half, target.y - half, half * 2, half * 2);
        }

        // Rope endpoint squares on top: tied structure persists (gold), a
        // seeking square lights up (handle blue) or flashes red while its
        // last tie click was refused (issue #54), a free square is
        // hover-revealed (white).
        for (const square of squares) {
            if (!square.visible) continue;
            // Refused-tie flash (ADR 0007 decision 4, issue #54): the
            // seeking handle goes red for the flash duration.
            ctx.fillStyle = square.refused
                ? 'rgba(232, 76, 76, 0.9)'
                : square.seeking
                    ? 'rgba(64, 128, 255, 0.9)'
                    : square.tied
                        ? 'rgba(184, 134, 11, 0.85)'
                        : 'rgba(255, 255, 255, 0.8)';
            ctx.strokeStyle = square.refused
                ? '#e34e4e'
                : square.seeking
                    ? '#4080ff'
                    : square.tied
                        ? '#8a6508'
                        : '#777';
            ctx.lineWidth = 1.5;
            ctx.fillRect(square.x - 7, square.y - 7, 14, 14);
            ctx.strokeRect(square.x - 7, square.y - 7, 14, 14);
        }

        // Refused-tie badge (ADR 0007 decision 4, issue #54): "rope too
        // short" marks the refused aim while the flash lives.
        const refusal = this._connectFlow.refusal;
        if (refusal) {
            ctx.font = 'bold 12px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillStyle = 'rgba(40, 12, 12, 0.9)';
            ctx.strokeStyle = '#e34e4e';
            ctx.lineWidth = 1;
            ctx.fillRect(refusal.x - 52, refusal.y + 10, 104, 18);
            ctx.strokeRect(refusal.x - 52, refusal.y + 10, 104, 18);
            ctx.fillStyle = '#ffd9d9';
            ctx.fillText(ROPE_TOO_SHORT, refusal.x, refusal.y + 23);
        }

        ctx.restore();
    }

    /**
     * The anchored-part badge (issue #67): a violet ⚓ dot at each anchored
     * part's top-right bounds corner — the distinguishing field marker,
     * visibly distinct from the amber 📌 pin affordance. Edit modes only
     * (EDITING/SANDBOX): the author audits what Save will keep and the
     * player sees which scenery refuses to move, while during play an
     * anchored part is just a part.
     * @private
     * @param {CanvasRenderingContext2D} ctx
     * @param {BaseObject[]} objs
     */
    _drawAnchorBadges(ctx, objs) {
        if (this._mode !== 'EDITING' && this._mode !== 'SANDBOX') return;
        for (const obj of objs) {
            if (!obj.isAnchored) continue;
            const b = obj.bounds;
            const cx = b.x + b.width;
            const cy = b.y;
            ctx.beginPath();
            ctx.arc(cx, cy, 7, 0, Math.PI * 2);
            ctx.fillStyle = ANCHOR_COLOR;
            ctx.fill();
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 1.5;
            ctx.stroke();
            ctx.font = 'bold 9px Arial';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = '#fff';
            ctx.fillText('⚓', cx, cy);
        }
    }

    /**
     * The GOAL-zone marker (issue #66): a dashed frame plus a "GOAL" caption
     * around the object that plays the win zone, answering "reach the zone…
     * what zone?" on the playfield itself. Two honest semantics:
     * - a loaded level marks only the object matching `goal.zoneId` — what
     *   GoalChecker can actually win on (nothing, if the zone is gone);
     * - a goal-less sandbox (#63) marks the unnamed bucket the next Save
     *   would stamp — the implied default zone.
     * Edit modes (EDITING/SANDBOX) only, nothing in PLAY.
     * @private
     * @param {CanvasRenderingContext2D} ctx
     * @param {BaseObject[]} objs
     */
    _drawGoalZoneMarker(ctx, objs) {
        if (this._mode !== 'EDITING' && this._mode !== 'SANDBOX') return;
        const stampFallback = this._mode === 'SANDBOX' && !this._goal;
        const zone = resolveGoalZoneObject(objs, this._goal, { stampFallback });
        if (!zone) return;

        const b = zone.bounds;
        ctx.save();
        ctx.strokeStyle = '#2f9e2f';
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 4]);
        ctx.strokeRect(b.x - 4, b.y - 4, b.width + 8, b.height + 8);
        ctx.setLineDash([]);
        ctx.font = 'bold 12px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = '#2f9e2f';
        ctx.fillText('GOAL', b.x + b.width / 2, b.y - 8);
        ctx.restore();
    }
}

/** Singleton renderer instance */
export const renderer = new Renderer();
export default Renderer;
