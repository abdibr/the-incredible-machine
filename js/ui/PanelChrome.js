/**
 * PanelChrome — the shared window chrome for the sandbox's floating panels.
 *
 * The floating panels wear the same title-bar chrome (sandbox usability
 * report): a header row with the panel title and a ➖/➕ toggle that
 * collapses the panel to the title bar and restores it, and a drag seam
 * that moves the whole panel (collapsed or expanded) anywhere on screen,
 * clamped to the viewport. EditorPanel (bottom-right) and PalettePanel
 * (top-right, issue #69) each build this once per session through here, so
 * the window behavior stays identical between the panels; both chrome
 * states — minimized and the dragged position — persist across sandbox
 * visits (_build runs once per session; no mode change resets them).
 *
 * The seams learned the hard way all live in this one implementation:
 *
 * - Build order is container = [header, body], and minimizing hides exactly
 *   one element (the body wrapper) so nothing can leak outside the body.
 *   The collapsed bar compacts ('8px 12px' padding, no min-width) but keeps
 *   its corner; the cheap event polls keep refreshing the hidden controls,
 *   so the next expand shows them current.
 * - Dragging excludes button targets (the ➖/➕ toggle stays a click
 *   affordance) and non-primary buttons. The first press re-anchors a
 *   right/bottom-anchored panel to a left/top pair at its standing visual
 *   position — the rect is read and left/top is set BEFORE clearing
 *   right/bottom: clearing the last anchor first drops a fixed panel onto
 *   its static position at (0, 0) mid-read (observed in Chrome), poisons
 *   the drag offset and teleports the whole drag to the corner.
 * - Moves clamp to the viewport minus the panel's own size, so the bar can
 *   never be parked off-screen; the document listeners are bound once in
 *   the constructor so pointerup removes exactly what pointerdown added.
 */

export class PanelChrome {
    /**
     * Build the chrome into the floating panel's container — the header row
     * (title + toggle), the body wrapper and the drag seam — then settle the
     * initial minimize state.
     *
     * @param {HTMLElement} container - the floating panel's container
     * @param {object} options
     * @param {string} options.title - header title text
     * @param {string} options.titleStyle - inline cssText for the title
     * @param {string} [options.expandedPadding] - container padding while
     *     expanded (the collapsed bar always compacts to '8px 12px')
     * @param {boolean} [options.initialMinimized] - collapse on build
     */
    constructor(container, { title, titleStyle, expandedPadding = '16px', initialMinimized = false }) {
        /** @type {HTMLElement} */
        this._container = container;

        /** Container padding while expanded; collapsed compacts to '8px 12px'. */
        this._expandedPadding = expandedPadding;

        /**
         * Minimize state: collapsed, the panel is only its header row so it
         * stops covering the play field.
         * @type {boolean}
         */
        this._minimized = false;

        /**
         * Active drag: the pointer-to-panel-top-left offset, captured on
         * header pointerdown (the ➖/➕ toggle excluded) and cleared on
         * pointerup / pointercancel.
         * @type {{dx: number, dy: number, pointerId: number|undefined}|null}
         */
        this._dragging = null;

        /**
         * Document-level drag listeners, bound once in the constructor so
         * pointerup can remove the exact functions pointerdown added.
         */
        this._onDragMove = this._dragMove.bind(this);
        this._onDragEnd = this._dragEnd.bind(this);

        // Header row: title + minimize/maximize toggle.
        const header = document.createElement('div');
        // grab cursor hints movability; user-select/touch-action keep a drag
        // from selecting title text or scrolling the page on touch.
        header.style.cssText = 'display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 0 0 8px; cursor: grab; user-select: none; touch-action: none;';
        header.title = 'Drag to move the panel';
        header.addEventListener('pointerdown', (e) => this._onHeaderPointerDown(e));
        container.appendChild(header);
        /** @type {HTMLElement} draggable header row (title + toggle). */
        this.headerRow = header;

        const titleEl = document.createElement('h3');
        titleEl.textContent = title;
        titleEl.style.cssText = titleStyle;
        header.appendChild(titleEl);

        /** @type {HTMLButtonElement} minimize/maximize toggle. */
        this.toggleBtn = document.createElement('button');
        this.toggleBtn.className = 'btn';
        this.toggleBtn.style.cssText = 'width: 28px; height: 28px; padding: 0; font-size: 13px; line-height: 1; flex: 0 0 auto;';
        this.toggleBtn.addEventListener('click', () => this.setMinimized(!this._minimized));
        header.appendChild(this.toggleBtn);

        // Body wrapper: the panel hangs every control below the header on
        // this (assigned out as `body`), so minimizing collapses the panel
        // by hiding exactly one element.
        /** @type {HTMLElement} body wrapper hidden while minimized. */
        this.body = document.createElement('div');
        container.appendChild(this.body);

        this.setMinimized(initialMinimized);
    }

    /** Whether the panel is currently collapsed to its header row. */
    get minimized() {
        return this._minimized;
    }

    /**
     * Minimize/maximize the panel: minimized, only the header row remains,
     * so the panel stops covering the play area. The body elements survive
     * the collapse — the cheap event poll keeps refreshing status/readout
     * on hidden nodes, so the next expand shows them current. The state
     * persists across sandbox visits: _build runs once per session and no
     * mode change resets it.
     * @param {boolean} minimized - true collapses to the header row
     */
    setMinimized(minimized) {
        this._minimized = !!minimized;
        if (this.body) {
            this.body.style.display = this._minimized ? 'none' : 'block';
        }
        if (this.toggleBtn) {
            // Window-chrome convention: ➖ collapses, ➕ restores.
            this.toggleBtn.textContent = this._minimized ? '➕' : '➖';
            this.toggleBtn.title = this._minimized ? 'Maximize panel' : 'Minimize panel';
        }
        // Compact chrome while minimized: hug the header row instead of the
        // full floating card.
        this._container.style.padding = this._minimized ? '8px 12px' : this._expandedPadding;
        this._container.style.minWidth = this._minimized ? '0' : '240px';
    }

    // ── Header drag — movable panel ──────────────────────────

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
        for (let node = e.target ?? null; node != null && node !== this.headerRow; node = node.parentNode) {
            if (node === this.toggleBtn) return;
        }

        const rect = this._container.getBoundingClientRect();
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
        this._container.style.left = `${rect.left}px`;
        this._container.style.top = `${rect.top}px`;
        this._container.style.right = '';
        this._container.style.bottom = '';
        if (this.headerRow) this.headerRow.style.cursor = 'grabbing';
        document.addEventListener('pointermove', this._onDragMove);
        document.addEventListener('pointerup', this._onDragEnd);
        document.addEventListener('pointercancel', this._onDragEnd);
    }

    /**
     * Drag tracking: reapply the clamped position for the current pointer.
     * @param {PointerEvent} e
     * @private
     */
    _dragMove(e) {
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
    _dragEnd() {
        if (!this._dragging) return;
        this._dragging = null;
        if (this.headerRow) this.headerRow.style.cursor = 'grab';
        document.removeEventListener('pointermove', this._onDragMove);
        document.removeEventListener('pointerup', this._onDragEnd);
        document.removeEventListener('pointercancel', this._onDragEnd);
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
        const rect = this._container.getBoundingClientRect();
        if (rect && window.innerWidth > 0) {
            left = Math.min(Math.max(0, left), Math.max(0, window.innerWidth - rect.width));
        }
        if (rect && window.innerHeight > 0) {
            top = Math.min(Math.max(0, top), Math.max(0, window.innerHeight - rect.height));
        }
        this._container.style.left = `${Math.round(left)}px`;
        this._container.style.top = `${Math.round(top)}px`;
    }
}

export default PanelChrome;