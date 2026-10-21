/**
 * DragDropManager — Central coordinator for drag-and-drop interactions
 *
 * Handles:
 * - Dragging items from the toolbox onto the canvas (ghost preview → placement)
 * - Clicking placed objects to select them
 * - Moving selected objects by dragging
 * - Rotating selected objects via handle
 * - Deleting selected objects (right-click or Delete key)
 *
 * Coordinates between the Toolbox (inventory) and Renderer (canvas).
 */

import { eventBus } from '../EventBus.js';
import { objectRegistry } from '../objects/ObjectRegistry.js';
import { renderer } from '../render/Renderer.js';
import { toolbox } from './Toolbox.js';
import { clampObjectToPlayfield } from '../objects/BaseObject.js';

class DragDropManager {
    constructor() {
        /** @type {BaseObject[]} — the live objects list (shared with renderer) */
        this._objects = [];

        /** Snap distance (px) for tying a placed rope endpoint to an attachment point (issue 04). */
        this.ROPE_SNAP_RADIUS = 24;

        /** Current edit mode */
        this._mode = 'MENU';
        this._enabled = false;

        /** Drag state */
        this._dragging = false;
        this._dragType = null;       // 'toolbox' | 'move' | 'rotate'
        this._dragObjType = null;    // object type from registry (for toolbox drags)
        this._dragObject = null;     // object being moved/rotated
        this._dragStartX = 0;
        this._dragStartY = 0;
        this._dragStartAngle = 0;

        /** @type {BaseObject|null} */
        this._selectedObject = null;
    }

    /**
     * Initialize drag-and-drop. Call after Renderer and Toolbox are initialized.
     * @param {BaseObject[]} objects — shared mutable array of placed objects
     */
    init(objects) {
        this._objects = objects;

        const canvas = renderer.canvas;

        // ── Toolbox drag start ──
        eventBus.on('toolbox:drag-start', ({ type, pageX, pageY }) => {
            if (!this._enabled) return;

            this._dragging = true;
            this._dragType = 'toolbox';
            this._dragObjType = type;

            // Set ghost at current cursor position
            const canvasPos = renderer.pageToCanvas(pageX, pageY);
            eventBus.emit('drag:ghost-update', { type, x: canvasPos.x, y: canvasPos.y });
        });

        // ── Canvas mousedown ──
        canvas.addEventListener('mousedown', (e) => {
            if (!this._enabled) return;
            if (e.button !== 0) return; // Left button only

            const pos = renderer.pageToCanvas(e.pageX, e.pageY);

            // Check for selection handle clicks first
            if (this._selectedObject) {
                const handle = renderer.getHandleAtPoint(pos.x, pos.y);
                if (handle === 'delete') {
                    this._deleteSelected();
                    return;
                }
                if (handle === 'move') {
                    this._startMoveObject(pos.x, pos.y);
                    return;
                }
                if (handle === 'rotate') {
                    this._startRotateObject(pos.x, pos.y);
                    return;
                }
            }

            // Check for clicking on an object
            const obj = renderer.getObjectAtPoint(pos.x, pos.y, this._objects);
            if (obj) {
                if (obj.isFixed) {
                    // Can't interact with fixed objects
                    this._selectObject(null);
                } else {
                    this._selectObject(obj);
                    this._startMoveObject(pos.x, pos.y);
                }
            } else {
                this._selectObject(null);
            }
        });

        // ── Global mousemove ──
        document.addEventListener('mousemove', (e) => {
            if (!this._dragging) return;

            const pos = renderer.pageToCanvas(e.pageX, e.pageY);

            if (this._dragType === 'toolbox') {
                eventBus.emit('drag:ghost-update', { type: this._dragObjType, x: pos.x, y: pos.y });
            } else if (this._dragType === 'move' && this._dragObject) {
                // Keep dragged parts fully inside the playfield — the static
                // boundary walls coincide with the world edges.
                const clamped = clampObjectToPlayfield(
                    this._dragObject, pos.x, pos.y,
                    renderer.canvas.width, renderer.canvas.height
                );
                this._dragObject.setPosition(clamped.x, clamped.y);
            } else if (this._dragType === 'rotate' && this._dragObject) {
                const objX = this._dragObject.x;
                const objY = this._dragObject.y;
                const angle = Math.atan2(pos.y - objY, pos.x - objX);
                this._dragObject.setAngle(angle);
                // Rotation can swing the footprint across a boundary edge —
                // keep the rotated AABB inside the playfield as well.
                const clamped = clampObjectToPlayfield(
                    this._dragObject, this._dragObject.x, this._dragObject.y,
                    renderer.canvas.width, renderer.canvas.height
                );
                if (clamped.x !== this._dragObject.x || clamped.y !== this._dragObject.y) {
                    this._dragObject.setPosition(clamped.x, clamped.y);
                }
            }
        });

        // ── Global mouseup ──
        document.addEventListener('mouseup', (e) => {
            if (!this._dragging) return;

            if (this._dragType === 'toolbox') {
                // Place the object at the drop position
                const pos = renderer.pageToCanvas(e.pageX, e.pageY);
                this._placeObject(this._dragObjType, pos.x, pos.y);
                eventBus.emit('drag:ghost-clear');
            } else if (this._dragType === 'move' && this._dragObject) {
                // A moved rope drags its knots off their points (issue 04):
                // untie at release — the drop-scan reconcile releases the
                // physical links on the next play.
                if (this._dragObject.type === 'rope') this._dragObject.clearAttachments();
                eventBus.emit('object:moved', {
                    id: this._dragObject.id,
                    x: this._dragObject.x,
                    y: this._dragObject.y,
                });
            }

            this._dragging = false;
            this._dragType = null;
            this._dragObjType = null;
            this._dragObject = null;
        });

        // ── Right-click to delete ──
        canvas.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            if (!this._enabled) return;

            const pos = renderer.pageToCanvas(e.pageX, e.pageY);
            const obj = renderer.getObjectAtPoint(pos.x, pos.y, this._objects);
            if (obj && !obj.isFixed) {
                this._selectObject(obj);
                this._deleteSelected();
            }
        });

        // ── Delete key ──
        document.addEventListener('keydown', (e) => {
            if (!this._enabled) return;
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

            if ((e.code === 'Delete' || e.code === 'Backspace') && this._selectedObject) {
                e.preventDefault();
                this._deleteSelected();
            }
        });

        // ── Mode changes ──
        eventBus.on('mode:changed', ({ newMode }) => {
            this._mode = newMode;
            this._enabled = (newMode === 'EDITING' || newMode === 'SANDBOX');

            if (!this._enabled) {
                this._selectObject(null);
                this._dragging = false;
                eventBus.emit('drag:ghost-clear');
            }
        });

        console.log('[DragDropManager] Initialized');
    }

    /**
     * Get the placed objects list.
     * @returns {BaseObject[]}
     */
    getObjects() {
        return this._objects;
    }

    /**
     * Clear all non-fixed placed objects.
     */
    clearPlacedObjects() {
        for (let i = this._objects.length - 1; i >= 0; i--) {
            if (!this._objects[i].isFixed) {
                this._objects[i].dispose();
                this._objects.splice(i, 1);
            }
        }
        this._selectObject(null);
    }

    /**
     * Set objects list (e.g. when loading a level).
     * @param {BaseObject[]} objects
     */
    setObjects(objects) {
        this._objects.length = 0;
        this._objects.push(...objects);
        renderer.setObjects(this._objects);
        this._selectObject(null);
    }

    // ── Private ──────────────────────────────────

    _selectObject(obj) {
        this._selectedObject = obj;
        renderer.selectedObject = obj;
        eventBus.emit('object:selected', obj);
    }

    _startMoveObject(x, y) {
        if (!this._selectedObject || this._selectedObject.isFixed) return;
        this._dragging = true;
        this._dragType = 'move';
        this._dragObject = this._selectedObject;
        this._dragStartX = x;
        this._dragStartY = y;
    }

    _startRotateObject(x, y) {
        if (!this._selectedObject || this._selectedObject.isFixed) return;
        this._dragging = true;
        this._dragType = 'rotate';
        this._dragObject = this._selectedObject;
        this._dragStartAngle = this._selectedObject.angle;
    }

    _placeObject(type, x, y) {
        // Check inventory
        const remaining = toolbox.getCount(type);
        if (remaining <= 0) return;

        try {
            const obj = objectRegistry.create(type, x, y);
            // Clamp into the playfield: a drop across a boundary edge (e.g. a
            // release over the toolbox panel, or below the ground line) must
            // land fully inside the walls, otherwise the part embeds in the
            // static boundary walls and gets violently displaced at play start.
            const clamped = clampObjectToPlayfield(
                obj, x, y, renderer.canvas.width, renderer.canvas.height
            );
            if (clamped.x !== x || clamped.y !== y) {
                obj.setPosition(clamped.x, clamped.y);
            }
            if (type === 'rope') this._snapRopeEndpoints(obj);
            this._objects.push(obj);
            this._selectObject(obj);
            eventBus.emit('object:placed', { type, id: obj.id, object: obj });
        } catch (e) {
            console.error(`[DragDrop] Failed to create ${type}:`, e);
        }
    }

    /**
     * Rope placement snap (issue 04): either rope endpoint ties itself to
     * the nearest board attachment point (balloon knot, bucket rim, …)
     * within ROPE_SNAP_RADIUS — endpoint 0 = the rope's anchor, endpoint 1
     * = its free end. Matching endpoints are re-layed onto their points and
     * knotted; unmatched endpoints stay as laid.
     * @param {import('../objects/Rope.js').default} rope — fresh rope, out of the physics world
     * @private
     */
    _snapRopeEndpoints(rope) {
        const bodies = rope.bodies;
        const start = bodies[0].position;      // anchor
        const end = bodies[bodies.length - 1].position; // free end

        const matches = [null, null];
        for (const target of this._objects) {
            if (target === rope) continue;
            for (const point of target.attachmentPoints ?? []) {
                const world = target.getAttachmentWorldPoint(point.id);
                if (!world) continue;
                for (const endpoint of [0, 1]) {
                    const spot = endpoint === 0 ? start : end;
                    const dist = Math.hypot(world.x - spot.x, world.y - spot.y);
                    if (dist > this.ROPE_SNAP_RADIUS) continue;
                    const best = matches[endpoint];
                    if (!best || dist < best.dist) {
                        matches[endpoint] = { target, pointId: point.id, world, dist };
                    }
                }
            }
        }

        // Re-lay the rope once, then knot the matched endpoints
        const newStart = matches[0] ? matches[0].world : start;
        const newEnd = matches[1] ? matches[1].world : end;
        if (newStart !== start || newEnd !== end) {
            rope.setEndpoints(newStart, newEnd);
        }
        for (const endpoint of [0, 1]) {
            const match = matches[endpoint];
            if (match) rope.attachEndpoint(endpoint, match.target, match.pointId);
        }
    }

    _deleteSelected() {
        if (!this._selectedObject || this._selectedObject.isFixed) return;

        const obj = this._selectedObject;
        const idx = this._objects.indexOf(obj);
        if (idx >= 0) {
            this._objects.splice(idx, 1);
        }

        eventBus.emit('object:removed', { type: obj.type, id: obj.id });
        obj.dispose();

        this._selectObject(null);
    }
}

/** Singleton DragDropManager instance */
export const dragDropManager = new DragDropManager();
export default DragDropManager;
