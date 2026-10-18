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
import { goalChecker } from './goals/GoalChecker.js';
import { levelSelect } from './ui/LevelSelect.js';
import { editorPanel } from './ui/EditorPanel.js';
import { dragDropManager } from './ui/DragDropManager.js';
import { objectRegistry } from './objects/ObjectRegistry.js';
import { beginPlay, restorePlacedFromSnapshot, resetSandboxBoard } from './reset/levelReset.js';

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

    // Size canvas to fill the game area
    function resizeCanvas() {
        canvas.width = gameArea.clientWidth;
        canvas.height = gameArea.clientHeight;
        eventBus.emit('canvas:resized', {
            width: canvas.width,
            height: canvas.height,
        });
    }

    window.addEventListener('resize', resizeCanvas);
    resizeCanvas();

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

    // 9. Drag-and-Drop (after Renderer + Toolbox)
    dragDropManager.init(state.placedObjects);

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

    // Reset button → back to EDITING (restore snapshot)
    eventBus.on('controls:reset', () => {
        const mode = getMode();
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

    // Level loaded → set up the board
    eventBus.on('level:loaded', (levelData) => {
        state.currentLevelId = levelData.id;
        _setupLevel(levelData);

        // Update the level name in the header
        const levelNameEl = document.getElementById('level-name');
        if (levelNameEl) {
            levelNameEl.textContent = `${levelData.name}`;
        }
    });

    // Next level
    eventBus.on('overlay:next-level', async ({ levelId }) => {
        try {
            await levelManager.loadLevel(levelId);
            setMode(AppMode.EDITING);
        } catch (e) {
            console.error('[App] Failed to load next level:', e);
        }
    });

    // Retry → reset the level
    eventBus.on('overlay:retry', () => {
        _resetLevel();
    });

    // Back to menu
    eventBus.on('overlay:menu', () => {
        state.placedObjects.length = 0;
        renderer.setObjects(state.placedObjects);
        setMode(AppMode.MENU);
    });
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
                const obj = objectRegistry.create(objData.type, objData.x, objData.y, {
                    angle: objData.angle || 0,
                    isFixed: true,
                    customId: objData.id, // named id from level JSON (goal zone refs)
                });
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
 * the snapshot taken at the start of the last play (parts return to their
 * edit positions; their bodies are re-added on the next play). Fixed
 * objects are always rebuilt from the level data.
 */
function _resetLevel() {
    const levelData = levelManager.getCurrentLevel();
    const previousMode = getMode();
    // Capture before _setupLevel() replaces the snapshot on board rebuild
    const savedPlacedSnapshot = state._savedPlacedSnapshot;

    if (levelData) {
        _setupLevel(levelData);

        // Restore the player's parts from the placed snapshot (bodies
        // re-added on next play). The renderer shares the placedObjects
        // array reference, so restored parts are drawn automatically.
        restorePlacedFromSnapshot(state.placedObjects, savedPlacedSnapshot);

        // Determine which mode to return to
        if (previousMode === 'WON' || previousMode === 'PLAYING' || previousMode === 'PAUSED') {
            setMode(state.currentLevelId ? AppMode.EDITING : AppMode.SANDBOX);
        }
    } else {
        // Sandbox mode — rewind to the last play-start board (decided
        // semantic: reset never destroys a sandbox; without a prior play
        // there is nothing to rewind to, so the sandbox is left untouched)
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
