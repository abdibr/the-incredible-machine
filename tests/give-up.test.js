/**
 * Give-up flow (ADR 0009, docs/adr/0009-scene-lock-and-solution-scenes.md):
 * `controls:give-up` swaps the board to the level's solution scene in a
 * read-only SOLUTION posture; Reset / `controls:solution-return` restores
 * the user's own attempt.
 *
 * Full fake-DOM boot (no jsdom — house style): main.js's init runs for real
 * against stubbed DOM nodes, so the whole wiring is the production wiring:
 * level:loaded → _setupLevel, give-up → enterSolutionView, reset/return →
 * leaveSolution. The solver scenes come from the shipped level JSON
 * (level-06 — the shortest scene).
 *
 * Seams under test:
 * - enterSolutionView: player postures only, a solution having been
 *   validated in; the user's board (attempt) is serialized first, then the
 *   board swaps to `solution.scene` built as a FULL restore (furniture + placed
 *   rows, scene-stamped), with NO physics bodies added and the loop not
 *   stepped — the goal checker cannot be reached from the solution view
 *   (no credit for watching).
 * - leaveSolution: rebuilds the level and restores the attempt — furniture
 *   fresh from level JSON, the user's placed parts from the give-up-time
 *   snapshot (a placed part placed after level load survives the round trip).
 * - Reset while in SOLUTION doubles as the return.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import level06 from '../js/levels/puzzles/level-06.json';

// Module-capture bindings: vi.resetModules() gives every test a fresh
// registry, so main.js's wiring lives on a FRESH event bus � the test must
// capture (and emit on) the same instances the boot created. Top-level
// imports of js singletons would race the reset and go stale.
let eventBus = null;
let objectRegistry = null;

// ── Harness (fake DOM, no jsdom — house style) ────────────────────

function fakeNode(tag = 'div', className = '') {
    const node = {
        tagName: String(tag).toUpperCase(),
        className,
        id: '',
        children: [],
        style: {},
        dataset: {},
        textContent: '',
        title: '',
        value: '',
        width: 0,
        height: 0,
        disabled: false,
        checked: false,
        appendChild(child) {
            node.children.push(child);
            child.parentElement = node;
            return child;
        },
        addEventListener(_type, listener) {
            node._test._eventListeners[_type] = node._test._eventListeners[_type] || [];
            node._test._eventListeners[_type].push(listener);
        },
        removeEventListener() {},
        focus() {},
        remove() {},
        setAttribute() {},
        getAttribute() { return null; },
        click() { node._test.emit('click'); },
        classList: {
            _set: new Set(),
            add(cls) { node.classList._set.add(cls); },
            remove(cls) { node.classList._set.delete(cls); },
            contains(cls) { return node.classList._set.has(cls); },
            toggle(cls, force) {
                if (force === undefined) {
                    node.classList._set.has(cls)
                        ? node.classList._set.delete(cls)
                        : node.classList._set.add(cls);
                } else if (force) {
                    node.classList._set.add(cls);
                } else {
                    node.classList._set.delete(cls);
                }
            },
        },
        querySelector() { return null; },
        querySelectorAll() { return []; },
    };
    node._test = { _eventListeners: {} };
    return node;
}

/** A 2D-context stub that absorbs every method/property write (renderer). */
function fakeContext(canvas) {
    const ctxFake = {
        canvas,
        save() {}, restore() {}, beginPath() {}, closePath() {}, fill() {}, stroke() {},
        clearRect() {}, fillRect() {}, strokeRect() {}, arc() {}, moveTo() {}, lineTo() {},
        translate() {}, rotate() {}, scale() {}, setTransform() {}, drawImage() {},
        fillText() {}, strokeText() {}, measureText() { return { width: 0 }; },
        createLinearGradient() { return { addColorStop() {} }; },
    };
    return ctxFake;
}

let domNodes = null;

function stubBrowserDom() {
    domNodes = Object.create(null);
    vi.stubGlobal('document', {
        readyState: 'complete', // boot immediately (main.js init runs on import)
        addEventListener: vi.fn(),
        getElementById: (id) => {
            if (!domNodes[id]) {
                const node = fakeNode('div');
                node.id = id;
                if (id === 'game-canvas') {
                    node.getContext = () => fakeContext(node);
                    node.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 600 });
                }
                domNodes[id] = node;
            }
            return domNodes[id];
        },
        createElement: (tag) => fakeNode(tag),
        createTextNode: (t) => ({ textContent: t, children: [] }),
    });
    vi.stubGlobal('window', { addEventListener: vi.fn() });
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('localStorage', { getItem: () => null, setItem() {} });
}

let mainModule = null;
let levelManager = null;
let dragDropManager = null;
let physicsEngineRef = null;

beforeEach(async () => {
    // A fresh module registry per test: main.js's init() wiring (the thing
    // under test) registers on a fresh Event bus each run — the singletons
    // would otherwise carry mode/board state across tests.
    vi.resetModules();

    stubBrowserDom();
    (await import('../js/objects/registerAllObjects.js')).registerAllObjects();
    eventBus = (await import('../js/EventBus.js')).eventBus;
    objectRegistry = (await import('../js/objects/ObjectRegistry.js')).objectRegistry;

    // Full boot: init() wires every listener (mode machine, give-up handlers)
    mainModule = await import('../js/main.js');
    levelManager = (await import('../js/levels/LevelManager.js')).levelManager;
    dragDropManager = (await import('../js/ui/DragDropManager.js')).dragDropManager;
    physicsEngineRef = mainModule.getPhysicsEngine();
    expect(physicsEngineRef).toBeTruthy();
    expect(typeof physicsEngineRef.clear).toBe('function');
});

afterEach(() => {
    eventBus.clear();
    vi.unstubAllGlobals();
    domNodes = null;
});

describe('give up → solution view → return (ADR 0009)', () => {
    it('swaps the board to the solved scene, adds no physics bodies, and grants no credit', () => {
        levelManager.loadCustom(structuredClone(level06));
        mainModule.setMode('EDITING'); // the player session the import flow creates
        expect(mainModule.getMode()).toBe('EDITING');

        // The user places a part (their attempt so far)
        const board = dragDropManager.getObjects();
        const furniture = board.length;
        const userBall = objectRegistry.create('ball', 500, 100, {});
        board.push(userBall);

        // Give up
        eventBus.emit('controls:give-up');

        expect(mainModule.getMode()).toBe('SOLUTION');
        // Board = exactly the solution scene (furniture + placed rows of the
        // solved board; level-06's scene is its three fixed rows)
        expect(board.length).toBe(level06.solution.scene.length);
        // The user's part is gone from display
        expect(board.some((b) => b === userBall)).toBe(false);
        // Everything on the solution board carries the scene marking or is
        // the solved machine's own content
        expect(board.every((b) => b.isScene === true)).toBe(true);
        // No physics bodies were added for the read-only view: the goal
        // checker cannot fire from here (the engine tracks objects in a Set)
        expect(physicsEngineRef.getObjects().size).toBe(0);
        // Watching the solution never completes the level
        expect(levelManager.isLevelCompleted('level-06')).toBe(false);
    });

    it('return rebuilds the level and restores the user attempt', () => {
        levelManager.loadCustom(structuredClone(level06));
        mainModule.setMode('EDITING');
        const board = dragDropManager.getObjects();
        const userBall = objectRegistry.create('ball', 500, 100, {});
        board.push(userBall);

        eventBus.emit('controls:give-up');
        expect(mainModule.getMode()).toBe('SOLUTION');

        eventBus.emit('controls:solution-return');
        expect(mainModule.getMode()).toBe('EDITING');

        // Furniture rebuilt (fresh scene-stamped instances) + the user's
        // placed part restored from the attempt snapshot
        expect(board.length).toBe(level06.fixedObjects.length + 1);
        const restored = board.find((b) => b.type === 'ball' && !b.isScene);
        expect(restored).toBeDefined();
        expect(restored).not.toBe(userBall); // a fresh deserialize of the snapshot row
        expect(restored.isFixed).toBe(false);
        expect(restored.isScene).toBe(false);
        // Furniture is scene-stamped again after the rebuild
        expect(board.filter((b) => b.isScene).length).toBe(level06.fixedObjects.length);
    });

    it('Reset doubles as the return while in the solution view', () => {
        levelManager.loadCustom(structuredClone(level06));
        mainModule.setMode('EDITING');
        eventBus.emit('controls:give-up');
        expect(mainModule.getMode()).toBe('SOLUTION');
        eventBus.emit('controls:reset');
        expect(mainModule.getMode()).toBe('EDITING');
    });

    it('give-up is refused outside player postures (menu) and without a solution scene', () => {
        expect(mainModule.getMode()).toBe('MENU'); // fresh boot
        eventBus.emit('controls:give-up');
        expect(mainModule.getMode()).toBe('MENU');

        // Loading a solution-less draft: give-up must be a no-op too
        const draft = structuredClone(level06);
        draft.solution = null;
        levelManager.loadCustom(draft);
        mainModule.setMode('EDITING');
        eventBus.emit('controls:give-up');
        expect(mainModule.getMode()).toBe('EDITING');
    });

    it('no goal:reached ever fires across the whole flow', () => {
        const reached = vi.fn();
        eventBus.on('goal:reached', reached);
        levelManager.loadCustom(structuredClone(level06));
        mainModule.setMode('EDITING');
        eventBus.emit('controls:give-up');
        eventBus.emit('controls:solution-return');
        expect(reached).not.toHaveBeenCalled();
        expect(levelManager.isLevelCompleted('level-06')).toBe(false);
    });
});
