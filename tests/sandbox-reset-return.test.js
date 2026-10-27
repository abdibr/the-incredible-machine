/**
 * Sandbox reset-return seam (issue #71): Stop must return to the posture
 * the run was born in, and the return must NOT behave as a fresh sandbox
 * visit.
 *
 * The bug this pins: a sandbox session that loaded an existing level (the
 * editor's Load Level → LevelManager.loadCustom installs the level id)
 * used to re-enter campaign EDITING on Play → Stop — the reset decided the
 * return mode from the level id alone, and only a campaign session shows
 * the editor + palette panels. On top of that, the panels' SANDBOX-entry
 * handlers wipe their same-visit state (loaded goal #63/#66, authored
 * palette #69) — and the renderer's GOAL-zone marker state with them.
 *
 * Two blocks:
 * 1. The reset-return decision + board rewind (levelReset seam), with the
 *    sandbox repro flow mirrored end to end exactly like tests/reset.test.js
 *    mirrors main.js's wiring (play = controls:play → beginPlay; stop =
 *    controls:reset → gameLoop.reset() → the sandbox branch →
 *    resetSandboxBoard), driven through the real setMode/AppMode machine
 *    and the real LevelManager.loadCustom seam.
 * 2. The panels + renderer at the mode seam (real modules with the
 *    fake-DOM boot, editor-palette.test.js house style — no jsdom): after
 *    the return both panels are visible again, the loaded goal readout +
 *    authored palette + GOAL marker state survive, the toolbox is re-armed
 *    to the authored counts and Save Level round-trips the loaded palette
 *    (paletteForSave is exactly what _saveLevel writes); PAUSED and WON
 *    returns keep the state; a plain sandbox play→stop stays unauthored;
 *    a genuine fresh visit (issues #63/#69) still wipes.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Matter from 'matter-js';

import { eventBus } from '../js/EventBus.js';
import { objectRegistry } from '../js/objects/ObjectRegistry.js';
import { registerAllObjects } from '../js/objects/registerAllObjects.js';

const { Composite } = Matter;

// ── Harness (fake DOM, no jsdom — house style) ────────────────────

/** Minimal fake DOM node sufficient for panel builds and Toolbox init. */
function fakeNode(tag = 'div', className = '') {
    const node = {
        tagName: String(tag).toUpperCase(),
        className,
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
        removeEventListener(_type, listener) {
            const list = node._test._eventListeners[_type];
            if (list) node._test._eventListeners[_type] = list.filter((l) => l !== listener);
        },
        focus() {},
        remove() {},
        setAttribute() {},
        getAttribute() { return null; },
        click() { node._test.emit('click'); },
        /** Fire a synthetic DOM event through the captured listeners. */
        emit(type) { node._test.emit(type); },
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
        querySelector(selector) {
            const matches = (n) => {
                if (selector.startsWith('.')) {
                    return String(n.className || '').split(' ').includes(selector.slice(1));
                }
                if (selector.startsWith('#')) return n.id === selector.slice(1);
                return n.tagName === selector.toUpperCase();
            };
            if (matches(node)) return node;
            for (const child of node.children) {
                const found = child.querySelector(selector);
                if (found) return found;
            }
            return null;
        },
        querySelectorAll() { return []; },
    };
    node._test = {
        _eventListeners: {},
        emit(type, detail = {}) {
            for (const listener of node._test._eventListeners[type] || []) {
                listener({ target: node, detail });
            }
        },
    };
    return node;
}

/** A 2D-context stub that absorbs every draw call (renderer boot only). */
function fakeCtx() {
    const noop = () => {};
    return new Proxy({}, {
        get(target, prop) { return prop in target ? target[prop] : noop; },
        set(target, prop, value) { target[prop] = value; return true; },
    });
}

/** All bodies in the world that are not boundary walls. */
function playBodies(physics) {
    return Composite.allBodies(physics.world).filter((b) => !/^wall-/.test(b.label ?? ''));
}

// Shared module references, resolved lazily under the DOM stub.
let mainModule = null;
let levelManager = null;
let levelReset = null;
let toolbox = null;
let palettePanel = null;
let dragDropManager = null;

function stubBrowserDom() {
    vi.stubGlobal('document', {
        readyState: 'loading', // defer main.js's boot — listeners only
        addEventListener: vi.fn(),
        getElementById: (id) => {
            if (id === 'editor-overlay') return fakeNode('div', 'editor-overlay');
            if (id === 'palette-overlay') return fakeNode('div', 'palette-overlay');
            if (id === 'toolbox-categories') return fakeNode();
            return null;
        },
        createElement: (tag) => fakeNode(tag),
        createTextNode: (t) => ({ textContent: t, children: [] }),
    });
    vi.stubGlobal('window', { addEventListener: vi.fn() });
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
}

beforeEach(async () => {
    eventBus.clear();
    // Fresh registrations each test — re-registering overwrites.
    registerAllObjects();
    stubBrowserDom();

    // The main chain imports exactly once; its real mode machine
    // (setMode/getMode/AppMode) is what every seam below is driven by.
    mainModule = await import('../js/main.js');
    levelManager = (await import('../js/levels/LevelManager.js')).levelManager;
    levelReset = await import('../js/reset/levelReset.js');
    toolbox = (await import('../js/ui/Toolbox.js')).toolbox;
    palettePanel = (await import('../js/ui/PalettePanel.js')).palettePanel;
    dragDropManager = (await import('../js/ui/DragDropManager.js')).dragDropManager;
});

afterEach(() => {
    eventBus.clear();
    vi.unstubAllGlobals();
    if (dragDropManager) dragDropManager._objects = [];
    // The toolbox is a module singleton — reset everything the suite can set.
    if (toolbox) {
        toolbox._palette = null;
        toolbox._inventory = {};
        toolbox._mode = 'MENU';
        toolbox._isSandbox = false;
        toolbox._enabled = false;
    }
    // The palette panel is a module singleton too — reset so the next boot
    // rebuilds its rows and starts unauthored.
    if (palettePanel) {
        palettePanel._authoredPalette = null;
        palettePanel._built = false;
        palettePanel._paletteRows = [];
        palettePanel._paletteReadout = null;
        palettePanel._unlimitedBtn = null;
        palettePanel.container = null;
        palettePanel._minimized = false;
    }
});

// ── Test data ─────────────────────────────────────────────────────

/** A custom level the sandbox editor loads (the repro's Load Level input). */
const SANDBOX_LEVEL = {
    id: 'sandbox-load-level',
    name: 'Sandbox Load Level',
    version: 1,
    boardSize: { width: 800, height: 600 },
    objects: [],
    fixedObjects: [
        { type: 'bucket', id: 'bucket-goal', x: 600, y: 520, isFixed: true },
        { type: 'ramp', id: 'ramp-1', x: 260, y: 420, angle: -0.2, isFixed: true },
    ],
    goal: { type: 'object_in_zone', targetType: 'bucket', zoneId: 'bucket-goal' },
    availableParts: { ball: 3, domino: 3 },
};

/** Register-order palette for part-2 loads (every type offered, 2 tweaked). */
function levelForLoad() {
    const parts = {};
    for (const item of objectRegistry.getAll()) parts[item.type] = 3;
    return {
        id: 'reset-return-level',
        name: 'Reset Return Level',
        version: 1,
        boardSize: { width: 800, height: 600 },
        objects: [],
        fixedObjects: [{ type: 'bucket', id: 'bucket-goal', x: 600, y: 520, isFixed: true }],
        goal: { type: 'object_in_zone', targetType: 'bucket', zoneId: 'bucket-goal' },
        availableParts: { ...parts, bucket: 2, ball: 1 },
    };
}

/** The palette row controls for one type (throws if the row is missing). */
function rowOf(source, type) {
    const row = source._paletteRows.find((entry) => entry.type === type);
    if (!row) throw new Error(`no palette row for "${type}"`);
    return row;
}

// ── Block 1 — the reset-return decision + board rewind ────────────

describe("the stop's return posture (issue #71 decision seam)", () => {
    it('returns to the posture the run was born in — not a mode guessed from the level id', () => {
        const levelData = { id: 'any-level' };

        // Sandbox-born runs stay sandbox — with a loaded level too (the fix):
        expect(levelReset.resetReturnPosture('SANDBOX', levelData)).toBe('SANDBOX');
        expect(levelReset.resetReturnPosture('SANDBOX', null)).toBe('SANDBOX');

        // Campaign-born runs return to campaign editing:
        expect(levelReset.resetReturnPosture('EDITING', levelData)).toBe('EDITING');

        // Defensive: a campaign posture without a level cannot hold — sandbox.
        expect(levelReset.resetReturnPosture('EDITING', null)).toBe('SANDBOX');

        // No record (before the first play): the historical level-id
        // heuristic — past behavior preserved.
        expect(levelReset.resetReturnPosture(null, levelData)).toBe('EDITING');
        expect(levelReset.resetReturnPosture(null, null)).toBe('SANDBOX');
    });
});

describe('sandbox-born run with a loaded level (issue #71 repro seam)', () => {
    it('rewinds to the play-start board and returns to the sandbox, repeatable', async () => {
        const { AppMode, setMode, getMode } = mainModule;
        const physicsMod = await import('../js/engine/PhysicsEngine.js');
        const loopMod = await import('../js/engine/GameLoop.js');
        const physics = new physicsMod.PhysicsEngine(800, 600);
        const loop = new loopMod.GameLoop(physics, () => {});
        const placed = [];

        // Fresh visit from the menu, then the editor's Load Level → the
        // loadCustom seam (ADR 0003) — the level id is now installed while
        // the session stays in its sandbox posture.
        setMode(AppMode.SANDBOX);
        levelManager.loadCustom(SANDBOX_LEVEL);
        expect(getMode()).toBe('SANDBOX'); // the load keeps the visit's posture

        // The visit's board: the level's fixed content + a placed part.
        for (const row of SANDBOX_LEVEL.fixedObjects) {
            placed.push(objectRegistry.create(row.type, row.x, row.y, { isFixed: true, customId: row.id }));
        }
        const ball = objectRegistry.create('ball', 150, 100);
        placed.push(ball);

        for (let cycle = 1; cycle <= 2; cycle++) {
            // ── Play: controls:play → beginPlay; the run is born SANDBOX ──
            const runOriginPosture = getMode(); // recorded at play start (issue #71)
            const snapshot = levelReset.beginPlay(physics, placed);
            setMode(AppMode.PLAYING);
            for (let f = 0; f < 6; f++) physics.step(16.67);

            // ── Stop: controls:reset → gameLoop.reset() then _resetLevel() ──
            loop.reset();
            const returnPosture = levelReset.resetReturnPosture(runOriginPosture, levelManager.getCurrentLevel());

            // THE FIX: the loaded level's id cannot flip the run to editing.
            expect(returnPosture).toBe('SANDBOX');
            // The sandbox branch rewinds the board from the play-start
            // snapshot (the level's fixed content round-trips inside it).
            levelReset.resetSandboxBoard(physics, placed, snapshot);
            setMode(returnPosture);

            expect(getMode()).toBe('SANDBOX');
            expect(placed).toHaveLength(SANDBOX_LEVEL.fixedObjects.length + 1);
            const bucket = placed.find((o) => o.type === 'bucket');
            expect(bucket.customId).toBe('bucket-goal'); // the goal zone is intact
            expect(bucket.x).toBe(600);
            expect(bucket.isFixed).toBe(true);
            expect(placed.find((o) => o.type === 'ramp').x).toBe(260);
            expect(ball.x).toBe(150); // the player's part is back at its edit spot
            expect(playBodies(physics)).toHaveLength(0); // no leaked bodies
            expect(loop.isStopped).toBe(true);
            // The loaded level stays installed for the goal checker.
            expect(levelManager.getCurrentLevel().id).toBe('sandbox-load-level');
        }

        loop.dispose();
        physics.dispose();
    });
});

describe('campaign-born run (sibling reset behavior unchanged)', () => {
    it('still rebuilds the level and returns to campaign editing', async () => {
        const { AppMode, setMode, getMode } = mainModule;
        const physicsMod = await import('../js/engine/PhysicsEngine.js');
        const loopMod = await import('../js/engine/GameLoop.js');
        const handlesMod = await import('../js/ui/selectionHandles.js');
        const physics = new physicsMod.PhysicsEngine(800, 600);
        const loop = new loopMod.GameLoop(physics, () => {});
        const placed = [];

        setMode(AppMode.MENU);
        levelManager.loadCustom(SANDBOX_LEVEL);
        setMode(AppMode.EDITING); // the campaign edit screen a level select lands on

        for (const row of SANDBOX_LEVEL.fixedObjects) {
            placed.push(objectRegistry.create(row.type, row.x, row.y, handlesMod.levelObjectOptions(row)));
        }
        const ball = objectRegistry.create('ball', 150, 100);
        placed.push(ball);

        // Play from campaign editing.
        const runOriginPosture = getMode(); // 'EDITING' recorded at play start
        expect(runOriginPosture).toBe('EDITING');
        const snapshot = levelReset.beginPlay(physics, placed);
        setMode(AppMode.PLAYING);
        for (let f = 0; f < 6; f++) physics.step(16.67);

        // Stop: level branch — rebuild fixed from the level, restore the
        // player's machine on top (mirrors _setupLevel/_resetLevel).
        loop.reset();
        const returnPosture = levelReset.resetReturnPosture(runOriginPosture, levelManager.getCurrentLevel());
        expect(returnPosture).toBe('EDITING');
        physics.clear(); // _setupLevel
        placed.length = 0;
        for (const row of SANDBOX_LEVEL.fixedObjects) {
            placed.push(objectRegistry.create(row.type, row.x, row.y, handlesMod.levelObjectOptions(row)));
        }
        levelReset.restorePlacedFromSnapshot(placed, snapshot);
        setMode(returnPosture);

        expect(getMode()).toBe('EDITING');
        expect(placed.filter((o) => !o.isFixed)).toHaveLength(1);
        expect(ball.x).toBe(150);
        expect(playBodies(physics)).toHaveLength(0);

        loop.dispose();
        physics.dispose();
    });
});

// ── Block 2 — panels + renderer at the mode seam ──────────────────

/**
 * Boot the sandbox visit the way main.js does — toolbox.init() first, then
 * the editor panel and the palette panel — plus a fresh Renderer for the
 * GOAL-marker state seam (main.js's own renderer singleton stays
 * un-initialized, as in the other panel suites), then enter SANDBOX.
 */
async function bootSandboxVisit() {
    const EditorPanel = (await import('../js/ui/EditorPanel.js')).default;
    const Renderer = (await import('../js/render/Renderer.js')).default;

    toolbox.init();
    const panel = new EditorPanel();
    panel.init();
    palettePanel.init();

    const renderer = new Renderer();
    const canvas = fakeNode('canvas');
    canvas.getContext = () => fakeCtx();
    renderer.init(canvas);

    // Fresh visit: MENU → SANDBOX.
    mainModule.setMode(mainModule.AppMode.SANDBOX);
    return { panel, renderer };
}

describe('mode seam — panels + renderer on the reset-return (issue #71)', () => {
    it('play → stop returns the panels and keeps the loaded goal, authored palette and GOAL marker', async () => {
        const { panel, renderer } = await bootSandboxVisit();
        const { AppMode } = mainModule;

        // ── Load an existing level through the editor ──
        const levelData = levelForLoad();
        panel._applyLoadedLevel(levelData);
        const loadedGoal = { ...levelData.goal };
        const authoredPalette = { ...levelData.availableParts };

        expect(panel._loadedGoal).toEqual(loadedGoal);
        expect(palettePanel.getPalette()).toEqual(authoredPalette);
        expect(toolbox._palette).toEqual(authoredPalette); // toolbox constrained (#69)
        expect(renderer._goal).toEqual(loadedGoal); // GOAL-marker source (#66)
        expect(panel._goalReadout.textContent).toContain('goal from "Reset Return Level"');

        // ── Play: the panels hide as designed ──
        mainModule.setMode(AppMode.PLAYING);
        expect(panel.container.classList.contains('hidden')).toBe(true);
        expect(palettePanel.container.classList.contains('hidden')).toBe(true);
        expect(toolbox._palette).toBeNull(); // the away-side release (#69/#70)

        // ── Stop: the reset-return — back to the sandbox run's posture ──
        mainModule.setMode(AppMode.SANDBOX);

        // The editor + palette panels are visible again (the repro's ask).
        expect(panel.container.classList.contains('hidden')).toBe(false);
        expect(panel.container.style.display).toBe('block');
        expect(palettePanel.container.classList.contains('hidden')).toBe(false);
        expect(palettePanel.container.style.display).toBe('block');

        // The loaded goal survived the return (issue #71).
        expect(panel._loadedGoal).toEqual(loadedGoal);
        expect(panel._goalReadout.textContent).toContain('goal from "Reset Return Level"');
        expect(panel._goalReadout.textContent).not.toContain('no active goal');
        expect(renderer._goal).toEqual(loadedGoal); // the marker keeps its zone

        // The authored palette survived; the toolbox is re-armed to it.
        expect(palettePanel._authoredPalette).toEqual(authoredPalette);
        expect(toolbox._palette).toEqual(authoredPalette);
        expect(rowOf(palettePanel, 'bucket').include.checked).toBe(true);
        expect(rowOf(palettePanel, 'bucket').count.value).toBe('2');
        expect(rowOf(palettePanel, 'ball').count.value).toBe('1');

        // Save Level still round-trips the loaded palette (paletteForSave
        // is exactly what _saveLevel writes).
        expect(palettePanel.paletteForSave()).toEqual(authoredPalette);
    });
});

describe('mode seam — return variants and unchanged siblings (issues #63/#69)', () => {
    it('PAUSED and WON returns keep the loaded session state too', async () => {
        const { panel, renderer } = await bootSandboxVisit();
        const { AppMode } = mainModule;
        panel._applyLoadedLevel(levelForLoad());

        for (const awayMode of [AppMode.PAUSED, AppMode.WON]) {
            mainModule.setMode(AppMode.PLAYING);
            mainModule.setMode(awayMode);
            mainModule.setMode(AppMode.SANDBOX);

            expect(panel.container.classList.contains('hidden')).toBe(false);
            expect(palettePanel.container.classList.contains('hidden')).toBe(false);
            expect(panel._loadedGoal).not.toBeNull();
            expect(palettePanel._authoredPalette).not.toBeNull();
            expect(toolbox._palette).not.toBeNull();
            expect(renderer._goal).not.toBeNull();
        }
    });

    it('a plain sandbox play → stop stays in the unauthored posture', async () => {
        const { panel, renderer } = await bootSandboxVisit();
        const { AppMode } = mainModule;
        // No level loaded: the fresh visit is goal-less + unauthored (#63/#69).
        expect(panel._loadedGoal).toBeNull();
        expect(palettePanel._authoredPalette).toBeNull();

        mainModule.setMode(AppMode.PLAYING);
        mainModule.setMode(AppMode.SANDBOX);

        // Panels visible, but nothing faked into "preserved" shape.
        expect(panel.container.classList.contains('hidden')).toBe(false);
        expect(palettePanel.container.classList.contains('hidden')).toBe(false);
        expect(panel._loadedGoal).toBeNull();
        expect(panel._goalReadout.textContent).toContain('no active goal');
        expect(renderer._goal).toBeNull();
        expect(palettePanel._authoredPalette).toBeNull();
        expect(toolbox._palette).toBeNull();
        for (const item of objectRegistry.getAll()) {
            expect(toolbox.getCount(item.type)).toBe(Infinity);
        }
    });

    it('a genuine fresh visit still wipes the session (issues #63/#69 unchanged)', async () => {
        const { panel, renderer } = await bootSandboxVisit();
        const { AppMode } = mainModule;
        panel._applyLoadedLevel(levelForLoad());
        expect(panel._loadedGoal).not.toBeNull();

        // Leave the sandbox family (campaign editing), then a fresh visit —
        // the designed wipe, NOT a reset-return.
        mainModule.setMode(AppMode.EDITING);
        mainModule.setMode(AppMode.SANDBOX);

        expect(panel._loadedGoal).toBeNull();
        expect(panel._loadedLevelName).toBeNull();
        expect(panel._goalReadout.textContent).toContain('no active goal');
        expect(renderer._goal).toBeNull();
        // The pin tip returns on each visit (issue #66 follow-up).
        expect(panel._pinNotice.textContent).toContain('Tip:');

        expect(palettePanel._authoredPalette).toBeNull();
        expect(palettePanel._paletteReadout.textContent).toContain('not authored');
        expect(toolbox._palette).toBeNull();
        expect(rowOf(palettePanel, 'bucket').count.value).toBe('10'); // ×10 default
        for (const item of objectRegistry.getAll()) {
            expect(toolbox.getCount(item.type)).toBe(Infinity);
        }
    });
});