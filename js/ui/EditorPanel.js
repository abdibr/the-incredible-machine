/**
 * EditorPanel — Sandbox / level editor controls
 *
 * Provides save/load level, set goal, author the parts palette (issue #69),
 * and test functionality. Only visible in SANDBOX mode.
 *
 * Goal honesty (issue #66): the Goal Type select only offers goal types
 * GoalChecker implements — the rest stay visible but disabled. A plain-
 * language readout explains the live session's goal (goal-less before a
 * load, #63 posture) and what the selection means for saved levels, and
 * Save writes exactly the goal the UI showed.
 *
 * Palette honesty (issue #69): per registered part a row offers an include
 * checkbox and a count. Nothing authored keeps the unauthored sandbox
 * posture (#63) — the toolbox is ∞ and Save Level writes the default
 * palette (every type ×10); any row edit authors exactly the displayed
 * posture, the toolbox constrains to it (placed parts consume, excluded
 * types cannot be placed), and Save Level writes it verbatim so loading
 * the file round-trips it exactly.
 *
 * Minimize/maximize (sandbox usability report): the panel floats over the
 * play area's bottom-right corner, so its header row grows a ➖/➕ toggle
 * that collapses it to the title bar and restores it. The same header row
 * also drags the panel anywhere on screen (clamped to the viewport), so a
 * collapsed bar can be parked clear of the action — the dragged position
 * persists across sandbox visits like the minimized state does.
 */

import { eventBus } from '../EventBus.js';
import { levelManager } from '../levels/LevelManager.js';
import { objectRegistry } from '../objects/ObjectRegistry.js';
import {
    DEFAULT_GOAL_ZONE_ID,
    IMPLEMENTED_GOAL_TYPES,
    KNOWN_GOAL_TYPES,
    ZONE_GOAL_TYPE,
    resolveGoalZoneObject,
    stampGoalZoneIds,
} from '../goals/GoalChecker.js';
import { dragDropManager } from './DragDropManager.js';
import { toolbox } from './Toolbox.js';
import { levelObjectOptions } from './selectionHandles.js';
import { sessionRecorder } from '../recorder/SessionRecorder.js';
import { downloadJson } from '../recorder/browser.js';
import { setMode, AppMode } from '../main.js';

/**
 * Standing pin tip (issue #66 follow-up): shown in the pin notice on every
 * sandbox entry, before any pin action has produced a live message. Also
 * introduces the anchor affordance (issue #67) so the two scenery markers
 * are explained side by side, in plain language.
 */
const PIN_TIP = 'Tip: select a part and click its 📌 handle (or press P) to pin it — a pinned bucket is the goal zone, and only pinned parts are saved. The ⚓ handle (or A) anchors a part instead: the player cannot move it, but at play it still falls — Save Level keeps anchored parts too.';

/**
 * The default per-type palette count (issue #69): what an untweaked editor
 * session has always written into saved levels (the sandbox posture — enough
 * for a generous build) and the count a re-included palette row returns to.
 */
const DEFAULT_PALETTE_COUNT = 10;

class EditorPanel {
    constructor() {
        /** @type {HTMLElement} */
        this.container = null;

        /** Current mode */
        this._mode = 'MENU';

        /** Whether the panel is built */
        this._built = false;

        /**
         * The loaded level's goal (issue #66): what the live sandbox session
         * runs on once a level is loaded. Null — no level loaded, the goal-
         * less sandbox posture (#63). Reset on every SANDBOX mode entry.
         * @type {object|null}
         */
        this._loadedGoal = null;

        /** Display name of the loaded level (readout). */
        this._loadedLevelName = null;

        /**
         * The authored parts palette (issue #69): the type→count map the
         * editor works from once a palette has been authored — either by
         * editing rows here or by loading a level (its availableParts become
         * the authored palette exactly as saved). Null — the unauthored
         * sandbox posture (#63): the toolbox offers every registered type
         * without limit and Save Level writes the default palette (every
         * type ×10). Reset on every SANDBOX mode entry.
         * @type {Object<string, number>|null}
         */
        this._authoredPalette = null;

        /** Palette rows: checkbox + count per registered type (issue #69). */
        this._paletteRows = [];

        /** @type {HTMLElement|null} plain-language palette posture readout */
        this._paletteReadout = null;

        /** @type {HTMLButtonElement|null} ∞-clear button (issue #69) */
        this._unlimitedBtn = null;

        /** @type {HTMLSelectElement|null} */
        this._goalSelect = null;

        /** @type {HTMLElement|null} plain-language goal readout (issue #66) */
        this._goalReadout = null;

        /**
         * One plain-language line about the last pin action (issue #66
         * follow-up), or the standing pin tip before any action. Null until
         * the panel is built.
         * @type {HTMLElement|null}
         */
        this._pinNotice = null;

        /**
         * Temporary disabled option displaying an imported level's
         * unimplemented goal type honestly (issue #66).
         * @type {HTMLOptionElement|null}
         */
        this._importedGoalOption = null;

        /** @type {HTMLButtonElement|null} header-row minimize/maximize toggle */
        this._minimizeToggleBtn = null;

        /** @type {HTMLElement|null} body wrapper hidden while minimized */
        this._panelBody = null;

        /**
         * Minimize state (sandbox usability report): collapsed, the panel is
         * only its header row so it stops covering the play area. Persists
         * across sandbox visits — _build runs once and nothing resets it.
         * @type {boolean}
         */
        this._minimized = false;

        /** @type {HTMLElement|null} draggable header row (title + toggle) */
        this._headerRow = null;

        /**
         * Active header drag (sandbox usability report — movable panel):
         * the pointer-to-panel-top-left offset, captured on header
         * pointerdown (the ➖/➕ toggle excluded) and cleared on pointerup /
         * pointercancel.
         * @type {{dx: number, dy: number, pointerId: number|undefined}|null}
         */
        this._dragging = null;

        /**
         * Document-level drag listeners, bound once in the constructor so
         * pointerup can remove the exact functions pointerdown added.
         */
        this._onHeaderDragMove = this._headerDragMove.bind(this);
        this._onHeaderDragEnd = this._headerDragEnd.bind(this);
    }

    /**
     * Initialize the editor panel.
     */
    init() {
        this.container = document.getElementById('editor-overlay');

        if (!this.container) {
            console.error('[EditorPanel] #editor-overlay not found');
            return;
        }

        // Show/hide based on mode
        eventBus.on('mode:changed', ({ newMode }) => {
            this._mode = newMode;
            if (newMode === 'SANDBOX') {
                this._build();
                this._show();
                // A fresh sandbox visit is goal-less (#63): drop any goal a
                // previous visit loaded; Load Level re-installs it (#66).
                this._loadedGoal = null;
                this._loadedLevelName = null;
                // A fresh sandbox visit is palette-less too (issue #69): the
                // ∞-everything toolbox posture returns, the rows display the
                // default values again and Save Level goes back to writing
                // the default palette until rows are edited or a level loads.
                this._authoredPalette = null;
                toolbox.setPalette(null);
                this._syncPaletteControls();
                this._updatePaletteReadout();
                this._updateBugStatus();
                this._updateGoalReadout();
                // The pin affordance opens each visit with its tip again —
                // no stale pin claim from a previous board (issue #66).
                this._setPinNotice(PIN_TIP);
            } else {
                this._hide();
                // Leaving the editor releases the toolbox (issue #69): the
                // constrained counts are an authoring affordance. Outside the
                // editor the live inventory answers again; re-entering SANDBOX
                // re-installs the authored palette.
                toolbox.setPalette(null);
            }
        });

        // Recording status refresh on the events that change it (cheap poll);
        // board events also refresh the goal readout, since they move the
        // goal-zone resolution (#66).
        for (const topic of ['controls:play', 'controls:pause', 'controls:reset', 'object:placed', 'object:moved', 'object:pinned', 'object:anchored', 'object:removed']) {
            eventBus.on(topic, () => {
                if (this._mode === 'SANDBOX') {
                    this._updateBugStatus();
                    // Board changes move the goal-zone resolution too (#66).
                    this._updateGoalReadout();
                }
            });
        }

        // Pin affordance (issue #66 follow-up): announce what a pin toggle
        // did to the goal, decided by the same resolver the readout, the
        // field's GOAL marker and Save share (the readout refresh rides on
        // the cheap poll above).
        eventBus.on('object:pinned', (ev) => this._onPinned(ev));

        // Anchor affordance (issue #67): announce what anchoring did — the
        // same plain-language pattern as the pin notice.
        eventBus.on('object:anchored', (ev) => this._onAnchored(ev));

        console.log('[EditorPanel] Initialized');
    }

    // ── Private ──────────────────────────────────

    _build() {
        if (this._built) return;
        this._built = true;

        this.container.innerHTML = '';
        this.container.style.cssText = `
            position: fixed;
            bottom: 16px;
            right: 16px;
            z-index: 50;
            background: rgba(96, 96, 160, 0.95);
            border: 3px solid #404040;
            border-radius: 8px;
            padding: 16px;
            min-width: 240px;
            color: #f0f0f0;
            font-size: 13px;
            box-shadow: 3px 3px 0 rgba(0,0,0,0.3);
        `;

        // Header row: title + minimize/maximize toggle (sandbox usability
        // report — the panel covered part of the play area and could not be
        // collapsed). Minimizing hides _panelBody and flips the toggle glyph;
        // the state persists across sandbox visits of the session.
        this._minimized = false;

        const header = document.createElement('div');
        // grab cursor hints movability; user-select/touch-action keep a drag
        // from selecting title text or scrolling the page on touch.
        header.style.cssText = 'display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 0 0 8px; cursor: grab; user-select: none; touch-action: none;';
        header.title = 'Drag to move the panel';
        header.addEventListener('pointerdown', (e) => this._onHeaderPointerDown(e));
        this.container.appendChild(header);
        this._headerRow = header;

        const title = document.createElement('h3');
        title.textContent = '🔧 Editor';
        title.style.cssText = 'margin: 0; font-family: Georgia, serif; font-size: 16px; color: #ffd700;';
        header.appendChild(title);

        this._minimizeToggleBtn = document.createElement('button');
        this._minimizeToggleBtn.className = 'btn';
        this._minimizeToggleBtn.style.cssText = 'width: 28px; height: 28px; padding: 0; font-size: 13px; line-height: 1; flex: 0 0 auto;';
        this._minimizeToggleBtn.addEventListener('click', () => this._setMinimized(!this._minimized));
        header.appendChild(this._minimizeToggleBtn);

        // Body wrapper: every control below the header lives here, so
        // minimizing collapses the panel by hiding exactly one element.
        this._panelBody = document.createElement('div');
        this.container.appendChild(this._panelBody);
        this._setMinimized(false);

        // Save Level
        const saveBtn = document.createElement('button');
        saveBtn.className = 'btn btn-primary';
        saveBtn.textContent = '💾 Save Level';
        saveBtn.style.cssText = 'width: 100%; margin-bottom: 8px;';
        saveBtn.addEventListener('click', () => this._saveLevel());
        this._panelBody.appendChild(saveBtn);

        // Load Level
        const loadBtn = document.createElement('button');
        loadBtn.className = 'btn btn-primary';
        loadBtn.textContent = '📂 Load Level';
        loadBtn.style.cssText = 'width: 100%; margin-bottom: 8px;';
        loadBtn.addEventListener('click', () => this._loadLevel());
        this._panelBody.appendChild(loadBtn);

        // Hidden file input for loading
        this._fileInput = document.createElement('input');
        this._fileInput.type = 'file';
        this._fileInput.accept = '.json';
        this._fileInput.style.display = 'none';
        this._fileInput.addEventListener('change', (e) => this._onFileSelected(e));
        this._panelBody.appendChild(this._fileInput);

        // Separator
        this._panelBody.appendChild(this._makeSep());

        // Goal type (issue #66): only implemented goal types are selectable.
        // Unimplemented types stay visible but disabled and marked, so a
        // choice can never silently produce a level that cannot be won.
        const goalLabel = document.createElement('label');
        goalLabel.textContent = 'Goal Type:';
        goalLabel.style.cssText = 'display: block; margin-bottom: 4px; font-weight: bold;';
        this._panelBody.appendChild(goalLabel);

        this._goalSelect = document.createElement('select');
        this._goalSelect.style.cssText = 'width: 100%; padding: 4px; border-radius: 4px; border: 1px solid #404040;';
        // Built from the implemented-goal contract (GoalChecker.js): the
        // honest select + change listener replaces the old silent list.
        this._rebuildGoalOptions(ZONE_GOAL_TYPE);
        this._goalSelect.addEventListener('change', () => this._updateGoalReadout());
        this._panelBody.appendChild(this._goalSelect);

        // Goal readout (issue #66): immediately explains what the live
        // session's goal is (goal-less before a load — #63 posture) and
        // what the current selection means for the next Save Level.
        this._goalReadout = document.createElement('div');
        this._goalReadout.style.cssText = 'opacity: 0.9; font-size: 12px; line-height: 1.4; margin: 6px 0 8px;';
        this._updateGoalReadout();
        this._panelBody.appendChild(this._goalReadout);

        // Pin notice (issue #66 follow-up): one plain-language line about the
        // last pin action — what the pin did to the goal, said by the same
        // resolver that the readout, the field's GOAL marker and Save use, so
        // the message can never promise a goal the checker does not keep.
        // Opens with the standing tip; every SANDBOX entry resets to it.
        this._pinNotice = document.createElement('div');
        this._pinNotice.style.cssText = 'font-size: 12px; line-height: 1.4; margin: 0 0 8px; padding: 4px 6px; background: rgba(255, 255, 255, 0.12); border-radius: 4px;';
        this._pinNotice.textContent = PIN_TIP;
        this._panelBody.appendChild(this._pinNotice);

        this._panelBody.appendChild(this._makeSep());

        // Parts palette (issue #69): per registered type an include checkbox
        // and a count. Nothing authored keeps the ∞-everything sandbox
        // posture (#63) and Save Level writes the default palette; any row
        // edit authors the palette the editor displays — the toolbox then
        // offers exactly those counts (placed parts consume them, excluded
        // types cannot be placed) and Save Level writes them verbatim.
        const paletteLabel = document.createElement('label');
        paletteLabel.textContent = 'Parts Palette:';
        paletteLabel.style.cssText = 'display: block; margin-bottom: 4px; font-weight: bold;';
        this._panelBody.appendChild(paletteLabel);

        // Posture readout: says whether the palette is still the unlimited
        // default and what Save Level will write — the same palette the save
        // uses (_paletteForSave), so the message cannot drift from the
        // download.
        this._paletteRows = [];
        this._paletteReadout = document.createElement('div');
        this._paletteReadout.style.cssText = 'opacity: 0.9; font-size: 12px; line-height: 1.4; margin: 4px 0 6px;';
        this._updatePaletteReadout();
        this._panelBody.appendChild(this._paletteReadout);

        for (const item of objectRegistry.getAll()) {
            const row = document.createElement('div');
            row.style.cssText = 'display: flex; align-items: center; gap: 6px; margin-bottom: 3px; font-size: 12px;';

            const include = document.createElement('input');
            include.type = 'checkbox';
            include.title = `Offer "${item.displayName || item.type}" in the toolbox`;
            include.addEventListener('change', () => this._onPaletteEdited(null));

            const name = document.createElement('span');
            name.textContent = item.displayName || item.type;

            const label = document.createElement('label');
            label.style.cssText = 'display: flex; align-items: center; gap: 6px; flex: 1; cursor: pointer;';
            label.appendChild(include);
            label.appendChild(name);

            const count = document.createElement('input');
            count.type = 'number';
            count.min = '0';
            count.step = '1';
            count.title = 'How many of this part may be placed (0 = excluded)';
            count.style.cssText = 'width: 56px; padding: 2px 4px; border: 1px solid #404040; border-radius: 4px; background: rgba(255, 255, 255, 0.95); color: #1e1e1e;';
            count.addEventListener('input', () => this._onPaletteEdited(item.type));

            row.appendChild(label);
            row.appendChild(count);
            this._panelBody.appendChild(row);
            this._paletteRows.push({ type: item.type, include, count });
        }
        this._syncPaletteControls();

        // The escape hatch back to the unlimited posture (issue #69): clears
        // the authored palette — toolbox ∞ again, Save Level back to the
        // default palette. Disabled while nothing is authored.
        this._unlimitedBtn = document.createElement('button');
        this._unlimitedBtn.className = 'btn btn-primary';
        this._unlimitedBtn.textContent = '∞ Everything Unlimited';
        this._unlimitedBtn.style.cssText = 'width: 100%; margin: 4px 0 8px;';
        this._unlimitedBtn.addEventListener('click', () => this._clearPalette());
        this._panelBody.appendChild(this._unlimitedBtn);
        this._updatePaletteReadout();

        // Test button
        const testBtn = document.createElement('button');
        testBtn.className = 'btn btn-success';
        testBtn.textContent = '▶ Test Puzzle';
        testBtn.style.cssText = 'width: 100%; margin-bottom: 8px;';
        testBtn.addEventListener('click', () => {
            eventBus.emit('controls:play');
        });
        this._panelBody.appendChild(testBtn);

        // Back to menu
        const menuBtn = document.createElement('button');
        menuBtn.className = 'btn btn-primary';
        menuBtn.textContent = '📋 Back to Menu';
        menuBtn.style.cssText = 'width: 100%;';
        menuBtn.addEventListener('click', () => {
            eventBus.emit('overlay:menu');
        });
        this._panelBody.appendChild(menuBtn);

        // ── Bug file recorder (ADR 0006) ──
        this._panelBody.appendChild(this._makeSep());

        const bugLabel = document.createElement('label');
        bugLabel.textContent = '🐞 Bug File';
        bugLabel.style.cssText = 'display: block; margin-bottom: 4px; font-weight: bold;';
        this._panelBody.appendChild(bugLabel);

        this._bugStatusLine = document.createElement('div');
        this._bugStatusLine.style.cssText = 'opacity: 0.85; font-size: 12px; margin-bottom: 4px;';
        this._panelBody.appendChild(this._bugStatusLine);

        this._bugNotesInput = document.createElement('input');
        this._bugNotesInput.type = 'text';
        this._bugNotesInput.placeholder = 'What went wrong? (goes in the file)';
        this._bugNotesInput.style.cssText = 'width: 100%; padding: 4px; margin-bottom: 4px; border-radius: 4px; border: 1px solid #404040; box-sizing: border-box;';
        this._bugNotesInput.addEventListener('input', () => {
            sessionRecorder.notes = this._bugNotesInput.value;
        });
        this._panelBody.appendChild(this._bugNotesInput);

        const denseLabel = document.createElement('label');
        denseLabel.style.cssText = 'display: block; margin-bottom: 4px;';
        this._bugDenseCheck = document.createElement('input');
        this._bugDenseCheck.type = 'checkbox';
        this._bugDenseCheck.addEventListener('change', () => {
            sessionRecorder.dense = this._bugDenseCheck.checked;
        });
        denseLabel.appendChild(this._bugDenseCheck);
        denseLabel.appendChild(document.createTextNode(' dense sampling (60 Hz, big file)'));
        this._panelBody.appendChild(denseLabel);

        const bugExportBtn = document.createElement('button');
        bugExportBtn.className = 'btn btn-success';
        bugExportBtn.textContent = '💾 Export Bug File';
        bugExportBtn.style.cssText = 'width: 100%; margin-bottom: 4px;';
        bugExportBtn.addEventListener('click', () => this._exportBugFile());
        this._panelBody.appendChild(bugExportBtn);

        this._bugRecoverBtn = document.createElement('button');
        this._bugRecoverBtn.className = 'btn btn-primary';
        this._bugRecoverBtn.textContent = '🩹 Recover crashed session';
        this._bugRecoverBtn.style.cssText = 'width: 100%; display: none;';
        this._bugRecoverBtn.addEventListener('click', () => this._recoverBugFile());
        this._panelBody.appendChild(this._bugRecoverBtn);
    }

    _makeSep() {
        const hr = document.createElement('hr');
        hr.style.cssText = 'border: none; border-top: 1px solid rgba(255,255,255,0.2); margin: 8px 0;';
        return hr;
    }

    /**
     * Minimize/maximize the panel (sandbox usability report): minimized,
     * only the header row remains, so the panel stops covering the play
     * area. The body elements survive the collapse — the cheap event poll
     * keeps refreshing status/readout on hidden nodes, so the next expand
     * shows them current. The state persists across sandbox visits: _build
     * runs once per session and no mode change resets it.
     * @param {boolean} minimized - true collapses to the header row
     * @private
     */
    _setMinimized(minimized) {
        this._minimized = !!minimized;
        if (this._panelBody) {
            this._panelBody.style.display = this._minimized ? 'none' : 'block';
        }
        if (this._minimizeToggleBtn) {
            // Window-chrome convention: ➖ collapses, ➕ restores.
            this._minimizeToggleBtn.textContent = this._minimized ? '➕' : '➖';
            this._minimizeToggleBtn.title = this._minimized ? 'Maximize panel' : 'Minimize panel';
        }
        // Compact chrome while minimized: hug the header row instead of the
        // full floating card, same bottom-right corner.
        this.container.style.padding = this._minimized ? '8px 12px' : '16px';
        this.container.style.minWidth = this._minimized ? '0' : '240px';
    }

    // ── Header drag — movable panel (sandbox usability report) ──────────

    /**
     * pointerdown on the header row starts dragging the panel. Anything
     * inside a button on the bar (the ➖/➕ toggle) stays a click affordance
     * and never starts a drag.
     * @param {PointerEvent} e
     * @private
     */
    _onHeaderPointerDown(e) {
        if (e.button !== undefined && e.button !== 0) return;
        // Walk up from the event target to the header row; hitting a button
        // first means the press belongs to that button, so don't drag.
        for (let node = e.target ?? null; node != null && node !== this._headerRow; node = node.parentNode) {
            if (node === this._minimizeToggleBtn) return;
        }

        const rect = this.container.getBoundingClientRect();
        this._dragging = {
            dx: e.clientX - rect.left,
            dy: e.clientY - rect.top,
            pointerId: e.pointerId,
        };
        if (e.preventDefault) e.preventDefault();
        // Swap the right/bottom anchor for a left/top pair ONLY after the
        // offset is captured: clearing the old anchor first drops the panel
        // onto its static position at (0, 0) mid-read (observed in Chrome),
        // which poisons dx/dy and teleports the whole drag to the corner.
        // Re-anchoring first keeps the panel visually exactly where it was.
        this.container.style.left = `${rect.left}px`;
        this.container.style.top = `${rect.top}px`;
        this.container.style.right = '';
        this.container.style.bottom = '';
        if (this._headerRow) this._headerRow.style.cursor = 'grabbing';
        document.addEventListener('pointermove', this._onHeaderDragMove);
        document.addEventListener('pointerup', this._onHeaderDragEnd);
        document.addEventListener('pointercancel', this._onHeaderDragEnd);
    }

    /**
     * Drag tracking: reapply the clamped position for the current pointer.
     * @param {PointerEvent} e
     * @private
     */
    _headerDragMove(e) {
        if (!this._dragging) return;
        if (e.pointerId !== undefined && e.pointerId !== this._dragging.pointerId) return;
        this._setPanelPosition(
            e.clientX - this._dragging.dx,
            e.clientY - this._dragging.dy,
        );
    }

    /**
     * pointerup/pointercancel: release the drag and its document listeners.
     * @private
     */
    _headerDragEnd() {
        if (!this._dragging) return;
        this._dragging = null;
        if (this._headerRow) this._headerRow.style.cursor = 'grab';
        document.removeEventListener('pointermove', this._onHeaderDragMove);
        document.removeEventListener('pointerup', this._onHeaderDragEnd);
        document.removeEventListener('pointercancel', this._onHeaderDragEnd);
    }

    /**
     * Park the panel at (left, top), clamped so it can never be dragged
     * fully outside the viewport — a bar parked off-screen would be hard to
     * re-grab. Clamping needs the container's geometry and the viewport
     * size; when either is missing it places as-is.
     * @param {number} left
     * @param {number} top
     * @private
     */
    _setPanelPosition(left, top) {
        const rect = this.container.getBoundingClientRect();
        if (rect && window.innerWidth > 0) {
            left = Math.min(Math.max(0, left), Math.max(0, window.innerWidth - rect.width));
        }
        if (rect && window.innerHeight > 0) {
            top = Math.min(Math.max(0, top), Math.max(0, window.innerHeight - rect.height));
        }
        this.container.style.left = `${Math.round(left)}px`;
        this.container.style.top = `${Math.round(top)}px`;
    }

    // ── Goal honesty (issue #66) ─────────────────

    /**
     * Rebuild the Goal Type select's options from GoalChecker.js's
     * KNOWN_GOAL_TYPES contract: implemented types selectable, every other
     * known type visible but disabled and marked — never a silent selection.
     * An imported level's unimplemented goal type joins the list (disabled)
     * so the select can display what is actually in the loaded level.
     * @param {string} selectedType - the goal type the select should display
     * @private
     */
    _rebuildGoalOptions(selectedType) {
        this._goalSelect.innerHTML = '';
        this._importedGoalOption = null;

        const known = KNOWN_GOAL_TYPES.map(({ type, implemented }) => [type, implemented]);
        // An imported unimplemented type joins the list (disabled) so the
        // select can show what is actually in the loaded level.
        if (selectedType !== ZONE_GOAL_TYPE && !known.some(([type]) => type === selectedType)) {
            known.push([selectedType, false]); // imported, not implemented
        }

        for (const [type, implemented] of known) {
            const opt = document.createElement('option');
            opt.value = type;
            opt.disabled = !implemented;
            opt.textContent = implemented
                ? type.replace(/_/g, ' ')
                : `${type.replace(/_/g, ' ')} (not implemented)`;
            this._goalSelect.appendChild(opt);
            if (type === selectedType && !implemented) {
                this._importedGoalOption = opt;
            }
        }
        this._goalSelect.value = selectedType;
    }

    /**
     * Refresh the goal readout (issue #66): what the live session's goal is —
     * goal-less until a level is loaded (#63 posture) — and what the current
     * Goal Type selection will mean for the level Save writes. Two honestly
     * different views:
     * - the live line resolves the goal zone explicitly only (what
     *   GoalChecker can actually win on, today);
     * - the save line resolves with the sandbox stamp fallback (what the
     *   next Save will write — see _computeSaveGoal).
     * Both use the same resolver the renderer's GOAL marker uses.
     * @private
     */
    _updateGoalReadout() {
        if (!this._built || !this._goalReadout) return;
        const objects = dragDropManager.getObjects();
        const loaded = this._loadedGoal;
        const lines = [];
        if (loaded) {
            // Live view: explicit zone resolution only — this session wins
            // exactly what GoalChecker checks, not what a future Save would
            // repair the zone to.
            lines.push(
                `This session: goal from "${this._loadedLevelName}" is active — ${this._goalSentence(loaded, objects)}.`,
            );
        } else {
            lines.push('This session has no active goal — sandbox play has no win/lose until a level is loaded.');
        }
        lines.push(`Save Level will use: ${this._goalSentence(this._computeSaveGoal(objects), objects, { sandboxFallback: true })}.`);

        // Anchored scenery vs palette (issue #67): when an anchored part's
        // type is also offered by the palette, say so in plain language —
        // the anchored copy is scene content and does not consume the count.
        const anchoredTypes = [...new Set(objects.filter((o) => o.isAnchored).map((o) => o.type))];
        const offered = anchoredTypes.filter((type) => this._paletteOffers(type));
        if (offered.length > 0) {
            const label = offered.join(', ');
            lines.push(`⚓ Anchored scenery: ${label} on the board is anchored scene content — it does not use any palette parts, though the palette also offers ${label}.`);
        }

        this._goalReadout.textContent = lines.join(' ');
    }

    /**
     * The goal JSON the next Save Level writes (issue #66): the selected
     * type decides it; while the selection still mirrors a loaded level, its
     * targetType rides along and its zoneId only when that zone still
     * resolves on the board — parity with the goal the UI showed, without
     * saving a reference to a zone that does not exist. Readout and Save
     * share this method, so the two can never drift.
     * @param {Array<import('../objects/BaseObject.js').default>} objects -
     *        the board objects, for zone resolution
     * @returns {{ type: string, targetType: string, zoneId: string }}
     * @private
     */
    _computeSaveGoal(objects) {
        const selectedType = this._goalSelect ? this._goalSelect.value : ZONE_GOAL_TYPE;
        const goal = { type: selectedType, targetType: 'ball', zoneId: DEFAULT_GOAL_ZONE_ID };
        const loaded = this._loadedGoal;
        if (loaded && loaded.type === selectedType) {
            goal.targetType = loaded.targetType ?? 'ball';
            // customId serializes to the level-JSON `id`, so this live-board
            // check matches _saveLevel's fixedObjects view exactly.
            if (selectedType === ZONE_GOAL_TYPE && loaded.zoneId
                && objects.some((obj) => obj.customId === loaded.zoneId)) {
                goal.zoneId = loaded.zoneId;
            }
        }
        return goal;
    }

    /**
     * One plain-language sentence for a goal (issue #66): what counts, at
     * what target, in which zone — or the honest reason it cannot win
     * anything yet.
     * @param {object|null} goal - level JSON goal
     * @param {Array<import('../objects/BaseObject.js').default>} objects -
     *        the board objects, for zone resolution
     * @param {{ sandboxFallback?: boolean }} [opts] - true for the
     *        next-save view (the stamp fallback names a zone); false for the
     *        live view (only an explicit goal.zoneId match counts)
     * @returns {string}
     * @private
     */
    _goalSentence(goal, objects, { sandboxFallback = false } = {}) {
        if (!goal) return 'no goal';
        if (!IMPLEMENTED_GOAL_TYPES.includes(goal.type)) {
            return `"${goal.type.replace(/_/g, ' ')}" is not implemented yet — a saved level with this goal cannot be won`;
        }
        const target = `the ${goal.targetType || 'ball'}`;
        const zone = resolveGoalZoneObject(objects, goal, { stampFallback: sandboxFallback });
        if (!zone) {
            return sandboxFallback
                ? `get ${target} into the goal zone — but no bucket on the board can be the goal zone, so the saved level cannot be won`
                : `get ${target} into the goal zone "${goal.zoneId}" — but that zone matches nothing on the board, so this session cannot reach the goal`;
        }
        return `get ${target} into the bucket marked GOAL on the field`;
    }

    /**
     * Show the pin notice line's text (issue #66 follow-up).
     * @param {string} text
     * @private
     */
    _setPinNotice(text) {
        if (!this._pinNotice) return;
        this._pinNotice.textContent = text;
    }

    /**
     * The pin message (issue #66 follow-up): right after a pin toggle, say in
     * plain language what the pin did — the goal-zone pin the user was looking
     * for, a decoy pin the field's GOAL marker does not point at, an unpin
     * that removed the last zone, or the simple play-static note for
     * non-bucket parts. Truth comes from resolveGoalZoneObject with the
     * save-time stamp fallback — the same resolver the readout, the marker
     * and Save share — so this message can never promise a goal the checker
     * does not keep. Unimplemented goal types (imported levels) get the
     * neutral part message: no zone claim while nothing can be won at all.
     * @param {{ type?: string|null, id?: number|null, isFixed?: boolean,
     *          object?: import('../objects/BaseObject.js').default|null }} [ev]
     *        the object:pinned packet
     * @private
     */
    _onPinned({ type = null, isFixed = false, object = null } = {}) {
        if (!this._pinNotice) return;
        const objects = dragDropManager.getObjects();
        const label = type ? type[0].toUpperCase() + type.slice(1) : 'Object';
        const saveGoal = this._computeSaveGoal(objects);

        if (type !== 'bucket' || !IMPLEMENTED_GOAL_TYPES.includes(saveGoal.type)) {
            this._setPinNotice(isFixed
                ? `📌 ${label} pinned — it will not move during play, and Save Level will include it.`
                : `${label} unpinned — it may fall during play. Only pinned parts are saved with a level.`);
            return;
        }

        const zone = resolveGoalZoneObject(objects, saveGoal, { stampFallback: true });
        const zoneIsThis = zone && object && zone.id === object.id;
        if (isFixed && zoneIsThis) {
            this._setPinNotice('📌 This bucket is the goal zone — the field marks it GOAL, and Save Level will include it.');
        } else if (isFixed) {
            this._setPinNotice('📌 Bucket pinned — but the goal zone is the bucket marked GOAL on the field.');
        } else if (zone) {
            this._setPinNotice('Bucket unpinned — the goal zone is the bucket marked GOAL on the field.');
        } else {
            this._setPinNotice('Bucket unpinned — no bucket on the board can be the goal zone now, so the saved level cannot be won. Pin a bucket to make it the goal.');
        }
    }

    /**
     * The anchor message (issue #67): right after an anchor toggle, say in
     * plain language what anchoring did. Anchored parts are scene content —
     * the player cannot move them, at play they stay physically dynamic, and
     * Save Level keeps them. A bucket gets one honest caution: an anchored
     * bucket cannot be the goal zone (goal zones are pinned buckets), so
     * anchoring one is always a "saved level cannot be won" turn the readout
     * will warn about on the next poll.
     * @param {{ type?: string|null, id?: number|null, isAnchored?: boolean,
     *          object?: import('../objects/BaseObject.js').default|null }} [ev]
     *        the object:anchored packet
     * @private
     */
    _onAnchored({ type = null, isAnchored = false } = {}) {
        if (!this._pinNotice) return;
        const label = type ? type[0].toUpperCase() + type.slice(1) : 'Object';
        if (!isAnchored) {
            this._setPinNotice(`${label} un-anchored — an ordinary movable part again.`);
            return;
        }
        const anchoredLine = `⚓ ${label} anchored — the player cannot move it, but at play it still falls or rolls like a free part. Save Level will include it.`;
        this._setPinNotice(type === 'bucket'
            ? `${anchoredLine} However, an anchored bucket cannot be the goal zone — a pinned bucket is.`
            : anchoredLine);
    }

    // ── Parts palette (issue #69) ──────────────

    /**
     * A palette row edit authors the palette (issue #69): the first touch
     * turns the displayed default posture into a concrete palette — every
     * registered type with what its row shows — and every edit keeps the
     * palette equal to the controls' state, so the toolbox (constrained via
     * setPalette), the readout and the next Save Level all agree.
     * @param {string|null} editedType - the count row being typed into (its
     *        display must not be rewritten mid-keystroke), or null for a
     *        checkbox edit, where a full control sync is safe and wanted
     * @private
     */
    _onPaletteEdited(editedType) {
        if (editedType === null) {
            // A checkbox edit: keep every included row's typed count, but a
            // row re-included while its count reads 0 (excluded rows store 0)
            // comes back at the default count — the default posture's value.
            for (const { include, count } of this._paletteRows) {
                if (include.checked && !(Number(count.value) > 0)) {
                    count.value = String(DEFAULT_PALETTE_COUNT);
                }
            }
        }
        this._authoredPalette = this._paletteFromControls();
        toolbox.setPalette({ ...this._authoredPalette });
        if (editedType === null) this._syncPaletteControls();
        this._updatePaletteReadout();
        // Palette changes can move the anchored-scenery note's honest claim
        // (issue #67): the readout refreshes on the same edit.
        this._updateGoalReadout();
    }

    /** The palette the row controls display right now (0 = excluded). */
    _paletteFromControls() {
        const palette = {};
        for (const { type, include, count } of this._paletteRows) {
            const raw = include.checked ? Number(count.value) : 0;
            palette[type] = Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
        }
        return palette;
    }

    /**
     * Clear the authored palette (issue #69): back to the unlimited sandbox
     * posture — the toolbox is released (∞ every part) and Save Level
     * returns to writing the default palette.
     * @private
     */
    _clearPalette() {
        this._authoredPalette = null;
        toolbox.setPalette(null);
        this._syncPaletteControls();
        this._updatePaletteReadout();
        this._updateGoalReadout();
    }

    /**
     * Push the panel's palette state into the row controls — on build, on
     * mode entry, after a clear and after a load. Unauthored rows display
     * the default posture (included ×10): the exact palette an untweaked
     * Save Level writes.
     * @private
     */
    _syncPaletteControls() {
        for (const { type, include, count } of this._paletteRows) {
            const value = this._authoredPalette
                ? (this._authoredPalette[type] || 0)
                : DEFAULT_PALETTE_COUNT;
            include.checked = value > 0;
            count.value = String(value);
            count.disabled = value <= 0;
        }
    }

    /** Plain-language posture line for the palette section (issue #69). */
    _updatePaletteReadout() {
        if (!this._paletteReadout) return;
        if (this._unlimitedBtn) this._unlimitedBtn.disabled = !this._authoredPalette;
        if (!this._authoredPalette) {
            this._paletteReadout.textContent =
                'Palette not authored — the toolbox offers every part without limit (∞) and Save Level writes the default palette (every type ×10). Toggle a part or edit a count to author it.';
        } else {
            this._paletteReadout.textContent =
                `Authored palette — the toolbox offers exactly these counts and Save Level writes them: ${this._paletteSummary()}. Excluded parts cannot be placed.`;
        }
    }

    /** One-line rendering of the authored palette (type ×count or excluded). */
    _paletteSummary() {
        return this._paletteRows
            .map(({ type }) => {
                const n = this._authoredPalette?.[type] || 0;
                return n > 0 ? `${type} ×${n}` : `${type} — excluded`;
            })
            .join(', ');
    }

    /**
     * Whether the palette offers `type` in the live session (issues #67/#69):
     * an authored palette — edited here or imported with a level — is the
     * palette (0 = not offered); without one every registered type is
     * offered (the #63 sandbox posture).
     * @param {string} type
     * @returns {boolean}
     * @private
     */
    _paletteOffers(type) {
        if (this._authoredPalette) return (this._authoredPalette[type] || 0) > 0;
        return objectRegistry.has(type);
    }

    // ── Bug file recorder (ADR 0006) ──────────────

    /** Always-on recorder: export the current sandbox session as a JSON download. */
    _exportBugFile() {
        if (this._bugNotesInput) sessionRecorder.notes = this._bugNotesInput.value;
        const { filename, json } = sessionRecorder.exportSession();
        downloadJson(json, filename);
        console.log('[EditorPanel] Bug file exported:', filename);
        this._updateBugStatus();
    }

    /** Export a session recovered from the crash mirror (if one is stashed). */
    _recoverBugFile() {
        const recovered = sessionRecorder.exportCrashedSession();
        if (!recovered) return;
        downloadJson(recovered.json, recovered.filename);
        console.log('[EditorPanel] Recovered session exported:', recovered.filename);
        this._updateBugStatus();
    }

    /** Refresh the recording status line + recovery button visibility. */
    _updateBugStatus() {
        if (!this._built) return;
        const st = sessionRecorder.status();
        if (this._bugStatusLine) {
            const runPart = st.runs.length > 0
                ? st.runs.map((r) => `#⁠${r.index + 1} ${r.ticks}t/${r.events}ev`).join(', ')
                : 'no runs yet';
            this._bugStatusLine.textContent = st.active
                ? `recording — ${st.buildEvents} build steps · ${runPart}`
                : 'not recording';
        }
        if (this._bugDenseCheck) this._bugDenseCheck.checked = st.dense;
        if (this._bugRecoverBtn) {
            this._bugRecoverBtn.style.display = st.crashedSession ? 'block' : 'none';
        }
    }

    _show() {
        this.container.classList.remove('hidden');
        // #editor-overlay is a sibling of #overlay-container in index.html: it
        // floats bottom-right instead of being a modal. LevelSelect/GoalOverlay
        // toggle the shared shell's `hidden` on every mode change, so any real
        // ancestry of this panel inside the shell would leave it unrenderable
        // whenever the shell is hidden (display:none ignores the child styles).
        this.container.style.display = 'block';
    }

    _hide() {
        this.container.classList.add('hidden');
        this.container.style.display = 'none';
    }

    _saveLevel() {
        const objects = dragDropManager.getObjects();
        const fixedObjects = [];
        const placedObjects = [];

        for (const obj of objects) {
            const data = obj.serialize();
            // Anchored parts are scene content (issue #67): Save keeps them
            // beside the pinned ones — their rows carry the `isAnchored`
            // marker and reload as player-immovable, play-dynamic parts.
            if (obj.isFixed || obj.isAnchored) {
                fixedObjects.push(data);
            } else {
                placedObjects.push(data);
            }
        }

        // Editor-save parity with the goal checker (issue #11): buckets
        // saved without a named id get the hard-coded goal zone id, so a
        // reloaded custom level's bucket matches goal.zoneId like official
        // level JSON does.
        stampGoalZoneIds(fixedObjects);

        // The goal the UI showed (issue #66): the same derivation the readout
        // prints — selected type; a loaded level's targetType/zoneId ride
        // along exactly while they still resolve on the board, so no saved
        // level can reference a zone that does not exist.
        const goal = this._computeSaveGoal(objects);

        const levelData = {
            id: `custom-${Date.now()}`,
            name: 'Custom Level',
            description: 'A custom puzzle created in the editor',
            difficulty: 1,
            goal,
            fixedObjects,
            availableParts: this._paletteForSave(),
            hints: [],
        };

        // Download as JSON
        const blob = new Blob([JSON.stringify(levelData, null, 4)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${levelData.id}.json`;
        a.click();
        URL.revokeObjectURL(url);

        console.log('[EditorPanel] Level saved');
    }

    _loadLevel() {
        this._fileInput.click();
    }

    _onFileSelected(e) {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (ev) => {
            try {
                const data = JSON.parse(ev.target.result);
                this._applyLoadedLevel(data);
                console.log('[EditorPanel] Level loaded:', data.name);
            } catch (err) {
                console.error('[EditorPanel] Failed to parse level JSON:', err);
            }
        };
        reader.readAsText(file);

        // Reset input so same file can be selected again
        this._fileInput.value = '';
    }

    _applyLoadedLevel(data) {
        // Create fixed objects from level data
        const objects = [];

        if (data.fixedObjects) {
            for (const objData of data.fixedObjects) {
                try {
                    // The shared rebuild-row rule (issue #67): legacy rows are
                    // forced-fixed scenery; anchored rows load play-dynamic
                    // but player-immovable, with their anchor marker applied.
                    const obj = objectRegistry.create(objData.type, objData.x, objData.y, levelObjectOptions(objData));
                    objects.push(obj);
                } catch (err) {
                    console.warn(`[EditorPanel] Could not create object: ${objData.type}`, err);
                }
            }
        }

        dragDropManager.setObjects(objects);

        // Route through LevelManager, not a direct bus emit (ADR 0003): the
        // imported data becomes _currentLevel, so reset (_resetLevel →
        // getCurrentLevel) and goal progression observe it, and
        // 'level:loaded' still reaches the toolbox/goal-checker listeners.
        levelManager.loadCustom(data);

        // Issue #66: reflect the loaded goal immediately — the select
        // displays the loaded type (imported unimplemented types become
        // disabled options, never silent choices) and the readout switches
        // to the live goal.
        this._loadedGoal = data.goal ?? null;
        // Issue #69: the imported palette becomes the authored palette —
        // normalized so absent rows read as 0 (nothing placeable), the
        // toolbox constrains to exactly what the level carries, the rows
        // display it and the next Save Level writes it back (round-trip).
        this._authoredPalette = this._normalizeLoadedPalette(data.availableParts);
        toolbox.setPalette({ ...this._authoredPalette });
        this._loadedLevelName = data.name ?? data.id ?? 'loaded level';
        if (this._goalSelect) {
            this._rebuildGoalOptions(data.goal?.type ?? ZONE_GOAL_TYPE);
        }
        this._updateGoalReadout();
        this._syncPaletteControls();
        this._updatePaletteReadout();
    }

    /**
     * The palette JSON Save Level writes (issue #69): the authored palette
     * when one is — every registered type explicitly, exclusions as 0, so
     * the saved file states exactly what the editor showed — or today's
     * default palette (every registered type ×10) while nothing is
     * authored.
     * @returns {Object<string, number>}
     * @private
     */
    _paletteForSave() {
        return this._authoredPalette ? { ...this._authoredPalette } : this._inferAvailableParts();
    }

    /**
     * Canonical palette from imported level JSON (issue #69): every
     * registered type present with a finite non-negative integer — an
     * absent row reads as 0, matching the player toolbox (and the editor
     * rows) that treat an absent part as un-placeable. Unregistered scalar
     * entries ride along untouched so hand-authored level JSON keeps its
     * round-trip fidelity (such types simply cannot be dragged).
     * @param {object|undefined} parts - the level's availableParts
     * @returns {Object<string, number>}
     * @private
     */
    _normalizeLoadedPalette(parts) {
        const palette = {};
        const registered = new Set(objectRegistry.getAll().map((item) => item.type));
        for (const type of registered) {
            const raw = Number(parts?.[type] || 0);
            palette[type] = Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
        }
        for (const [type, value] of Object.entries(parts || {})) {
            if (registered.has(type)) continue;
            if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
                palette[type] = Math.floor(value);
            }
        }
        return palette;
    }

    _inferAvailableParts() {
        // In sandbox mode, list all known types with generous quantities
        const parts = {};
        const allTypes = objectRegistry.getAll();
        for (const { type } of allTypes) {
            parts[type] = DEFAULT_PALETTE_COUNT;
        }
        return parts;
    }
}

/** Singleton editor panel instance */
export const editorPanel = new EditorPanel();
export default EditorPanel;
