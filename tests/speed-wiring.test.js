/**
 * Speed control wiring tests (issue #4 / TODO §2.1).
 *
 * Two seams:
 * 1. App-level wiring: emit `controls:speed` on the EventBus → the GameLoop
 *    cycles its speed (1× ↔ 2×) and the physics time scale follows.
 * 2. Visible affordance: PlayControls mirrors the live loop speed on its
 *    button label + tooltip when `loop:speed` is emitted.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── controls:speed → GameLoop.cycleSpeed ──────────

describe('controls:speed wiring', () => {
    let unsubs = [];

    beforeEach(() => {
        // main.js boots when the DOM is ready; pretend the DOM is still
        // loading so importing the module does not run init().
        vi.stubGlobal('document', { readyState: 'loading', addEventListener: vi.fn() });
        vi.stubGlobal('window', { addEventListener: vi.fn() });
        vi.stubGlobal('requestAnimationFrame', vi.fn());
        vi.stubGlobal('cancelAnimationFrame', vi.fn());
    });

    afterEach(() => {
        for (const fn of unsubs) fn();
        unsubs = [];
        vi.unstubAllGlobals();
    });

    it('cycles the GameLoop (1× → 2× → 1×) and physics timeScale on controls:speed', async () => {
        const { eventBus } = await import('../js/EventBus.js');
        const { GameLoop } = await import('../js/engine/GameLoop.js');
        const { PhysicsEngine } = await import('../js/engine/PhysicsEngine.js');
        const main = await import('../js/main.js');

        const physics = new PhysicsEngine(800, 600);
        const loop = new GameLoop(physics, () => { });
        expect(loop.speed).toBe(1);

        unsubs.push(main.wireSpeedControl({ gameLoop: loop }));

        eventBus.emit('controls:speed', { speed: 2 });
        expect(loop.speed).toBe(2);
        expect(physics.engine.timing.timeScale).toBe(2);

        eventBus.emit('controls:speed', { speed: 1 });
        expect(loop.speed).toBe(1);
        expect(physics.engine.timing.timeScale).toBe(1);

        loop.dispose();
        physics.dispose();
    });

    it('does not throw when no game loop exists yet', async () => {
        const { eventBus } = await import('../js/EventBus.js');
        const main = await import('../js/main.js');

        unsubs.push(main.wireSpeedControl({}));
        expect(() => eventBus.emit('controls:speed', { speed: 2 })).not.toThrow();
    });
});

// ── PlayControls shows the current speed ──────────

/** Button nodes captured by the fake DOM across the describe block. */
let fakeButtons = [];

describe('PlayControls speed affordance', () => {
    beforeEach(() => {
        // Minimal DOM fakes — PlayControls only needs createElement /
        // getElementById / appendChild / classList / setAttribute.
        const makeFakeButton = () => {
            const classes = new Set();
            const el = {
                className: '', id: '', textContent: '', title: '', disabled: false,
                attrs: {},
                classList: {
                    add: (...c) => c.forEach(x => classes.add(x)),
                    remove: (...c) => c.forEach(x => classes.delete(x)),
                    toggle: (c, force) => {
                        if (force === undefined ? !classes.has(c) : force) classes.add(c);
                        else classes.delete(c);
                    },
                    contains: (c) => classes.has(c),
                },
                addEventListener: vi.fn(),
            };
            el.setAttribute = (k, v) => { el.attrs[k] = v; };
            return el;
        };

        fakeButtons = [];
        const container = {
            innerHTML: '',
            appendChild: (el) => { fakeButtons.push(el); },
        };

        vi.stubGlobal('document', {
            readyState: 'complete',
            getElementById: vi.fn(() => container),
            createElement: vi.fn(() => makeFakeButton()),
            addEventListener: vi.fn(),
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('shows current speed on label and tooltip, following loop:speed', async () => {
        const { eventBus } = await import('../js/EventBus.js');
        const { playControls } = await import('../js/ui/PlayControls.js');
        playControls.init();

        const btn = fakeButtons.find(b => b.id === 'btn-speed');
        expect(btn).toBeDefined();
        expect(btn.textContent).toBe('1×');
        expect(btn.title).toBe('Play speed: 1×');

        eventBus.emit('loop:speed', { speed: 2 });
        expect(btn.textContent).toBe('2×');
        expect(btn.title).toBe('Play speed: 2×');

        eventBus.emit('loop:speed', { speed: 1 });
        expect(btn.textContent).toBe('1×');
        expect(btn.title).toBe('Play speed: 1×');
    });
});