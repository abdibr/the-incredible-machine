/**
 * Editor panel placement regression tests (ADR 0006 follow-up finding).
 *
 * User report: "I don't see any button in the UI" — entering SANDBOX from the
 * level-select screen never showed the editor panel (and its 🐞 Bug File
 * section). Root cause: `#editor-overlay` was nested INSIDE `#overlay-container`,
 * whose `hidden` class LevelSelect/GoalOverlay toggle on every mode change —
 * including `LevelSelect.hide()` running right before `setMode(SANDBOX)` on the
 * 🔧 Sandbox Mode button. A display:none ancestor makes the panel unrenderable
 * no matter what the panel's own classes/styles say.
 *
 * Two seams pinned here:
 * 1. index.html structure: `#editor-overlay` must be a SIBLING of (never
 *    inside) `#overlay-container`.
 * 2. Behavior: the real sandbox-entry sequence (`levelSelect.hide()` →
 *    `mode:changed` SANDBOX) must leave the built panel visible — no `hidden`
 *    on the panel nor on any ancestor — with the bug-file controls present;
 *    non-SANDBOX modes must still hide it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

// ── 1. index.html structure — the DOM contract ──────

describe('index.html — #editor-overlay placement', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

    it('declares #editor-overlay exactly once, outside #overlay-container', () => {
        const hits = html.match(/id="editor-overlay"/g) ?? [];
        expect(hits).toHaveLength(1);

        // Extract the balanced <div id="overlay-container">…</div> block.
        const containerOpen = html.indexOf('<div', html.indexOf('id="overlay-container"'));
        expect(containerOpen).toBeGreaterThan(-1);
        const re = /<div\b[^>]*>|<\/div>/g;
        re.lastIndex = containerOpen;
        let depth = 0;
        let end = -1;
        let m;
        while ((m = re.exec(html))) {
            if (m[0].startsWith('</')) {
                depth -= 1;
                if (depth === 0) { end = m.index + m[0].length; break; }
            } else {
                depth += 1;
            }
        }
        expect(end).toBeGreaterThan(-1);

        const shell = html.slice(containerOpen, end);
        expect(shell).toContain('id="goal-overlay"');
        // The regression: the editor panel used to live in here…
        expect(shell).not.toContain('id="editor-overlay"');
        // …and must only appear after the shell closes.
        expect(html.indexOf('id="editor-overlay"')).toBeGreaterThan(end);
    });
});

// ── 2. Behavior — sandbox entry must leave the panel visible ──

describe('EditorPanel visibility across the sandbox-entry sequence', () => {
    /**
     * Minimal DOM fake in the speed-wiring.test.js house style, extended with
     * a parent chain + children so ancestor visibility can be asserted.
     */
    function fakeNode(tag, id = '') {
        const classes = new Set();
        const children = [];
        const node = {
            tagName: String(tag).toUpperCase(),
            id, textContent: '', className: '',
            type: '', value: '', checked: false, placeholder: '', title: '',
            attrs: {}, style: {},
            classList: {
                add: (...c) => c.forEach((x) => classes.add(x)),
                remove: (...c) => c.forEach((x) => classes.delete(x)),
                contains: (c) => classes.has(c),
                toggle: (c, force) => {
                    if (force === undefined ? !classes.has(c) : force) classes.add(c);
                    else classes.delete(c);
                },
            },
            children,
            parentElement: null,
            appendChild(child) { child.parentElement = node; children.push(child); return child; },
            addEventListener: vi.fn(),
            setAttribute: (k, v) => { node.attrs[k] = v; },
        };
        return node;
    }

    /** Depth-collected textContent (fake nodes do not compose child text). */
    function allText(node) {
        return [node.textContent ?? '', ...node.children.map(allText)].join('');
    }

    /** Depth-first lookup of the first node whose textContent matches exactly. */
    function findNodeByText(node, text) {
        if (node.textContent === text) return node;
        for (const child of node.children ?? []) {
            const hit = findNodeByText(child, text);
            if (hit) return hit;
        }
        return null;
    }

    /** Assert every node from el up to the root carries no `hidden` class. */
    function expectUnhiddenThroughAncestors(el) {
        for (let n = el; n; n = n.parentElement) {
            expect(n.classList.contains('hidden')).toBe(false);
        }
    }

    beforeEach(() => {
        // index.html shape AFTER the fix: #editor-overlay is a sibling of the
        // modal shell, which starts with class="hidden" like the real page.
        const app = fakeNode('div');
        const overlayContainer = fakeNode('div', 'overlay-container');
        [
            fakeNode('div', 'goal-overlay'),
            fakeNode('div', 'level-select-overlay'),
        ].forEach((el) => {
            el.classList.add('hidden');
            overlayContainer.appendChild(el);
        });
        const editorOverlay = fakeNode('div', 'editor-overlay');
        editorOverlay.classList.add('hidden');
        app.appendChild(overlayContainer);
        app.appendChild(editorOverlay);

        const byId = {
            'overlay-container': overlayContainer,
            'goal-overlay': overlayContainer.children[0],
            'level-select-overlay': overlayContainer.children[1],
            'editor-overlay': editorOverlay,
        };

        // main.js boots when the DOM is ready; pretend the DOM is still
        // loading so importing the module does not run init() (the same
        // guard speed-wiring.test.js uses).
        vi.stubGlobal('document', {
            readyState: 'loading',
            addEventListener: vi.fn(),
            getElementById: (id) => byId[id] ?? null,
            createElement: (tag) => fakeNode(tag),
            createTextNode: (t) => ({ textContent: t, children: [] }),
        });
        vi.stubGlobal('window', { addEventListener: vi.fn() });
        vi.stubGlobal('requestAnimationFrame', vi.fn());
        vi.stubGlobal('cancelAnimationFrame', vi.fn());
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('entering SANDBOX (level-select hide + mode:changed) builds the bug-file UI unhidden', async () => {
        const { eventBus } = await import('../js/EventBus.js');
        const { default: EditorPanel } = await import('../js/ui/EditorPanel.js');
        const { default: LevelSelect } = await import('../js/ui/LevelSelect.js');

        const panel = new EditorPanel();
        panel.init();
        const levelSelect = new LevelSelect();
        levelSelect.init();

        const editorOverlay = panel.container; // #editor-overlay
        // The exact sequence the 🔧 Sandbox Mode button runs (LevelSelect.js:108–110):
        levelSelect.hide();
        eventBus.emit('mode:changed', { newMode: 'SANDBOX' });

        expect(editorOverlay.classList.contains('hidden')).toBe(false);
        // The exact regression: LevelSelect.hide() re-hides the shared shell —
        // while the panel lived inside it, it vanished with the shell.
        expectUnhiddenThroughAncestors(editorOverlay);

        // The bug-file section is inside the built panel.
        const text = allText(editorOverlay);
        expect(text).toContain('🐞 Bug File');
        expect(text).toContain('Export Bug File');
        expect(text).toContain('Recover crashed session');
        expect(text).toContain('dense sampling');
        // Recorder not armed in the bare test env → the honest idle status.
        expect(text).toContain('not recording');
        // Recovery button exists but stays hidden until a crash stash appears.
        // (It lives inside the panel body — not a bare container child — so
        // the lookup walks the subtree; #editor-overlay's top level is exactly
        // [header, body] since the minimize/maximize toggle.)
        const recoverBtn = findNodeByText(editorOverlay, '🩹 Recover crashed session');
        expect(recoverBtn).toBeDefined();
        expect(recoverBtn.style.display).toBe('none');
    });

    it('hides the panel again when the mode leaves SANDBOX', async () => {
        const { eventBus } = await import('../js/EventBus.js');
        const { default: EditorPanel } = await import('../js/ui/EditorPanel.js');

        const panel = new EditorPanel();
        panel.init();
        const editorOverlay = panel.container;

        eventBus.emit('mode:changed', { newMode: 'SANDBOX' });
        expect(editorOverlay.classList.contains('hidden')).toBe(false);

        eventBus.emit('mode:changed', { newMode: 'EDITING' });
        expect(editorOverlay.classList.contains('hidden')).toBe(true);
    });
});