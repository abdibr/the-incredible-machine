/**
 * DragDropManager — Central coordinator for drag-and-drop interactions
 *
 * Handles:
 * - Dragging items from the toolbox onto the canvas (ghost preview → placement)
 * - Clicking placed objects to select them
 * - Moving selected objects by dragging
 * - Rotating selected objects via handle
 * - Deleting selected objects (right-click or Delete key)
 * - Pinning a selected object (pin handle or P key, issue #66 follow-up):
 *   a pinned part cannot move during play, Save Level writes it into the
 *   level's fixedObjects, and a pinned unnamed bucket is the goal zone the
 *   readout, GOAL marker and Save all agree on
 * - Anchoring a selected object (anchor handle or A key, issue #67): an
 *   anchored part is pre-placed scene content the player cannot move or
 *   delete in the edit stage, yet physically dynamic at play — Save Level
 *   writes it into fixedObjects with its `isAnchored` marker
 *
 * Coordinates between the Toolbox (inventory) and Renderer (canvas).
 *
 * The selection-affordance set is state-driven (issues #68, #67): which
 * handles a part offers — and which move/rotate/delete verbs are accepted —
 * come from the shared selectionHandles table (part state × stage posture).
 * Sandbox authoring edits fixed scenery in place (dragging a pinned goal
 * bucket IS the #66 goal-zone authoring move); every other stage leaves a
 * pinned part only its pin handle and an anchored part only its anchor
 * handle.
 */

import { eventBus } from '../EventBus.js';
import { objectRegistry } from '../objects/ObjectRegistry.js';
import { renderer } from '../render/Renderer.js';
import { toolbox } from './Toolbox.js';
import { clampObjectToPlayfield } from '../objects/BaseObject.js';
import { isRopeFamily } from '../objects/Rope.js';
import { selectionHandleSet, isAnchorCapable } from './selectionHandles.js';
import ConnectFlow from './ConnectFlow.js';

class DragDropManager {
    constructor() {
        /** @type {BaseObject[]} — the live objects list (shared with renderer) */
        this._objects = [];

        /** Click-to-connect flow (ADR 0007 decision 2): this manager delegates
         * square clicks (seek entry, tie, cancel, untie) to it. */
        this._connectFlow = new ConnectFlow();

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

        // ── Click-to-connect flow (ADR 0007 decision 2) ──
        this._connectFlow.init();

        // ── Canvas mousedown ──
        canvas.addEventListener('mousedown', (e) => {
            if (!this._enabled) return;
            if (e.button !== 0) return; // Left button only

            const pos = renderer.pageToCanvas(e.pageX, e.pageY);
            this._onCanvasPointerDown(pos.x, pos.y);
        });

        // ── Global mousemove ──
        document.addEventListener('mousemove', (e) => {
            const pos = renderer.pageToCanvas(e.pageX, e.pageY);

            // Hover-reveal for the connect-flow squares; the seek preview
            // line aims wherever the cursor is while a seek is in flight.
            renderer.hoverPoint = pos;
            if (this._connectFlow.seek) this._connectFlow.setPreview(pos.x, pos.y);

            if (!this._dragging) return;

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
        document.addEventListener('mouseup', (e) => this._endDrag(e.pageX, e.pageY));

        // ── Right-click to delete ──
        canvas.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            if (!this._enabled) return;

            const pos = renderer.pageToCanvas(e.pageX, e.pageY);
            this._onCanvasContextMenu(pos.x, pos.y);
        });

        // ── Cursor leaves the canvas: no hover target ──
        canvas.addEventListener('mouseleave', () => {
            renderer.hoverPoint = null;
        });

        // ── Keyboard (Esc / Delete) ──
        document.addEventListener('keydown', (e) => this._onKeyDown(e));

        // ── Mode changes ──
        eventBus.on('mode:changed', ({ newMode }) => {
            this._mode = newMode;
            this._enabled = (newMode === 'EDITING' || newMode === 'SANDBOX');

            if (!this._enabled) {
                this._selectObject(null);
                this._clearDragState(); // a drag cannot outlive the stage that started it
                this._connectFlow.cancel(); // leaving the edit stage ends any seek
                renderer.hoverPoint = null;
                eventBus.emit('drag:ghost-clear');
            }
        });

        console.log('[DragDropManager] Initialized');
    }

    /**
     * The flow the drag-drop handler delegates square clicks to — the
     * renderer draws from the same instance (main.js wires it in).
     * @returns {ConnectFlow}
     */
    get connectFlow() {
        return this._connectFlow;
    }

    /**
     * Pointer-down on the canvas body, in canvas coordinates. Order matters:
     * selection handles first, then the click-to-connect squares (a seek
     * entry, untie, tie or swallowed seek-click consumes the pointer before
     * selection can claim it), then normal selection/move.
     * @param {number} x - canvas x
     * @param {number} y - canvas y
     * @private
     */
    _onCanvasPointerDown(x, y) {
        // Check for selection handle clicks first
        if (this._selectedObject) {
            const handle = renderer.getHandleAtPoint(x, y);
            if (handle === 'delete') {
                this._deleteSelected();
                return;
            }
            if (handle === 'move') {
                this._startMoveObject(x, y);
                return;
            }
            if (handle === 'rotate') {
                this._startRotateObject(x, y);
                return;
            }
            if (handle === 'pin') {
                this._togglePinSelected();
                return;
            }
            if (handle === 'anchor') {
                this._toggleAnchorSelected();
                return;
            }
        }

        // Click-to-connect squares (ADR 0007 decision 2)
        if (this._connectFlow.handlePointerDown(x, y, this._objects)) return;

        // Check for clicking on an object
        const obj = renderer.getObjectAtPoint(x, y, this._objects);
        if (obj) {
            // Start a drag only when the part's state-driven handle set
            // (issue #68) offers move — sandbox authoring drags fixed
            // scenery in place; every other stage leaves it stationary.
            this._selectObject(obj);
            if (selectionHandleSet(obj, this._mode).includes('move')) {
                this._startMoveObject(x, y);
            }
        } else {
            this._selectObject(null);
        }
    }

    /**
     * Right-click on the canvas body, in canvas coordinates: deletes the
     * part under the cursor when its state-driven handle set offers delete
     * (issue #68) — everywhere but sandbox authoring, fixed scenery stays
     * put and only its pin handle remains offered.
     * @param {number} x - canvas x
     * @param {number} y - canvas y
     * @private
     */
    _onCanvasContextMenu(x, y) {
        const obj = renderer.getObjectAtPoint(x, y, this._objects);
        if (obj && selectionHandleSet(obj, this._mode).includes('delete')) {
            this._selectObject(obj);
            this._deleteSelected();
        }
    }

    /**
     * Global keyboard handling: Esc cancels an in-flight seek; Delete or
     * Backspace removes the selection; P pins/unpins it (issue #66 follow-up).
     * @param {KeyboardEvent} e
     * @private
     */
    _onKeyDown(e) {
        if (!this._enabled) return;
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

        if (e.code === 'Escape') {
            this._connectFlow.cancel(); // AC: Esc cancels the seek
            return;
        }

        if (e.code === 'KeyP' && this._selectedObject) {
            e.preventDefault();
            this._togglePinSelected();
            return;
        }

        if (e.code === 'KeyA' && this._selectedObject) {
            e.preventDefault();
            this._toggleAnchorSelected();
            return;
        }

        if ((e.code === 'Delete' || e.code === 'Backspace') && this._selectedObject) {
            e.preventDefault();
            this._deleteSelected();
        }
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
            // Anchored parts are scene content, not placed parts (issue #67):
            // they survive a clear exactly like fixed scenery. Authored scene
            // content generally (isScene, ADR 0009) survives too — the board
            // clear must never erase the level's own furniture.
            if (!this._objects[i].isFixed && !this._objects[i].isAnchored && !this._objects[i].isScene) {
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

    /**
     * Whether the current selection's state-driven handle set offers a
     * handle (issue #68) — the one gate for the move/rotate/delete verbs,
     * mirroring what the renderer draws and hit-tests.
     * @param {'move'|'rotate'|'delete'} handle
     * @returns {boolean}
     * @private
     */
    _offersHandle(handle) {
        return !!this._selectedObject &&
            selectionHandleSet(this._selectedObject, this._mode).includes(handle);
    }

    _startMoveObject(x, y) {
        // The state-driven handle set decides (issue #68): a fixed part is
        // draggable in sandbox authoring, never elsewhere.
        if (!this._offersHandle('move')) return;
        this._dragging = true;
        this._dragType = 'move';
        this._dragObject = this._selectedObject;
        this._dragStartX = x;
        this._dragStartY = y;
    }

    _startRotateObject(x, y) {
        // The state-driven handle set decides (issue #68): a fixed part is
        // rotatable in sandbox authoring, never elsewhere.
        if (!this._offersHandle('rotate')) return;
        this._dragging = true;
        this._dragType = 'rotate';
        this._dragObject = this._selectedObject;
        this._dragStartAngle = this._selectedObject.angle;
    }

    /**
     * Release the drag in flight at the hand's release point — the drop half
     * of every drag the manager starts (the `mouseup` listener delegates
     * here, so a test can drive the drop without a DOM). A toolbox drag
     * places, a move drag settles the pose (untieing a rope-family part's
     * knots), a rotate drag announces its final angle.
     *
     * Drag state clears in a `finally`: the reset is the whole contract of a
     * release. A throw on the way (a missing import once did exactly that)
     * used to leave `_dragging` set, gluing the part to the cursor with no
     * drop left to let go of it — recoverable only by deleting the part.
     * @param {number} pageX - release point, page coordinates
     * @param {number} pageY
     * @private
     */
    _endDrag(pageX, pageY) {
        if (!this._dragging) return;

        try {
            if (this._dragType === 'toolbox') {
                // Place the object at the drop position
                const pos = renderer.pageToCanvas(pageX, pageY);
                this._placeObject(this._dragObjType, pos.x, pos.y);
                eventBus.emit('drag:ghost-clear');
            } else if (this._dragType === 'move' && this._dragObject) {
                // A moved rope-family part drags its knots off their points
                // (issue 04; the family fact is the rope module's, issue
                // #75): untie at release — the drop-scan reconcile releases
                // the physical links on the next play.
                if (isRopeFamily(this._dragObject)) {
                    this._dragObject.clearAttachments();
                } else {
                    // A moved TARGET bearing knots unties them the same
                    // way (issue #98's symmetric policy - one untie rule
                    // on both sides): exactly the knots that bear on the
                    // dropped part, through the rope's own per-knot
                    // detachEndpoint seam - the reconcile releases their
                    // physical links on the next step (the same feedback
                    // path the rope-drag untie answers). Rope-family
                    // drags keep the wholesale clear above - rope-to-rope
                    // handling stays as shipped.
                    this._untieMovedTargetKnots(this._dragObject);
                }
                eventBus.emit('object:moved', {
                    id: this._dragObject.id,
                    x: this._dragObject.x,
                    y: this._dragObject.y,
                });
            } else if (this._dragType === 'rotate' && this._dragObject) {
                // Rotate drops previously emitted nothing — a build-trace gap
                // (ADR 0006): announce the final angle like move announces
                // its pose, so the recorded trace can reconstruct pose history.
                eventBus.emit('object:rotated', {
                    id: this._dragObject.id,
                    angle: this._dragObject.angle,
                });
            }
        } finally {
            this._clearDragState();
        }
    }

    /**
     * Untie the knots a dropped (moved) part bears (issue #98, the
     * target-side half of the move-release untie): every knot-walking part
     * on the board that ties INTO `target` loses exactly the knots that
     * bear on it - detachEndpoint per live ref, the same per-knot untie
     * seam every other roper drop rides - and nothing else: the ropes'
     * other knots, seats and ref order are unmoved by the clear. The
     * physical links drop on the next reconcile step (the same feedback
     * path the rope-side release untie answers). The walk is
     * capability-first on "offers attachment refs" (the reconcile's own
     * gate), so a rope-family roster change cannot strand the scan; a
     * severed holder answers no refs and drops nothing.
     *
     * @param {import('../objects/BaseObject.js').default} target - the dropped part
     * @private
     */
    _untieMovedTargetKnots(target) {
        for (const part of this._objects) {
            if (part === target || typeof part.getAttachmentRefs !== 'function') continue;
            for (const ref of part.getAttachmentRefs()) {
                if (ref.target === target) {
                    part.detachEndpoint(ref.seat, ref.target, ref.pointId);
                }
            }
        }
    }

    /**
     * Drop the drag in flight back to "nothing held". The one place that
     * knows what a clean hand looks like: release (`_endDrag`) and the stage
     * change that voids a drag both come here, so no path can leave a stale
     * `_dragType`/`_dragObject` behind for the next press to inherit.
     * @private
     */
    _clearDragState() {
        this._dragging = false;
        this._dragType = null;
        this._dragObjType = null;
        this._dragObject = null;
    }

    /**
     * Toggle the selected object's pin state (issue #66 follow-up): pinned
     * parts are play-static scene elements — Save Level writes them into the
     * level's fixedObjects — and a pinned unnamed bucket is the goal zone the
     * readout, the GOAL marker and the stamp-fallback resolver all agree on.
     * Announces `object:pinned { type, id, isFixed, object }` so the editor's
     * goal message, goal readout and the bug-file build trace can react.
     * @private
     */
    _togglePinSelected() {
        if (!this._selectedObject) return;
        const obj = this._selectedObject;
        // Move/rotate/delete are state-driven offers now (issue #68): a
        // fixed part keeps them only in sandbox authoring. The pin toggle
        // is the one operation a fixed part still offers everywhere — the
        // unpin escape hatch.
        obj.isFixed = !obj.isFixed;
        eventBus.emit('object:pinned', { type: obj.type, id: obj.id, isFixed: obj.isFixed, object: obj });
    }

    /**
     * Toggle the selected object's anchor state (issue #67): anchored parts
     * are pre-placed scene content — the player cannot move, rotate or
     * delete them in the edit stage — yet at play they enter the world
     * dynamic like any free part. Save Level writes them into the level's
     * fixedObjects with their `isAnchored` marker.
     *
     * The toggle rides the state-driven handle set (issue #68): it only
     * acts where the set offers 'anchor', so a pinned part outside sandbox
     * authoring (whose escape hatch is the pin) refuses quietly, and the
     * rope family — out of scope until the connector redesign — never
     * anchors at all. Announces
     * `object:anchored { type, id, isAnchored, object }` so the editor's
     * notice, goal readout and the bug-file build trace can react.
     * @private
     */
    _toggleAnchorSelected() {
        if (!this._selectedObject) return;
        const obj = this._selectedObject;
        if (!isAnchorCapable(obj)) return; // rope scope exclusion (issue #67)
        if (!this._offersHandle('anchor')) return; // same boundary the draw/hit-test set defines
        obj.isAnchored = !obj.isAnchored;
        eventBus.emit('object:anchored', { type: obj.type, id: obj.id, isAnchored: obj.isAnchored, object: obj });
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
            this._objects.push(obj);
            this._selectObject(obj);
            eventBus.emit('object:placed', { type, id: obj.id, object: obj });
        } catch (e) {
            console.error(`[DragDrop] Failed to create ${type}:`, e);
        }
    }

    _deleteSelected() {
        // The state-driven handle set decides (issue #68): fixed scenery is
        // deletable in sandbox authoring, never elsewhere.
        if (!this._offersHandle('delete')) return;

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
