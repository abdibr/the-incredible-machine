#!/usr/bin/env node
/**
 * docker-demo - executable documentation + acceptance for ticket #47
 * ("Agent P2 2/6: Docker image for the headless turn service").
 *
 * The default branch is deliberately markdown-free, so THIS SCRIPT is the
 * documented command sequence: build the image, audit its filesystem, run
 * it with a published port, and beat level-01 from the host through the
 * HTTP turn boundary using ONLY place + trial calls.
 *
 * Manual sequence (what the script below does, host side):
 *
 *   1. docker build -t tim-turn-service .
 *      -> lean node:24-alpine image; the build context whitelist
 *         (.dockerignore) plus the Dockerfile COPY lines admit ONLY the
 *         production set - js/, agent/, package.json, package-lock.json -
 *         so tests/, docs/, scripts/, resources/, css/, index.html, *.md
 *         and scratch artifacts never reach the image, and no browser /
 *         Chromium / graphics system is installed (single runtime dep:
 *         matter-js via npm ci --omit=dev).
 *
 *   2. docker run --rm --entrypoint node tim-turn-service -e "<audit>"
 *      -> the image fs self-audit (--entrypoint node beats the service ENTRYPOINT): /app holds exactly
 *         agent/ js/ node_modules/ package.json package-lock.json, and
 *         node_modules holds exactly matter-js. Any stray file fails loudly.
 *
 *   3. docker run -d --name tim-turn-demo -p 8787:8787 -e TIM_TURN_PORT=8787 tim-turn-service
 *      -> the service listens INSIDE the container on 0.0.0.0:$TIM_TURN_PORT
 *         (port configurable via env, see Dockerfile); this step publishes
 *         container 8787 on host 8787.
 *
 *   4. curl -X POST http://127.0.0.1:8787/turn -H "Content-Type: application/json" \
 *           -d '{"action":"place","type":"ball","x":700,"y":500}'
 *      -> 200 { observation, result: { ok: true, ..., budgetLeft: 0 } }
 *         the response body carries the post-action observation read-back
 *         (level header, grid, legend, state table...).
 *
 *   5. curl -X POST http://127.0.0.1:8787/turn ... \
 *           -d '{"action":"trial","seconds":5}'
 *      -> 200 { observation, result: { outcome: "reached", ... } }
 *         the known level-01 win - place(ball, 700, 500) drops the ball
 *         straight into the bucket-goal at (700, 480); 1 placement, 1 trial,
 *         the ramp part stays unused. Driven entirely through the container
 *         with place + trial calls only.
 *
 *   6. docker rm -f tim-turn-demo
 *
 * No compose file (orchestration is the #49 end-to-end ticket's job) and no
 * markdown docs (the branch is markdown-free): this header plus the run log
 * reproduce build -> run -> win.
 *
 * To also see the env-configurable port MOVE the listener, boot a manual
 * container on a non-default container port:
 *   docker run -d --rm --name tim-turn-port -p 8788:9800 -e TIM_TURN_PORT=9800 tim-turn-service
 *   curl.exe http://127.0.0.1:8788/health     -> {"ok":true,"level":"level-01"}
 *   docker rm -f tim-turn-port
 * Seeded determinism (#46) flows straight through as well:
 *   -e TIM_AGENT_SEED=<seed>   (read by AgentSession inside the container)
 *
 * Usage:
 *   node scripts/docker-demo.mjs              build -> audit -> run -> win -> cleanup
 *   node scripts/docker-demo.mjs --keep       leave the container up for manual curl
 *   node scripts/docker-demo.mjs --audit-only build + image fs audit, no service
 *
 * Overrides: TIM_DEMO_PORT (host port in step 3, default 8787).
 */

import { execFileSync, spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const IMAGE = 'tim-turn-service';
const CONTAINER = 'tim-turn-demo';
const CONTAINER_PORT = 8787;
const HOST_PORT = Number(process.env.TIM_DEMO_PORT ?? CONTAINER_PORT);
const BASE_URL = `http://127.0.0.1:${HOST_PORT}`;
const AUDIT_ONLY = process.argv.includes('--audit-only');
const KEEP = process.argv.includes('--keep');

/**
 * One-line image filesystem audit (single argv - no host shell involved).
 * Asserts /app is exactly the production set, so anything docs/test-ish is
 * ABSENT by construction and any stray file fails loudly.
 */
const AUDIT_JS = [
    "const fs=require('fs')",
    "const root='/app'",
    "const bad=[]",
    "const want=['agent','js','node_modules','package-lock.json','package.json'].sort().join(',')",
    "const top=fs.readdirSync(root).sort().join(',')",
    "if(top!==want) bad.push('unexpected /app top-level: '+top)",
    "const have=['agent/server.js','agent/turn.js','js/EventBus.js','js/levels/puzzles/level-01.json','node_modules/matter-js/package.json']",
    "for(const p of have) if(!fs.existsSync(root+'/'+p)) bad.push('missing '+p)",
    "const mdfiles=fs.readdirSync(root,{recursive:true}).filter(p=>p.endsWith('.md'))",
    "if(mdfiles.length) bad.push('*.md files in image: '+mdfiles.join(','))",
    "const nm=fs.readdirSync(root+'/node_modules').filter(f=>f!=='.package-lock.json'&&f!=='.bin').join(',')",
    "if(nm!=='matter-js') bad.push('unexpected node_modules entries: '+nm)",
    "if(bad.length){console.error('AUDIT FAIL\\n'+bad.join('\\n'));process.exit(1)}",
    "console.log('AUDIT OK: /app='+top+'; zero *.md anywhere; node_modules=matter-js only (one runtime dep, no browser/graphics)')",
].join(';');

function docker(args, { capture = false } = {}) {
    if (capture) {
        const r = execFileSync('docker', args, { encoding: 'utf8' });
        return r.replace(/\r?\n+$/, '');
    }
    const r = spawnSync('docker', args, { stdio: 'inherit' });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(`docker ${args.join(' ')} exited ${r.status}`);
    return null;
}

function dockerQuiet(args) {
    try {
        execFileSync('docker', args, { stdio: 'ignore' });
    } catch {
        // best-effort cleanup - a missing container/image is not an error
    }
}

async function main() {
    console.log(`[demo] 1. build: docker build -t ${IMAGE} <repo root>`);
    docker(['build', '-t', IMAGE, REPO_ROOT]);

    console.log('[demo] 2. image fs audit: docker run --rm --entrypoint node <image> -e "<audit>"');
    docker(['run', '--rm', '--entrypoint', 'node', IMAGE, '-e', AUDIT_JS]);

    if (AUDIT_ONLY) {
        console.log(`[demo] AUDIT-ONLY PASS: ${IMAGE} is production-only - build -> audit done.`);
        return;
    }

    console.log(`[demo] 3. run: docker run -d --name ${CONTAINER} -p ${HOST_PORT}:${CONTAINER_PORT} -e TIM_TURN_PORT=${CONTAINER_PORT} ${IMAGE}`);
    dockerQuiet(['rm', '-f', CONTAINER]);
    docker(['run', '-d', '--name', CONTAINER, '-p', `${HOST_PORT}:${CONTAINER_PORT}`, '-e', `TIM_TURN_PORT=${CONTAINER_PORT}`, IMAGE]);

    console.log(`[demo] 4. wait for health: GET ${BASE_URL}/health`);
    if (await health()) {
        console.log('[demo]    -> {"ok":true} - the published port serves the turn service');
    }

    console.log('[demo] 5. place through the container (POST /turn): {"action":"place","type":"ball","x":700,"y":500}');
    const placed = await turn({ action: 'place', type: 'ball', x: 700, y: 500 });
    if (placed.status !== 200 || placed.body.result?.ok !== true) {
        fail(`place turn failed: HTTP ${placed.status} ${JSON.stringify(placed.body.result ?? placed.body)}`);
    }
    if (!String(placed.body.observation).includes('level-01')) {
        fail(`place observation read-back is not a level-01 observation: ${JSON.stringify(String(placed.body.observation).slice(0, 120))}`);
    }
    console.log(`[demo]    -> 200 ok; budgetLeft=${placed.body.result.budgetLeft}; observation read-back (extract):`);
    console.log(excerpt(placed.body.observation, 8));

    console.log('[demo] 6. win through the container (POST /turn): {"action":"trial","seconds":5}');
    const won = await turn({ action: 'trial', seconds: 5 });
    if (won.status !== 200 || won.body.result?.outcome !== 'reached') {
        fail(`trial did not reach the goal: HTTP ${won.status} result=${JSON.stringify(won.body.result ?? won.body)}`);
    }
    console.log(`[demo]    -> 200 outcome="reached" (elapsed=${won.body.result.elapsed}s); win narrative (extract):`);
    console.log(excerpt(String(won.body.observation), 6, true));

    if (KEEP) {
        console.log(`[demo] KEEP: ${CONTAINER} left running at ${BASE_URL}`);
        console.log(`[demo] manual curl: curl -X POST ${BASE_URL}/turn -H "Content-Type: application/json" -d '{"action":"trial","seconds":5}'`);
        console.log(`[demo] cleanup:      docker rm -f ${CONTAINER}`);
    } else {
        console.log(`[demo] 7. cleanup: docker rm -f ${CONTAINER}`);
        dockerQuiet(['rm', '-f', CONTAINER]);
    }
    console.log(`[demo] PASS: built ${IMAGE}, audited it production-only, published the port, and beat level-01 through the container with place + trial only.`);
}

/** Wait until /health answers {ok:true} (published port serving), ~60s budget. */
async function health() {
    const deadline = Date.now() + 60_000;
    for (;;) {
        try {
            const res = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(2000) });
            if (res.ok) {
                const body = await res.json();
                if (body.ok === true) return true;
            }
        } catch {
            // connection refused - container still booting; keep polling
        }
        if (Date.now() > deadline) fail('service never became healthy on the published port within 60s');
        await new Promise((r) => setTimeout(r, 300));
    }
}

/** POST /turn one action JSON; returns { status, body }. */
async function turn(actionJson) {
    const res = await fetch(`${BASE_URL}/turn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(actionJson),
    });
    const body = await res.json();
    return { status: res.status, body };
}

/** @param {string} text @param {number} lines @param {boolean} [tail] */
function excerpt(text, lines, tail = false) {
    const parts = String(text).split(/\r?\n/).filter(Boolean);
    const picked = tail ? parts.slice(-lines) : parts.slice(0, lines);
    return picked.map((l) => `    | ${l}`).join('\n');
}

/** Stop hard with a reason and a clean container state. */
function fail(reason) {
    console.error(`[demo] FAIL: ${reason}`);
    if (!KEEP) dockerQuiet(['rm', '-f', CONTAINER]);
    process.exit(1);
}

main().catch((e) => {
    fail(e?.stack ?? String(e));
});
