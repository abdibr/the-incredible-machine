/**
 * LevelManager — Load, validate, track, and serialize puzzle levels
 *
 * Loads level JSON from js/levels/puzzles/, validates structure,
 * tracks player progress in localStorage, and handles level sequencing.
 */

import { eventBus } from '../EventBus.js';

/** All available level IDs (linear progression order) */
const LEVEL_ORDER = [
    'level-01', 'level-02', 'level-03', 'level-04', 'level-05',
    'level-06', // issue #67 campaign fixture: an anchored part demonstrates the flow end-to-end
];

/** localStorage key for progress */
const STORAGE_KEY = 'tim-progress';

class LevelManager {
    constructor() {
        /** @type {object|null} Current loaded level data */
        this._currentLevel = null;

        /** @type {Map<string, object>} Cache of loaded levels */
        this._levelCache = new Map();

        /** @type {Set<string>} Completed level IDs */
        this._completedLevels = new Set();
    }

    /**
     * Initialize — load saved progress from localStorage.
     */
    init() {
        this._loadProgress();

        // Listen for goal:reached to mark level complete (id-guarded: ad-hoc
        // levels may carry no id, and 'undefined' must not land in the
        // persisted progress set)
        eventBus.on('goal:reached', () => {
            if (this._currentLevel?.id) {
                this.markComplete(this._currentLevel.id);
            }
        });

        console.log('[LevelManager] Initialized');
    }

    /**
     * Load a level by ID. Fetches JSON, validates, caches, and emits 'level:loaded'.
     * @param {string} id - Level ID (e.g. 'level-01')
     * @returns {Promise<object>} Level data
     */
    async loadLevel(id) {
        // Check cache first
        if (this._levelCache.has(id)) {
            const data = this._levelCache.get(id);
            this._currentLevel = data;
            eventBus.emit('level:loaded', data);
            return data;
        }

        try {
            const url = `/js/levels/puzzles/${id}.json`;
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

            const data = await resp.json();
            this._validate(data);

            this._levelCache.set(id, data);
            this._currentLevel = data;

            eventBus.emit('level:loaded', data);
            console.log(`[LevelManager] Loaded: ${data.name}`);
            return data;
        } catch (e) {
            console.error(`[LevelManager] Failed to load level "${id}":`, e);
            throw e;
        }
    }

    /**
     * Load an ad-hoc level (e.g. a JSON file imported through the editor):
     * install it as the current level and emit 'level:loaded' through the
     * same seam as loadLevel(), so goal progression (`goal:reached` marks
     * the current level) and reset (`_resetLevel` reads `getCurrentLevel()`)
     * observe the data actually on screen — a direct bus emit left
     * `_currentLevel` pointing at the previous puzzle.
     * The player path (LevelSelect import, issue #70) goes through
     * validateCustom() first; the sandbox editor import stays lenient so a
     * broken save can still be opened for repair.
     * @param {object} data - arbitrary level data (validated upstream)
     * @returns {object} the same data
     */
    loadCustom(data) {
        this._currentLevel = data;
        eventBus.emit('level:loaded', data);
        return data;
    }

    /**
     * Validate a custom level's JSON without installing it (issue #70).
     *
     * The player-facing import path (LevelSelect → open as player) checks
     * before it opens: a broken or truncated save must be refused with a
     * readable message at level select, never partially built on the board.
     * Deliberately the same `_validate` the campaign loader runs, so a saved
     * level and a shipped level answer to the identical schema. (The sandbox
     * editor's own import stays lenient on purpose — it must be able to open
     * broken files for repair.)
     * @param {object} data - parsed custom level JSON
     * @returns {object} the same data, on success
     * @throws {Error} with a readable message on the first schema violation
     */
    validateCustom(data) {
        this._validate(data);
        return data;
    }

    /**
     * The sandbox document gate (issue #63): validateCustom's goal-less
     * sibling. Sandbox sessions load ad-hoc, goal-less boards - the goal,
     * the scarcity budget (availableParts) and the ADR 0009 solvability
     * proof are all optional, because a sandbox build is not a winnable
     * puzzle. The structural fields (id, name, fixedObjects) stay
     * required, and a goal that rides along with a sandbox document must
     * still carry its type. Puzzle documents never travel this gate:
     * validateCustom keeps the typed-goal requirement (and the rest of
     * the shared `_validate`) exactly as the campaign loader answers to it.
     * @param {object} data - parsed sandbox document JSON
     * @returns {object} the same data, on success
     * @throws {Error} with a readable message on the first schema violation
     */
    validateSandbox(data) {
        this._validate(data, { sandbox: true });
        return data;
    }

    /**
     * Get the current loaded level.
     * @returns {object|null}
     */
    getCurrentLevel() {
        return this._currentLevel;
    }

    /**
     * Get the next level after the current one (or null if last).
     * @returns {string|null} Level ID
     */
    getNextLevel() {
        if (!this._currentLevel) return LEVEL_ORDER[0] || null;
        const idx = LEVEL_ORDER.indexOf(this._currentLevel.id);
        if (idx < 0 || idx >= LEVEL_ORDER.length - 1) return null;
        return LEVEL_ORDER[idx + 1];
    }

    /**
     * Check if a level is completed.
     * @param {string} id
     * @returns {boolean}
     */
    isLevelCompleted(id) {
        return this._completedLevels.has(id);
    }

    /**
     * Check if a level is unlocked (first level always unlocked, rest require previous completion).
     * @param {string} id
     * @returns {boolean}
     */
    isLevelUnlocked(id) {
        const idx = LEVEL_ORDER.indexOf(id);
        if (idx <= 0) return true; // First level always unlocked
        // Unlocked if previous level is completed
        return this.isLevelCompleted(LEVEL_ORDER[idx - 1]);
    }

    /**
     * Mark a level as completed and persist.
     * @param {string} id
     */
    markComplete(id) {
        this._completedLevels.add(id);
        this._saveProgress();
        console.log(`[LevelManager] Completed: ${id}`);
    }

    /**
     * Get metadata for all levels (for level select screen).
     * @returns {Promise<Array<{ id, name, description, difficulty, unlocked, completed }>>}
     */
    async getLevelList() {
        const list = [];

        for (const id of LEVEL_ORDER) {
            // Try to load level data for metadata
            let data = this._levelCache.get(id);
            if (!data) {
                try {
                    const url = `/js/levels/puzzles/${id}.json`;
                    const resp = await fetch(url);
                    if (resp.ok) {
                        data = await resp.json();
                        this._levelCache.set(id, data);
                    }
                } catch (e) {
                    // Skip levels that can't be loaded
                    continue;
                }
            }

            if (data) {
                list.push({
                    id: data.id,
                    name: data.name,
                    description: data.description || '',
                    difficulty: data.difficulty || 1,
                    unlocked: this.isLevelUnlocked(id),
                    completed: this.isLevelCompleted(id),
                });
            }
        }

        return list;
    }

    /**
     * Get level order list.
     * @returns {string[]}
     */
    getLevelOrder() {
        return [...LEVEL_ORDER];
    }

    // ── Private ──────────────────────────────────

    _validate(data, { sandbox = false } = {}) {
        // The puzzle gate requires the full puzzle furniture; the sandbox
        // gate (issue #63) relaxes exactly the three puzzle-owning fields -
        // the typed goal, the scarcity budget and the ADR 0009 solution
        // proof - and never weakens the puzzle requirement itself.
        const required = sandbox
            ? ['id', 'name', 'fixedObjects']
            : ['id', 'name', 'goal', 'fixedObjects', 'availableParts', 'solution'];
        for (const field of required) {
            if (!(field in data)) {
                throw new Error(`[LevelManager] Level missing required field: "${field}"`);
            }
        }

        if (!sandbox) {
            if (!data.goal.type) {
                throw new Error('[LevelManager] Level goal must have a "type" field');
            }
        } else if (data.goal && !data.goal.type) {
            // A sandbox document may be goal-less (issue #63); a goal that
            // rides along still must carry its type - the puzzle wording.
            throw new Error('[LevelManager] Level goal must have a "type" field');
        }

        if (!Array.isArray(data.fixedObjects)) {
            throw new Error('[LevelManager] fixedObjects must be an array');
        }

        if (sandbox) {
            // A sandbox document's availableParts, when it rides along, must
            // still be map-shaped (a sandbox save carries its parts palette
            // there); the sandbox posture never budgets against it - the
            // placement budget is the registered roster (issue #63). And a
            // sandbox board ships no solvability proof: it is not a winnable
            // puzzle, so ADR 0009's two-scene rule is a puzzle requirement.
            if (data.availableParts != null && typeof data.availableParts !== 'object') {
                throw new Error('[LevelManager] availableParts must be an object');
            }
            return;
        }

        if (typeof data.availableParts !== 'object') {
            throw new Error('[LevelManager] availableParts must be an object');
        }

        // Solvability proof (ADR 0009): a level definition is two scenes —
        // the puzzle and its solution. Without a solution scene the level
        // cannot be shown to a player who gives up, and nothing guarantees it
        // can be won at all.
        if (!data.solution || !Array.isArray(data.solution.scene)) {
            throw new Error(
                '[LevelManager] Level needs a solvable proof: "solution.scene" must be an array of board rows (the solved scene, shown when the player gives up)'
            );
        }
        if (data.solution.scene.length === 0) {
            throw new Error('[LevelManager] solution.scene must carry at least one row — the solved board, not an empty one');
        }
        for (const row of data.solution.scene) {
            if (!row || typeof row.type !== 'string') {
                throw new Error('[LevelManager] solution.scene rows must each carry a "type" string');
            }
        }
    }

    _loadProgress() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
                const arr = JSON.parse(raw);
                if (Array.isArray(arr)) {
                    this._completedLevels = new Set(arr);
                }
            }
        } catch (e) {
            console.warn('[LevelManager] Could not load progress:', e);
        }
    }

    _saveProgress() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify([...this._completedLevels]));
        } catch (e) {
            console.warn('[LevelManager] Could not save progress:', e);
        }
    }
}

/** Singleton level manager instance */
export const levelManager = new LevelManager();
export default LevelManager;
