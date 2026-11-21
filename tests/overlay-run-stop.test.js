/**
 * Overlay run-stop ordering (issue #77): the loop seam is the ONE
 * run-lifecycle owner, so the fail-overlay retry and its siblings
 * (next level, back-to-menu) call the loop-owned stop - GameLoop.reset(),
 * idempotent, one loop:reset end fact per real stop - instead of
 * hand-deriving isStopped guards, and the posture work happens after the
 * end fact. (controls:reset and the give-up path call the same owned
 * stop; their ordering is pinned through the recorder suite and
 * tests/give-up.test.js.)
 *
 * Full fake-DOM boot (no jsdom - house style after give-up.test.js):
 * main.js init() runs for real against stubbed DOM nodes, so the wiring
 * under test is the production wiring, and the facts are pinned at the
 * bus seam the loop publishes them on.
 *
 * Seams under test:
 * - overlay:retry stops the run EXACTLY once (a single loop:reset end
 *   fact) and orders it before the posture rows; a retry on an already
 *   stopped loop re-announces nothing (the owned stop is idempotent, so
 *   main needs no isStopped guard).
 * - overlay:menu / overlay:next-level adopt the same single ordering.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import level06 from '../js/levels/puzzles/level-06.json';

// Module-capture bindings (give-up.test.js style): vi.resetModules() gives
// every test a fresh registry, so the wiring lives on a FRESH event bus and
// the test captures the instances the boot created.
let eventBus = null;
let mainModule = null;
let levelManager = null;
let domNodes = null;

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
        appendChild(child) {
            node.children.push(child);
            child.parentElement = node;
            return child;
        },
        addEventListener() {},
        removeEventListener() {},
        focus() {},
        remove() {},
        setAttribute() {},
        getAttribute() { return null; },
        classList: {
            _set: new Set(),
            add(cls) { node.classList._set.add(cls); },
            remove(cls) { node.classList._set.delete(cls); },
            contains(cls) { return node.classList._set.has(cls); },
            toggle(cls) {
                node.classList._set.has(cls)
                    ? node.classList._set.delete(cls)
                    : node.classList._set.add(cls);
            },
        },
        querySelector() { return null; },
        querySelectorAll() { return []; },
    };
    return node;
}

/** A 2D-context stub that absorbs every method/property write (renderer). */
function fakeContext(canvas) {
    return {
        canvas,
        save() {}, restore() {}, beginPath() {}, closePath() {}, fill() {}, stroke() {},
        clearRect() {}, fillRect() {}, strokeRect() {}, arc() {}, moveTo() {}, lineTo() {},
        translate() {}, rotate() {}, scale() {}, setTransform() {}, drawImage() {},
        fillText() {}, strokeText() {}, measureText() { return { width: 0 }; },
        createLinearGradient() { return { addColorStop() {} }; },
    };
}

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

beforeEach(async () => {
    vi.resetModules();

    stubBrowserDom();
    (await import('../js/objects/registerAllObjects.js')).registerAllObjects();
    eventBus = (await import('../js/EventBus.js')).eventBus;

    // Full boot: init() wires every listener (mode machine, overlay handlers)
    mainModule = await import('../js/main.js');
    levelManager = (await import('../js/levels/LevelManager.js')).levelManager;
});

afterEach(() => {
    eventBus.clear();
    vi.unstubAllGlobals();
    domNodes = null;
});

/** The player-session posture the overlay paths answer from. */
function loadLevelAndEnterEditing() {
    levelManager.loadCustom(structuredClone(level06));
    mainModule.setMode('EDITING');
}

/** Capture the run facts + posture rows at the bus seam. */
function recordFacts() {
    const facts = [];
    for (const topic of ['loop:play', 'loop:reset', 'mode:changed']) {
        eventBus.on(topic, (packet) => facts.push({ topic, packet }));
    }
    // The subscriptions ride the per-test module registry: vi.resetModules()
    // plus the afterEach eventBus.clear() retire them with the test.
    return facts;
}

describe('overlay run-stop ordering (issue #77: the loop owns run ordering)', () => {
    it('fail-overlay retry stops the run once, before the posture rows', () => {
        loadLevelAndEnterEditing();
        try {
            const facts = recordFacts();
            eventBus.emit('controls:play');
            expect(mainModule.getMode()).toBe('PLAYING');

            eventBus.emit('overlay:retry');

            // play: the begin fact then the posture row; retry: the owned
            // stop sends its end fact first, the return posture follows.
            expect(facts.map((f) => f.topic)).toEqual([
                'loop:play', 'mode:changed', 'loop:reset', 'mode:changed',
            ]);
            expect(facts[2].topic).toBe('loop:reset');
            expect(facts[3].packet.newMode).toBe('EDITING');
            expect(mainModule.getMode()).toBe('EDITING');

            // The owned stop is idempotent: a retry on a stopped loop
            // re-announces nothing - and main needs no isStopped guard.
            eventBus.emit('overlay:retry');
            expect(facts.map((f) => f.topic)).toEqual([
                'loop:play', 'mode:changed', 'loop:reset', 'mode:changed',
            ]);
            expect(mainModule.getMode()).toBe('EDITING');
        } finally {
        }
    });

    it('back-to-menu adopts the same single ordering', async () => {
        loadLevelAndEnterEditing();
        const unsubs = [];
        try {
            const facts = recordFacts();
            eventBus.emit('controls:play');
            eventBus.emit('overlay:menu');

            expect(mainModule.getMode()).toBe('MENU');
            expect(facts.map((f) => f.topic)).toEqual([
                'loop:play', 'mode:changed', 'loop:reset', 'mode:changed',
            ]);
            expect(facts[2].topic).toBe('loop:reset');
            expect(facts[3].packet.newMode).toBe('MENU');

            // LevelSelect re-renders the puzzle list on MENU mode (two
            // menu listeners) after setMode(MENU) - let those async show()
            // chains settle HERE, while the DOM stub is still up, or they
            // land after afterEach as unhandled rejections. getLevelList
            // skips its unfetchable entries, so the chain drains fast.
            await new Promise((resolve) => setTimeout(resolve, 10));
        } finally {
            for (const unsub of unsubs) unsub();
        }
    });

    it('next-level adopts the same single ordering', async () => {
        loadLevelAndEnterEditing();
        // loadLevel fetches a shipped level it has not cached: headless,
        // serve the next id with level-06's data (goals.test.js pattern).
        const nextLevel = { ...structuredClone(level06), id: 'level-07' };
        const unsubs = [];
        try {
            const facts = recordFacts();
            vi.stubGlobal('fetch', vi.fn(async () => ({
                ok: true,
                json: async () => structuredClone(nextLevel),
            })));
            eventBus.emit('controls:play');
            eventBus.emit('overlay:next-level', { levelId: 'level-07' });
            await vi.waitFor(() => expect(mainModule.getMode()).toBe('EDITING'));

            expect(facts.map((f) => f.topic)).toEqual([
                'loop:play', 'mode:changed', 'loop:reset', 'mode:changed',
            ]);
            expect(facts[2].topic).toBe('loop:reset');
            expect(facts[3].packet.newMode).toBe('EDITING');
        } finally {
            for (const unsub of unsubs) unsub();
        }
    });
});
