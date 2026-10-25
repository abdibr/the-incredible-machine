/**
 * PalettePanel — the parts palette (issue #69) as its own floating panel.
 *
 * Split out of EditorPanel: authoring the palette — per registered part an
 * include checkbox and a count — is its own concern, so it gets its own
 * panel with its own header, floating top-right under the control bar. The
 * header row has the same window chrome the editor panel has (sandbox
 * usability report): a ➖/➕ toggle that collapses the panel to the title
 * bar and restores it, and a drag handle that parks the panel anywhere on
 * screen (clamped to the viewport). The chrome is the shared PanelChrome
 * (js/ui/PanelChrome.js) — one implementation both panels build through,
 * no editor-panel copy. Both states persist across sandbox
 * visits of the session, and the editor panel stays separate from it.
 *
 * Palette honesty (issue #69): per registered part a row offers an include
 * checkbox and a count. Nothing authored keeps the unauthored sandbox
 * posture (#63) — the toolbox is ∞ and Save Level writes the default
 * palette (every type ×10); any row edit authors exactly the displayed
 * posture, the toolbox constrains to it (placed parts consume, excluded
 * types cannot be placed), and Save Level writes it verbatim so loading
 * the file round-trips it exactly.
 *
 * Lifecycle (SANDBOX-only, like EditorPanel): every SANDBOX entry resets to
 * the unauthored posture (∞ everything — #63); leaving the mode releases
 * the toolbox to the live inventory — the constrained counts are an
 * authoring affordance, issues #69/#70 — and the authored palette is not
 * carried across visits.
 *
 * Cross-panel contract: EditorPanel delegates the palette-shaped questions
 * to this panel — what Save Level writes (paletteForSave), what a loaded
 * level installs (install + normalizeLoaded), what the live session offers
 * (offers) — and refreshes its goal readout on the `palette:changed` event
 * this panel emits whenever the installed palette changes, so the
 * anchored-scenery note (issue #67) can never claim a type the palette
 * excludes.
 */

import { eventBus } from '../EventBus.js';
import { objectRegistry } from '../objects/ObjectRegistry.js';
import { PanelChrome } from './PanelChrome.js';
import { toolbox } from './Toolbox.js';

/**
 * The default per-type palette count (issue #69): what an untweaked editor
 * session has always written into saved levels (the sandbox posture — enough
 * for a generous build) and the count a re-included palette row returns to.
 */
const DEFAULT_PALETTE_COUNT = 10;

class PalettePanel {
    constructor() {
        /** @type {HTMLElement} */
        this.container = null;

        /** Current mode */
        this._mode = 'MENU';

        /** Whether the panel is built */
        this._built = false;

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

        /**
         * Shared floating-panel window chrome (js/ui/PanelChrome.js): the
         * header row + ➖/➕ toggle, the body wrapper minimizing hides, the
         * minimize state and the header drag. Built once in _build().
         * @type {PanelChrome|null}
         */
        this._chrome = null;

        /** @type {HTMLElement|null} body wrapper hidden while minimized */
        this._panelBody = null;
    }

    /**
     * Minimize-state mirror for singleton resets (tests/editor-palette.test.js
     * and tests/anchored-part.test.js reset the module singleton between
     * boots): reads and writes the built chrome's minimized state — the
     * chrome (js/ui/PanelChrome.js) owns it. With no chrome built yet
     * (panel not booted) both directions no-op.
     * @returns {boolean}
     */
    get _minimized() {
        return this._chrome ? this._chrome.minimized : false;
    }

    set _minimized(value) {
        if (this._chrome) this._chrome.setMinimized(!!value);
    }

    /**
     * Initialize the palette panel.
     */
    init() {
        this.container = document.getElementById('palette-overlay');

        if (!this.container) {
            console.error('[PalettePanel] #palette-overlay not found');
            return;
        }

        // Show/hide based on mode — a SANDBOX-only float, in its own element
        // next to the editor overlay.
        eventBus.on('mode:changed', ({ newMode }) => {
            this._mode = newMode;
            if (newMode === 'SANDBOX') {
                this._build();
                this._show();
                // A fresh sandbox visit is palette-less too (issue #69): the
                // ∞-everything toolbox posture returns, the rows display the
                // default values again and Save Level goes back to writing
                // the default palette until rows are edited or a level loads.
                this._authoredPalette = null;
                toolbox.setPalette(null);
                this._syncPaletteControls();
                this._updatePaletteReadout();
                // The editor's readouts answer to this palette (issue #67
                // anchored-scenery note); announce the reset.
                eventBus.emit('palette:changed', { palette: null });
            } else {
                this._hide();
                // Leaving the editor releases the toolbox (issue #69): the
                // constrained counts are an authoring affordance. Outside the
                // editor the live inventory answers again; a fresh SANDBOX
                // visit is unauthored (∞) again (issues #69/#70).
                toolbox.setPalette(null);
            }
        });

        console.log('[PalettePanel] Initialized');
    }

    // ── Palette data API (consumed by EditorPanel) ──────────────

    /**
     * The installed palette snapshot the editor may read back (issue #69),
     * or null while the unauthored sandbox posture is live.
     * @returns {Object<string, number>|null}
     */
    getPalette() {
        return this._authoredPalette ? { ...this._authoredPalette } : null;
    }

    /**
     * Install a normalized palette as the authored one (the load path,
     * issue #69): the toolbox constrains to exactly what the level carries,
     * the rows display it and the next Save Level writes it back
     * (round-trip).
     * @param {Object<string, number>|null} palette
     */
    install(palette) {
        this._authoredPalette = palette ? { ...palette } : null;
        toolbox.setPalette(this._authoredPalette ? { ...this._authoredPalette } : null);
        this._syncPaletteControls();
        this._updatePaletteReadout();
        eventBus.emit('palette:changed', { palette: this.getPalette() });
    }

    /**
     * Whether the palette offers `type` in the live session (issues #67/#69):
     * an authored palette — edited here or imported with a level — is the
     * palette (0 = not offered); without one every registered type is
     * offered (the #63 sandbox posture).
     * @param {string} type
     * @returns {boolean}
     */
    offers(type) {
        if (this._authoredPalette) return (this._authoredPalette[type] || 0) > 0;
        return objectRegistry.has(type);
    }

    /**
     * The palette JSON Save Level writes (issue #69): the authored palette
     * when one is — every registered type explicitly, exclusions as 0, so
     * the saved file states exactly what the editor showed — or today's
     * default palette (every registered type ×10) while nothing is
     * authored. EditorPanel delegates here, so the download and the panel's
     * readout can never drift.
     * @returns {Object<string, number>}
     */
    paletteForSave() {
        if (this._authoredPalette) return { ...this._authoredPalette };
        const parts = {};
        for (const { type } of objectRegistry.getAll()) {
            parts[type] = DEFAULT_PALETTE_COUNT;
        }
        return parts;
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
     */
    normalizeLoaded(parts) {
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

    // ── Private ──────────────────────────────────

    _build() {
        if (this._built) return;
        this._built = true;

        this.container.innerHTML = '';
        this.container.style.cssText = `
            position: fixed;
            top: 72px;
            right: 16px;
            z-index: 50;
            background: rgba(128, 128, 160, 0.95);
            border: 3px solid #404040;
            border-radius: 8px;
            padding: 12px;
            min-width: 240px;
            color: #f0f0f0;
            font-size: 13px;
            box-shadow: 3px 3px 0 rgba(0,0,0,0.3);
            text-align: left;
        `;

        // Shared floating-panel window chrome (js/ui/PanelChrome.js) — the
        // same header/toggle/body/drag chrome the editor panel wears. Start
        // minimized (sandbox usability report, issue #69): the palette is
        // maximized on demand from the header's ➕ — the compact title bar
        // parks in the top-right corner beside the bottom-right editor panel
        // instead of both tall floats covering the play field.
        this._chrome = new PanelChrome(this.container, {
            title: '🎨 Parts Palette',
            titleStyle: 'margin: 0; font-family: Georgia, serif; font-size: 16px; color: #ffd700;',
            expandedPadding: '12px',
            initialMinimized: true,
        });
        this._panelBody = this._chrome.body;

        // Parts palette (issue #69): per registered type an include checkbox
        // and a count. Nothing authored keeps the ∞-everything sandbox
        // posture (#63) and Save Level writes the default palette; any row
        // edit authors the palette the editor displays — the toolbox then
        // offers exactly those counts (placed parts consume them, excluded
        // types cannot be placed) and Save Level writes them verbatim.
        const paletteLabel = document.createElement('label');
        paletteLabel.textContent = 'Toolbox inventory per part:';
        paletteLabel.style.cssText = 'display: block; margin-bottom: 4px; font-weight: bold;';
        this._panelBody.appendChild(paletteLabel);

        // Posture readout: says whether the palette is still the unlimited
        // default and what Save Level will write — the same palette the
        // editor's save uses (paletteForSave), so the message cannot drift
        // from the download.
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
    }

    // ── Palette authoring (issue #69) ──────────────

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
        // The editor's readouts answer to this palette (issue #67
        // anchored-scenery note); announce the change.
        eventBus.emit('palette:changed', { palette: this.getPalette() });
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
        eventBus.emit('palette:changed', { palette: null });
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

    /** Plain-language posture line for the palette panel (issue #69). */
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

    _show() {
        this.container.classList.remove('hidden');
        // #palette-overlay is a sibling of #overlay-container in index.html
        // (same rationale as #editor-overlay): it floats top-right instead of
        // being a modal. LevelSelect/GoalOverlay toggle the shared shell's
        // `hidden` on every mode change, so any real ancestry of this panel
        // inside the shell would leave it unrenderable whenever the shell is
        // hidden (display:none ignores the child styles).
        this.container.style.display = 'block';
    }

    _hide() {
        this.container.classList.add('hidden');
        this.container.style.display = 'none';
    }
}

/** Singleton palette panel instance */
export const palettePanel = new PalettePanel();
export default PalettePanel;