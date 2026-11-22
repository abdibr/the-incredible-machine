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
 *
 * The trial is steppable (issue #61): beginTrial() opens a run with the
 * same begin facts, advanceTrial() steps any number of frames between
 * pauses, the run view reads the latched verdict and event log at any
 * point, and finalizeTrial() returns the same result object trial()
 * returns. trial() IS that composition, so the two spellings cannot
 * drift: what a watched run latches is what trial() judged.
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

/**
 * The sandbox palette's per-type count (issue #63): every registered part,
 * at the count the game's unauthored sandbox posture writes on Save (the
 * default palette - js/ui/PalettePanel.js DEFAULT_PALETTE_COUNT, issue #69,
 * "every type x10"). The parity is deliberate: if the game's default
 * palette count ever changes, this constant and the agent-side sandbox
 * posture documentation follow it.
 */
const SANDBOX_PALETTE_COUNT = 10;

/**
 * TrialRun - one live steppable trial run (issue #61).
 *
 * Created ONLY by AgentSession.beginTrial (the world it watches belongs
 * to the session); the session itself does the stepping (advanceTrial)
 * and the closing (finalizeTrial). The run object is the read surface:
 * its getters answer the latched verdict, the failure reason and the
 * event log at any pause between frames - exactly what the run has
 * judged so far - and stay readable after finalize.
 */
export class TrialRun {
    /**
     * @param {AgentSession} session the world owner (module-internal back reference)
     * @param {{ dt: number, steps: number, recorder: EventRecorder }} shape
     * @private (beginTrial constructs runs)
     */
    constructor(session, { dt, steps, recorder }) {
        this._session = session;
        /** @type {number} the frame quantum in ms - the trial's dt, defaulting to the loop's FIXED_STEP_MS double */
        this.dt = dt;
        /** @type {number} planned frame count - trial()'s Math.max(1, round(seconds*1000/dt)) arithmetic */
        this.steps = steps;
        /** @type {number} frames stepped so far */
        this.stepped = 0;
        /** @type {number} ms of sim time actually stepped (whole dt multiples) */
        this.elapsed = 0;
        /** @type {EventRecorder} @private subscribes from begin to finalize only */
        this._recorder = recorder;
    }

    /** @returns {'reached'|'failed'|null} the latched verdict (null until GoalChecker has one) */
    get verdict() {
        return this._session._outcome;
    }

    /** @returns {string|undefined} the failure packet reason while verdict is 'failed' */
    get failureReason() {
        return this._session._failureReason;
    }

    /** @returns {Array<{t: string, text: string, landmark?: boolean}>} event rows so far (a copy) */
    get events() {
        return this._recorder.rows;
    }

    /**
     * @returns {number} the frames advanceTrial would still step: zero once
     * the verdict latched or the budget stepped out (a latched run stops
     * stepping exactly where the all-at-once loop broke)
     */
    get stepsLeft() {
        return this.verdict === null ? Math.max(0, this.steps - this.stepped) : 0;
    }

    /** @returns {boolean} stepping is over: the verdict latched or the budget stepped out */
    get done() {
        return this.stepsLeft === 0;
    }

    /** @returns {boolean} the session still holds this run open (finalizeTrial closes it) */
    get open() {
        return this._session._run === this;
    }
}

/**
 * The seed env var value, read only where an environment exists: a
 * browser page has no `process` (ADR 0010 made the agent layer loadable
 * there), and unseeded stays the browser posture. In Node this answers
 * exactly the env lookup it replaces.
 * @returns {string|number|undefined}
 */
function seedEnvValue() {
    if (typeof process === `undefined`) return undefined;
    return process.env?.[SEED_ENV_VAR];
}

export class AgentSession {
    /**
     * @param {{ width?: number, height?: number, seed?: number|string }} [options]
     *      playfield size; `seed` opts this session into seeded construction
     *      randomness (strings accepted, e.g. a raw env value). When omitted
     *      the TIM_AGENT_SEED env var is consulted; both unset = today's
     *      unseeded behavior. `sandbox: true` opens the sandbox posture
     *      (issue #63): goal-less ad-hoc sessions - the load gate accepts
     *      goal-less documents, placements draw from the parts palette (the
     *      registered roster), and runs judge no goal. Defaults false - the
     *      puzzle posture, today's behavior to the byte.
     */
    constructor({ width = 1000, height = 600, seed, sandbox = false } = {}) {
        if (objectRegistry.getAll().length === 0) registerAllObjects();
        this.width = width;
        this.height = height;
        this.levelData = null;
        /** @type {Array<{type:string,x:number,y:number,angle:number}>} agent placements — source of truth */
        this.placements = [];
        /** @type {PhysicsEngine|null} */
        this.engine = null;
        // The session posture (issue #63): true = sandbox - goal-less
        // ad-hoc sessions; placements from the parts palette; runs that
        // never judge a goal. Default false: the puzzle posture, today's
        // behavior to the byte.
        this._sandbox = !!sandbox;
        this._goalChecker = null;
        this._outcome = null;
        this._failureReason = null;
        this._lastResult = null;
        /** @type {TrialRun|null} the open steppable run (issue #61) - null when none is open */
        this._run = null;
        // Opt-in seeded determinism, agent-side only (null = unseeded = stock
        // Math.random behavior). Re-applied per build in _rebuild().
        this._seed = resolveSeed(seed === undefined ? seedEnvValue() : seed);
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
     * The open steppable run (issue #61), or null before beginTrial / after
     * finalizeTrial. Between frames this is the read-latch handle (the same
     * object beginTrial returned): verdict, failure reason, event log,
     * clock - readable any time; live poses stay on snapshotObjects().
     * @returns {TrialRun|null}
     */
    get trialRun() {
        return this._run;
    }

    /**
     * Load a level by id (fs, levels live in js/levels/puzzles/) or accept a
     * full level-data object directly (ad-hoc / custom levels). The string
     * branch is Node-only (ADR 0010): a browser fetches the level JSON itself
     * and calls loadLevel with the parsed data object.
     * @param {string|object} idOrData e.g. 'level-01'
     */
    async loadLevel(idOrData) {
        this._abandonRun(); // the watched world is torn down; a run over it is over
        let data = idOrData;
        if (typeof idOrData === 'string') {
            // ADR 0010: the fs level loader stays Node-only. A browser page
            // fetches the served level JSON itself (js/watch/watchFlow.js,
            // the same URL the campaign loader pulls) and hands the
            // session the level data object.
            if (typeof document !== `undefined`) {
                throw new Error(`[AgentSession] loadLevel(id) is Node-only (ADR 0010): the browser fetches the level JSON itself and passes the parsed level data object.`);
            }
            const fs = await import('node:fs/promises');
            const path = new URL(`../js/levels/puzzles/${idOrData}.json`, import.meta.url);
            data = JSON.parse(await fs.readFile(path, 'utf8'));
        }
        // The level owner validates and publishes (issue #78): the same
        // schema the campaign loader answers to (validateCustom), and the
        // level:loaded fact emitted by the LevelManager seam in the rebuild
        // below - never by hand here.
        // The level owner validates and publishes (issue #78): the sandbox
        // posture (issue #63) takes the goal-less sibling gate - the same
        // schema owner, the puzzle requirements relaxed only for the posture
        // that carries them - and every other load keeps answering to the
        // same schema the campaign loader runs (validateCustom).
        if (this._sandbox) {
            levelManager.validateSandbox(data);
        } else {
            levelManager.validateCustom(data);
        }
        this.levelData = data;
        this.placements = [];
        this._rebuild();
        return this;
    }

    /**
     * The placement budget per type.
     * Puzzle posture: the level's availableParts counts minus placed.
     * Sandbox posture (issue #63): the parts palette - every registered
     * type at the unauthored sandbox posture's default count (the game's
     * DEFAULT_PALETTE_COUNT of 10, the palette an untweaked sandbox Save
     * writes - PalettePanel, issue #69) minus placed. The level document
     * carries no budget in the sandbox: its availableParts, when present,
     * is carry-through save data, never the constraint.
     */
    budget() {
        const placed = {};
        for (const p of this.placements) placed[p.type] = (placed[p.type] ?? 0) + 1;
        if (this._sandbox) {
            // The palette is the registered roster, not the document -
            // `place` keeps refusing its way through this same shape.
            const remaining = {};
            for (const { type } of objectRegistry.getAll()) {
                remaining[type] = SANDBOX_PALETTE_COUNT - (placed[type] ?? 0);
            }
            return remaining;
        }
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
        // The sandbox posture (issue #63): runs are goal-less BY POSTURE -
        // no checker is installed, so no verdict can latch and no goal
        // event can fire, even when a document carries a goal shape. The
        // run rides its budget to 'timeout'; distanceToZone() reads
        // Infinity on a goal-less board. The puzzle posture arms the same
        // private checker exactly as before.
        if (!this._sandbox) {
            this._goalChecker = new GoalChecker();
            this._goalChecker.init({ physicsEngine: this.engine });
        }
        this._outcome = null;
        this._failureReason = null;
        // The level fact arms GoalChecker (same seam as the live app) and
        // comes from the LevelManager owner - loadCustom, the exact seam
        // editor imports ride (the glossary owner rule: the browser/session
        // surface never emits level:loaded by hand; the replay harness
        // still hand-emits it for its checker wiring - the one known case
        // left). The play-mode boundary row belongs to the run framing
        // (trial() and the steppable seam), not the build (issue #78: the
        // run lifecycle is the loop seam's business).
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
     * Run one deterministic trial: fresh world, step to `seconds`, judge
     * (the all-at-once spelling - exact contract unchanged). This is the
     * steppable seam as one call - beginTrial, advanceTrial over the whole
     * budget, finalizeTrial - so the two spellings are identical by
     * construction (issue #61 stepping parity).
     * @param {{ seconds?: number, dt?: number }} [options]
     * @returns {{ outcome: 'reached'|'failed'|'timeout', elapsed: number, events: object[],
     *            snapshot: object[], distance: number, failureReason?: string }}
     */
    trial({ seconds = 5, dt = FIXED_STEP_MS } = {}) {
        // A steppable run mixed into this call is abandoned, never merged:
        // its recorder is released quietly and this fresh run owns the world.
        this._abandonRun();
        this.beginTrial({ seconds, dt });
        this.advanceTrial(this._run.steps);
        return this.finalizeTrial();
    }

    /**
     * Begin a steppable trial run (issue #61): fresh world, event recorder
     * and run facts opened exactly as trial() frames them - loop:play (the
     * packet GameLoop.play() publishes), the play boundary row after it
     * (sandbox order) - and then each loop:frame arrives from advanceTrial.
     * Between advances the caller may pause as long as it likes: the
     * returned run view reads the latched verdict, the failure reason and
     * the event log at any point; live poses and the live distance stay on
     * the public getters (snapshotObjects / distanceToZone).
     * @param {{ seconds?: number, dt?: number }} [options] the budget and
     *   frame quantum - the same arithmetic trial() applies (one step
     *   minimum; the dt default is the loop's FIXED_STEP_MS double)
     * @returns {TrialRun} the open run; finalize it with finalizeTrial()
     */
    beginTrial({ seconds = 5, dt = FIXED_STEP_MS } = {}) {
        if (this._run) {
            throw new Error('[AgentSession] beginTrial: a trial run is already open (finalizeTrial it before beginning another)');
        }
        this._rebuild();
        const recorder = new EventRecorder();
        recorder.start();
        const steps = Math.max(1, Math.round((seconds * 1000) / dt));
        // The run lifecycle is the loop seam's contract (issue #78), not a
        // private ordering: the begin loop:play is the packet GameLoop.play()
        // publishes, and the play boundary row follows it (sandbox order);
        // the per-step fact belongs to advanceTrial and the owned end fact
        // (loop:reset) to finalizeTrial. GoalChecker sees post-step states
        // exactly as it does live.
        eventBus.emit('loop:play', { elapsed: 0 });
        eventBus.emit('mode:changed', { oldMode: 'EDITING', newMode: 'PLAYING' });
        this._run = new TrialRun(this, { dt, steps, recorder });
        return this._run;
    }

    /**
     * Advance the open trial run by at most `frames` steps, then stop for
     * however long the caller likes (issue #61). The step body is trial()'s
     * exact loop: engine.step -> elapsed -> emit loop:frame - the post-step
     * packet in the step -> elapsed -> emit order ADR 0008 decision 2 pins
     * - breaking early when GoalChecker latches a verdict and never
     * stepping past the run budget: a done or latched run steps nothing
     * further, so the watched frames are the frames the all-at-once loop
     * would have stepped, only unwrapped over time.
     * @param {number} [frames] how many frames to step this call (fractional
     *   asks floor - a frame is never half-stepped; a non-finite ask
     *   steps nothing - the budget is on the run view)
     * @returns {{ stepped: number, done: boolean, verdict: 'reached'|'failed'|null }}
     *   frames actually stepped this call, whether the run is over, and the
     *   latched verdict (null until GoalChecker has one)
     */
    advanceTrial(frames = 1) {
        const run = this._run;
        if (!run) throw new Error('[AgentSession] advanceTrial: no trial run is open (beginTrial first)');
        let target = Math.floor(frames);
        if (!Number.isFinite(target)) target = 0;
        const before = run.stepped; // the run's own counter is the one truth - this call steps the delta
        while (!run.done && run.stepped - before < target) {
            this.engine.step(run.dt);
            run.elapsed += run.dt;
            run.stepped++;
            eventBus.emit('loop:frame', { dt: run.dt, elapsed: run.elapsed });
            if (this._outcome) break; // GoalChecker latched a verdict
        }
        return { stepped: run.stepped - before, done: run.done, verdict: run.verdict };
    }

    /**
     * Finalize the open trial run: the owned end fact (loop:reset, the
     * packet GameLoop.reset() publishes - exactly one, latched verdict or
     * not), recorder unsubscription, and the same result object the
     * all-at-once trial returns (issue #61 parity by construction).
     * `elapsed` is the sim time actually stepped, not the budget.
     * @returns {{ outcome: 'reached'|'failed'|'timeout', elapsed: number, events: object[],
     *            snapshot: object[], distance: number, failureReason?: string }}
     */
    finalizeTrial() {
        const run = this._run;
        if (!run) throw new Error('[AgentSession] finalizeTrial: no trial run is open (beginTrial first)');
        eventBus.emit('loop:reset', { elapsed: 0 });
        const outcome = this._outcome ?? 'timeout';
        run._recorder.stop();
        const distance = this.distanceToZone();
        this._lastResult = {
            outcome,
            elapsed: run.elapsed,
            events: run._recorder.rows,
            distance,
            snapshot: this.snapshotObjects(),
            failureReason: this._failureReason,
        };
        this._run = null;
        return this._lastResult;
    }

    /** Quietly release the open run's recorder without judging it - the run is gone, not ended. @private */
    _abandonRun() {
        this._run?._recorder.stop();
        this._run = null;
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
        this._abandonRun(); // an open steppable run must not outlive the session (its recorder would leak)
        this._teardown();
        for (const unsub of this._unsubs) unsub();
        this._unsubs = [];
    }
}