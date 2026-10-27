/**
 * recorder/meta — app identity for bug-file headers.
 *
 * Kept as plain constants on purpose: Node harnesses import the recorder
 * core directly, and a bare `import 'package.json'` needs import attributes
 * under Node (Vite/vitest alone would resolve it). Scripts that need the
 * version read package.json from disk with fs (scripts/replay-bugfile.mjs).
 * Keep in sync with package.json — bump both when the version bumps.
 */
export const APP_NAME = 'the-incredible-machine';
export const APP_VERSION = '1.0.0';

/** @returns {string} user agent, or '' outside a browser. */
export function userAgentString() {
    return (typeof navigator !== 'undefined' && navigator.userAgent) || '';
}