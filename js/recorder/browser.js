/**
 * recorder/browser — browser-only shims for the session recorder.
 *
 * The recorder core (SessionRecorder, replay) is DOM-free so Node harnesses
 * and vitest can use it; anything touching window/localStorage/download
 * lives here and is imported only by UI wiring (main.js / EditorPanel).
 */
import { MIRROR_KEY } from './schema.js';

/** localStorage adapter in the shape SessionRecorder expects. */
export function localMirrorStore() {
    let store = null;
    try {
        store = globalThis.localStorage ?? null;
        const probe = `${MIRROR_KEY}-probe`;
        store.setItem(probe, '1');
        store.removeItem(probe);
    } catch (e) {
        return null; // storage unavailable (private mode / disabled)
    }
    return {
        get: (key) => store.getItem(key),
        set: (key, value) => {
            try {
                store.setItem(key, value);
            } catch (e) {
                // Quota errors: keep recording in memory, mirror silently off.
                console.warn('[BugFile] mirror write failed:', e);
            }
        },
        remove: (key) => store.removeItem(key),
    };
}

/** Trigger a browser download for the given JSON payload. */
export function downloadJson(json, filename) {
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}