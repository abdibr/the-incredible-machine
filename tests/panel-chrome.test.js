/**
 * PanelChrome — the shared floating-panel window chrome (js/ui/PanelChrome.js).
 *
 * EditorPanel and PalettePanel build their header/toggle/body/drag chrome
 * through this helper. editor-panel-minimize.test.js pins the behavior
 * through the editor panel; the palette suite pins the palette side (its
 * singleton `_minimized` reset). The helper's own seams pinned here, direct
 * over a fake DOM (editor-panel-minimize.test.js harness style):
 *
 * - Build: container = exactly [header, body]; header = [title, toggle];
 *   the initial minimize state settles on build (default expanded,
 *   initialMinimized collapses).
 * - Collapse/restore: the toggle (or setMinimized) hides exactly the body,
 *   flips the ➖/➕ glyph + title, and compacts the bar (padding '8px 12px',
 *   min-width 0) — expanded restores the configured padding and '240px'.
 * - Drag: the first press re-anchors the panel at its standing rect and
 *   drops right/bottom (the (0, 0) static-position trap), moves apply the
 *   exact pointer delta and clamp past the viewport edges, foreign pointer
 *   ids are ignored, and release detaches the document listeners.
 * - Press safety: a press on the toggle (the click affordance) or a
 *   non-primary button never starts a drag; two chrome instances carry
 *   fully independent drag state.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

import { PanelChrome } from '../js/ui/PanelChrome.js';

/**
 * Minimal DOM fake with children, listeners and attribute storage so the
 * chrome can be built and its controls driven directly from tests.
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
        },
        children,
        appendChild(child) {
            child.parentNode = node;
            children.push(child);
            return child;
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
    };
    return node;
}

/** Document-level listeners captured by the document stub. */
let docHandlers = {};

/** Fire captured document-level listeners (the drag move/up plumbing). */
function docEmit(type, ev) {
    for (const fn of docHandlers[type] ?? []) fn(ev);
}

/**
 * Stub the DOM globals, then build the chrome into a geometry-backed
 * container — a bottom-right bar whose size follows the collapsed state
 * (145×58 bar vs the wide card), like the real floating panels.
 */
function makeChrome({ initialMinimized = false, expandedPadding = '16px', title = 'Test Panel' } = {}) {
    const container = fakeNode('div');
    docHandlers = {};
    const geometry = { left: 1584, top: 900 };
    container.getBoundingClientRect = () => {
        const body = container.children[1];
        const collapsed = !!body && body.style.display === 'none';
        const width = collapsed ? 145 : 240;
        const height = collapsed ? 58 : 420;
        return { left: geometry.left, top: geometry.top, right: geometry.left + width, bottom: geometry.top + height, width, height };
    };
    // The panels stand anchored by right/bottom until a drag swaps the pair.
    container.style.right = '16px';
    container.style.bottom = '16px';
    // Document listeners are captured (not discarded) so the full drag
    // event chain can be driven via docEmit().
    vi.stubGlobal('document', {
        readyState: 'loading',
        addEventListener: (type, fn) => { (docHandlers[type] ??= []).push(fn); },
        removeEventListener: (type, fn) => {
            const list = docHandlers[type] ?? [];
            const idx = list.indexOf(fn);
            if (idx !== -1) list.splice(idx, 1);
        },
        getElementById: () => null,
        createElement: (tag) => fakeNode(tag),
        createTextNode: (t) => ({ textContent: t, children: [] }),
    });
    vi.stubGlobal('window', { addEventListener: vi.fn(), innerWidth: 1600, innerHeight: 1000 });
    const chrome = new PanelChrome(container, { title, titleStyle: 'color: #ffd700;', expandedPadding, initialMinimized });
    return { chrome, container };
}

const toggleOf = (container) => container.children[0].children[1];

afterEach(() => {
    vi.unstubAllGlobals();
    docHandlers = {};
});

describe('PanelChrome build structure and minimize state', () => {
    it('builds exactly [header, body] with a title + ➖ toggle; expanded is the default', () => {
        const { chrome, container } = makeChrome();

        expect(container.children).toHaveLength(2);
        const header = container.children[0];
        expect(header.tagName).toBe('DIV');
        expect(header.children[0].tagName).toBe('H3');
        expect(header.children[0].textContent).toBe('Test Panel');
        expect(toggleOf(container).tagName).toBe('BUTTON');
        // Shared with the tests: the chrome exposes what it built.
        expect(chrome.headerRow).toBe(header);
        expect(chrome.toggleBtn).toBe(toggleOf(container));
        expect(chrome.body).toBe(container.children[1]);
        expect(chrome.minimized).toBe(false);
        // Expanded posture: full body and the configured padding.
        expect(container.children[1].style.display).toBe('block');
        expect(toggleOf(container).textContent).toBe('➖');
        expect(toggleOf(container).title).toBe('Minimize panel');
        expect(container.style.padding).toBe('16px');
        expect(container.style.minWidth).toBe('240px');
    });

    it('initialMinimized collapses to the compact bar on build', () => {
        const { chrome, container } = makeChrome({ initialMinimized: true });

        expect(chrome.minimized).toBe(true);
        expect(container.children[1].style.display).toBe('none');
        expect(container.children[0].style.display).toBeUndefined(); // the header stays
        expect(toggleOf(container).textContent).toBe('➕');
        expect(toggleOf(container).title).toBe('Maximize panel');
        expect(container.style.padding).toBe('8px 12px');
        expect(container.style.minWidth).toBe('0');
    });

    it('the toggle click collapses and restores — body display, glyph and compaction', () => {
        const { chrome, container } = makeChrome();
        const toggle = toggleOf(container);

        toggle.click();
        expect(chrome.minimized).toBe(true);
        expect(container.children[1].style.display).toBe('none');
        expect(toggle.textContent).toBe('➕');
        expect(toggle.title).toBe('Maximize panel');
        expect(container.style.padding).toBe('8px 12px');
        expect(container.style.minWidth).toBe('0');

        toggle.click();
        expect(chrome.minimized).toBe(false);
        expect(container.children[1].style.display).toBe('block');
        expect(toggle.textContent).toBe('➖');
        expect(toggle.title).toBe('Minimize panel');
        expect(container.style.padding).toBe('16px');
        expect(container.style.minWidth).toBe('240px');
    });

    it('the expanded padding comes from the options; the compact bar is fixed', () => {
        const { container } = makeChrome({ expandedPadding: '12px' });

        expect(container.style.padding).toBe('12px');
        toggleOf(container).click();
        expect(container.style.padding).toBe('8px 12px');
        toggleOf(container).click();
        expect(container.style.padding).toBe('12px');
    });
});

describe('PanelChrome header drag', () => {
    it('press re-anchors where the bar stood and drops right/bottom — no (0, 0) teleport', () => {
        const { container } = makeChrome({ initialMinimized: true });
        const header = container.children[0];

        header.emit('pointerdown', {
            button: 0, pointerId: 1, clientX: 1600, clientY: 940,
            target: header.children[0], preventDefault: vi.fn(),
        });
        // Re-anchored to the standing visual position (1584, 900)…
        expect(container.style.left).toBe('1584px');
        expect(container.style.top).toBe('900px');
        // …the old right/bottom anchor was dropped on the first grab.
        expect(container.style.right).toBe('');
        expect(container.style.bottom).toBe('');
        expect(container.children[0].style.cursor).toBe('grabbing');
    });

    it('moves apply the exact pointer delta, clamp past viewport edges, and detach on release', () => {
        const { container } = makeChrome({ initialMinimized: true });
        const header = container.children[0];

        header.emit('pointerdown', {
            button: 0, pointerId: 1, clientX: 1600, clientY: 940,
            target: header.children[0], preventDefault: vi.fn(),
        });
        // dx=16/dy=40 past the viewport edges (1600×1000) → clamped.
        docEmit('pointermove', { pointerId: 1, clientX: 1800, clientY: 1200 });
        expect(container.style.left).toBe('1455px'); // 1600 - 145
        expect(container.style.top).toBe('942px');   // 1000 - 58

        docEmit('pointerup', {});
        expect(header.style.cursor).toBe('grab');
        // After release the drag listeners are detached — moves no-op.
        docEmit('pointermove', { pointerId: 1, clientX: 500, clientY: 500 });
        expect(container.style.left).toBe('1455px');
        expect(container.style.top).toBe('942px');
    });

    it('a free drag lands at the exact offset captured on press', () => {
        const { container } = makeChrome({ initialMinimized: true });
        const header = container.children[0];

        header.emit('pointerdown', {
            button: 0, pointerId: 1, clientX: 1590, clientY: 940,
            target: header, preventDefault: vi.fn(),
        });
        docEmit('pointermove', { pointerId: 1, clientX: 800, clientY: 300 });
        // Offset preserved: grabbed at +6/+40 from the panel's top-left corner.
        expect(container.style.left).toBe('794px');
        expect(container.style.top).toBe('260px');
    });

    it('moves from a different pointer id never move the panel', () => {
        const { container } = makeChrome({ initialMinimized: true });
        const header = container.children[0];

        header.emit('pointerdown', {
            button: 0, pointerId: 1, clientX: 1600, clientY: 940,
            target: header.children[0], preventDefault: vi.fn(),
        });
        docEmit('pointermove', { pointerId: 9, clientX: 100, clientY: 100 });
        expect(container.style.left).toBe('1584px'); // still the re-anchored spot
        expect(container.style.top).toBe('900px');
    });

    it('a press on the ➖/➕ toggle never starts a drag — it stays a click affordance', () => {
        const { chrome, container } = makeChrome({ initialMinimized: true });
        const toggle = toggleOf(container);

        toggle.emit('pointerdown', { button: 0, pointerId: 1, clientX: 1590, clientY: 940, target: toggle });
        docEmit('pointermove', { pointerId: 1, clientX: 100, clientY: 100 });
        expect(container.style.left).toBeUndefined();
        // …and the toggle still works as a click target afterwards.
        toggle.click();
        expect(chrome.minimized).toBe(false);
        expect(container.children[1].style.display).toBe('block');
    });

    it('non-primary-button presses never drag either', () => {
        const { container } = makeChrome({ initialMinimized: true });
        const header = container.children[0];

        header.emit('pointerdown', { button: 2, pointerId: 7, clientX: 1590, clientY: 940, target: header });
        docEmit('pointermove', { pointerId: 7, clientX: 100, clientY: 100 });
        expect(container.style.left).toBeUndefined();
    });

    it('two chrome instances carry fully independent drag state', () => {
        const a = makeChrome({ initialMinimized: true });
        const b = makeChrome({ initialMinimized: true });

        const headerA = a.container.children[0];
        headerA.emit('pointerdown', {
            button: 0, pointerId: 1, clientX: 1590, clientY: 940,
            target: headerA, preventDefault: vi.fn(),
        });
        docEmit('pointermove', { pointerId: 1, clientX: 500, clientY: 500 });
        // Only the dragged panel's container moved; the other's anchor is untouched.
        expect(a.container.style.left).toBe('494px'); // 500 - 6
        expect(b.container.style.left).toBeUndefined();
        // Minimize state is per-chrome too: clicking B's toggle does not touch A.
        toggleOf(b.container).click();
        expect(a.chrome.minimized).toBe(true);
        expect(b.chrome.minimized).toBe(false);
    });
});