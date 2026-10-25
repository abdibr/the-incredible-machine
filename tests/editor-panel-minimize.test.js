/**
 * Editor panel minimize/maximize (sandbox usability report).
 *
 * The SANDBOX editor panel floats fixed at the bottom-right corner over the
 * play area and could be neither moved nor minimized — part of the field was
 * permanently buried under it. The panel's header row now carries a ➖/➕
 * toggle that collapses it to the title bar (and restores it), with compact
 * chrome in the collapsed state. Seams pinned here:
 *
 * - Structure: the built panel is exactly [header, body]; every control —
 *   save/load, goal select + readout, pin notice, test/menu, the 🐞 Bug File
 *   recorder section — lives inside the body, so minimizing hides exactly
 *   one element and nothing can leak outside the body.
 * - Toggle wiring: clicking ➖ hides the body, flips the glyph to ➕
 *   ("Maximize panel") and compacts the padding/min-width; clicking ➕
 *   restores the full panel.
 * - Mode round-trip: leaving SANDBOX still hides the panel entirely (the
 *   pre-existing _show/_hide behavior is untouched by minimization);
 *   re-entering shows it back in the state it was left in — minimizing is a
 *   layout choice, not per-visit state to reset.
 * - Events while minimized: the cheap board/status poll keeps refreshing the
 *   hidden controls (the next expand must show current data) and never
 *   resurrects the collapsed body.
 * - Header drag (movable bar): pressing the header row grabs the whole panel
 *   (the ➖/➕ toggle never starts a drag); the right/bottom anchor swaps for
 *   the dragged left/top pair on first press, movements clamp to the viewport
 *   so the bar can never be parked off-screen, the drag listeners detach on
 *   release, and the final position survives a sandbox round-trip.
 *
 * House style: the editor-goal.test.js fake DOM (captured listeners +
 * click()/emit()) with the speed-wiring boot guard (readyState 'loading').
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { eventBus } from '../js/EventBus.js';

/**
 * Minimal DOM fake with children, listeners and attribute storage so the
 * panel can be built and its controls driven directly from tests.
 */
function fakeNode(tag, id = '') {
    const classes = new Set();
    const children = [];
    const handlers = {};
    const node = {
        tagName: String(tag).toUpperCase(),
        id,
        textContent: '',
        className: '',
        type: '',
        value: '',
        checked: false,
        disabled: false,
        placeholder: '',
        title: '',
        attrs: {},
        style: {},
        parentNode: null,
        classList: {
            add: (...c) => c.forEach((x) => classes.add(x)),
            remove: (...c) => c.forEach((x) => classes.delete(x)),
            contains: (c) => classes.has(c),
            toggle: (c, force) => {
                const on = force === undefined ? !classes.has(c) : !!force;
                if (on) classes.add(c); else classes.delete(c);
                return on;
            },
        },
        children,
        appendChild(child) {
            child.parentNode = node;
            children.push(child);
            return child;
        },
        remove() {
            if (node.parentNode) {
                const idx = node.parentNode.children.indexOf(node);
                if (idx !== -1) node.parentNode.children.splice(idx, 1);
            }
        },
        setAttribute(k, v) { node.attrs[k] = String(v); },
        getAttribute(k) { return node.attrs[k] ?? null; },
        addEventListener(type, fn) { (handlers[type] ??= []).push(fn); },
        removeEventListener() {},
        /** Fire the fake node's captured listeners directly (click etc.). */
        emit(type, ev = {}) {
            for (const fn of handlers[type] ?? []) fn(ev);
        },
        click() { node.emit('click'); },
        focus() {},
        set innerHTML(_v) { children.length = 0; },
        get innerHTML() { return ''; },
    };
    return node;
}

/** Document-level listeners captured by makeFreshPanel's document stub. */
let docHandlers = {};

/** Fire captured document-level listeners (the header drag move/up plumbing). */
function docEmit(type, ev) {
    for (const fn of docHandlers[type] ?? []) fn(ev);
}

/** Stub the boot-guard DOM globals, then return a fresh entry-built panel. */
async function makeFreshPanel() {
    const container = fakeNode('div', 'editor-overlay');
    container.classList.add('hidden');
    docHandlers = {};
    // Drag support: geometry like the real fixed panel — a bottom-right bar
    // whose size follows the collapsed state (145×58 bar vs the wide card).
    const geometry = { left: 1584, top: 900 };
    container.getBoundingClientRect = () => {
        const body = container.children[1];
        const collapsed = !!body && body.style.display === 'none';
        const width = collapsed ? 145 : 240;
        const height = collapsed ? 58 : 420;
        return { left: geometry.left, top: geometry.top, right: geometry.left + width, bottom: geometry.top + height, width, height };
    };
    // Document listeners are captured (not discarded) so the full drag event
    // chain on the real EditorPanel code can be driven via docEmit().
    vi.stubGlobal('document', {
        readyState: 'loading',
        addEventListener: (type, fn) => { (docHandlers[type] ??= []).push(fn); },
        removeEventListener: (type, fn) => {
            const list = docHandlers[type] ?? [];
            const idx = list.indexOf(fn);
            if (idx !== -1) list.splice(idx, 1);
        },
        getElementById: (id) => (id === 'editor-overlay' ? container : null),
        createElement: (tag) => fakeNode(tag),
        createTextNode: (t) => ({ textContent: t, children: [] }),
    });
    vi.stubGlobal('window', { addEventListener: vi.fn(), innerWidth: 1600, innerHeight: 1000 });
    vi.stubGlobal('requestAnimationFrame', vi.fn());
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    const { default: EditorPanel } = await import('../js/ui/EditorPanel.js');
    const panel = new EditorPanel();
    panel.init();
    eventBus.emit('mode:changed', { oldMode: 'MENU', newMode: 'SANDBOX' });
    return panel;
}

/** Depth-first list of every node's textContent (fake nodes don't compose). */
function allTexts(node, acc = []) {
    acc.push(node.textContent ?? '');
    (node.children ?? []).forEach((child) => allTexts(child, acc));
    return acc;
}

const headerOf = (panel) => panel.container.children[0];
const bodyOf = (panel) => panel.container.children[1];
const toggleOf = (panel) => headerOf(panel).children.find((c) => c.tagName === 'BUTTON');

afterEach(() => {
    vi.unstubAllGlobals();
});
describe('EditorPanel minimize/maximize toggle', () => {
    it('builds exactly header + body; the controls (incl. 🐞 Bug File) all live in the body', async () => {
        const panel = await makeFreshPanel();
        const overlay = panel.container;

        expect(overlay.children).toHaveLength(2);
        const [header, body] = overlay.children;

        // Header: the title and the collapse toggle — nothing else.
        const headerTexts = header.children.map((c) => c.textContent);
        expect(headerTexts).toContain('🔧 Editor');
        const toggle = toggleOf(panel);
        expect(toggle.tagName).toBe('BUTTON');
        expect(toggle.textContent).toBe('➖');
        expect(toggle.title).toBe('Minimize panel');

        // Expanded by default.
        expect(body.style.display).toBe('block');

        // The full control stack moved into the body.
        const bodyTexts = allTexts(body);
        expect(bodyTexts).toContain('💾 Save Level');
        expect(bodyTexts).toContain('📂 Load Level');
        expect(bodyTexts).toContain('▶ Test Puzzle');
        expect(bodyTexts).toContain('📋 Back to Menu');
        expect(bodyTexts).toContain('🐞 Bug File');
        expect(bodyTexts).toContain('💾 Export Bug File');
        expect(bodyTexts).toContain('🩹 Recover crashed session');
    });

    it('clicking ➖ collapses to the compact header bar; clicking ➕ restores', async () => {
        const panel = await makeFreshPanel();
        const toggle = toggleOf(panel);
        const body = bodyOf(panel);
        const overlay = panel.container;

        toggle.click();
        // The body (and nothing else) is hidden…
        expect(body.style.display).toBe('none');
        // …the panel itself stays on the field in its collapsed state…
        expect(overlay.classList.contains('hidden')).toBe(false);
        // …with the flipped glyph, the invite and the compact chrome.
        expect(toggle.textContent).toBe('➕');
        expect(toggle.title).toBe('Maximize panel');
        expect(overlay.style.padding).toBe('8px 12px');
        expect(overlay.style.minWidth).toBe('0');

        toggle.click();
        expect(body.style.display).toBe('block');
        expect(toggle.textContent).toBe('➖');
        expect(toggle.title).toBe('Minimize panel');
        expect(overlay.style.padding).toBe('16px');
        expect(overlay.style.minWidth).toBe('240px');
    });

    it('leaving SANDBOX still hides the panel; re-entering shows it back minimized', async () => {
        const panel = await makeFreshPanel();
        const toggle = toggleOf(panel);
        const overlay = panel.container;

        toggle.click();
        eventBus.emit('mode:changed', { oldMode: 'SANDBOX', newMode: 'EDITING' });
        expect(overlay.classList.contains('hidden')).toBe(true);
        expect(overlay.style.display).toBe('none');

        eventBus.emit('mode:changed', { oldMode: 'EDITING', newMode: 'SANDBOX' });
        expect(overlay.classList.contains('hidden')).toBe(false);
        expect(overlay.style.display).toBe('block');
        // Minimizing is a layout choice: the collapsed state survived the
        // round trip instead of being reset per visit.
        expect(bodyOf(panel).style.display).toBe('none');
        expect(toggle.textContent).toBe('➕');

        toggle.click();
        expect(bodyOf(panel).style.display).toBe('block');
        expect(toggle.textContent).toBe('➖');
    });

    it('board/status events while minimized refresh hidden controls and never resurrect the body', async () => {
        const panel = await makeFreshPanel();
        toggleOf(panel).click();

        // The cheap poll drives the hidden status line/readout — the next
        // expand shows data that is current, and nothing unhides the body.
        expect(() => eventBus.emit('controls:play')).not.toThrow();
        expect(() => eventBus.emit('object:placed', {})).not.toThrow();
        expect(bodyOf(panel).style.display).toBe('none');
        expect(toggleOf(panel).textContent).toBe('➕');
    });
});

describe('EditorPanel header drag — movable collapsed bar', () => {
    it('dragging the bar by its title applies the pointer delta and clamps to the viewport', async () => {
        const panel = await makeFreshPanel();
        const header = headerOf(panel);
        const overlay = panel.container;
        toggleOf(panel).click(); // collapsed: a 145×58 bar at (1584, 900)

        // Grab near the bar's right edge (press on the 🔧 Editor title).
        header.emit('pointerdown', {
            button: 0, pointerId: 1, clientX: 1600, clientY: 940,
            target: header.children[0], preventDefault: vi.fn(),
        });
        expect(overlay.style.left).toBe('1584px'); // re-anchored where it stood
        expect(overlay.style.top).toBe('900px');
        // The right/bottom anchor was dropped in favor of the dragged pair.
        expect(overlay.style.right).toBe('');
        expect(overlay.style.bottom).toBe('');
        expect(header.style.cursor).toBe('grabbing');

        // Drag past both viewport edges (1600×1000): clamped, never parked
        // off-screen where a bar would be hard to re-grab.
        docEmit('pointermove', { pointerId: 1, clientX: 1800, clientY: 1200 });
        expect(overlay.style.left).toBe('1455px'); // 1600 - 145
        expect(overlay.style.top).toBe('942px');   // 1000 - 58

        docEmit('pointerup', {});
        expect(header.style.cursor).toBe('grab');
        // After release the drag listeners are detached — further moves no-op.
        docEmit('pointermove', { pointerId: 1, clientX: 500, clientY: 500 });
        expect(overlay.style.left).toBe('1455px');
        expect(overlay.style.top).toBe('942px');
    });

    it('free drags land where dropped and survive a sandbox round-trip', async () => {
        const panel = await makeFreshPanel();
        const overlay = panel.container;

        headerOf(panel).emit('pointerdown', {
            button: 0, pointerId: 1, clientX: 1590, clientY: 940,
            target: headerOf(panel), preventDefault: vi.fn(),
        });
        docEmit('pointermove', { pointerId: 1, clientX: 800, clientY: 300 });
        // Offset preserved: grabbed at +6/+40 from the panel's top-left corner.
        expect(overlay.style.left).toBe('794px');
        expect(overlay.style.top).toBe('260px');

        docEmit('pointerup', {});
        eventBus.emit('mode:changed', { oldMode: 'SANDBOX', newMode: 'EDITING' });
        eventBus.emit('mode:changed', { oldMode: 'EDITING', newMode: 'SANDBOX' });
        // The dragged position is session layout like the minimize state: the
        // round-trip neither clears it nor resurrects the right/bottom anchor.
        expect(overlay.classList.contains('hidden')).toBe(false);
        expect(overlay.style.left).toBe('794px');
        expect(overlay.style.top).toBe('260px');
        expect(overlay.style.right).toBe('');
        expect(overlay.style.bottom).toBe('');
    });

    it('the ➖/➕ toggle never starts a drag; a non-primary button does nothing', async () => {
        const panel = await makeFreshPanel();
        const toggle = toggleOf(panel);
        const overlay = panel.container;

        toggle.emit('pointerdown', {
            button: 0, pointerId: 1, clientX: 1590, clientY: 940, target: toggle,
        });
        docEmit('pointermove', { pointerId: 1, clientX: 100, clientY: 100 });
        expect(overlay.style.left).toBeUndefined();
        // …and the toggle still works as a click target afterwards.
        toggle.click();
        expect(bodyOf(panel).style.display).toBe('none');

        // Secondary-button presses don't drag either.
        headerOf(panel).emit('pointerdown', {
            button: 2, pointerId: 7, clientX: 1590, clientY: 940, target: headerOf(panel),
        });
        docEmit('pointermove', { pointerId: 7, clientX: 100, clientY: 100 });
        expect(overlay.style.left).toBeUndefined();
    });
});