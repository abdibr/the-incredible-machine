/**
 * main.js — Application entry point for The Incredible Machine
 *
 * Initializes the game engine, renderer, UI panels, and manages
 * the top-level application mode state machine.
 */

import { eventBus } from './EventBus.js';
import { registerAllObjects } from './objects/registerAllObjects.js';
import { PhysicsEngine } from './engine/PhysicsEngine.js';
import { GameLoop } from './engine/GameLoop.js';
import { renderer } from './render/Renderer.js';
import { toolbox } from './ui/Toolbox.js';
import { playControls } from './ui/PlayControls.js';
import { levelManager } from './levels/LevelManager.js';
import { goalOverlay } from './ui/GoalOverlay.js';
import { goalChecker, goalSentence } from './goals/GoalChecker.js';
import { levelSelect } from './ui/LevelSelect.js';
import { editorPanel } from './ui/EditorPanel.js';
import { palettePanel } from './ui/PalettePanel.js';
import { dragDropManager } from './ui/DragDropManager.js';
import { objectRegistry } from './objects/ObjectRegistry.js';
import { beginPlay, restorePlacedFromSnapshot, resetSandboxBoard, resetReturnPosture, serializePlacedBoard } from './reset/levelReset.js';
import { levelObjectOptions } from './ui/selectionHandles.js';
import { sessionRecorder } from './recorder/SessionRecorder.js';
import { localMirrorStore } from './recorder/browser.js';

// ──────────────────────────────────────────────
// Application Modes
// ──────────────────────────────────────────────
export const AppMode = Object.freeze({
    MENU: 'MENU',
    EDITING: 'EDITING',
    PLAYING: 'PLAYING',
    PAUSED: 'PAUSED',
    WON: 'WON',
    SANDBOX: 'SANDBOX',
    /** Read-only display of a level's solution scene (ADR 0009 give-up). */
    SOLUTION: 'SOLUTION',
});

// ──────────────────────────────────────────────
// Application State
// ──────────────────────────────────────────────
const state = {
    mode: AppMode.MENU,
    currentLevelId: null,
    /** @type {import('./objects/BaseObject.js').default[]} */
    placedObjects: [],
    /** Saved snapshot of placed objects for reset */
    _savedPlacedSnapshot: [],
    /**
     * The posture the current/last run was born in (issue #71): recorded at
     * controls:play so the reset path can return to it — a sandbox-born run
     * re-enters the sandbox even though a loaded level sets a level id.
     * Null before the first play (the fallback then decides from the level
     * id — the historical heuristic).
     */
    _runOriginPosture: null,
    /**
     * The give-up seam (ADR 0009): the user's attempt board, serialized when
     * the solution view opens, restored by the return path. Empty outside
     * the SOLUTION posture.
     */
    _attemptSnapshot: [],
    /** @type {PhysicsEngine|null} */
    physicsEngine: null,
    /** @type {GameLoop|null} */
    gameLoop: null,
};

/**
 * Switch application mode and notify all listeners.
 * @param {string} newMode - One of AppMode values
 */
export function setMode(newMode) {
    const oldMode = state.mode;
    state.mode = newMode;
    // Entering the sandbox drops the header goal line (issue #70): a fresh
    // sandbox has no win/lose until a level is loaded (issue #63 posture),
    // and the editor panel's readout is the goal truth there. Player
    // sessions (level solving from a campaign card or an imported custom
    // level) keep the goal line through EDITING/PLAYING/PAUSED/WON.
    if (newMode === AppMode.SANDBOX) {
        clearHeaderGoal();
    }
    eventBus.emit('mode:changed', { oldMode, newMode });
    console.log(`[App] Mode: ${oldMode} → ${newMode}`);
}

/**
 * Get current application mode.
 * @returns {string}
 */
export function getMode() {
    return state.mode;
}

/**
 * The live physics engine (read-only test seam: give-up assertions peer at
 * the engine to prove the solution view adds no game bodies).
 * @returns {import('./engine/PhysicsEngine.js').PhysicsEngine|null}
 */
export function getPhysicsEngine() {
    return state.physicsEngine;
}

/**
 * Update the header readout for a loaded level — the level name and, since
 * issue #70, a plain-language goal line. Exported separately from the
 * level:loaded wiring so the header slice is unit-testable without a full
 * DOM boot (the same way wireSpeedControl is). The sentence comes from the
 * shared goalSentence() — the same truth the editor's goal readout uses —
 * resolved against the freshly built board, so a goal zone that matches
 * nothing on the field is said out loud here too.
 * @param {object|null} levelData - the loaded level JSON
 * @param {Array<import('./objects/BaseObject.js').default>} [objects] - the
 *        freshly built board (fixed furniture + restored parts)
 * @returns {{ name: string, goal: string }} what the header now shows
 */
export function setHeaderLevel(levelData, objects = []) {
    const name = levelData?.name ? String(levelData.name) : '';
    const goal = levelData?.goal
        ? `🎯 Goal: ${goalSentence(levelData.goal, objects)}.`
        : '';
    const levelNameEl = document.getElementById('level-name');
    if (levelNameEl) {
        levelNameEl.textContent = name;
    }
    const goalEl = document.getElementById('goal-name');
    if (goalEl) {
        goalEl.textContent = goal;
    }
    return { name, goal };
}

/**
 * Clear the header goal line (sandbox entry — issue #63 posture: sandbox
 * play has no win/lose until a level is loaded; see setMode).
 * @private
 */
function clearHeaderGoal() {
    const goalEl = document.getElementById('goal-name');
    if (goalEl) {
        goalEl.textContent = '';
    }
}

/**
 * Subscribe the speed control to the game loop (issue #4 / TODO §2.1).
 * Exported separately from _wireEvents() so the wiring is unit-testable
 * without a DOM boot.
 * @param {{gameLoop: GameLoop|null}} appState
 * @returns {Function} unsubscribe function
 */
export function wireSpeedControl(appState) {
    return eventBus.on('controls:speed', () => {
        if (appState.gameLoop) appState.gameLoop.cycleSpeed();
    });
}

/**
 * Subscribe the rope debug overlay toggle (issue #59): the DBG control
 * flips the renderer's overlay flag and nothing else - a debugging
 * affordance must not disturb the simulation or gameplay state.
 * Exported separately from _wireEvents() so the wiring is unit-testable
 * without a DOM boot (same way wireSpeedControl is).
 * @returns {Function} unsubscribe function
 */
export function wireRopeDebugOverlay() {
    return eventBus.on('controls:rope-debug', ({ enabled }) => {
        renderer.showRopeDebugOverlay = enabled === true;
    });
}

// ──────────────────────────────────────────────
// Initialization
// ──────────────────────────────────────────────
function init() {
    console.log('🔧 The Incredible Machine — Initializing...');

    // Get DOM elements
    const canvas = document.getElementById('game-canvas');
    const gameArea = document.getElementById('game-area');

    if (!canvas || !gameArea) {
        console.error('[App] Required DOM elements not found');
        return;
    }

    // Fixed playfield size: levels are authored for a 1000×600 world, and
    // goal objects near the bottom/right edge of that world (e.g. the level-1
    // bucket at x=700,y=480) must stay inside the physics boundaries at every
    // window size. The canvas stretches to the game area via CSS
    // (`#game-canvas { width: 100%; height: 100% }`), so the backing store
    // (world space) can stay constant; renderer.pageToCanvas() already
    // divides by the CSS scale. (Found via QA: with the old resize-to-area
    // canvas, world space equalled the container size — at a 714×471 window
    // the bucket's sensor sat below the physics floor and balls could never
    // be caught.)
    const WORLD_WIDTH = 1000;
    const WORLD_HEIGHT = 600;
    canvas.width = WORLD_WIDTH;
    canvas.height = WORLD_HEIGHT;

    // ── Register ALL real game objects ──
    registerAllObjects();

    // ── Create physics engine and game loop ──
    state.physicsEngine = new PhysicsEngine(canvas.width, canvas.height);
    state.gameLoop = new GameLoop(state.physicsEngine, () => {
        // GameLoop drives rendering during play — renderer.startLoop()
        // handles the edit-mode loop (see below).
        renderer.render();
    });

    // ── Module initialization order ──
    // 1. Renderer
    renderer.init(canvas);
    renderer.setObjects(state.placedObjects);

    // 2. Toolbox
    toolbox.init();

    // 3. Play Controls
    playControls.init();

    // 4. Level Manager
    levelManager.init();

    // 5. Goal Overlay
    goalOverlay.init();

    // 6. Goal Checker — listens for bucket:caught / loop:frame and emits
    //    goal:reached / goal:failed (GoalOverlay + LevelManager display
    //    the overlay and mark progress; main.js answers overlay:next-level)
    goalChecker.init({ physicsEngine: state.physicsEngine });

    // 7. Level Select
    levelSelect.init();

    // 8. Editor Panel
    editorPanel.init();

    // 9. Parts Palette panel (issue #69) — the parts palette lives in its
    //    own floating panel (separate from the editor panel, same collapse/
    //    move header chrome); EditorPanel delegates save/load/offers to it.
    palettePanel.init();

    // 10. Drag-and-Drop (after Renderer + Toolbox)
    dragDropManager.init(state.placedObjects);
    // The renderer paints the click-to-connect squares from the same flow
    // instance the drag-drop handler delegates square clicks to
    // (ADR 0007 decision 2).
    renderer.setConnectFlow(dragDropManager.connectFlow);
    renderer.setPhysicsEngine(state.physicsEngine);
    // The rope debug overlay (issue #59) reads the live engine picture from
    // the same engine the game loop steps - read-only access.
    // Fixed-end tie pulls clamp to the same world as the physics engine's
    // boundary walls (ADR 0007 decision 4): a pulled target must never be
    // parked inside a wall. Same dims the engine was constructed with.
    dragDropManager.connectFlow.setPlayfield(state.physicsEngine.width, state.physicsEngine.height);

    // 11. Session bug-file recorder (ADR 0006) — always-on in SANDBOX;
    //     the Editor panel surfaces export / recovery for it.
    sessionRecorder.init({
        getBoard: () => state.placedObjects,
        getSnapshot: () => (state._savedPlacedSnapshot.length > 0 ? state._savedPlacedSnapshot : null),
        getEngine: () => state.physicsEngine?.engine ?? null,
        getPlayfield: () => (state.physicsEngine
            ? { width: state.physicsEngine.width, height: state.physicsEngine.height }
            : null),
        getEngineInfo: () => (state.physicsEngine
            ? {
                gravityX: state.physicsEngine.engine.gravity.x,
                gravityY: state.physicsEngine.engine.gravity.y,
                enableSleeping: state.physicsEngine.engine.enableSleeping,
            }
            : null),
        mirrorStore: localMirrorStore(),
    });
    window.addEventListener('beforeunload', () => sessionRecorder.flushMirror());

    // ── Wire up mode transition events ──
    _wireEvents();

    // ── Start render loop (paused once GameLoop takes over) ──
    renderer.startLoop();

    // ── Show level select on start ──
    setMode(AppMode.MENU);

    console.log('✅ The Incredible Machine — Ready!');
    eventBus.emit('app:ready');
}

// ──────────────────────────────────────────────
// Event Wiring — mode transitions
// ──────────────────────────────────────────────
function _wireEvents() {
    // Play button → PLAYING
    eventBus.on('controls:play', () => {
        const mode = getMode();
        if (mode === 'EDITING' || mode === 'PAUSED' || mode === 'SANDBOX') {
            // On first play (not resume), rebuild the physics world from the
            // placed board and save the snapshot for reset
            // (GameLoop.play() takes the physics snapshot when STOPPED)
            if (mode === 'EDITING' || mode === 'SANDBOX') {
                state._savedPlacedSnapshot = beginPlay(state.physicsEngine, state.placedObjects);
                // The play-start snapshot, announced (ADR 0009): the editor
                // captures it as the solution scene when this run wins.
                eventBus.emit('run:started', { snapshot: state._savedPlacedSnapshot });
                // Record the posture this run was born in: the reset path
                // returns to it, not to a mode guessed from the level id —
                // the sandbox Load Level path installs an id too (issue #71).
                state._runOriginPosture = mode;
            }
            // Stop renderer's own loop — GameLoop will drive rendering
            renderer.stopLoop();
            state.gameLoop.play();
            setMode(AppMode.PLAYING);
        }
    });

    // Pause button → PAUSED
    eventBus.on('controls:pause', () => {
        if (getMode() === 'PLAYING') {
            state.gameLoop.pause();
            // Restart renderer loop for edit-mode rendering
            renderer.startLoop();
            setMode(AppMode.PAUSED);
        }
    });

    // Reset button → back to EDITING (restore snapshot); in the solution
    // view (ADR 0009) Reset doubles as the return to the user's attempt.
    eventBus.on('controls:reset', () => {
        const mode = getMode();
        if (mode === AppMode.SOLUTION) {
            _leaveSolution();
            return;
        }
        if (mode === 'PLAYING' || mode === 'PAUSED' || mode === 'WON') {
            // GameLoop.reset() already restores snapshot + clears it
            state.gameLoop.reset();
            // Restart renderer loop for edit-mode rendering
            renderer.startLoop();
            _resetLevel();
        }
    });

    // Speed button → cycle motion speed (issue #4 / TODO §2.1)
    wireSpeedControl(state);
    wireRopeDebugOverlay();
    // The rope debug overlay toggle (issue #59): the DBG control flips the
    // renderer's overlay flag only - the one play-safe debugging affordance.

    // Level loaded → set up the board
    eventBus.on('level:loaded', (levelData) => {
        state.currentLevelId = levelData.id;
        _setupLevel(levelData);

        // Update the header: level name + a plain-language goal line
        // (issue #70). The sentence resolves against the freshly built
        // board — the same goalSentence() the editor's readout uses, so a
        // zone that matches nothing on the board is said out loud here too.
        setHeaderLevel(levelData, state.placedObjects);
    });

    // Give up → the level's solution scene (ADR 0009, docs/adr/
    // 0009-scene-lock-and-solution-scenes.md): player postures only, a
    // solution having been validated in. The board swaps to the solved
    // scene in a read-only posture; the user's attempt rides the snapshot
    // for the return path.
    eventBus.on('controls:give-up', () => _enterSolution());

    // Return from the solution view → the user's attempt, rebuilt the same
    // way a post-run reset rebuilds it (furniture fresh from level JSON,
    // player parts from the give-up-time snapshot).
    eventBus.on('controls:solution-return', () => _leaveSolution());

    // Next level
    eventBus.on('overlay:next-level', async ({ levelId }) => {
        // The goal overlay fires while the GameLoop is still RUNNING (the
        // win/fail overlay itself does not pause it; it only emits events).
        // Overlay-driven mode switches MUST stop the loop first, or the next
        // `controls:play` hits GameLoop.play()'s RUNNING early-return and
        // skips the contracted play-start snapshot (stale snapshot then
        // false-triggers the mismatch re-baseline on the next reset).
        // Mirrors controls:reset's ordered path (reviewer finding #1).
        if (!state.gameLoop.isStopped) state.gameLoop.reset();
        renderer.startLoop();
        try {
            await levelManager.loadLevel(levelId);
            setMode(AppMode.EDITING);
        } catch (e) {
            console.error('[App] Failed to load next level:', e);
        }
    });

    // Retry → reset the level
    eventBus.on('overlay:retry', () => {
        // Loop-stop first (same reason as overlay:next-level).
        if (!state.gameLoop.isStopped) state.gameLoop.reset();
        renderer.startLoop();
        _resetLevel();
    });

    // Back to menu
    eventBus.on('overlay:menu', () => {
        // Loop-stop first (same reason as overlay:next-level).
        if (!state.gameLoop.isStopped) state.gameLoop.reset();
        renderer.startLoop();
        state.placedObjects.length = 0;
        renderer.setObjects(state.placedObjects);
        setMode(AppMode.MENU);
    });
}

/**
 * Exported for testability (same slice pattern as setHeaderLevel): the
 * give-up handler behind `controls:give-up`. Null-safe before a full boot —
 * a test can drive the real seam with no game loop or engine built yet.
 */
export function enterSolutionView() {
    _enterSolution();
}

/**
 * Exported for testability: the return handler behind
 * `controls:solution-return` (and Reset, while in the solution view).
 */
export function leaveSolution() {
    _leaveSolution();
}

/**
 * Show the level's solution scene (ADR 0009 give-up).
 *
 * Any running attempt stops first (the same ordered loop-stop the reset path
 * uses). The user's board is serialized to `_attemptSnapshot`, then the board
 * swaps to the level's `solution.scene` — rebuilt as a FULL board restore
 * (furniture and placed rows, exactly as the author left them at their
 * winning play-start). The SOLUTION posture is display-only: the loop is not
 * stepped and no physics bodies are added, so the goal checker cannot be
 * reached and watching the solution never marks the level complete.
 * @private
 */
function _enterSolution() {
    const mode = getMode();
    if (!['EDITING', 'PLAYING', 'PAUSED', 'WON'].includes(mode)) return;
    const levelData = levelManager.getCurrentLevel();
    const scene = levelData?.solution?.scene;
    if (!Array.isArray(scene) || scene.length === 0) return;

    // Stop any running attempt before touching the board (ordered path;
    // null-safe before a boot that has built the loop)
    if (state.gameLoop && !state.gameLoop.isStopped) state.gameLoop.reset();
    if (renderer.canvas) renderer.startLoop();
    goalOverlay.hide();

    state._attemptSnapshot = serializePlacedBoard(state.placedObjects);

    if (state.physicsEngine) state.physicsEngine.clear();
    state.placedObjects.length = 0;
    restorePlacedFromSnapshot(state.placedObjects, scene, objectRegistry, { includeFixed: true });
    _showHeaderSolution(levelData);
    setMode(AppMode.SOLUTION);
}

/**
 * Leave the solution view: rebuild the level, restore the user's attempt
 * from the give-up-time snapshot, back to campaign editing.
 * @private
 */
function _leaveSolution() {
    if (getMode() !== AppMode.SOLUTION) return;
    const levelData = levelManager.getCurrentLevel();
    const attempt = state._attemptSnapshot;
    _setupLevel(levelData);
    restorePlacedFromSnapshot(state.placedObjects, attempt);
    setHeaderLevel(levelData, state.placedObjects);
    state._attemptSnapshot = [];
    setMode(AppMode.EDITING);
}

/**
 * Header line for the solution view (ADR 0009): the level name gains the
 * solution marker and the goal line says what is shown and how to leave.
 * @private
 */
function _showHeaderSolution(levelData) {
    const nameEl = document.getElementById('level-name');
    if (nameEl) {
        nameEl.textContent = levelData?.name ? `💡 Solution — ${levelData.name}` : '💡 Solution';
    }
    const goalEl = document.getElementById('goal-name');
    if (goalEl) {
        goalEl.textContent = 'The solved machine, proven solvable — press Return (or Reset) to go back to your own attempt.';
    }
}

/**
 * Set up a level — load fixed objects onto the board.
 */
function _setupLevel(levelData) {
    // Clear physics world (remove game objects, keep boundaries)
    state.physicsEngine.clear();

    // Clear existing objects
    state.placedObjects.length = 0;

    // Create fixed objects from level data
    if (levelData.fixedObjects) {
        for (const objData of levelData.fixedObjects) {
            try {
                const obj = objectRegistry.create(objData.type, objData.x, objData.y, levelObjectOptions(objData));
                state.placedObjects.push(obj);
            } catch (e) {
                console.warn(`[App] Could not create fixed object: ${objData.type}`, e);
            }
        }
    }

    renderer.setObjects(state.placedObjects);
    state._savedPlacedSnapshot = [];
}

/**
 * Reset the current level — rebuild the board for edit mode.
 *
 * The player's machine survives: player-placed objects are restored from
 * the snapshot taken at the start of the last play. The app returns to the
 * posture the run was born in (issue #71): a sandbox-born run rewinds to
 * its play-start board and re-enters the sandbox — the sandbox Load Level
 * path installs a level id too, so id presence cannot decide the posture —
 * and a campaign-born run rebuilds the level and returns to campaign
 * editing.
 */
function _resetLevel() {
    const levelData = levelManager.getCurrentLevel();
    const previousMode = getMode();
    // Capture before _setupLevel() replaces the snapshot on board rebuild
    const savedPlacedSnapshot = state._savedPlacedSnapshot;

    // The posture this run was born in, recorded at controls:play (issue
    // #71); without a record (unreachable in practice) the historical
    // level-id heuristic decides.
    const returnPosture = resetReturnPosture(state._runOriginPosture, levelData);

    if (returnPosture === AppMode.EDITING) {
        _setupLevel(levelData);

        // Restore the player's parts from the placed snapshot (bodies
        // re-added on next play). The renderer shares the placedObjects
        // array reference, so restored parts are drawn automatically.
        restorePlacedFromSnapshot(state.placedObjects, savedPlacedSnapshot);

        // Determine which mode to return to
        if (previousMode === 'WON' || previousMode === 'PLAYING' || previousMode === 'PAUSED') {
            setMode(AppMode.EDITING);
        }
    } else {
        // Sandbox run — rewind to the last play-start board (decided
        // semantic: reset never destroys a sandbox; without a prior play
        // there is nothing to rewind to, so the sandbox is left untouched).
        // The play-start snapshot IS the board: a loaded level's fixed
        // content round-trips inside it, so the stop re-enters the sandbox
        // exactly as the run found it (issue #71).
        resetSandboxBoard(state.physicsEngine, state.placedObjects, savedPlacedSnapshot);
        setMode(AppMode.SANDBOX);
    }
}

// Boot the app when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
