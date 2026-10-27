/**
 * Import a saved custom level and open it as a PLAYER (issue #70) — the
 * level-select import seam, on the tests/sandbox-reset-return.test.js
 * fake-DOM boot (no jsdom, house style).
 *
 * From the level-select screen, "Import custom level" picks a JSON file
 * saved from the sandbox (Save Level) and opens it as a player: hide level
 * select, LevelManager.validateCustom (the same _validate the campaign
 * loader runs), then loadCustom → setMode(EDITING) — the same level-solving
 * posture a campaign card gives, never the sandbox. The loadCustom seam
 * emits level:loaded exactly like a campaign load, so the live listeners
 * do the rest without further wiring:
 * - main.js's level:loaded handler builds the board (_setupLevel) and puts
 *   the level name + a plain-language goal line in the header
 *   (setHeaderLevel — exported from main.js for exactly this testability);
 * - Toolbox.init's level:loaded subscription sets the level's
 *   availableParts as the session inventory (getCount in player modes);
 * - GoalChecker.init arms the checker, and Bucket.registerCatch — the
 *   public emission seam of bucket:caught — wins the level exactly like a
 *   campaign catch does (type + zoneId filters, latched, re-armed per
 *   attempt).
 *
 * Seams under test:
 * - LevelSelect._importCustomLevelText (private-seam driving): refusal
 *   paths (broken JSON, schema-invalid JSON) report an inline error at
 *   level select and refuse the mode switch; the success path hides level
 *   select, installs the level and lands in EDITING.
 * - The player session: fixed furniture is locked in EDITING (one shared
 *   policy table from issue #68; only the pin handle remains), and the
 *   header shows name + goal via the real setHeaderLevel seam.
 * - Winnability: wrong-object and wrong-zone catches do not win; the goal
 *   zone catching the target emits goal:reached { levelId } once, latched,
 *   and re-arms on a fresh play attempt.
 * - setHeaderLevel (unit slice): a goal-less level clears the goal line,
 *   an unresolvable zoneId says so honestly, and an unimplemented imported
 *   goal type says it cannot be won yet (issue #66 parity).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { eventBus } from '../js/EventBus.js';
import { objectRegistry } from '../js/objects/ObjectRegistry.js';
import { registerAllObjects } from '../js/objects/registerAllObjects.js';

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
        querySelector() { return null; },
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

/** Memoized ids: one node per id within a test (header spans, overlays). */
let domNodes = null;

function stubBrowserDom() {
    domNodes = Object.create(null);
    vi.stubGlobal('document', {
        readyState: 'loading', // defer main.js's boot — listeners only
        addEventListener: vi.fn(),
        getElementById: (id) => {
            if (!domNodes[id]) domNodes[id] = fakeNode('div');
            return domNodes[id];
        },
        createElement: (tag) => fakeNode(tag),
        createTextNode: (t) => ({ textContent: t, children: [] }),
    });
    vi.stubGlobal('window', { addEventListener: vi.fn() });
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
}

/** The header span a given setHeaderLevel write landed in. */
function headerNode(id) {
    return domNodes[id];
}

// Shared module references, resolved lazily under the DOM stub.
let mainModule = null;
let levelManager = null;
let toolbox = null;
let goalChecker = null;
let selectionHandles = null;

beforeEach(async () => {
    eventBus.clear();
    // Fresh registrations each test — re-registering overwrites.
    registerAllObjects();
    stubBrowserDom();

    // The main chain imports exactly once; its real mode machine
    // (setMode/getMode/AppMode) and its exported setHeaderLevel seam are
    // what the flow below is driven by.
    mainModule = await import('../js/main.js');
    levelManager = (await import('../js/levels/LevelManager.js')).levelManager;
    toolbox = (await import('../js/ui/Toolbox.js')).toolbox;
    selectionHandles = await import('../js/ui/selectionHandles.js');
});

afterEach(() => {
    if (goalChecker) goalChecker.dispose();
    eventBus.clear();
    vi.unstubAllGlobals();
    domNodes = null;
    // The toolbox is a module singleton — reset everything the suite can set.
    if (toolbox) {
        toolbox._palette = null;
        toolbox._inventory = {};
        toolbox._mode = 'MENU';
        toolbox._isSandbox = false;
        toolbox._enabled = false;
    }
});

// ── Test data ─────────────────────────────────────────────────────

/** A save-shaped custom level (exactly what editor Save Level produces). */
const SAVED_LEVEL = {
    id: 'custom-lab-1',
    name: 'Custom Lab 1',
    version: 1,
    boardSize: { width: 800, height: 600 },
    objects: [],
    fixedObjects: [
        { type: 'bucket', id: 'bucket-goal', x: 600, y: 520, isFixed: true },
        { type: 'ramp', id: 'ramp-1', x: 260, y: 420, angle: -0.2, isFixed: true },
    ],
    goal: { type: 'object_in_zone', targetType: 'ball', zoneId: 'bucket-goal' },
    availableParts: { ball: 2, domino: 1 },
};

/**
 * Boot the player flow the way main.js does at game init — toolbox.init()
 * first (its level:loaded subscription must exist before a load), then the
 * goal checker (armed on level:loaded / mode:changed / bucket:caught), then
 * a fresh LevelSelect (the import seam under test).
 */
async function bootPlayerFlow() {
    const GoalCheckerMod = await import('../js/goals/GoalChecker.js');
    goalChecker = GoalCheckerMod.goalChecker;
    goalChecker.init(); // idempotent: the init-once guard guards re-entry

    toolbox.init();

    const LevelSelect = (await import('../js/ui/LevelSelect.js')).default;
    const levelSelect = new LevelSelect();
    levelSelect.init(); // grabs the (stubbed) overlay containers
    return { levelSelect };
}

/** Mirror main.js's level:loaded board build (_setupLevel's fixed loop). */
function buildBoard(levelData) {
    return levelData.fixedObjects.map((row) =>
        objectRegistry.create(row.type, row.x, row.y, selectionHandles.levelObjectOptions(row)),
    );
}

// ── Refusal paths ─────────────────────────────────────────────────

describe('the level-select import refuses broken files (issue #70)', () => {
    it('a file that is not JSON reports an inline error and never switches modes', async () => {
        const { levelSelect } = await bootPlayerFlow();
        // A rendered level-select screen owns the inline error element.
        levelSelect._importErrorEl = fakeNode('div');
        const modeBefore = mainModule.getMode();

        const result = levelSelect._importCustomLevelText('{ definitely not }');

        expect(result).toBeNull();
        expect(levelSelect._importErrorEl.textContent).toContain('not valid JSON');
        expect(levelSelect._importErrorEl.style.display).toBe('block');
        // The refusal happens before the mode switch AND before the hide.
        expect(mainModule.getMode()).toBe(modeBefore);
        expect(levelSelect.container.classList.contains('hidden')).toBe(false);
        expect(levelManager.getCurrentLevel()).toBeNull();
    });

    it('schema-invalid JSON is refused through the campaign validator with a readable reason', async () => {
        const { levelSelect } = await bootPlayerFlow();
        levelSelect._importErrorEl = fakeNode('div');
        const modeBefore = mainModule.getMode();

        // Parses as JSON, but misses goal / fixedObjects / availableParts —
        // the same _validate the campaign loader runs on shipped levels.
        const result = levelSelect._importCustomLevelText('{"id":"x","name":"x"}');

        expect(result).toBeNull();
        expect(levelSelect._importErrorEl.textContent).toContain('Could not import level:');
        expect(levelSelect._importErrorEl.textContent).toContain('missing required field: "goal"');
        expect(mainModule.getMode()).toBe(modeBefore);
        expect(levelManager.getCurrentLevel()).toBeNull();
    });
});

// ── The player session ────────────────────────────────────────────

describe('a saved level opens as a player (issue #70)', () => {
    it('imports into EDITING with a locked board, a level header and the level palette', async () => {
        const { levelSelect } = await bootPlayerFlow();

        const data = levelSelect._importCustomLevelText(JSON.stringify(SAVED_LEVEL));

        // The parse result is exactly what was installed.
        expect(data).toEqual(SAVED_LEVEL);
        expect(levelManager.getCurrentLevel()).toBe(data);

        // The campaign edit posture a level card gives — never the sandbox.
        expect(mainModule.getMode()).toBe('EDITING');
        expect(levelSelect.container.classList.contains('hidden')).toBe(true);
        expect(levelSelect.overlayContainer.classList.contains('hidden')).toBe(true);

        // main.js's level:loaded wiring mirrors in two documented slices:
        // _setupLevel's fixed loop builds the board from levelObjectOptions…
        const board = buildBoard(data);
        const [goalBucket, ramp] = board;
        expect(goalBucket.type).toBe('bucket');
        expect(goalBucket.customId).toBe('bucket-goal'); // the goal zone resolves
        expect(goalBucket.isFixed).toBe(true);
        expect(ramp.type).toBe('ramp');
        expect(ramp.isFixed).toBe(true);

        // …and setHeaderLevel puts name + a plain-language goal in the header.
        const header = mainModule.setHeaderLevel(data, board);
        expect(header.name).toBe('Custom Lab 1');
        expect(header.goal).toBe('🎯 Goal: get the ball into the bucket marked GOAL on the field.');
        expect(headerNode('level-name').textContent).toBe('Custom Lab 1');
        expect(headerNode('goal-name').textContent).toBe(header.goal);

        // Fixed furniture is locked in the player's EDITING posture: the
        // shared policy table (issue #68) leaves a pinned part only its pin
        // handle — and the drawn/hit-test/verb sets are all that table.
        for (const part of board) {
            expect(selectionHandles.selectionHandleSet(part, mainModule.getMode())).toEqual(['pin']);
        }

        // A player-placed part is not locked — placement is the session's point.
        const ball = objectRegistry.create('ball', 200, 150);
        expect(selectionHandles.selectionHandleSet(ball, 'EDITING'))
            .toEqual(selectionHandles.SELECTION_HANDLES);

        // The palette: Toolbox.init's real level:loaded subscription set the
        // level's availableParts as the session inventory (player modes read
        // _inventory; absent types read 0).
        expect(toolbox.getCount('ball')).toBe(2);
        expect(toolbox.getCount('domino')).toBe(1);
        expect(toolbox.getCount('bucket')).toBe(0); // the fixed goal bucket is not offered
        expect(toolbox.getCount('ramp')).toBe(0);
    });
});

// ── Winnability ───────────────────────────────────────────────────

describe('the imported level is winnable like a campaign level (issue #70)', () => {
    it('wrong catches do not win; the goal zone catching the target wins once, per attempt', async () => {
        const { levelSelect } = await bootPlayerFlow();
        levelSelect._importCustomLevelText(JSON.stringify(SAVED_LEVEL));

        const goalZone = buildBoard(SAVED_LEVEL)[0];
        const winner = objectRegistry.create('ball', 300, 100);
        const winnerTwo = objectRegistry.create('ball', 305, 105); // same type, distinct object
        const winnerThree = objectRegistry.create('ball', 310, 110); // fresh for the replay attempt
        const decoyZone = objectRegistry.create('bucket', 100, 520, { isFixed: true, customId: 'decoy' });
        const wrongTarget = buildBoard(SAVED_LEVEL)[1]; // a ramp in the goal zone changes nothing

        const wins = [];
        const fails = [];
        const onWin = (payload) => wins.push(payload);
        const onFail = (payload) => fails.push(payload);
        eventBus.on('goal:reached', onWin);
        eventBus.on('goal:failed', onFail);
        try {
            // A play attempt re-arms the checker through the real machine.
            mainModule.setMode(mainModule.AppMode.PLAYING);

            // Wrong object in the right zone: no win.
            goalZone.registerCatch(wrongTarget);
            expect(wins).toHaveLength(0);

            // Right object in a wrong zone: no win.
            decoyZone.registerCatch(winner);
            expect(wins).toHaveLength(0);

            // The goal zone catching the target: one win, keyed to the level.
            goalZone.registerCatch(winner);
            expect(wins).toHaveLength(1);
            expect(wins[0].levelId).toBe('custom-lab-1');

            // Latched: another catch in the same attempt cannot re-win (the
            // checker sees the bucket's emission and stays decided).
            goalZone.registerCatch(winnerTwo);
            expect(wins).toHaveLength(1);

            // A fresh play attempt re-arms the checker (retry / replay —
            // with a fresh object, as a reset rebuilds the board).
            mainModule.setMode(mainModule.AppMode.EDITING);
            mainModule.setMode(mainModule.AppMode.PLAYING);
            goalZone.registerCatch(winnerThree);
            expect(wins).toHaveLength(2);
            expect(wins[1].levelId).toBe('custom-lab-1');
        } finally {
            eventBus.off('goal:reached', onWin);
            eventBus.off('goal:failed', onFail);
        }
        expect(fails).toHaveLength(0);
    });
});

// ── setHeaderLevel unit slice ─────────────────────────────────────

describe('setHeaderLevel — the header slice (issue #70 unit)', () => {
    it('writes name and goal into the header spans and returns what it shows', () => {
        const board = buildBoard(SAVED_LEVEL);
        const shown = mainModule.setHeaderLevel(SAVED_LEVEL, board);

        expect(shown).toEqual({
            name: 'Custom Lab 1',
            goal: '🎯 Goal: get the ball into the bucket marked GOAL on the field.',
        });
        expect(headerNode('level-name').textContent).toBe(shown.name);
        expect(headerNode('goal-name').textContent).toBe(shown.goal);
    });

    it('a goal-less level clears the header goal line', () => {
        const shown = mainModule.setHeaderLevel(
            { id: 'no-goal', name: 'No Goal', fixedObjects: [], availableParts: {} },
            [],
        );
        expect(shown).toEqual({ name: 'No Goal', goal: '' });
        expect(headerNode('goal-name').textContent).toBe('');
    });

    it('an unresolvable zone speaks honestly about the loaded level', () => {
        const shown = mainModule.setHeaderLevel(
            {
                id: 'lost-zone',
                name: 'Lost Zone',
                goal: { type: 'object_in_zone', targetType: 'ball', zoneId: 'nope' },
                fixedObjects: [],
                availableParts: {},
            },
            [],
        );
        expect(shown.goal).toContain('matches nothing on the board');
        expect(headerNode('goal-name').textContent).toBe(shown.goal);
    });

    it('an unimplemented imported goal type says it cannot be won yet (issue #66 parity)', () => {
        const shown = mainModule.setHeaderLevel(
            {
                id: 'from-the-future',
                name: 'From The Future',
                goal: { type: 'pop_all_balloons' },
                fixedObjects: [],
                availableParts: {},
            },
            [],
        );
        expect(shown.goal).toContain('"pop all balloons" is not implemented yet');
        expect(headerNode('goal-name').textContent).toBe(shown.goal);
    });
});