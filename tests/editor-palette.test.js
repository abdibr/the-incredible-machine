/**
 * EditorPanel + Toolbox parts palette — issue #69, on top of the unauthored
 * sandbox posture from #63.
 *
 * Covered here:
 * - The unauthored editor session: every registered part ∞ in the toolbox,
 *   rows displaying the ×10 default, honest readout, clear button disabled,
 *   and an untweaked Save Level writing the default palette (every type ×10) —
 *   the file a sandbox session has always produced.
 * - Authoring: the first row edit authors exactly the displayed posture —
 *   the toolbox constrains to those counts (placed parts consume them),
 *   edited counts save verbatim, exclusions save as an explicit 0, a
 *   re-included row returns to the default count, and a typed-0 row also
 *   excludes on save.
 * - Load: an imported level's availableParts become the authored palette —
 *   a level saved without the field loads honestly empty (0 everywhere) —
 *   and the toolbox constrains to exactly what the level carries.
 * - The escape hatch: "∞ Everything Unlimited" clears the authored palette —
 *   toolbox ∞ again, Save Level back to the default — and leaving the editor
 *   releases the toolbox to the live inventory.
 * - Badges mirror the palette with the disabled gate at 0, exactly like a
 *   player's edit stage.
 *
 * DOM: minimal fake DOM per tests/editor-goal.test.js house style (no
 * jsdom). Blob/createObjectURL save capture with a targeted URL stub +
 * saveOnce, like the goal tests' saveCapture.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { eventBus } from '../js/EventBus.js';
import { objectRegistry } from '../js/objects/ObjectRegistry.js';
import { registerAllObjects } from '../js/objects/registerAllObjects.js';

let editorModule = null;
let dragDropManager = null;
let toolbox = null;

/** Minimal fake DOM node sufficient for EditorPanel builds and Toolbox init. */
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

/**
 * Boot the editor the way main.js does — toolbox.init() first, then the
 * panel — then enter SANDBOX so the palette rows, the readout and the
 * toolbox posture all settle into the unauthored default.
 */
async function makeFreshEditor() {
    vi.stubGlobal('document', {
        readyState: 'loading',
        addEventListener: vi.fn(),
        getElementById: (id) => {
            if (id === 'editor-overlay') return fakeNode('div', 'editor-overlay');
            if (id === 'toolbox-categories') return fakeNode();
            return null;
        },
        createElement: (tag) => fakeNode(tag),
        createTextNode: (t) => ({ textContent: t, children: [] }),
    });
    vi.stubGlobal('window', { addEventListener: vi.fn() });
    vi.stubGlobal('requestAnimationFrame', vi.fn());
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    editorModule = editorModule || (await import('../js/ui/EditorPanel.js'));
    const toolboxModule = await import('../js/ui/Toolbox.js');
    toolbox = toolboxModule.toolbox;
    dragDropManager = dragDropManager || (await import('../js/ui/DragDropManager.js')).dragDropManager;

    // Mirror main.js boot order: toolbox first, editor panel second.
    toolbox.init();
    const { default: EditorPanel } = await import('../js/ui/EditorPanel.js');
    const panel = new EditorPanel();
    panel.init();
    eventBus.emit('mode:changed', { oldMode: 'MENU', newMode: 'SANDBOX' });
    return panel;
}

beforeEach(() => {
    eventBus.clear();
    // Fresh registrations each test — re-registering overwrites, so no
    // registry clear is needed (the registry has no clear()).
    registerAllObjects();
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
});

/** Every registered part type, in registry order. */
function registeredTypes() {
    return objectRegistry.getAll().map((item) => item.type);
}

/** The palette row controls for one type (throws if the row is missing). */
function rowOf(panel, type) {
    const row = panel._paletteRows.find((entry) => entry.type === type);
    if (!row) throw new Error(`no palette row for "${type}"`);
    return row;
}

/** The count badge element for one toolbox item. */
function badge(type) {
    return toolbox._itemElements.get(type).querySelector('.toolbox-item-count');
}

/**
 * A palette with every registered type offered (a generous 3) and the two
 * headline parts tweaked — the shape a real level JSON carries.
 */
function partsAll(overrides = {}) {
    const parts = {};
    for (const type of registeredTypes()) parts[type] = 3;
    Object.assign(parts, overrides);
    return parts;
}

/** Minimal valid level JSON; availableParts defaults to partsAll(). */
function mkLevelData(overrides = {}) {
    return {
        id: 'palette-level',
        name: 'Palette Level',
        version: 1,
        boardSize: { width: 1200, height: 800 },
        objects: [],
        fixedObjects: [],
        goal: { type: 'object_in_zone', targetType: 'bucket' },
        availableParts: partsAll({ bucket: 2, ball: 1 }),
        ...overrides,
    };
}

/** One save through the real blob pipeline; returns the emitted level JSON. */
async function saveOnce(panel) {
    const createObjectURL = vi.fn(() => 'blob:editor-palette');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    panel._saveLevel();
    const blob = createObjectURL.mock.calls.at(-1)[0];
    vi.unstubAllGlobals();
    return JSON.parse(await blob.text());
}

describe('EditorPanel parts palette — unauthored sandbox posture (issues #63, #69)', () => {
    it('a fresh sandbox is unauthored: every part ∞, rows show the ×10 default, clear disabled', async () => {
        const panel = await makeFreshEditor();

        expect(panel._authoredPalette).toBeNull();
        expect(toolbox._palette).toBeNull();
        for (const type of registeredTypes()) {
            expect(toolbox.getCount(type)).toBe(Infinity);
        }

        // Rows display the default posture: the palette an untweaked save writes.
        for (const { include, count } of panel._paletteRows) {
            expect(include.checked).toBe(true);
            expect(count.value).toBe('10');
            expect(count.disabled).toBe(false);
        }

        expect(panel._paletteReadout.textContent).toContain('not authored');
        expect(panel._unlimitedBtn.disabled).toBe(true);

        expect(String(badge('rope').textContent)).toBe('∞');
        expect(toolbox._itemElements.get('rope').classList.contains('disabled')).toBe(false);
    });

    it('an untweaked Save Level still writes the default ×10 palette', async () => {
        const panel = await makeFreshEditor();

        const expected = {};
        for (const type of registeredTypes()) expected[type] = 10;

        const saved = await saveOnce(panel);
        expect(saved.availableParts).toEqual(expected);
    });
});

describe('EditorPanel parts palette — authoring (issue #69)', () => {
    it('editing one count authors exactly the displayed posture and save writes it', async () => {
        const panel = await makeFreshEditor();

        rowOf(panel, 'rope').count.value = '3';
        rowOf(panel, 'rope').count.emit('input');

        expect(panel._authoredPalette.rope).toBe(3);
        expect(toolbox._palette.rope).toBe(3);
        expect(toolbox.getCount('rope')).toBe(3);
        // The untouched rows keep their displayed default — they are authored
        // now, not ∞.
        expect(toolbox.getCount('ball')).toBe(10);

        expect(panel._paletteReadout.textContent).toContain('Authored palette');
        expect(panel._unlimitedBtn.disabled).toBe(false);

        const saved = await saveOnce(panel);
        expect(saved.availableParts.rope).toBe(3);
        expect(saved.availableParts.ball).toBe(10);
    });

    it('excluding a type un-placeables it and saves an explicit 0', async () => {
        const panel = await makeFreshEditor();

        rowOf(panel, 'ball').include.checked = false;
        rowOf(panel, 'ball').include.emit('change');

        expect(panel._authoredPalette.ball).toBe(0);
        expect(toolbox.getCount('ball')).toBe(0);
        expect(rowOf(panel, 'ball').count.value).toBe('0');
        expect(rowOf(panel, 'ball').count.disabled).toBe(true);

        const saved = await saveOnce(panel);
        expect(Object.hasOwn(saved.availableParts, 'ball')).toBe(true);
        expect(saved.availableParts.ball).toBe(0);
    });

    it('re-including a row returns it to the default count', async () => {
        const panel = await makeFreshEditor();

        rowOf(panel, 'ball').include.checked = false;
        rowOf(panel, 'ball').include.emit('change');
        rowOf(panel, 'ball').include.checked = true;
        rowOf(panel, 'ball').include.emit('change');

        expect(rowOf(panel, 'ball').count.value).toBe('10');
        expect(rowOf(panel, 'ball').count.disabled).toBe(false);
        expect(panel._authoredPalette.ball).toBe(10);
        expect(toolbox.getCount('ball')).toBe(10);
    });

    it('typing a 0 count also excludes on save, without rewriting mid-keystroke', async () => {
        const panel = await makeFreshEditor();

        rowOf(panel, 'ball').count.value = '0';
        rowOf(panel, 'ball').count.emit('input');

        // No mid-keystroke rewrite: the row stays editable, the palette says 0.
        expect(rowOf(panel, 'ball').count.disabled).toBe(false);
        expect(rowOf(panel, 'ball').include.checked).toBe(true);
        expect(panel._authoredPalette.ball).toBe(0);
        expect(toolbox.getCount('ball')).toBe(0);

        const saved = await saveOnce(panel);
        expect(saved.availableParts.ball).toBe(0);
    });

    it('"∞ Everything Unlimited" clears back to the default posture', async () => {
        const panel = await makeFreshEditor();

        rowOf(panel, 'rope').count.value = '3';
        rowOf(panel, 'rope').count.emit('input');
        expect(toolbox._palette).not.toBeNull();

        panel._unlimitedBtn.click();

        expect(panel._authoredPalette).toBeNull();
        expect(toolbox._palette).toBeNull();
        expect(toolbox.getCount('rope')).toBe(Infinity);
        expect(rowOf(panel, 'rope').count.value).toBe('10');
        expect(panel._unlimitedBtn.disabled).toBe(true);

        const saved = await saveOnce(panel);
        expect(saved.availableParts.rope).toBe(10);
    });
});

describe('EditorPanel parts palette — load (issue #69)', () => {
    it('a loaded level installs its availableParts as the authored palette and constrains the toolbox', async () => {
        const panel = await makeFreshEditor();
        const data = mkLevelData();

        panel._applyLoadedLevel(data);

        // Canonical palette: every registered type present, exactly as saved.
        for (const type of registeredTypes()) {
            expect(panel._authoredPalette[type]).toBe(data.availableParts[type]);
        }
        expect(toolbox.getCount('bucket')).toBe(2);
        expect(toolbox.getCount('ramp')).toBe(3);

        // Rows display the imported posture; the clear button is live.
        expect(rowOf(panel, 'bucket').count.value).toBe('2');
        expect(panel._unlimitedBtn.disabled).toBe(false);
        expect(panel._paletteReadout.textContent).toContain('Authored palette');

        // Save Level now writes the imported palette, not the default.
        const saved = await saveOnce(panel);
        expect(saved.availableParts).toEqual(data.availableParts);
    });

    it('a level saved without availableParts loads honestly empty (0 everywhere)', async () => {
        const panel = await makeFreshEditor();
        const data = mkLevelData();
        delete data.availableParts;

        panel._applyLoadedLevel(data);

        for (const type of registeredTypes()) {
            expect(panel._authoredPalette[type]).toBe(0);
            expect(toolbox.getCount(type)).toBe(0);
        }
        expect(rowOf(panel, 'bucket').include.checked).toBe(false);
        expect(rowOf(panel, 'bucket').count.disabled).toBe(true);
        expect(panel._unlimitedBtn.disabled).toBe(false);
        expect(panel._paletteReadout.textContent).toContain('Authored palette');
    });

    it('save → load in a fresh session → save round-trips the palette verbatim', async () => {
        // Session A: author a distinctive palette and save it.
        let panel = await makeFreshEditor();
        rowOf(panel, 'rope').count.value = '3';
        rowOf(panel, 'rope').count.emit('input');
        rowOf(panel, 'ball').include.checked = false;
        rowOf(panel, 'ball').include.emit('change');
        const first = await saveOnce(panel);
        expect(Object.hasOwn(first.availableParts, 'ball')).toBe(true);
        expect(first.availableParts.ball).toBe(0);

        // Session B: import exactly the saved file and save it again.
        panel = await makeFreshEditor();
        panel._applyLoadedLevel(mkLevelData({ id: 'reimported', availableParts: first.availableParts }));

        expect(panel._authoredPalette.rope).toBe(3);
        expect(panel._authoredPalette.ball).toBe(0);
        expect(rowOf(panel, 'rope').count.value).toBe('3');
        expect(rowOf(panel, 'ball').include.checked).toBe(false);

        const second = await saveOnce(panel);
        expect(second.availableParts).toEqual(first.availableParts);
    });

    it('the anchored-scenery note only claims a type the palette offers (issue #67)', async () => {
        const panel = await makeFreshEditor();
        const bucket = objectRegistry.create('bucket', 500, 500, { isFixed: true });
        bucket.isAnchored = true;
        dragDropManager._objects = [bucket];

        panel._updateGoalReadout();
        expect(panel._goalReadout.textContent).toContain('Anchored scenery');

        rowOf(panel, 'bucket').include.checked = false;
        rowOf(panel, 'bucket').include.emit('change');
        expect(panel._goalReadout.textContent).not.toContain('Anchored scenery');

        bucket.dispose();
    });
});

describe('Constrained sandbox toolbox (issue #69)', () => {
    it('placement consumes the palette count, removal returns it, and it clamps at zero', async () => {
        const panel = await makeFreshEditor();
        panel._applyLoadedLevel(mkLevelData({ availableParts: partsAll({ rope: 2 }) }));
        expect(toolbox.getCount('rope')).toBe(2);

        // Five placements against a count of 2 clamp at 0.
        for (let i = 0; i < 5; i++) {
            eventBus.emit('object:placed', { type: 'rope', id: i, object: null });
        }
        expect(toolbox.getCount('rope')).toBe(0);
        expect(toolbox._itemElements.get('rope').classList.contains('disabled')).toBe(true);

        eventBus.emit('object:removed', { type: 'rope', id: 0, object: null });
        expect(toolbox.getCount('rope')).toBe(1);
        expect(toolbox._itemElements.get('rope').classList.contains('disabled')).toBe(false);
    });

    it('an unauthored sandbox records nothing — placements do not create a palette', async () => {
        await makeFreshEditor();

        eventBus.emit('object:placed', { type: 'rope', id: 1, object: null });
        eventBus.emit('object:removed', { type: 'rope', id: 1, object: null });

        expect(toolbox._palette).toBeNull();
        expect(toolbox._inventory).toEqual({});
        expect(toolbox.getCount('rope')).toBe(Infinity);
        expect(String(badge('rope').textContent)).toBe('∞');
        expect(toolbox._itemElements.get('rope').classList.contains('disabled')).toBe(false);
    });

    it('leaving the editor releases the toolbox to live inventory; a fresh sandbox visit is unlimited again', async () => {
        const panel = await makeFreshEditor();
        rowOf(panel, 'rope').count.value = '5';
        rowOf(panel, 'rope').count.emit('input');
        expect(toolbox.getCount('rope')).toBe(5);

        eventBus.emit('mode:changed', { oldMode: 'SANDBOX', newMode: 'EDITING' });
        expect(toolbox._palette).toBeNull();
        // In a live session the inventory comes from the loaded level; here,
        // setInventory directly proves the palette no longer answers counts.
        toolbox.setInventory({ rope: 9 });
        expect(toolbox.getCount('rope')).toBe(9);

        eventBus.emit('mode:changed', { oldMode: 'EDITING', newMode: 'SANDBOX' });
        expect(toolbox._palette).toBeNull();
        expect(toolbox.getCount('rope')).toBe(Infinity);
        expect(rowOf(panel, 'rope').count.value).toBe('10');
        expect(panel._unlimitedBtn.disabled).toBe(true);
    });

    it('badges mirror the authored palette exactly and gate at zero', async () => {
        const panel = await makeFreshEditor();

        // Unauthored: ∞ badge.
        expect(String(badge('rope').textContent)).toBe('∞');

        panel._applyLoadedLevel(mkLevelData({ availableParts: partsAll({ rope: 2, ball: 0 }) }));
        expect(String(badge('rope').textContent)).toBe('2');
        expect(String(badge('ball').textContent)).toBe('0');
        expect(toolbox._itemElements.get('ball').classList.contains('disabled')).toBe(true);
        expect(toolbox._itemElements.get('rope').classList.contains('disabled')).toBe(false);

        // Authoring live-updates badges too.
        rowOf(panel, 'rope').count.value = '1';
        rowOf(panel, 'rope').count.emit('input');
        expect(String(badge('rope').textContent)).toBe('1');

        eventBus.emit('object:placed', { type: 'rope', id: 1, object: null });
        expect(String(badge('rope').textContent)).toBe('0');
        expect(toolbox._itemElements.get('rope').classList.contains('disabled')).toBe(true);
    });
});