/**
 * BaseObject — Abstract base class for all game objects.
 *
 * Every interactive object in the game (balls, ramps, fans, etc.)
 * extends this class. It defines the contract that the physics engine,
 * renderer, toolbox, and serialization system all depend on.
 *
 * ═══════════════════════════════════════════════════════════════
 *  THIS IS THE SHARED INTERFACE CONTRACT BETWEEN AGENT A AND B.
 *  Both agents code against this interface.
 * ═══════════════════════════════════════════════════════════════
 */

let _nextId = 1;

/**
 * Clamp a desired object center position so the object's current AABB stays
 * fully inside the playfield rectangle (0..playfieldWidth × 0..playfieldHeight).
 *
 * Used by placement and move/rotate-drag handling so parts never stick out of
 * the world: the static boundary walls coincide exactly with the playfield
 * edges (the boundary floor's top edge is at y = playfieldHeight), and a part
 * embedded in a wall gets violently displaced when play starts.
 *
 * The footprint is read from `obj.bounds` at the object's current pose, so
 * rotated objects are clamped against their rotated AABB.
 *
 * @param {BaseObject} obj - the object (its current bounds define the footprint)
 * @param {number} x - desired center x
 * @param {number} y - desired center y
 * @param {number} playfieldWidth - world width in px (e.g. 1000)
 * @param {number} playfieldHeight - world height in px (e.g. 600)
 * @returns {{ x: number, y: number }} clamped center position
 */
export function clampObjectToPlayfield(obj, x, y, playfieldWidth, playfieldHeight) {
    const b = obj.bounds;
    const halfW = b.width / 2;
    const halfH = b.height / 2;
    return {
        x: Math.min(Math.max(x, halfW), playfieldWidth - halfW),
        y: Math.min(Math.max(y, halfH), playfieldHeight - halfH),
    };
}

export default class BaseObject {
    /**
     * @param {number} x - Initial x position (center)
     * @param {number} y - Initial y position (center)
     * @param {object} [options={}] - Object-specific configuration
     */
    constructor(x, y, options = {}) {
        // customId, angle, isFixed are lifecycle keys (id/pose/placement),
        // not behavior options: they are consumed here and never land in
        // _options, so serialize→deserialize round-trips stay stable (C3).
        const { customId, angle, isFixed, ...behaviorOptions } = options;

        /** @type {number} Unique instance ID */
        this._id = _nextId++;

        /** @type {string|null} Named id from level JSON, if the level names this object */
        this._customId = customId ?? null;

        /** @type {number} World x position */
        this._x = x;

        /** @type {number} World y position */
        this._y = y;

        /** @type {number} Rotation angle in radians */
        this._angle = angle || 0;

        /** @type {boolean} If true, this object is pre-placed and cannot be moved by the player */
        this._isFixed = isFixed || false;

        /** @type {object} Original options for serialization */
        this._options = { ...behaviorOptions };
    }

    // ── Identity ──────────────────────────────────

    /** @returns {number} Unique instance ID */
    get id() {
        return this._id;
    }

    /**
     * Named id from level JSON (e.g. the goal bucket's zone id, referenced by
     * `goal.zoneId` in the level spec). Distinct id space from `id`, which
     * stays auto-increment for physics/engine references.
     * @returns {string|null}
     */
    get customId() {
        return this._customId;
    }

    /**
     * Object type identifier (e.g., 'ball', 'ramp', 'fan').
     * Must be overridden by subclasses.
     * @returns {string}
     */
    get type() {
        throw new Error(`${this.constructor.name} must override get type()`);
    }

    // ── Physics Bodies ────────────────────────────

    /**
     * Return Matter.js Body instances owned by this object.
     * Must be overridden by subclasses.
     * @returns {Matter.Body[]}
     */
    get bodies() {
        throw new Error(`${this.constructor.name} must override get bodies()`);
    }

    /**
     * Return Matter.js Constraint instances owned by this object.
     * Override if the object uses constraints (ropes, pulleys, etc.)
     * @returns {Matter.Constraint[]}
     */
    get constraints() {
        return [];
    }

    // ── Position & Bounds ─────────────────────────

    /** @returns {number} */
    get x() { return this._x; }

    /** @returns {number} */
    get y() { return this._y; }

    /** @returns {number} angle in radians */
    get angle() { return this._angle; }

    /** @returns {boolean} */
    get isFixed() { return this._isFixed; }

    /**
     * Get the bounding box of this object.
     * Must be overridden by subclasses.
     * @returns {{ x: number, y: number, width: number, height: number }}
     */
    get bounds() {
        throw new Error(`${this.constructor.name} must override get bounds()`);
    }

    // ── Edit Mode Operations ──────────────────────

    /**
     * Move the object to a new position (edit mode only).
     * @param {number} x
     * @param {number} y
     */
    setPosition(x, y) {
        this._x = x;
        this._y = y;
        // Subclasses should also update their Matter.js bodies
    }

    /**
     * Set the rotation angle (edit mode only).
     * @param {number} angle - Angle in radians
     */
    setAngle(angle) {
        this._angle = angle;
        // Subclasses should also update their Matter.js bodies
    }

    // ── Runtime Hooks ─────────────────────────────

    // Lifecycle contract (docs/adr/0003-lifecycle-contract.md): every object
    // goes create (constructor) → play (onBeforeUpdate each step, in-world)
    // → restore (restoreState across a play/reset cycle) → dispose (out of
    // the world). Optional hooks: onBeforeUpdate and restoreState (both
    // default no-ops); dispose must override when the subclass owns Matter
    // state. There is deliberately NO onCollision hook here: contact
    // reactions are declared in js/interactions/rules.js (the interaction
    // matrix) and routed by PhysicsEngine to the owning object's behavior
    // methods — see docs/interactions.md and docs/adr/0001-interaction-matrix.md.

    /**
     * Called every physics step before the engine updates.
     * Override to apply custom forces, behaviors, etc.
     * (e.g., Fan applies wind force, Conveyor applies surface velocity)
     * @param {object} engine - PhysicsEngine instance
     * @param {number} [_dt] - delta time in ms (passed by PhysicsEngine.step)
     */
    onBeforeUpdate(engine, _dt) {
        // Default: no-op
    }

    /**
     * Snapshot-restore seam: play/reset cycles replay through here.
     * PhysicsEngine.restoreSnapshot() re-applies recorded body poses by body
     * id first, then calls this on objects whose body-id set matches the
     * snapshot's — so a subclass only handles behavioral state (flags,
     * cooldowns, directions), never positions.
     *
     * Default: no-op. Override only when the class carries behavioral
     * runtime state (Mouse pattern); `data` is the snapshot-time
     * serialize() record.
     * @param {object} [_data] - serialized snapshot entry (serialize() shape)
     */
    restoreState(_data) {
        // Default: no behavioral state to restore
    }

    // ── Attachment points (issue 04: rope as a connector) ─────────

    /**
     * Named points where a rope endpoint can tie to this object. Each
     * entry carries the body that bears the point plus the offset from
     * that body's center (in its local frame — it follows the body).
     * Default: no attachment points.
     * @returns {Array<{id: string, body: Matter.Body|null, offset: {x: number, y: number}}>}
     */
    get attachmentPoints() {
        return [];
    }

    /**
     * World position of a named attachment point right now.
     * @param {string} id
     * @returns {{x: number, y: number}|null} null if unknown or currently unavailable (e.g. popped balloon)
     */
    getAttachmentWorldPoint(id) {
        const ap = this.attachmentPoints.find((p) => p.id === id);
        const body = ap ? (ap.body ?? this.bodies[0]) : null;
        if (!ap || !body) return null;
        return { x: body.position.x + ap.offset.x, y: body.position.y + ap.offset.y };
    }

    // ── Rendering ─────────────────────────────────

    /**
     * Draw this object on the canvas.
     * Must be overridden by subclasses.
     * @param {CanvasRenderingContext2D} ctx
     */
    draw(ctx) {
        throw new Error(`${this.constructor.name} must override draw(ctx)`);
    }

    /**
     * Draw a small icon for the toolbox panel.
     * Override for custom icons; default draws a scaled-down version.
     * @param {CanvasRenderingContext2D} ctx
     * @param {number} w - Icon width
     * @param {number} h - Icon height
     */
    drawToolboxIcon(ctx, w, h) {
        // Default: draw a small gray square placeholder
        ctx.fillStyle = '#a0a0a0';
        ctx.fillRect(4, 4, w - 8, h - 8);
        ctx.strokeStyle = '#404040';
        ctx.lineWidth = 1;
        ctx.strokeRect(4, 4, w - 8, h - 8);
    }

    // ── Serialization ─────────────────────────────

    /**
     * Serialize this object to a plain JSON-friendly object.
     * @returns {object}
     */
    serialize() {
        const data = {
            type: this.type,
            x: this._x,
            y: this._y,
            angle: this._angle,
            isFixed: this._isFixed,
            options: { ...this._options },
        };
        // Match the level-JSON key convention (`"id": "bucket-goal"`) so
        // editor-saved levels and round-trips keep named ids. Omitted when unset.
        if (this._customId !== null) {
            data.id = this._customId;
        }
        return data;
    }

    /**
     * Reconstruct an object from serialized data.
     * Must be overridden by subclasses.
     * @param {object} data
     * @returns {BaseObject}
     */
    static deserialize(data) {
        throw new Error('Subclasses must override static deserialize(data)');
    }

    // ── Cleanup ───────────────────────────────────

    /**
     * Remove this object from the physics world and clean up resources.
     * Override to remove specific bodies/constraints.
     */
    dispose() {
        // Subclasses should remove their Matter.js bodies and constraints
    }
}
