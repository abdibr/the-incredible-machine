/**
 * docker-demo-common - the shared helpers of scripts/docker-demo.mjs and
 * scripts/e2e-demo.mjs: the docker() / dockerQuiet() runners, the hard
 * stop (fail), the /health polling loop and the repo root. One copy of each
 * - sibling scripts that do the same build/run/poll/cleanup dance must not
 * drift apart by copy-paste. No markdown docs (the branch is markdown-free):
 * this header is the doc.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import process from 'node:process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repo root (this module lives at scripts/lib/) - where docker build runs. */
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Run docker with args. stdio inherits by default (the build/run steps are
 * for humans); `capture` returns trimmed stdout for value-carrying calls.
 * A non-zero exit throws - each demo stops hard on its own fail().
 */
export function docker(args, { capture = false } = {}) {
    if (capture) {
        const r = execFileSync('docker', args, { encoding: 'utf8' });
        return r.replace(/\r?\n+$/, '');
    }
    const r = spawnSync('docker', args, { stdio: 'inherit' });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(`docker ${args.join(' ')} exited ${r.status}`);
    return null;
}

/** Best-effort docker call: a missing container/image is NOT an error. */
export function dockerQuiet(args) {
    try {
        execFileSync('docker', args, { stdio: 'ignore' });
    } catch {
        // best-effort cleanup - a missing container/image is not an error
    }
}

/**
 * Stop hard with a reason: one FAIL line on stderr (the demo's own prefix),
 * the demo container removed (unless the run was --keep'ed), exit 1.
 * @param {{ prefix: string, container: string, keep: boolean }} ctx the demo's identity
 * @param {string} reason
 */
export function demoFail(ctx, reason) {
    console.error(`${ctx.prefix} FAIL: ${reason}`);
    if (!ctx.keep) dockerQuiet(['rm', '-f', ctx.container]);
    process.exit(1);
}

/**
 * Wait until GET <baseUrl>/health answers {"ok":true} (the published port
 * serves the turn service): ~60s budget, 2s per-fetch timeout, 300ms poll.
 * On the deadline `fail` stops its demo with the same message both scripts
 * have always shown.
 * @param {string} baseUrl
 * @param {(reason: string) => never} fail the demo's own fail()
 * @returns {Promise<{"ok": true, level: string}>} the health body
 */
export async function waitForHealth(baseUrl, fail) {
    const deadline = Date.now() + 60_000;
    for (;;) {
        try {
            const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
            if (res.ok) {
                const body = await res.json();
                if (body.ok === true) return body;
            }
        } catch {
            // connection refused - container still booting; keep polling
        }
        if (Date.now() > deadline) fail('service never became healthy on the published port within 60s');
        await new Promise((r) => setTimeout(r, 300));
    }
}