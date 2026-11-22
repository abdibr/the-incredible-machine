import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import viteConfig from '../../vite.config.js';
import { eventBus } from '../../js/EventBus.js';
import { levelManager } from '../../js/levels/LevelManager.js';
import { AgentSession } from '../../agent/session.js';
import { WatchFlow } from '../../js/watch/watchFlow.js';

/**
 * The boundary tests (issue #62).
 *
 * The watch sidecar crosses a boundary deliberately, and the decision is
 * pinned on both sides:
 *
 * - ADR 0010 records the scoped amendment: the watch sidecar site may
 *   import the agent layer; the player's game bundle (its entry subgraph)
 *   still may not; watching never mutates player state (no progress
 *   marks, no recorder or editor side effects - the sidecar reuses none
 *   of those components); watched trials are the same deterministic
 *   trials trial() judges; the level data reaches the session from a
 *   browser-side fetch, the fs loader staying Node-only.
 * - The second browser entry is real in both toolchains: the vite config
 *   lists both HTML files, and the game entry (index.html -> js/main.js)
 *   imports nothing new. Import-graph scans pin the amendment in code.
 */

/** Relative to tests/watch/. */
function readText(rel) {
    return readFileSync(new URL(rel, import.meta.url), 'utf8');
}

/** Every .js file under js/, as paths relative to it (recursive). */
function jsModuleFiles() {
    const root = join(fileURLToPath(new URL('../../js', import.meta.url)));
    return readdirSync(root, { recursive: true, encoding: 'utf8' })
        .filter((f) => f.endsWith('.js'))
        .map((f) => f.replaceAll('\\', '/'));
}

const importSpecifiers = (text) => [...text.matchAll(/(?:\bfrom\s+|\bimport\s+)["']([^"']+)["']/g)].map((m) => m[1]);

describe('ADR 0010 - the watch-sidecar boundary decision', () => {
    const adrFiles = readdirSync(join(fileURLToPath(new URL('../../docs/adr', import.meta.url))), 'utf8');
    const adrFile = adrFiles.find((f) => /^0010-.*\.md$/.test(f));
    const text = adrFile ? readText(`../../docs/adr/${adrFile}`) : '';

    it('exists as the next slot in the ADR sequence (docs/adr/0010-*.md)', () => {
        expect(adrFile, 'expected docs/adr/0010-*.md from ticket #62').toBeDefined();
    });

    it('records the scoped amendment: the sidecar may import the agent layer, the game bundle still may not', () => {
        expect(text).toMatch(/\b0010\b/);
        expect(text).toMatch(/watch sidecar/i);
        expect(text).toMatch(/may import the agent layer/i);
        expect(text).toMatch(/game bundle|entry subgraph/i);
        expect(text).toMatch(/still may not|remains barred|still excluded/i);
    });

    it('records the watch posture: watched runs never touch player state', () => {
        expect(text).toMatch(/never mutate[sd]? player state|never touch(es)? player state|player state/i);
        expect(text).toMatch(/progress mark/i);
        expect(text).toMatch(/recorder|editor/i);
    });

    it('records the two remaining constraints: the deterministic-trial parity and the Node-only fs loader', () => {
        expect(text).toMatch(/deterministic/i);
        expect(text).toMatch(/Node-only/i);
    });
});

describe('the watch sidecar is a second browser entry - dev served, production built', () => {
    it('vite.config.js lists both HTML entries via build.rollupOptions.input', () => {
        const input = viteConfig.build?.rollupOptions?.input;
        expect(input, 'expected build.rollupOptions.input with both entries').toBeTypeOf('object');
        expect(Object.keys(input).sort()).toEqual(['main', 'watch']);
        const values = JSON.stringify(Object.values(input));
        expect(values).toContain('index.html');
        expect(values).toContain('watch.html');
        // The vitest/test configuration rides along untouched.
        expect(viteConfig.test).toEqual({ globals: true });
        expect(viteConfig.root).toBe('.');
    });

    it('watch.html is the sidecar page: the watch entry module, canvas, HUD mounts', () => {
        const html = readText('../../watch.html');
        const script = html.match(/<script type="module" src="([^"]+)">/);
        expect(script?.[1]).toBe('/js/watch/main.js');
        expect(html).toContain('id="watch-canvas"');
        expect(html).toContain('id="watch-events"');
        expect(html).toContain('id="watch-banner"');
        expect(html).toContain('id="solve-watch"');
        expect(html).toContain('id="watch-status"');
        expect(html).toMatch(/css\/watch\.css/);
    });

    it('css/watch.css exists and styles the canvas the page mounts', () => {
        const css = readText('../../css/watch.css');
        expect(css).toContain('#watch-canvas');
    });
});

describe('the game bundle is unchanged - its entry imports nothing new', () => {
    it('index.html still boots only the game bundle module', () => {
        const html = readText('../../index.html');
        expect(html.match(/<script type="module" src="\/js\/main\.js">/g)).toHaveLength(1);
        expect(html).not.toContain('/js/watch');
    });

    it('js/main.js imports no agent module and no watch module', () => {
        const main = readText('../../js/main.js');
        for (const specifier of importSpecifiers(main)) {
            expect(specifier).not.toMatch(/agent\//);
            expect(specifier).not.toMatch(/watch/);
        }
    });

    it('the import-graph amendment holds exactly where the ADR grants it: only js/watch imports the agent layer', () => {
        const outsideWatch = jsModuleFiles().filter((f) => !f.startsWith('watch/'));
        const agentImporters = [];
        const watchImporters = [];
        for (const file of outsideWatch) {
            const specifiers = importSpecifiers(readText(`../../js/${file}`));
            if (specifiers.some((s) => s.includes('agent/'))) agentImporters.push(file);
            if (specifiers.some((s) => s.includes('watch'))) watchImporters.push(file);
        }
        expect(agentImporters).toEqual([]); // one-way rule stands: the game subgraph never reads agent/
        expect(watchImporters).toEqual([]); // and nothing in the game tree pulls the sidecar in

        // The granting side: the watch entry's site does import the agent layer.
        const watchSpecifiers = jsModuleFiles()
            .filter((f) => f.startsWith('watch/'))
            .map((f) => importSpecifiers(readText(`../../js/${f}`)))
            .flat();
        expect(watchSpecifiers.some((s) => s.includes('agent/'))).toBe(true);
    });
});

describe('watched runs never mutate player state (ADR 0010)', () => {
    /** @type {import('../../js/watch/watchFlow.js').WatchFlow|null} */
    let flow = null;

    afterEach(() => {
        flow?.cancel();
        flow = null;
    });


    function makeTicker() {
        const queue = [];
        return {
            schedule: (cb) => { queue.push(cb); return queue.length; },
            pump: (times) => {
                const n = queue.length;
                for (let i = 0; i < n && queue.length > 0; i++) queue.shift()(times); // feed the timestamps: the watch pacing is wall-clock
            },
        };
    }

    it('a full Solve & Watch win on the shared bus leaves the progress set untouched', { timeout: 120000 }, async () => {
        expect(levelManager.isLevelCompleted('level-01')).toBe(false);

        const ticker = makeTicker();
        const session = new AgentSession({ seed: null });
        const doc = JSON.parse(readText('../../js/levels/puzzles/level-01.json'));
        flow = new WatchFlow({
            session,
            schedule: ticker.schedule,
            fetchImpl: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(doc) }),
            listeners: { onStatus: () => {}, onEvent: () => {}, onFrame: () => {} },
        });
        /** @type {import('../../js/watch/watchFlow.js').WatchFlow|null} */
        let flowLocal = flow;
        await flowLocal.start();
        let guard = 0;
        while (flow.status === 'solving' && guard++ < 2000) ticker.pump();
        let now = 0;
        while (flow.status === 'watching') ticker.pump((now += 17));
        expect(flow.result?.outcome).toBe('reached'); // sanity: the watched run won

        // The watched win did not mark progress: the watch site never
        // initializes the LevelManager's player hooks.
        expect(levelManager.isLevelCompleted('level-01')).toBe(false);
        // Even a goal:reached arriving on the shared bus afterwards marks
        // nothing - the markComplete listener is armed by levelManager.init(),
        // which no watch module ever runs.
        eventBus.emit('goal:reached', { levelId: 'level-01' });
        expect(levelManager.isLevelCompleted('level-01')).toBe(false);

        flow.cancel();
    });

    it('the watch site never references the player-side machinery', () => {
        const watchFiles = jsModuleFiles().filter((f) => f.startsWith('watch/'));
        expect(watchFiles.length).toBeGreaterThan(0);
        for (const file of watchFiles) {
            const text = readText(`../../js/${file}`);
            expect(text).not.toMatch(/SessionRecorder/);
            expect(text).not.toMatch(/EditorPanel/);
            expect(text).not.toMatch(/PalettePanel/);
            expect(text).not.toMatch(/markComplete/);
            expect(text).not.toMatch(/localStorage/);
            expect(text).not.toMatch(/levelManager\.init/);
            expect(text).not.toMatch(/from\s+["'][^"']*js\/main/); // never boots the game
        }
    });
});

describe("AgentSession's fs level loader stays Node-only (ADR 0010)", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('in a browser-like page, loadLevel(id) refuses with the fetch-it-yourself sentence', async () => {
        const session = new AgentSession();
        try {
            vi.stubGlobal('document', { readyState: 'complete' }); // the sidecar page posture
            await expect(session.loadLevel('level-01')).rejects.toThrow(/Node-only/);
            await expect(session.loadLevel('level-01')).rejects.toThrow(/fetch/);
        } finally {
            session.dispose();
        }
    });

    it('the session constructor survives a browser page: no `process` to consult, unseeded posture', () => {
        vi.stubGlobal('process', undefined); // a browser page has no process
        const session = new AgentSession();
        expect(session.seed).toBeNull(); // unseeded - the deterministic build behavior
        session.dispose();
    });
});


