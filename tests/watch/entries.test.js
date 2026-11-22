import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as viteBuild, createServer as createViteDevServer } from 'vite';

/**
 * The two toolchains the second browser entry must survive (issue #62,
 * ADR 0010).
 *
 * The vite-config structure pin lives in boundary.test.js; these are the
 * REAL runs: the dev server actually serves the watch page (the page HTML,
 * the entry module through the dev transform chain, and the level JSON URL
 * fetchLevelDocument points at), and the production build actually emits
 * both HTML entries - the game bundle named by its input key `main`, the
 * watch sidecar by its key `watch` - with the agent layer's code present
 * only in the sidecar bundle (the game entry's chunk still reads no agent
 * module).
 */

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** A string literal that exists only in the agent layer's browser-path guard. */
const AGENT_SENTENCE = 'is Node-only (ADR 0010)';

afterAll(() => {
    // The build output lives inside gitignored node_modules; start clean, leave clean.
    rmSync(join(REPO_ROOT, 'node_modules', '.watch-entries-build'), { recursive: true, force: true });
});

describe('the dev server serves the watch sidecar (issue #62)', () => {
    /** @type {import('vite').ViteDevServer|null} */
    let server = null;

    afterEach(async () => {
        if (server) {
            await server.close(); // the port and the transform chain end with the test
            server = null;
        }
    });

    it('serves the watch page, its entry module and the level JSON the page fetches', { timeout: 60000 }, async () => {
        server = await createViteDevServer({
            root: REPO_ROOT,
            configFile: join(REPO_ROOT, 'vite.config.js'),
            logLevel: 'error', // the transform pipeline must be silent: no resolution warnings on the watch path
            server: { open: false }, // never a browser window from the suite
        });
        await server.listen();
        const base = server.resolvedUrls?.local?.[0];
        expect(base, 'expected the dev server to resolve a serving URL').toBeDefined();

        const page = await fetch(new URL('watch.html', base));
        expect(page.status).toBe(200);
        const html = await page.text();
        expect(html).toContain('/js/watch/main.js'); // the sidecar entry module the page boots
        expect(html).toContain('id="watch-canvas"'); // the stage the renderer paints
        expect(html).toContain('id="solve-watch"'); // the Solve & Watch control

        // The entry module rides the dev transform chain cleanly - a broken
        // import graph would answer a transform error instead of this module.
        const mod = await fetch(new URL('js/watch/main.js', base));
        expect(mod.status).toBe(200);
        expect(await mod.text()).toContain('watchFlow');

        // The level URL fetchLevelDocument points at is served by the same
        // server: the browser fetches the level JSON itself (ADR 0010 keeps
        // the agent session's fs loader Node-only).
        const level = await fetch(new URL('js/levels/puzzles/level-01.json', base));
        expect(level.status).toBe(200);
        expect((await level.json()).id).toBe('level-01');
    });
});

describe('the production build emits both HTML entries (issue #62)', () => {
    it('dist carries index.html and watch.html, each wiring its own bundle, and the agent layer ships only in the watch bundle', { timeout: 180000 }, async () => {
        const outDir = join(REPO_ROOT, 'node_modules', '.watch-entries-build');
        await viteBuild({
            root: REPO_ROOT,
            configFile: join(REPO_ROOT, 'vite.config.js'),
            logLevel: 'warn',
            build: { outDir },
        });

        const indexHtml = readFileSync(join(outDir, 'index.html'), 'utf8');
        const watchHtml = readFileSync(join(outDir, 'watch.html'), 'utf8');
        expect(indexHtml).toMatch(/src="\/assets\/main-[^"]+\.js"/); // input key `main` names the game bundle
        expect(watchHtml).toMatch(/src="\/assets\/watch-[^"]+\.js"/); // input key `watch` names the sidecar bundle
        expect(watchHtml).toMatch(/watch-[^"]+\.css/); // the sidecar's own stylesheet shipped
        expect(indexHtml).not.toContain('/js/watch'); // the game entry still boots nothing of the sidecar

        const mainChunk = /src="\/assets\/(main-[^"]+\.js)"/.exec(indexHtml)?.[1];
        expect(mainChunk, 'expected the game bundle to be referenced from dist/index.html').toBeDefined();
        const assetsDir = join(outDir, 'assets');
        const jsAssets = readdirSync(assetsDir).filter((f) => f.endsWith('.js'));
        const withAgent = jsAssets.filter((f) => readFileSync(join(assetsDir, f), 'utf8').includes(AGENT_SENTENCE));
        expect(withAgent.length).toBeGreaterThanOrEqual(1); // the sidecar bundle carries the agent layer
        expect(withAgent).not.toContain(mainChunk); // the game bundle's own chunk reads no agent code
    });
});