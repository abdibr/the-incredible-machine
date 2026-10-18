/**
 * PhysicsEngine — Matter.js wrapper
 *
 * Manages the Matter.js world, object lifecycle, collision events,
 * snapshot/restore for reset, boundary walls, and hit-testing.
 */

import Matter from 'matter-js';
import { eventBus } from '../EventBus.js';

const { Engine, World, Bodies, Body, Composite, Events, Query, Sleeping, Pairs } = Matter;

export class PhysicsEngine {
    /**
     * @param {number} width   — playfield width in px
     * @param {number} height  — playfield height in px
     * @param {object} [opts]
     * @param {number} [opts.gravityX=0]
     * @param {number} [opts.gravityY=1]
     * @param {boolean} [opts.enableSleeping=true]
     */
    constructor(width, height, opts = {}) {
        this.width = width;
        this.height = height;

        // Create Matter.js engine
        this.engine = Engine.create({
            gravity: {
                x: opts.gravityX ?? 0,
                y: opts.gravityY ?? 1,
            },
            enableSleeping: opts.enableSleeping ?? true,
        });

        this.world = this.engine.world;

        /** @type {Set<import('../objects/BaseObject.js').default>} */
        this._objects = new Set();

        /** @type {Map<number, import('../objects/BaseObject.js').default>} */
        this._bodyToObject = new Map();

        /** @type {object|null} Serialized snapshot for reset */
        this._snapshot = null;

        // Add boundary walls
        this._addBoundaries();

        // Forward collision events
        this._setupCollisionEvents();

        // Consume severing so a severed rope is physically detached
        this._setupSeveredEvents();

        // Object removal events (popped balloons, etc.)
        this._setupRemovalEvents();
    }

    // ── Object Lifecycle ──────────────────────────

    /**
     * Add a game object to the physics world.
     * @param {import('../objects/BaseObject.js').default} gameObject
     */
    addObject(gameObject) {
        this._objects.add(gameObject);

        // Add all bodies
        for (const body of gameObject.bodies) {
            Composite.add(this.world, body);
            this._bodyToObject.set(body.id, gameObject);
        }

        // Add all constraints
        if (gameObject.constraints) {
            for (const constraint of gameObject.constraints) {
                Composite.add(this.world, constraint);
            }
        }
    }

    /**
     * Remove a game object from the physics world.
     * @param {import('../objects/BaseObject.js').default} gameObject
     */
    removeObject(gameObject) {
        // Remove constraints first
        if (gameObject.constraints) {
            for (const constraint of gameObject.constraints) {
                Composite.remove(this.world, constraint);
            }
        }

        // Remove bodies
        for (const body of gameObject.bodies) {
            if (!body) continue; // disposed objects may report null bodies
            Composite.remove(this.world, body);
            this._bodyToObject.delete(body.id);
        }

        this._objects.delete(gameObject);
        if (gameObject.dispose) gameObject.dispose();
    }

    /** Remove all game objects (keeps boundaries). */
    clear() {
        for (const obj of [...this._objects]) {
            this.removeObject(obj);
        }
    }

    // ── Simulation ────────────────────────────────

    /**
     * Advance the physics simulation by dt milliseconds.
     * @param {number} dt — delta time in ms
     */
    step(dt) {
        // Pre-update hooks on all objects.
        // BaseObject contract: onBeforeUpdate(engine, dt).
        for (const obj of this._objects) {
            if (obj.onBeforeUpdate) {
                obj.onBeforeUpdate(this, dt);
            }
        }

        Engine.update(this.engine, dt);

        // Post-update hooks
        for (const obj of this._objects) {
            if (obj.onAfterUpdate) {
                obj.onAfterUpdate(this, dt);
            }
        }
    }

    /**
     * Set the time scale (1 = normal, 2 = double speed, etc.)
     * @param {number} scale
     */
    setTimeScale(scale) {
        this.engine.timing.timeScale = scale;
    }

    // ── Snapshot / Restore ────────────────────────

    /** Save the current state for later reset. */
    takeSnapshot() {
        this._snapshot = [];
        for (const obj of this._objects) {
            this._snapshot.push({
                serialized: obj.serialize(),
                bodyStates: obj.bodies.map(b => ({
                    id: b.id,
                    position: { x: b.position.x, y: b.position.y },
                    angle: b.angle,
                    velocity: { x: b.velocity.x, y: b.velocity.y },
                    angularVelocity: b.angularVelocity,
                    // Vertex geometry drifts through rotate/translate each
                    // step (floating point), so restored contacts would
                    // differ; store it to keep restores bit-deterministic.
                    vertices: b.vertices.map(v => ({ x: v.x, y: v.y })),
                    positionImpulse: { x: b.positionImpulse.x, y: b.positionImpulse.y },
                    motion: b.motion,
                    sleepCounter: b.sleepCounter,
                })),
            });
        }
    }

    /**
     * Restore to the last snapshot.
     *
     * Poses are matched to live bodies by Matter.js body id, never by
     * position in the object list, so adding/removing objects after the
     * snapshot cannot shift, skip, or misapply recorded poses.
     */
    restoreSnapshot() {
        if (!this._snapshot) return;

        // Reset the pair cache so contacts re-form cold after teleporting
        // bodies: Matter warm-starts the solver from accumulated contact
        // impulses stored on pairs; stale impulses make restores diverge.
        Pairs.clear(this.engine.pairs);

        // Optional behavioral state (e.g. Mouse walking direction) so
        // play/reset cycles replay deterministically. Snapshot entries zip
        // with the objects in recording order; only when the object set is
        // unchanged — otherwise the drift check below re-takes the snapshot
        // to self-heal, and stale behavioral state must not leak.
        const objectArray = [...this._objects];
        if (this._snapshot.length === objectArray.length) {
            for (let i = 0; i < objectArray.length; i++) {
                const obj = objectArray[i];
                if (typeof obj.restoreState === 'function' && this._snapshot[i].serialized) {
                    obj.restoreState(this._snapshot[i].serialized);
                }
            }
        }

        // Index the recorded poses by body id.
        const posesById = new Map();
        for (const snap of this._snapshot) {
            for (const bodyState of snap.bodyStates) {
                posesById.set(bodyState.id, bodyState);
            }
        }

        // Apply each pose to the live body carrying the same id.
        const appliedBodyIds = new Set();
        for (const obj of this._objects) {
            for (const body of obj.bodies) {
                if (!body) continue; // disposed objects may report null bodies
                const bodyState = posesById.get(body.id);
                if (!bodyState) continue;

                Body.setPosition(body, bodyState.position);
                Body.setAngle(body, bodyState.angle);
                Body.setVelocity(body, bodyState.velocity);
                Body.setAngularVelocity(body, bodyState.angularVelocity);
                Sleeping.set(body, false);

                // Position-solver impulse accumulators warm across steps
                // (postSolvePosition keeps a fraction when the body moves
                // along the impulse); restore them for exact replay.
                if (bodyState.positionImpulse) {
                    body.positionImpulse.x = bodyState.positionImpulse.x;
                    body.positionImpulse.y = bodyState.positionImpulse.y;
                }

                // Sleeping is per-body numeric state; restore it so sleep
                // evolution replays identically (engine has sleeping on).
                body.motion = bodyState.motion ?? body.motion;
                body.sleepCounter = bodyState.sleepCounter ?? body.sleepCounter;

                // Restore exact vertex geometry LAST (setVertices() orients
                // around body.position): per-step rotate/translate
                // accumulate floating-point drift into vertices, so the
                // SAT solver would otherwise see slightly different
                // contacts than the original run.
                if (bodyState.vertices) {
                    Body.setVertices(body, bodyState.vertices);
                }

                appliedBodyIds.add(body.id);
            }
        }

        // Detect drift between snapshot and world: recorded poses whose
        // bodies are gone (objects removed), and live bodies the snapshot
        // never saw (objects added after it was taken).
        const unmatchedSnapshotBodyIds = [...posesById.keys()]
            .filter((id) => !appliedBodyIds.has(id));
        const unmatchedLiveBodyIds = [];
        for (const obj of this._objects) {
            for (const body of obj.bodies) {
                if (!body) continue; // disposed objects may report null bodies
                if (!posesById.has(body.id)) unmatchedLiveBodyIds.push(body.id);
            }
        }

        if (unmatchedSnapshotBodyIds.length > 0 || unmatchedLiveBodyIds.length > 0) {
            // Fail loudly, then self-heal: converge the baseline to the just-
            // restored world so the next restore stays consistent.
            console.warn(
                '[PhysicsEngine] Snapshot mismatch: ' +
                `${unmatchedSnapshotBodyIds.length} snapshot pose(s) not in world, ` +
                `${unmatchedLiveBodyIds.length} live body(s) missing from snapshot. Re-taking snapshot.`
            );
            eventBus.emit('physics:snapshot-mismatch', {
                unmatchedSnapshotBodyIds,
                unmatchedLiveBodyIds,
            });
            this.takeSnapshot();
        }
    }

    /** Clear the stored snapshot. */
    clearSnapshot() {
        this._snapshot = null;
    }

    /** @returns {boolean} */
    hasSnapshot() {
        return this._snapshot !== null;
    }

    // ── Queries ───────────────────────────────────

    /** @returns {Set<import('../objects/BaseObject.js').default>} */
    getObjects() {
        return this._objects;
    }

    /**
     * Find the game object whose body contains the given point.
     * @param {{ x: number, y: number }} point
     * @returns {import('../objects/BaseObject.js').default | null}
     */
    objectAtPoint(point) {
        const bodies = Query.point(Composite.allBodies(this.world), point);
        for (const body of bodies) {
            const obj = this._bodyToObject.get(body.id);
            if (obj) return obj;
        }
        return null;
    }

    /**
     * Find the game object for a given Matter.js body.
     * @param {Matter.Body} body
     * @returns {import('../objects/BaseObject.js').default | null}
     */
    getObjectForBody(body) {
        return this._bodyToObject.get(body.id) ?? null;
    }

    // ── Boundaries ────────────────────────────────

    /** @private */
    _addBoundaries() {
        const wallThickness = 50;
        const walls = [
            // Floor
            Bodies.rectangle(this.width / 2, this.height + wallThickness / 2, this.width + wallThickness * 2, wallThickness, { isStatic: true, label: 'wall-floor' }),
            // Left
            Bodies.rectangle(-wallThickness / 2, this.height / 2, wallThickness, this.height, { isStatic: true, label: 'wall-left' }),
            // Right
            Bodies.rectangle(this.width + wallThickness / 2, this.height / 2, wallThickness, this.height, { isStatic: true, label: 'wall-right' }),
            // Ceiling
            Bodies.rectangle(this.width / 2, -wallThickness / 2, this.width + wallThickness * 2, wallThickness, { isStatic: true, label: 'wall-ceiling' }),
        ];
        Composite.add(this.world, walls);
    }

    // ── Collision Events ──────────────────────────

    /** @private */
    _setupCollisionEvents() {
        Events.on(this.engine, 'collisionStart', (event) => {
            for (const pair of event.pairs) {
                const objA = this._bodyToObject.get(pair.bodyA.id);
                const objB = this._bodyToObject.get(pair.bodyB.id);

                if (objA && objB) {
                    if (objA.onCollision) objA.onCollision(objB, pair);
                    if (objB.onCollision) objB.onCollision(objA, pair);
                    // (`physics:collision` was pruned — no production
                    // listener; objects receive contacts via onCollision.)
                }
            }
        });
    }

    /** @private */
    _setupSeveredEvents() {
        this._onRopeSevered = ({ rope }) => this._detachRopeConstraints(rope);
        eventBus.on('rope:severed', this._onRopeSevered);
    }

    /**
     * Physically detach a severed rope: drop its Matter constraints from the
     * world (mirroring the severed flag/visual), then wake its bodies so the
     * freed piece falls in the next step.
     * @param {import('../objects/Rope.js').default} rope
     * @private
     */
    _detachRopeConstraints(rope) {
        for (const constraint of rope.constraints) {
            Composite.remove(this.world, constraint);
        }
        // A rope held by constraints can be asleep; release it so it falls
        for (const body of rope.bodies) {
            Sleeping.set(body, false);
        }
    }

    /** @private */
    _setupRemovalEvents() {
        // Popped balloons must leave the physics world immediately: the body
        // is invisible (draw no-ops) but would keep colliding and buoyantly
        // acting on other objects forever (work plan section 1.4).
        this._onBalloonPopped = ({ body }) => {
            if (!body || !this._bodyToObject.has(body.id)) return;
            Composite.remove(this.world, body);
            this._bodyToObject.delete(body.id);
        };

        eventBus.on('balloon:popped', this._onBalloonPopped);
    }

    // ── Cleanup ───────────────────────────────────

    /** Tear down the engine completely. */
    dispose() {
        eventBus.off('balloon:popped', this._onBalloonPopped);
        Events.off(this.engine);
        eventBus.off('rope:severed', this._onRopeSevered);
        this.clear();
        World.clear(this.world);
        Engine.clear(this.engine);
    }
}

export default PhysicsEngine;
