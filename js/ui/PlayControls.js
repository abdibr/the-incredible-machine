/**
 * PlayControls — Play / Pause / Reset / Speed UI
 *
 * Renders transport-style control buttons into the #play-controls
 * DOM element and emits events on the EventBus.
 */

import { eventBus } from '../EventBus.js';

class PlayControls {
    constructor() {
        /** @type {HTMLElement} */
        this.container = null;

        /** @type {Object<string, HTMLButtonElement>} */
        this.buttons = {};

        /** Current speed multiplier */
        this._speed = 1;

        /** Current mode */
        this._mode = 'MENU';

        /** The rope debug overlay toggle state (issue #59) - the button reflects it. */
        this._ropeDebug = false;
    }

    /**
     * Initialize Play Controls — build buttons and wire events.
     */
    init() {
        this.container = document.getElementById('play-controls');
        if (!this.container) {
            console.error('[PlayControls] #play-controls element not found');
            return;
        }

        // Clear any placeholder content
        this.container.innerHTML = '';

        // Create buttons
        this._createButton('play', '▶', 'Play');
        this._createButton('pause', '⏸', 'Pause');
        this._createButton('reset', '⏹', 'Reset');
        this._createButton('speed', '1×', 'Speed Toggle');
        // The rope debug overlay toggle (issue #59): a debugging affordance,
        // available at every stage but the menu - enabling it during play is
        // the deliberate decision-9 exception the overlay exists for.
        this._createButton('rope-debug', 'DBG', 'Rope debug overlay');
        // Give up (ADR 0009): swap the board to the level's solution scene;
        // in the solution view the same button becomes the return control.
        this._createButton('give-up', '🏳', 'Give up — show this level\'s solution');

        // Button click handlers
        this.buttons.play.addEventListener('click', () => this._onPlay());
        this.buttons.pause.addEventListener('click', () => this._onPause());
        this.buttons.reset.addEventListener('click', () => this._onReset());
        this.buttons.speed.addEventListener('click', () => this._onSpeed());
        this.buttons['rope-debug'].addEventListener('click', () => this._onRopeDebug());
        this.buttons['give-up'].addEventListener('click', () => this._onGiveUp());

        // Keyboard shortcuts
        this._keyHandler = (e) => {
            // Don't capture keys when typing in an input
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

            if (e.code === 'Space') {
                e.preventDefault();
                if (this._mode === 'PLAYING') {
                    this._onPause();
                } else if (this._mode === 'EDITING' || this._mode === 'PAUSED' || this._mode === 'SANDBOX') {
                    this._onPlay();
                }
            } else if (e.code === 'KeyR' && !e.ctrlKey && !e.metaKey) {
                e.preventDefault();
                this._onReset();
            }
        };
        document.addEventListener('keydown', this._keyHandler);

        // Listen for mode changes to update button states
        eventBus.on('mode:changed', ({ newMode }) => {
            this._mode = newMode;
            this._updateButtonStates();
        });

        // Mirror the live loop speed — GameLoop is the source of truth
        eventBus.on('loop:speed', ({ speed }) => this._setSpeed(speed));

        // Initial state
        this._setSpeed(this._speed);
        this._updateButtonStates();

        console.log('[PlayControls] Initialized');
    }

    // ── Private ──────────────────────────────────

    _createButton(name, label, title) {
        const btn = document.createElement('button');
        btn.className = 'btn btn-icon';
        btn.id = `btn-${name}`;
        btn.textContent = label;
        btn.title = title;
        btn.setAttribute('aria-label', title);
        this.container.appendChild(btn);
        this.buttons[name] = btn;
    }

    _onPlay() {
        eventBus.emit('controls:play');
    }

    _onPause() {
        eventBus.emit('controls:pause');
    }

    _onReset() {
        eventBus.emit('controls:reset');
    }

    _onRopeDebug() {
        // Issue #59: the toggle flips its own state and announces it; the app
        // wiring (wireRopeDebugOverlay) carries it to the renderer's overlay
        // flag - nothing else moves (simulation and gameplay state untouched
        // by construction: this emits a flag, not a stage change).
        this._ropeDebug = !this._ropeDebug;
        // The button mirrors its own state right here: a click is the one
        // thing this toggle answers for and no stage change rides along,
        // so _updateButtonStates alone cannot carry its highlight.
        this.buttons['rope-debug'].classList.toggle('btn-active', this._ropeDebug);
        eventBus.emit('controls:rope-debug', { enabled: this._ropeDebug });
    }

    /**
     * Give up / return control (ADR 0009): in the SOLUTION posture the same
     * button returns to the user's attempt; everywhere else it swaps the
     * board to the level's solution scene. main.js validates the posture.
     * @private
     */
    _onGiveUp() {
        if (this._mode === 'SOLUTION') {
            eventBus.emit('controls:solution-return');
        } else {
            eventBus.emit('controls:give-up');
        }
    }

    _onSpeed() {
        // GameLoop.cycleSpeed() (wired at app level) owns the speed state;
        // this UI mirrors it via the `loop:speed` event.
        eventBus.emit('controls:speed', { speed: this._speed });
    }

    /** Show the current speed on the button label and tooltip. */
    _setSpeed(speed) {
        this._speed = speed;
        this.buttons.speed.textContent = `${speed}×`;
        this.buttons.speed.title = `Play speed: ${speed}×`;
        this.buttons.speed.classList.toggle('btn-active', speed !== 1);
    }

    _updateButtonStates() {
        const mode = this._mode;

        // Reset all active states
        for (const btn of Object.values(this.buttons)) {
            btn.classList.remove('btn-active', 'btn-pressed');
            btn.disabled = false;
        }

        // The give-up button's resting label (ADR 0009): SOLUTION re-labels
        // it below as the return control.
        this.buttons['give-up'].textContent = '🏳';
        this.buttons['give-up'].title = 'Give up — show this level\'s solution';

        // Preserve the speed button's highlight — it reflects current speed
        if (this._speed !== 1) {
            this.buttons.speed.classList.add('btn-active');
        }

        // The debug toggle's own highlight (issue #59): pressed while the
        // overlay is explicitly enabled, whatever the stage.
        this.buttons['rope-debug'].classList.toggle('btn-active', this._ropeDebug);

        switch (mode) {
            case 'MENU':
                // Disable all buttons on the menu screen
                for (const btn of Object.values(this.buttons)) {
                    btn.disabled = true;
                }
                break;

            case 'EDITING':
            case 'SANDBOX':
                // Play is enabled, pause/reset grayed out
                this.buttons.pause.disabled = true;
                if (mode === 'SANDBOX') {
                    // No goal in the sandbox (#63): there is nothing to give
                    // up on, and the editor is not a player posture.
                    this.buttons['give-up'].disabled = true;
                }
                break;

            case 'PLAYING':
                // Pause enabled, play shows as pressed/active
                this.buttons.play.classList.add('btn-pressed');
                break;

            case 'PAUSED':
                // Both play and pause available
                this.buttons.pause.classList.add('btn-pressed');
                break;

            case 'WON':
                // Only reset is meaningful
                this.buttons.play.disabled = true;
                this.buttons.pause.disabled = true;
                this.buttons.speed.disabled = true;
                break;

            case 'SOLUTION':
                // Read-only solution view (ADR 0009): give up becomes the
                // return control; nothing here runs.
                this.buttons.play.disabled = true;
                this.buttons.pause.disabled = true;
                this.buttons.speed.disabled = true;
                this.buttons['give-up'].classList.add('btn-active');
                this.buttons['give-up'].textContent = '↩';
                this.buttons['give-up'].title = 'Return to your attempt';
                break;
        }
    }
}

/** Singleton play controls instance */
export const playControls = new PlayControls();
export default PlayControls;
