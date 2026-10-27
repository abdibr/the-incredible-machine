/**
 * Toolbox — Left-side part inventory panel
 *
 * Populates the #toolbox DOM element with available parts grouped by
 * category. Each item shows a canvas icon, name, and quantity.
 * Emits drag-start events for the DragDropManager to pick up.
 *
 * Sandbox posture (issue #69): the unauthored sandbox offers every part
 * without limit (#63). Once the editor panel authors a palette — by editing
 * rows or loading a level — the sandbox behaves exactly like a player's edit
 * stage: placement consumes the authored counts, removal returns them, and a
 * type at 0 cannot be placed (same drag gate as the player path).
 */

import { eventBus } from '../EventBus.js';
import { objectRegistry } from '../objects/ObjectRegistry.js';

class Toolbox {
    constructor() {
        /** @type {HTMLElement} */
        this.container = null;

        /** Available parts inventory: { type: count } */
        this._inventory = {};

        /**
         * The authored sandbox palette (issue #69): when set, the sandbox
         * toolbox offers exactly these counts — placed parts consume them,
         * removed parts return them and a type at 0 is un-placeable. Null
         * keeps the unauthored sandbox posture (#63): every part unlimited.
         * Installed via setPalette() (editor panel edit / load / clear).
         * @type {Object<string, number>|null}
         */
        this._palette = null;

        /** Whether we're in sandbox mode (infinite parts) */
        this._isSandbox = false;

        /** Whether editing is allowed (disabled during play) */
        this._enabled = true;

        /** Current mode */
        this._mode = 'MENU';

        /** Map of type → DOM element for quick updates */
        this._itemElements = new Map();
    }

    /**
     * Initialize the toolbox panel.
     */
    init() {
        this.container = document.getElementById('toolbox-categories');
        if (!this.container) {
            console.error('[Toolbox] #toolbox-categories element not found');
            return;
        }

        // Listen for mode changes
        eventBus.on('mode:changed', ({ newMode }) => {
            this._mode = newMode;
            this._isSandbox = newMode === 'SANDBOX';
            this._enabled = (newMode === 'EDITING' || newMode === 'SANDBOX');
            this._updateAllItems();
        });

        // Listen for object placed / removed to update counts. The player
        // path tracks the level inventory; the sandbox tracks the authored
        // palette (issue #69) exactly like a player's edit stage — the
        // unauthored sandbox (∞ everything, #63) records nothing.
        eventBus.on('object:placed', ({ type }) => {
            const counts = this._liveCounts();
            if (counts && counts[type] !== undefined) {
                counts[type] = Math.max(0, counts[type] - 1);
                this._updateItemCount(type);
            }
        });

        eventBus.on('object:removed', ({ type }) => {
            const counts = this._liveCounts();
            if (counts && counts[type] !== undefined) {
                counts[type]++;
                this._updateItemCount(type);
            }
        });

        // Listen for level loaded to set inventory
        eventBus.on('level:loaded', (levelData) => {
            this.setInventory(levelData.availableParts || {});
        });

        this._buildCategories();

        console.log('[Toolbox] Initialized');
    }

    /**
     * Set the parts inventory for the current level.
     * @param {Object<string, number>} parts - { type: quantity }
     */
    setInventory(parts) {
        this._inventory = { ...parts };
        this._updateAllItems();
    }

    /**
     * Install or release the sandbox palette (issue #69). The editor panel
     * drives this: an authored palette (edited rows or a loaded level's
     * availableParts) makes sandbox items behave like player items — gated,
     * counted, consumed and returned; null releases back to the
     * ∞-everything posture the unauthored sandbox keeps (#63).
     * @param {Object<string, number>|null} palette - type→count map or null
     */
    setPalette(palette) {
        this._palette = palette ? { ...palette } : null;
        this._updateAllItems();
    }

    /**
     * Get remaining count for a type.
     * @param {string} type
     * @returns {number|Infinity} Infinity in the unauthored sandbox (∞
     *          everything, #63), the authored palette's count thereafter
     *          (issue #69), or the level inventory count in player modes
     */
    getCount(type) {
        if (this._isSandbox) {
            if (!this._palette) return Infinity;
            return this._palette[type] || 0;
        }
        return this._inventory[type] || 0;
    }

    /**
     * The counts map the current posture consumes (issue #69): the authored
     * sandbox palette, the player's level inventory, or null — the
     * unauthored sandbox that records nothing.
     * @returns {Object<string, number>|null}
     * @private
     */
    _liveCounts() {
        if (this._isSandbox) return this._palette;
        return this._inventory;
    }

    // ── Private ──────────────────────────────────

    _buildCategories() {
        this.container.innerHTML = '';
        this._itemElements.clear();

        const categories = objectRegistry.getCategories();

        for (const category of categories) {
            const items = objectRegistry.getByCategory(category);
            if (items.length === 0) continue;

            // Category wrapper
            const catDiv = document.createElement('div');
            catDiv.className = 'toolbox-category';

            // Category title
            const title = document.createElement('div');
            title.className = 'toolbox-category-title';
            title.textContent = category;
            catDiv.appendChild(title);

            // Items
            for (const item of items) {
                const el = this._createItemElement(item);
                catDiv.appendChild(el);
                this._itemElements.set(item.type, el);
            }

            this.container.appendChild(catDiv);
        }
    }

    _createItemElement(item) {
        const div = document.createElement('div');
        div.className = 'toolbox-item';
        div.dataset.type = item.type;

        // Icon canvas
        const iconCanvas = document.createElement('canvas');
        iconCanvas.className = 'toolbox-item-icon';
        iconCanvas.width = 36;
        iconCanvas.height = 36;
        div.appendChild(iconCanvas);

        // Draw icon
        try {
            const tmpObj = objectRegistry.create(item.type, 0, 0);
            const iconCtx = iconCanvas.getContext('2d');
            tmpObj.drawToolboxIcon(iconCtx, 36, 36);
            tmpObj.dispose();
        } catch (e) {
            // Fallback — plain gray square is drawn by BaseObject default
        }

        // Name
        const name = document.createElement('span');
        name.className = 'toolbox-item-name';
        name.textContent = item.displayName || item.type;
        div.appendChild(name);

        // Count badge
        const count = document.createElement('span');
        count.className = 'toolbox-item-count';
        count.dataset.type = item.type;
        count.textContent = '—';
        div.appendChild(count);

        // Drag start via mousedown
        div.addEventListener('mousedown', (e) => {
            if (!this._enabled) return;

            const remaining = this.getCount(item.type);
            if (remaining <= 0) return;

            e.preventDefault();
            eventBus.emit('toolbox:drag-start', {
                type: item.type,
                pageX: e.pageX,
                pageY: e.pageY,
            });
        });

        // Tooltip
        if (item.description) {
            div.title = item.description;
        }

        return div;
    }

    _updateItemCount(type) {
        const el = this._itemElements.get(type);
        if (!el) return;

        const countEl = el.querySelector('.toolbox-item-count');
        if (!countEl) return;

        if (this._isSandbox) {
            if (!this._palette) {
                // Unauthored sandbox posture (#63): every part unlimited.
                countEl.textContent = '∞';
                el.classList.remove('disabled');
            } else {
                // Authored palette (issue #69): exact counts, gated at 0.
                const count = this._palette[type] || 0;
                countEl.textContent = count > 0 ? count : '0';
                el.classList.toggle('disabled', count <= 0);
            }
        } else {
            const count = this._inventory[type] || 0;
            countEl.textContent = count > 0 ? count : '0';
            el.classList.toggle('disabled', count <= 0);
        }
    }

    _updateAllItems() {
        for (const [type] of this._itemElements) {
            this._updateItemCount(type);
        }

        // Disable all items during play
        if (!this._enabled) {
            for (const [, el] of this._itemElements) {
                el.classList.add('disabled');
            }
        }
    }
}

/** Singleton toolbox instance */
export const toolbox = new Toolbox();
export default Toolbox;
