/**
 * AgentSession — the headless world owner for the agent play interface.
 *
 * Owns a PhysicsEngine, the object registry bootstrap, level data and goal
 * checking (a private GoalChecker instance on the shared eventBus). Every
 * trial rebuilds a FRESH engine from level data + placements, giving
 * independent deterministic trials and sidestepping the ADR 0003 restore
 * caveats (construction IS the restore).
 *
 * No DOM, no rAF, no GameLoop. Steps the engine manually and emits
 * `loop:frame` per step — exactly what GoalChecker listens to.
 */

import { eventBus } from '../js/EventBus.js';
import { objectRegistry } from '../js/objects/ObjectRegistry.js';
import { registerAllObjects } from '../js/objects/registerAllObjects.js';
import { PhysicsEngine } from '../js/engine/PhysicsEngine.js';
import { GoalChecker } from '../js/goals/GoalChecker.js';
import { EventRecorder } from './observe/events.js';

/** Validate a level document — mirrors LevelManager._validate(). @private */
function validateLevelData(data) {
    for (const field of ['id', 'name', 'goal', 'fixedObjects', 'availableParts']) {
        if (!(field in data)) throw new Error(`[AgentSession] level missing field: "${field}"`);
    }
    if (!data.goal?.type) throw new Error('[AgentSession] level goal must have a "type" field');
    if (!Array.isArray(data.fixedObjects)) throw new Error('[AgentSession] fixedObjects must be an array');
}

export class AgentSession {
    /**
     * @param {{ width?: number, height?: number }} [options] playfield size
     */
    constructor({ width = 1000, height = 600 } = {}) {
        if (objectRegistry.getAll().length === 0) registerAllObjects();
        this.width = width;
        this.height = height;
        this.levelData = null;
        /** @type {Array<{type:string,x:number,y:number,angle:number}>} agent placements — source of truth */
        this.placements = [];
        /** @type {PhysicsEngine|null} */
        this.engine = null;
        this._goalChecker = null;
        this._outcome = null;
        this._failureReason = null;
        this._lastResult = null;
        this._unsubs = [
            eventBus.on('goal:reached', () => { this._outcome = 'reached'; }),
            eventBus.on('goal:failed', ({ reason } = {}) => { this._outcome = 'failed'; this._failureReason = reason; }),
        ];
    }

    /** @returns {object|null} the level goal */
    get goal() {
        return this.levelData?.goal ?? null;
    }

    /** @returns {string|null} 'reached' | 'failed' | 'timeout' | null */
    get lastOutcome() {
        return this._outcome ?? (this._lastResult ? this._lastResult.outcome : null);
    }

    /** @returns {Array<{t:string,text:string,landmark?:boolean}>} sentences of the last trial */
    get lastEventSentences() {
        return this._lastResult?.events ?? [];
    }

    /**
     * Load a level by id (fs, levels live in js/levels/puzzles/) or accept a
     * full level-data object directly (ad-hoc / custom levels).
     * @param {string|object} idOrData e.g. 'level-01'
     */
    async loadLevel(idOrData) {
        let data = idOrData;
        if (typeof idOrData === 'string') {
            const fs = await import('node:fs/promises');
            const path = new URL(`../js/levels/puzzles/${idOrData}.json`, import.meta.url);
            data = JSON.parse(await fs.readFile(path, 'utf8'));
        }
        validateLevelData(data);
        this.levelData = data;
        this.placements = [];
        this._rebuild();
        return this;
    }

    /** Remaining parts budget per type: availableParts minus placed. */
    budget() {
        const placed = {};
        for (const p of this.placements) placed[p.type] = (placed[p.type] ?? 0) + 1;
        return Object.fromEntries(
            Object.entries(this.levelData?.availableParts ?? {}).map(([type, n]) => [type, n - (placed[type] ?? 0)]),
        );
    }

    /** Tear the engine + goal checker down (fresh world next rebuild). @private */
    _teardown() {
        this._goalChecker?.dispose();
        this._goalChecker = null;
        if (this.engine) {
            if (typeof this.engine.dispose === 'function') this.engine.dispose();
            else this.engine.clear();
            this.engine = null;
        }
    }

    /** Build a fresh engine: fixed objects from level data, then placements. @private */
    _rebuild() {
        this._teardown();
        this.engine = new PhysicsEngine(this.width, this.height);
        this._goalChecker = new GoalChecker();
        this._goalChecker.init({ physicsEngine: this.engine });
        this._outcome = null;
        this._failureReason = null;
        // GoalChecker arms on these two events (same seam as the live app).
        eventBus.emit('level:loaded', this.levelData);
        eventBus.emit('mode:changed', { oldMode: 'EDITING', newMode: 'PLAYING' });
        for (const d of this.levelData.fixedObjects) {
            try {
                const obj = objectRegistry.create(d.type, d.x, d.y, {
                    angle: d.angle || 0,
                    isFixed: true,
                    customId: d.id, // named id from level JSON (goal zone refs)
                });
                this.engine.addObject(obj);
            } catch (e) {
                console.warn(`[AgentSession] could not create fixed object: ${d.type}`, e);
            }
        }
        for (const p of this.placements) {
            this.engine.addObject(objectRegistry.create(p.type, p.x, p.y, { angle: p.angle }));
        }
    }

    /**
     * Run one deterministic trial: fresh world, step to `seconds`, judge.
     * @param {{ seconds?: number, dt?: number }} [options]
     * @returns {{ outcome: 'reached'|'failed'|'timeout', elapsed: number, events: object[],
     *            sentences: string[], snapshot: object[], distance: number }}
     */
    trial({ seconds = 5, dt = 1000 / 60 } = {}) {
        this._rebuild();
        const recorder = new EventRecorder();
        recorder.start();
        const steps = Math.max(1, Math.round((seconds * 1000) / dt));
        let elapsed = 0;
        for (let i = 0; i < steps; i++) {
            eventBus.emit('loop:frame', { dt, t: elapsed });
            this.engine.step(dt);
            elapsed += dt;
            if (this._outcome) break; // GoalChecker latched a verdict
        }
        const outcome = this._outcome ?? 'timeout';
        recorder.stop();
        const distance = this.distanceToZone();
        this._lastResult = {
            outcome,
            elapsed,
            events: recorder.rows,
            distance,
            snapshot: this.snapshotObjects(),
            failureReason: this._failureReason,
        };
        return this._lastResult;
    }

    /** Per-object pose snapshot (public getters only). */
    snapshotObjects() {
        return [...(this.engine?.getObjects() ?? [])].map((obj) => ({
            id: obj.customId ?? `${obj.type}-${obj.id}`,
            type: obj.type,
            x: obj.x, y: obj.y, angle: obj.angle,
        }));
    }

    /**
     * Min distance from goal-target object(s) to the zone object's center.
     * @returns {number} Infinity when either side is missing
     */
    distanceToZone() {
        const goal = this.goal;
        // getObjects() returns the live Set — spread before array operations.
        const objects = [...(this.engine?.getObjects() ?? [])];
        if (!goal || goal.type !== 'object_in_zone') return Infinity;
        const zone = objects.find((o) => o.customId === goal.zoneId);
        if (!zone) return Infinity;
        let best = Infinity;
        for (const obj of objects) {
            if (obj.type !== goal.targetType) continue;
            for (const body of obj.bodies) {
                if (!body?.position) continue;
                best = Math.min(best, Math.hypot(body.position.x - zone.x, body.position.y - zone.y));
            }
        }
        return best;
    }

    dispose() {
        this._teardown();
        for (const unsub of this._unsubs) unsub();
        this._unsubs = [];
    }
}