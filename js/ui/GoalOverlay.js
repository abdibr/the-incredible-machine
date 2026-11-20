/**
 * GoalOverlay — Win/lose notification overlay
 *
 * Shows on level completion with stats and navigation buttons.
 * Shows on failure/timeout with retry option and optional hints.
 */

import { eventBus } from '../EventBus.js';
import { levelManager } from '../levels/LevelManager.js';

class GoalOverlay {
    constructor() {
        /** @type {HTMLElement} */
        this.container = null;

        /** @type {HTMLElement} */
        this.overlayContainer = null;

        /** Play start timestamp for timing stats */
        this._playStartTime = null;

        /** Parts used count */
        this._partsUsed = 0;
    }

    /**
     * Initialize the goal overlay.
     */
    init() {
        this.container = document.getElementById('goal-overlay');
        this.overlayContainer = document.getElementById('overlay-container');

        if (!this.container) {
            console.error('[GoalOverlay] #goal-overlay not found');
            return;
        }

        // Track play start time for stats
        eventBus.on('mode:changed', ({ newMode }) => {
            if (newMode === 'PLAYING') {
                this._playStartTime = Date.now();
            }
        });

        // Track parts placed
        eventBus.on('object:placed', () => {
            this._partsUsed++;
        });

        eventBus.on('object:removed', () => {
            this._partsUsed = Math.max(0, this._partsUsed - 1);
        });

        // Reset parts count when level is loaded
        eventBus.on('level:loaded', () => {
            this._partsUsed = 0;
        });

        // Listen for win/lose
        eventBus.on('goal:reached', () => {
            this._showWin();
        });

        eventBus.on('goal:failed', (data) => {
            this._showFail(data);
        });

        console.log('[GoalOverlay] Initialized');
    }

    /**
     * Show the overlay (generic).
     */
    show() {
        this.container.classList.remove('hidden');
        this.overlayContainer.classList.remove('hidden');
    }

    /**
     * Hide the overlay.
     */
    hide() {
        // Null-safe: the give-up path (ADR 0009) may hide the overlay before
        // the boot built the containers (tests drive the seam directly).
        this.container?.classList.add('hidden');
        this.overlayContainer?.classList.add('hidden');
    }

    // ── Private ──────────────────────────────────

    _showWin() {
        const elapsed = this._playStartTime
            ? ((Date.now() - this._playStartTime) / 1000).toFixed(1)
            : '?';

        const level = levelManager.getCurrentLevel();
        const nextId = levelManager.getNextLevel();

        this.container.innerHTML = '';

        // Title
        const h2 = document.createElement('h2');
        h2.textContent = '🎉 Puzzle Complete!';
        this.container.appendChild(h2);

        // Stats
        const stats = document.createElement('p');
        stats.innerHTML = `
            <strong>${level ? level.name : 'Level'}</strong><br>
            ⏱ Time: ${elapsed}s &nbsp; | &nbsp; 🔧 Parts used: ${this._partsUsed}
        `;
        this.container.appendChild(stats);

        // Buttons
        const btnRow = document.createElement('div');
        btnRow.style.cssText = 'display: flex; gap: 10px; justify-content: center; margin-top: 16px;';

        if (nextId) {
            const nextBtn = document.createElement('button');
            nextBtn.className = 'btn btn-success';
            nextBtn.textContent = '➡ Next Level';
            nextBtn.addEventListener('click', () => {
                this.hide();
                eventBus.emit('overlay:next-level', { levelId: nextId });
            });
            btnRow.appendChild(nextBtn);
        }

        const retryBtn = document.createElement('button');
        retryBtn.className = 'btn btn-primary';
        retryBtn.textContent = '🔄 Retry';
        retryBtn.addEventListener('click', () => {
            this.hide();
            eventBus.emit('overlay:retry');
        });
        btnRow.appendChild(retryBtn);

        const menuBtn = document.createElement('button');
        menuBtn.className = 'btn btn-primary';
        menuBtn.textContent = '📋 Menu';
        menuBtn.addEventListener('click', () => {
            this.hide();
            eventBus.emit('overlay:menu');
        });
        btnRow.appendChild(menuBtn);

        this.container.appendChild(btnRow);

        this.show();
    }

    _showFail(data = {}) {
        this.container.innerHTML = '';

        const h2 = document.createElement('h2');
        h2.textContent = '😅 Try Again!';
        this.container.appendChild(h2);

        // Optional hint
        const level = levelManager.getCurrentLevel();
        if (level && level.hints && level.hints.length > 0) {
            const hint = document.createElement('p');
            hint.style.cssText = 'font-style: italic; color: #606060; margin-bottom: 12px;';
            hint.textContent = `💡 Hint: ${level.hints[0]}`;
            this.container.appendChild(hint);
        }

        if (data.reason) {
            const reason = document.createElement('p');
            reason.textContent = data.reason;
            this.container.appendChild(reason);
        }

        const btnRow = document.createElement('div');
        btnRow.style.cssText = 'display: flex; gap: 10px; justify-content: center; margin-top: 16px;';

        const retryBtn = document.createElement('button');
        retryBtn.className = 'btn btn-primary';
        retryBtn.textContent = '🔄 Try Again';
        retryBtn.addEventListener('click', () => {
            this.hide();
            eventBus.emit('overlay:retry');
        });
        btnRow.appendChild(retryBtn);

        // Give-up affordance (ADR 0009): a level that ships its solution
        // scene — every validated level does — can show the solved machine
        // when the player gives up. main.js validates the posture; this
        // button only announces the ask.
        if (level?.solution?.scene?.length > 0) {
            const solutionBtn = document.createElement('button');
            solutionBtn.className = 'btn btn-primary';
            solutionBtn.textContent = '🏳 Show me the solution';
            solutionBtn.title = 'Give up and see the solved machine';
            solutionBtn.addEventListener('click', () => {
                this.hide();
                eventBus.emit('controls:give-up');
            });
            btnRow.appendChild(solutionBtn);
        }

        const menuBtn = document.createElement('button');
        menuBtn.className = 'btn btn-primary';
        menuBtn.textContent = '📋 Menu';
        menuBtn.addEventListener('click', () => {
            this.hide();
            eventBus.emit('overlay:menu');
        });
        btnRow.appendChild(menuBtn);

        this.container.appendChild(btnRow);

        this.show();
    }
}

/** Singleton goal overlay instance */
export const goalOverlay = new GoalOverlay();
export default GoalOverlay;
