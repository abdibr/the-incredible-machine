/**
 * AgentSession — the headless world owner for the agent play interface.
 *
 * Owns a PhysicsEngine, the object registry bootstrap, level data and goal
 * checking (a private GoalChecker instance on the shared eventBus). Every
 * trial rebuilds a FRESH engine from level data + placements, giving
 * independent deterministic trials and sidestepping the ADR 0003 restore
 * caveats (construction IS the restore).
 *
 * No DOM, no rAF, no GameLoop of its own: steps the engine manually while
 * publishing the run facts the loop seam owns (issue #78) in the loop's
 * exact contract - `loop:play` opens each trial run, one `loop:frame`
 * {dt, elapsed} follows each engine step (step -> elapsed -> emit, ADR
 * 0008 decision 2), `loop:reset` ends the run - so GoalChecker (arm +
 * off-world check) and the event narrator consume the same fact stream
 * the sandbox sees.
 */

import { eventBus } from '../js/EventBus.js';
import { objectRegistry } from '../js/objects/ObjectRegistry.js';
import { registerAllObjects } from '../js/objects/registerAllObjects.js';
import { PhysicsEngine } from '../js/engine/PhysicsEngine.js';
import { FIXED_STEP_MS } from '../js/engine/GameLoop.js';
import { GoalChecker } from '../js/goals/GoalChecker.js';
import { levelManager } from '../js/levels/LevelManager.js';

import { levelObjectOptions } from '../js/ui/selectionHandles.js';
import { EventRecorder } from './observe/events.js';
import { createSeedRng, resolveSeed, SEED_ENV_VAR } from './rng.js';

export class AgentSession {
    /**
     * @param {{ width?: number, height?: number, seed?: number|string }} [options]
     *      playfield size; `seed` opts this session into seeded construction
     *      randomness (strings accepted, e.g. a raw env value). When omitted
     *      the TIM_AGENT_SEED env var is consulted; both unset = today's
     *      unseeded behavior.
     */
    constructor({ width = 1000, height = 600, seed } = {}) {
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
        // Opt-in seeded determinism, agent-side only (null = unseeded = stock
        // Math.random behavior). Re-applied per build in _rebuild().
        this._seed = resolveSeed(seed === undefined ? process.env?.[SEED_ENV_VAR] : seed);
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

    /** @returns {number|null} resolved construction seed, or null when unseeded */
    get seed() {
        return this._seed;
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
        // The level owner validates and publishes (issue #78): the same
        // schema the campaign loader answers to (validateCustom), and the
        // level:loaded fact emitted by the LevelManager seam in the rebuild
        // below - never by hand here.
        levelManager.validateCustom(data);
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
        // The level fact arms GoalChecker (same seam as the live app) and
        // comes from the LevelManager owner - loadCustom, the exact seam
        // editor imports ride (the glossary owner rule: the browser/session
        // surface never emits level:loaded by hand; the replay harness
        // still hand-emits it for its checker wiring - the one known case
        // left). The play-mode boundary row belongs to the run framing in
        // trial(), not the build (issue #78: the run lifecycle is the loop
        // seam's business).
        levelManager.loadCustom(this.levelData);
        // Construction window (agent-side seeded determinism): object ctors are
        // the only Math.random consumers during a build (Balloon color/bob
        // phase, Candle flicker phase). With a seed configured, swap the global
        // generator for one re-seeded per rebuild, so every draw in this window
        // is reproducible run-over-run; restore before any step runs. With no
        // seed the swap never happens - behavior is exactly the browser's.
        const prevRandom = Math.random;
        if (this._seed !== null) Math.random = createSeedRng(this._seed);
        try {
            for (const d of this.levelData.fixedObjects) {
                try {
                    const obj = objectRegistry.create(d.type, d.x, d.y, levelObjectOptions(d));
                    this.engine.addObject(obj);
                } catch (e) {
                    console.warn(`[AgentSession] could not create fixed object: ${d.type}`, e);
                }
            }
            for (const p of this.placements) {
                this.engine.addObject(objectRegistry.create(p.type, p.x, p.y, { angle: p.angle }));
            }
        } finally {
            Math.random = prevRandom;
        }
    }

    /**
     * Run one deterministic trial: fresh world, step to `seconds`, judge.
     * @param {{ seconds?: number, dt?: number }} [options]
     * @returns {{ outcome: 'reached'|'failed'|'timeout', elapsed: number, events: object[],
     *            sentences: string[], snapshot: object[], distance: number }}
     */
    trial({ seconds = 5, dt = FIXED_STEP_MS } = {}) {
        this._rebuild();
        const recorder = new EventRecorder();
        recorder.start();
        const steps = Math.max(1, Math.round((seconds * 1000) / dt));
        // The run lifecycle is the loop seam's contract (issue #78), not a
        // private ordering: begin (`loop:play`, the packet GameLoop.play()
        // publishes), the play boundary row after it - sandbox order - then
        // one published step-to fact per engine step in the step -> elapsed
        // -> emit order ADR 0008 decision 2 pins, and the owned end fact
        // (`loop:reset`, the packet GameLoop.reset() publishes) closes it.
        // GoalChecker sees post-step states exactly as it does live.
        let elapsed = 0;
        eventBus.emit('loop:play', { elapsed: 0 });
        eventBus.emit('mode:changed', { oldMode: 'EDITING', newMode: 'PLAYING' });
        for (let i = 0; i < steps; i++) {
            this.engine.step(dt);
            elapsed += dt;
            eventBus.emit('loop:frame', { dt, elapsed });
            if (this._outcome) break; // GoalChecker latched a verdict
        }
        eventBus.emit('loop:reset', { elapsed: 0 });
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