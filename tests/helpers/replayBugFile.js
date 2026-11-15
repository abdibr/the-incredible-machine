/**
 * replayBugFile test helper — vitest-facing wrapper around the replay core.
 * Graduated bug files live verbatim in tests/fixtures/bugfiles/ (ADR 0006
 * decision 13) and are loaded with loadBugFile(); a fixture that ever stops
 * replaying bit-exactly fails via assertBugFileReplaysExactly(). Working
 * copies exported from the browser belong in gitignored .scratch/bugfiles/.
 */
import { readFileSync } from 'node:fs';

import { replayBugFile, replayRun } from '../../js/recorder/replay.js';

// Both the harness re-exports and the local bindings the assert uses —
// a bare `export { x } from` re-export creates no local binding, which
// silently broke assertBugFileReplaysExactly until the ufzs fixture
// exercised it (issue #93).
export { replayBugFile, replayRun };

/**
 * Load a bug file from a path, or pass an in-memory document through.
 * @param {string|object} pathOrDoc
 * @returns {object} the bug-file document
 */
export function loadBugFile(pathOrDoc) {
    if (typeof pathOrDoc === 'string') {
        return JSON.parse(readFileSync(pathOrDoc, 'utf8'));
    }
    return pathOrDoc;
}

/**
 * Assert that a bug file replays exactly (all runs, or per options).
 * Throws with the divergence details on any mismatch.
 * @param {string|object} pathOrDoc
 * @param {object} [options] — forwarded to replayBugFile (runIndex, untilTick)
 * @returns {object} the replay report
 */
export function assertBugFileReplaysExactly(pathOrDoc, options = {}) {
    const file = loadBugFile(pathOrDoc);
    const result = replayBugFile(file, options);
    if (!result.ok || result.runReports.some((r) => r.divergence)) {
        const lines = ['bug file did not replay bit-exactly:'];
        if (result.summary) lines.push(...result.summary);
        for (const r of result.runReports) {
            if (r.divergence) {
                lines.push(`  recorded: ${JSON.stringify(r.divergence.recorded ?? r.divergence)}`);
                lines.push(`  replayed: ${JSON.stringify(r.divergence.replayed ?? null)}`);
            }
        }
        throw new Error(lines.join('\n'));
    }
    return result;
}