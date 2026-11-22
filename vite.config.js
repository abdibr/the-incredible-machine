import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Two HTML entries (issue #62, ADR 0010): the game (index.html -> the game
// bundle via js/main.js - its entry subgraph imports nothing new) and the
// Agent Watch sidecar (watch.html -> js/watch/main.js, the one site allowed
// to import the agent layer). The dev server serves watch.html at
// /watch.html; the production build emits both entries.
export default defineConfig({
    root: '.',
    publicDir: 'public',
    build: {
        outDir: 'dist',
        rollupOptions: {
            input: {
                main: fileURLToPath(new URL('./index.html', import.meta.url)),
                watch: fileURLToPath(new URL('./watch.html', import.meta.url)),
            },
        },
    },
    server: {
        open: true,
    },
    test: {
        globals: true,
    },
});
