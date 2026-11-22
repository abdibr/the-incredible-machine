/**
 * watch page entry - the browser sidecar (issue #62, ADR 0010).
 *
 * The ONLY entry allowed to import the agent layer: this page watches the
 * agent beat a level. The player's game bundle (index.html -> js/main.js)
 * still never reads agent/, and this page never boots main.js - so none of
 * the player machinery is wired: no progress marks, no recorder, no editor
 * panels (watching never mutates player state). The canvas below is a
 * fresh Renderer CLASS instance on this page's own canvas (importing
 * ../render/Renderer.js creates the game's singleton, but that one is
 * never initialized - the game's canvas is untouched). The level document
 * is fetched by the browser (the agent session's fs loader stays
 * Node-only) and handed to the session as a data object.
 */

import Renderer from '../render/Renderer.js';
import { bannerForRunResult, formatEventRow, WatchFlow } from './watchFlow.js';

const WORLD_WIDTH = 1000;
const WORLD_HEIGHT = 600;

const canvas = document.getElementById('watch-canvas');
const levelNameEl = document.getElementById('watch-level-name');
const statusEl = document.getElementById('watch-status');
const eventsEl = document.getElementById('watch-events');
const bannerEl = document.getElementById('watch-banner');
const button = document.getElementById('solve-watch');

if (!canvas || !levelNameEl || !statusEl || !eventsEl || !bannerEl || !button) {
    console.error('[watch] required DOM elements not found');
} else {
    // Fixed playfield size: the level geometry's home is the 1000x600
    // world (same backing store rule as the game page); CSS scales it.
    canvas.width = WORLD_WIDTH;
    canvas.height = WORLD_HEIGHT;

    // The page's own renderer - the same class the game's main.js boots,
    // its own canvas, no connect flow, no debug engine: a pure viewer.
    const renderer = new Renderer();
    renderer.init(canvas);

    let flow = null;

    function setBanner(payload) {
        if (!payload) {
            bannerEl.classList.add('hidden');
            bannerEl.textContent = '';
            bannerEl.dataset.outcome = '';
            return;
        }
        bannerEl.textContent = `${payload.title} - ${payload.body}`;
        bannerEl.dataset.outcome = payload.kind;
        bannerEl.classList.remove('hidden');
    }

    function syncButton() {
        button.disabled = !!(flow && !flow.done);
    }

    button.addEventListener('click', () => {
        if (flow && !flow.done) return; // a cycle is on: wait for its banner
        flow?.cancel(); // the previous cycle's world is gone
        eventsEl.replaceChildren();
        setBanner(null);
        statusEl.classList.remove('error');
        flow = new WatchFlow({
            listeners: {
                onLevelLoaded: (doc) => {
                    levelNameEl.textContent = `${doc.id} - ${doc.name}`;
                },
                onStatus: (text) => {
                    statusEl.textContent = text;
                },
                onEvent: (rows) => {
                    for (const row of rows) {
                        const li = document.createElement('li');
                        li.textContent = formatEventRow(row);
                        if (row.landmark) li.className = 'landmark'; // verdict rows emphasized
                        eventsEl.appendChild(li);
                        eventsEl.scrollTop = eventsEl.scrollHeight;
                    }
                },
                onFrame: () => {
                    // The live board: the watch flow owns the session and
                    // its world - the painter is a pure view over it.
                    renderer.render(flow.liveObjects());
                },
                onWatchOutcome: (result) => {
                    const banner = bannerForRunResult(result);
                    setBanner({ title: banner.label, body: banner.text, kind: result.outcome });
                    syncButton();
                },
                onSolverUnsolved: (report) => {
                    setBanner({ title: 'SOLVER UNSOLVED', body: report.diagnosis, kind: 'unsolved' });
                    syncButton();
                },
                onError: () => {
                    statusEl.classList.add('error');
                    syncButton();
                },
            },
        });
        syncButton(); // disabled while the cycle runs
        flow.start();
    });
}
