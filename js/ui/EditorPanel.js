/**
 * EditorPanel — Sandbox / level editor controls
 *
 * Provides save/load level, set goal, set available parts,
 * and test functionality. Only visible in SANDBOX mode.
 */

import { eventBus } from '../EventBus.js';
import { levelManager } from '../levels/LevelManager.js';
import { objectRegistry } from '../objects/ObjectRegistry.js';
import { DEFAULT_GOAL_ZONE_ID, stampGoalZoneIds } from '../goals/GoalChecker.js';
import { dragDropManager } from './DragDropManager.js';
import { sessionRecorder } from '../recorder/SessionRecorder.js';
import { downloadJson } from '../recorder/browser.js';
import { setMode, AppMode } from '../main.js';

class EditorPanel {
    constructor() {
        /** @type {HTMLElement} */
        this.container = null;

        /** Current mode */
        this._mode = 'MENU';

        /** Whether the panel is built */
        this._built = false;
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
                this._updateBugStatus();
            } else {
                this._hide();
            }
        });

        // Recording status refresh on the events that change it (cheap poll)
        for (const topic of ['controls:play', 'controls:pause', 'controls:reset', 'object:placed', 'object:moved', 'object:removed']) {
            eventBus.on(topic, () => {
                if (this._mode === 'SANDBOX') {
                    this._updateBugStatus();
                }
            });
        }

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

        // Title
        const title = document.createElement('h3');
        title.textContent = '🔧 Editor';
        title.style.cssText = 'margin: 0 0 12px; font-family: Georgia, serif; font-size: 16px; color: #ffd700;';
        this.container.appendChild(title);

        // Save Level
        const saveBtn = document.createElement('button');
        saveBtn.className = 'btn btn-primary';
        saveBtn.textContent = '💾 Save Level';
        saveBtn.style.cssText = 'width: 100%; margin-bottom: 8px;';
        saveBtn.addEventListener('click', () => this._saveLevel());
        this.container.appendChild(saveBtn);

        // Load Level
        const loadBtn = document.createElement('button');
        loadBtn.className = 'btn btn-primary';
        loadBtn.textContent = '📂 Load Level';
        loadBtn.style.cssText = 'width: 100%; margin-bottom: 8px;';
        loadBtn.addEventListener('click', () => this._loadLevel());
        this.container.appendChild(loadBtn);

        // Hidden file input for loading
        this._fileInput = document.createElement('input');
        this._fileInput.type = 'file';
        this._fileInput.accept = '.json';
        this._fileInput.style.display = 'none';
        this._fileInput.addEventListener('change', (e) => this._onFileSelected(e));
        this.container.appendChild(this._fileInput);

        // Separator
        this.container.appendChild(this._makeSep());

        // Goal type
        const goalLabel = document.createElement('label');
        goalLabel.textContent = 'Goal Type:';
        goalLabel.style.cssText = 'display: block; margin-bottom: 4px; font-weight: bold;';
        this.container.appendChild(goalLabel);

        this._goalSelect = document.createElement('select');
        this._goalSelect.style.cssText = 'width: 100%; padding: 4px; margin-bottom: 8px; border-radius: 4px; border: 1px solid #404040;';
        const goalTypes = [
            'object_in_zone',
            'pop_all_balloons',
            'chain_complete',
            'mouse_in_zone',
            'custom',
        ];
        for (const gt of goalTypes) {
            const opt = document.createElement('option');
            opt.value = gt;
            opt.textContent = gt.replace(/_/g, ' ');
            this._goalSelect.appendChild(opt);
        }
        this.container.appendChild(this._goalSelect);

        this.container.appendChild(this._makeSep());

        // Test button
        const testBtn = document.createElement('button');
        testBtn.className = 'btn btn-success';
        testBtn.textContent = '▶ Test Puzzle';
        testBtn.style.cssText = 'width: 100%; margin-bottom: 8px;';
        testBtn.addEventListener('click', () => {
            eventBus.emit('controls:play');
        });
        this.container.appendChild(testBtn);

        // Back to menu
        const menuBtn = document.createElement('button');
        menuBtn.className = 'btn btn-primary';
        menuBtn.textContent = '📋 Back to Menu';
        menuBtn.style.cssText = 'width: 100%;';
        menuBtn.addEventListener('click', () => {
            eventBus.emit('overlay:menu');
        });
        this.container.appendChild(menuBtn);

        // ── Bug file recorder (ADR 0006) ──
        this.container.appendChild(this._makeSep());

        const bugLabel = document.createElement('label');
        bugLabel.textContent = '🐞 Bug File';
        bugLabel.style.cssText = 'display: block; margin-bottom: 4px; font-weight: bold;';
        this.container.appendChild(bugLabel);

        this._bugStatusLine = document.createElement('div');
        this._bugStatusLine.style.cssText = 'opacity: 0.85; font-size: 12px; margin-bottom: 4px;';
        this.container.appendChild(this._bugStatusLine);

        this._bugNotesInput = document.createElement('input');
        this._bugNotesInput.type = 'text';
        this._bugNotesInput.placeholder = 'What went wrong? (goes in the file)';
        this._bugNotesInput.style.cssText = 'width: 100%; padding: 4px; margin-bottom: 4px; border-radius: 4px; border: 1px solid #404040; box-sizing: border-box;';
        this._bugNotesInput.addEventListener('input', () => {
            sessionRecorder.notes = this._bugNotesInput.value;
        });
        this.container.appendChild(this._bugNotesInput);

        const denseLabel = document.createElement('label');
        denseLabel.style.cssText = 'display: block; margin-bottom: 4px;';
        this._bugDenseCheck = document.createElement('input');
        this._bugDenseCheck.type = 'checkbox';
        this._bugDenseCheck.addEventListener('change', () => {
            sessionRecorder.dense = this._bugDenseCheck.checked;
        });
        denseLabel.appendChild(this._bugDenseCheck);
        denseLabel.appendChild(document.createTextNode(' dense sampling (60 Hz, big file)'));
        this.container.appendChild(denseLabel);

        const bugExportBtn = document.createElement('button');
        bugExportBtn.className = 'btn btn-success';
        bugExportBtn.textContent = '💾 Export Bug File';
        bugExportBtn.style.cssText = 'width: 100%; margin-bottom: 4px;';
        bugExportBtn.addEventListener('click', () => this._exportBugFile());
        this.container.appendChild(bugExportBtn);

        this._bugRecoverBtn = document.createElement('button');
        this._bugRecoverBtn.className = 'btn btn-primary';
        this._bugRecoverBtn.textContent = '🩹 Recover crashed session';
        this._bugRecoverBtn.style.cssText = 'width: 100%; display: none;';
        this._bugRecoverBtn.addEventListener('click', () => this._recoverBugFile());
        this.container.appendChild(this._bugRecoverBtn);
    }

    _makeSep() {
        const hr = document.createElement('hr');
        hr.style.cssText = 'border: none; border-top: 1px solid rgba(255,255,255,0.2); margin: 8px 0;';
        return hr;
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
        // Editor panel floats independently (not in overlay-container)
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
            if (obj.isFixed) {
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

        const levelData = {
            id: `custom-${Date.now()}`,
            name: 'Custom Level',
            description: 'A custom puzzle created in the editor',
            difficulty: 1,
            goal: {
                type: this._goalSelect ? this._goalSelect.value : 'object_in_zone',
                targetType: 'ball',
                zoneId: DEFAULT_GOAL_ZONE_ID,
            },
            fixedObjects,
            availableParts: this._inferAvailableParts(),
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
                    const obj = objectRegistry.create(objData.type, objData.x, objData.y, {
                        angle: objData.angle,
                        isFixed: true,
                        customId: objData.id, // same convention as main.js _setupLevel
                    });
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
    }

    _inferAvailableParts() {
        // In sandbox mode, list all known types with generous quantities
        const parts = {};
        const allTypes = objectRegistry.getAll();
        for (const { type } of allTypes) {
            parts[type] = 10;
        }
        return parts;
    }
}

/** Singleton editor panel instance */
export const editorPanel = new EditorPanel();
export default EditorPanel;
