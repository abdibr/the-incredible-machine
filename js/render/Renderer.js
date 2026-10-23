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
import { ROPE_SNAP_RADIUS, ROPE_ATTRACT_RADIUS } from '../objects/Rope.js';

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
        eventBus.on('mode:changed', ({ newMode }) => {
            this._mode = newMode;
            if (newMode === 'PLAYING' || newMode === 'PAUSED') {
                this.selectedObject = null;
            }
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

        // 3. Draw all placed objects
        for (const obj of objs) {
            ctx.save();
            obj.draw(ctx);
            ctx.restore();
        }

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

        // 5.5. Rope snap hints (issue 04): while a rope hangs on the cursor,
        // every board attachment point shows a marker; points this ghost's
        // endpoints would tie (same clamped layout a drop will lay, within
        // ROPE_SNAP_RADIUS) glow bright with a tie-line to that endpoint.
        // The object-side mirror: while a knot-bearing part (balloon knot,
        // bucket rim, …) hangs on the cursor, every board rope endpoint
        // shows the same reach markers.
        if (this._ghostObj
            && this.ghostState
            && (this._mode === 'EDITING' || this._mode === 'SANDBOX')) {
            if (this._ghostObj.type === 'rope') {
                this._drawRopeSnapHints(ctx, objs, this._ghostObj);
            } else if (this._ghostObj.attachmentPoints?.length) {
                this._drawRopeEndpointHints(ctx, objs, this._ghostObj);
            }
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
     * @returns {'move'|'rotate'|'delete'|null}
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
        }

        ctx.restore();
    }

    _getHandlePositions(obj) {
        const b = obj.bounds;
        return [
            ['move', b.x + b.width / 2, b.y - 14],
            ['rotate', b.x + b.width + 14, b.y + b.height / 2],
            ['delete', b.x - 14, b.y + b.height / 2],
        ];
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
            if (obj.type !== 'rope' || typeof obj.getAttachmentRefs !== 'function') continue;
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
     * Rope-placement hints (issue 04): while a rope ghost hangs on the
     * cursor, mark every board attachment point. Points within
     * ROPE_SNAP_RADIUS of one of the ghost's two endpoints — the same
     * clamped layout a drop will lay, because the ghost received the
     * placement clamp — get a bright filled ring and a tie-line from that
     * endpoint; the rest stay faint dashed. The drop will then knot exactly
     * what glows (see DragDropManager._snapRopeEndpoints).
     * @param {CanvasRenderingContext2D} ctx
     * @param {BaseObject[]} objs
     * @param {import('../objects/Rope.js').default} ghost — rope object on the cursor
     * @private
     */
    _drawRopeSnapHints(ctx, objs, ghost) {
        const bodies = ghost.bodies;
        if (!bodies.length) return;
        const endpoints = [bodies[0].position, bodies[bodies.length - 1].position];

        ctx.save();
        for (const target of objs) {
            if (target === ghost) continue;
            for (const point of target.attachmentPoints ?? []) {
                const world = target.getAttachmentWorldPoint(point.id);
                if (!world) continue;

                let tiesThrough = null;
                for (const end of endpoints) {
                    if (Math.hypot(world.x - end.x, world.y - end.y) <= ROPE_SNAP_RADIUS) {
                        tiesThrough = end;
                        break;
                    }
                }

                ctx.beginPath();
                ctx.arc(world.x, world.y, tiesThrough ? 7 : 4, 0, Math.PI * 2);
                if (tiesThrough) {
                    ctx.fillStyle = 'rgba(64, 192, 64, 0.35)';
                    ctx.fill();
                }
                ctx.strokeStyle = tiesThrough ? '#2f9e2f' : 'rgba(122, 106, 38, 0.8)';
                ctx.setLineDash(tiesThrough ? [] : [3, 3]);
                ctx.lineWidth = tiesThrough ? 2 : 1.5;
                ctx.stroke();
                ctx.setLineDash([]);
                if (tiesThrough) {
                    ctx.beginPath();
                    ctx.moveTo(tiesThrough.x, tiesThrough.y);
                    ctx.lineTo(world.x, world.y);
                    ctx.strokeStyle = '#2f9e2f';
                    ctx.stroke();
                }
            }
        }
        ctx.restore();
    }

    /**
     * Object-placement hints (issue 04, the mirror of _drawRopeSnapHints):
     * while a knot-bearing part (balloon knot, bucket rim, …) hangs on the
     * cursor, mark every board rope's tying endpoints — the same clamped
     * layout a drop will land, because the ghost received the placement
     * clamp. With the pull-to-tie seam (ADR 0005 decision 11) an endpoint
     * glows bright (filled ring + tie-line) when the drop will tie it: it
     * sits within ROPE_SNAP_RADIUS of a knot, or it is the one endpoint the
     * drop gets pulled onto from within ROPE_ATTRACT_RADIUS. The rest stay
     * faint dashed. The drop will then knot exactly what glows (see
     * DragDropManager._snapObjectToRopes).
     * @param {CanvasRenderingContext2D} ctx
     * @param {BaseObject[]} objs
     * @param {import('../objects/BaseObject.js').default} ghost — knot-bearing object on the cursor
     * @private
     */
    _drawRopeEndpointHints(ctx, objs, ghost) {
        const knots = (ghost.attachmentPoints ?? []).map((point) => (
            ghost.getAttachmentWorldPoint(point.id)
        )).filter(Boolean);
        if (!knots.length) return;

        ctx.save();
        // Board endpoints are collected first: the pull-to-tie attract is
        // chosen globally (one winner per drop), so the bright/faint
        // decision must see every candidate, not one rope at a time.
        const ends = [];
        for (const obj of objs) {
            if (obj === ghost || obj.type !== 'rope' || obj.isSevered) continue;
            const bodies = obj.bodies;
            if (!bodies[0]) continue; // disposed rope
            ends.push(bodies[0].position, bodies[bodies.length - 1].position);
        }

        // The drop knots exactly what glows (DragDropManager._snapObjectToRopes):
        // an endpoint within ROPE_SNAP_RADIUS of a knot ties as laid, and the
        // single nearest endpoint within ROPE_ATTRACT_RADIUS is the one the
        // drop will be pulled onto — both glow bright.
        let best = null;
        for (const end of ends) {
            for (const knot of knots) {
                const dist = Math.hypot(knot.x - end.x, knot.y - end.y);
                if (dist > ROPE_ATTRACT_RADIUS) continue;
                if (!best || dist < best.dist) best = { end, knot, dist };
            }
        }

        for (const end of ends) {
            let tiesTo = null;
            for (const knot of knots) {
                if (Math.hypot(knot.x - end.x, knot.y - end.y) <= ROPE_SNAP_RADIUS) {
                    tiesTo = knot;
                    break;
                }
            }
            if (!tiesTo && best && best.end === end) tiesTo = best.knot;

            ctx.beginPath();
            ctx.arc(end.x, end.y, tiesTo ? 7 : 4, 0, Math.PI * 2);
            if (tiesTo) {
                ctx.fillStyle = 'rgba(64, 192, 64, 0.35)';
                ctx.fill();
            }
            ctx.strokeStyle = tiesTo ? '#2f9e2f' : 'rgba(122, 106, 38, 0.8)';
            ctx.setLineDash(tiesTo ? [] : [3, 3]);
            ctx.lineWidth = tiesTo ? 2 : 1.5;
            ctx.stroke();
            ctx.setLineDash([]);
            if (tiesTo) {
                ctx.beginPath();
                ctx.moveTo(end.x, end.y);
                ctx.lineTo(tiesTo.x, tiesTo.y);
                ctx.strokeStyle = '#2f9e2f';
                ctx.stroke();
            }
        }
        ctx.restore();
    }

    /**
     * The click-to-connect squares (ADR 0007 decision 2): rope endpoint
     * handles, attachment-point target squares, and — while a seek is in
     * flight — the preview line to the cursor and the glow on every valid
     * target. Edit modes only (EDITING/SANDBOX): gates itself so PLAY
     * boards draw nothing, exactly like the proximity hints above.
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

        // Target squares: glow green during a seek (every target is valid —
        // click to tie), faint on bare hover.
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
        // seeking square lights up (handle blue), a free square is
        // hover-revealed (white).
        for (const square of squares) {
            if (!square.visible) continue;
            ctx.fillStyle = square.seeking
                ? 'rgba(64, 128, 255, 0.9)'
                : square.tied
                    ? 'rgba(184, 134, 11, 0.85)'
                    : 'rgba(255, 255, 255, 0.8)';
            ctx.strokeStyle = square.seeking
                ? '#4080ff'
                : square.tied
                    ? '#8a6508'
                    : '#777';
            ctx.lineWidth = 1.5;
            ctx.fillRect(square.x - 7, square.y - 7, 14, 14);
            ctx.strokeRect(square.x - 7, square.y - 7, 14, 14);
        }

        ctx.restore();
    }
}

/** Singleton renderer instance */
export const renderer = new Renderer();
export default Renderer;
