/**
 * watch page entry - the browser sidecar (issues #62 + #65, ADR 0010).
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
 *
 * Two spectating sources share the page (issue #65): the scripted solver
 * (WatchFlow, the #62 fallback - always available) and the live LLM turn
 * source (LiveFlow: the page connects to the configurable turn service, or
 * rides the in-page runTurn posture, and a live model drives the watched
 * world; the model's observations render in the HUD's observation panel).
 * Either button starts its cycle; starting one interrupts the other (a
 * click is the human's takeover - a stuck or errored cycle never locks the
 * page, and the scripted fallback keeps the watch usable). The live
 * cycle's settings ride window.WATCH_LIVE_CONFIG; without them the page
 * names the resolver's gaps at boot.
 */

import Renderer from '../render/Renderer.js';
import { AgentSession } from '../../agent/session.js';
import { bannerForRunResult, formatEventRow, WatchFlow } from './watchFlow.js';
import {
    LiveFlow,
    createChatModelTransport,
    createHttpTurnTransport,
    createLocalTurnTransport,
    resolveLiveDriverConfig,
} from './liveFlow.js';

const WORLD_WIDTH = 1000;
const WORLD_HEIGHT = 600;

const canvas = document.getElementById('watch-canvas');
const levelNameEl = document.getElementById('watch-level-name');
const statusEl = document.getElementById('watch-status');
const eventsEl = document.getElementById('watch-events');
const observationsEl = document.getElementById('watch-observations');
const bannerEl = document.getElementById('watch-banner');
const button = document.getElementById('solve-watch');
const liveButton = document.getElementById('watch-live');

if (!canvas || !levelNameEl || !statusEl || !eventsEl || !observationsEl || !bannerEl || !button || !liveButton) {
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

    // The live source's page configuration (issue #65): the host page sets
    // window.WATCH_LIVE_CONFIG ({model, modelBaseUrl, turnBaseUrl?,
    // apiKey?, maxTurns?, level?}); the resolver's contract is the driver
    // resolver's own ({errors, config} - the #62 boundary shape). Without
    // the global the resolver names every gap, the live button sits out
    // and the status line says so - the scripted source needs nothing.
    const liveConfig = resolveLiveDriverConfig(window.WATCH_LIVE_CONFIG ?? {});

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

    function renderEvents(rows) {
        for (const row of rows) {
            const li = document.createElement('li');
            li.textContent = formatEventRow(row);
            if (row.landmark) li.className = 'landmark'; // verdict rows emphasized
            eventsEl.appendChild(li);
        }
        eventsEl.scrollTop = eventsEl.scrollHeight;
    }

    function renderObservation(text) {
        const li = document.createElement('li');
        li.textContent = text;
        observationsEl.appendChild(li);
        observationsEl.scrollTop = observationsEl.scrollHeight;
    }

    function resetHud() {
        eventsEl.replaceChildren();
        observationsEl.replaceChildren();
        setBanner(null);
        statusEl.classList.remove('error');
    }

    /** Interrupt any running cycle: both buttons stay live and a click is
     *  the human's takeover - the scripted fallback keeps the watch
     *  usable around a stuck, waiting or errored live source. */
    function takeOver() {
        if (flow && !flow.done) flow.cancel(); // the previous cycle's world is gone
        resetHud();
    }

    const hudListeners = {
        onLevelLoaded: (doc) => {
            levelNameEl.textContent = `${doc.id} - ${doc.name}`;
        },
        onStatus: (text) => {
            statusEl.textContent = text;
        },
        onEvent: renderEvents,
        onObservation: renderObservation,
        onFrame: () => {
            // The live board: the flow owns the session and its world - the
            // painter is a pure view over it.
            renderer.render(flow.liveObjects());
        },
    };

    const scriptedListeners = {
        ...hudListeners,
        onWatchOutcome: (result) => {
            const banner = bannerForRunResult(result);
            setBanner({ title: banner.label, body: banner.text, kind: result.outcome });
        },
        onSolverUnsolved: (report) => {
            setBanner({ title: 'SOLVER UNSOLVED', body: report.diagnosis, kind: 'unsolved' });
        },
        onError: () => {
            statusEl.classList.add('error');
        },
    };

    // The live goal banners compose with the #62 compositor: the judged
    // run's outcome rides onWatchOutcome, the turn-cap ending banners
    // here (the goal outcomes themselves banner through the run result).
    const liveListeners = {
        ...hudListeners,
        onWatchOutcome: (result) => {
            const banner = bannerForRunResult(result);
            setBanner({ title: banner.label, body: banner.text, kind: result.outcome });
        },
        onLiveEnded: (payload) => {
            if (payload.outcome !== 'turn-cap') return;
            setBanner({
                title: 'TURN CAP',
                body: `the live source used its ${payload.turns} turns - the cap is the driver's, not the model's`,
                kind: 'cap',
            });
        },
        onDriverError: (payload) => {
            statusEl.classList.add('error');
            setBanner({
                title: 'LIVE SOURCE ERROR',
                body: `${payload.message} - the scripted watch stays usable`,
                kind: 'error',
            });
        },
        onServiceUnreachable: (payload) => {
            statusEl.classList.add('error');
            setBanner({
                title: 'TURN SERVICE UNREACHABLE',
                body: `${payload.message} - the scripted watch stays usable`,
                kind: 'error',
            });
        },
    };

    if (liveConfig.errors.length > 0) {
        // The unconfigured live posture is a visible page fact: the button
        // sits out with the resolver's gap names (the page defaults ride).
        liveButton.disabled = true;
        liveButton.title = liveConfig.errors.join(' ');
        statusEl.textContent = 'idle - press Solve & Watch (the live source needs its config)';
    }

    button.addEventListener('click', () => {
        takeOver();
        // Scripted fallback: never needs a model or a service. The cycle
        // runs to its banner; a second click interrupts it mid-run.
        flow = new WatchFlow({
            listeners: scriptedListeners,
        });
        flow.start();
    });

    liveButton.addEventListener('click', () => {
        if (liveConfig.errors.length > 0) {
            takeOver();
            statusEl.classList.add('error');
            statusEl.textContent = liveConfig.errors.join(' ');
            return;
        }
        takeOver();
        const cfg = liveConfig.config;
        // The in-page posture shares the flow's session with the turn
        // transport; the service posture reads through the configurable
        // URL with the level stamped per turn.
        const session = new AgentSession({ seed: null });
        flow = new LiveFlow({
            levelId: cfg.level,
            session,
            model: createChatModelTransport({ baseUrl: cfg.modelBaseUrl, model: cfg.model, apiKey: cfg.apiKey }),
            turns: cfg.turnBaseUrl !== undefined
                ? createHttpTurnTransport(cfg.turnBaseUrl, cfg.level)
                : createLocalTurnTransport(session),
            maxTurns: cfg.maxTurns,
            listeners: liveListeners,
        });
        flow.start();
    });
}
