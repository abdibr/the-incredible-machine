#!/usr/bin/env node
/**
 * e2e-demo - executable documentation + acceptance for ticket #49
 * ("Agent P2 5/6: containerized end-to-end - LLM solves level-01 against
 * the container"). The default branch is deliberately markdown-free, so
 * THIS header is the run instructions.
 *
 * THE WHOLE PICTURE AS ONE COMMAND, FROM A CLEAN STATE:
 *
 *   1. clean:   remove the stale demo container AND the image (docker
 *               rm -f / rmi -f) so nothing pre-built is trusted
 *   2. build:   docker build -t tim-turn-service .   (image rebuilt from
 *               scratch: js/ + agent/ + manifests only, no tests/docs/)
 *   3. serve:   docker run -d --name tim-e2e-llm -p 8787:8787
 *               -e TIM_TURN_PORT=8787 ... ; wait for GET /health
 *   4. select:  POST /level {"level":"<level>"} on the published port -
 *               the level is selected against the service BY CONFIG
 *   5. drive:   spawn `node agent/driver.js --level <level> --transcript <path>`
 *               with TIM_AGENT_TURN_BASE_URL=http://127.0.0.1:8787 in the
 *               child env. The HOST-side LLM driver now plays the game
 *               that lives INSIDE the container: every tool turn is one
 *               POST /turn round-trip over the published port. Switching
 *               host-mode <-> container-mode is ENV-CONFIG ONLY (that one
 *               env var) - no code change, no rebuild of anything but the
 *               image.
 *   6. assert:  driver exit 0 <=> outcome "reached"; the transcript (with
 *               every round-trip) sits under gitignored .agent-transcripts/
 *   7. cleanup: docker rm -f tim-e2e-llm
 *
 * PROVIDER VARIANT: there is no OPENAI_API_KEY on the dev host, so the
 * run goes through TIM_AGENT_BASE_URL - e.g. the local Ollama daemon
 * (OpenAI-compatible) - which the ticket names as the supported
 * alternative-provider path. Example (PowerShell):
 *
 *   $env:TIM_AGENT_MODEL    = "devstral-small-2:latest"
 *   $env:TIM_AGENT_BASE_URL = "http://127.0.0.1:11434/v1"
 *   node scripts/e2e-demo.mjs
 *
 * ENV (all optional unless noted; secret values are NEVER printed):
 *   TIM_AGENT_MODEL       REQUIRED. Model name as the provider knows it
 *                         (e.g. devstral-small-2:latest on Ollama).
 *   TIM_AGENT_BASE_URL    OpenAI-compatible endpoint for the MODEL (e.g.
 *                         Ollama http://127.0.0.1:11434/v1). Unset -> SDK
 *                         default OpenAI, which needs OPENAI_API_KEY.
 *   OPENAI_API_KEY        optional; only ever seen by the driver process.
 *   TIM_AGENT_MAX_TURNS   optional hard driver-turn cap (default 20).
 *   TIM_AGENT_TRANSCRIPT  optional transcript path (default
 *                         .agent-transcripts/e2e-<level>-<stamp>.txt).
 *   TIM_AGENT_SEED        optional; forwarded INTO the container
 *                         (docker run -e TIM_AGENT_SEED=...) where
 *                         AgentSession (ticket #46) seeds the trials.
 *   TIM_E2E_PORT          optional published host port (default 8787).
 *   TIM_E2E_LEVEL         optional level (default level-01).
 *   TIM_E2E_IMAGE         optional image tag (default tim-turn-service).
 *   TIM_E2E_CONTAINER     optional container name (default tim-e2e-llm).
 *
 * Driver-side env contract: see the header of agent/driver.js (tickets
 * #48/#49); service-side: agent/server.js and the Dockerfile (tickets
 * #45/#47). Container-only quick-start without an LLM:
 * scripts/docker-demo.mjs.
 *
 * Usage:
 *   node scripts/e2e-demo.mjs            clean -> build -> run -> win -> cleanup
 *   node scripts/e2e-demo.mjs --keep     leave the container up for manual curl
 */

import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { REPO_ROOT, demoFail, docker, dockerQuiet, waitForHealth } from './lib/docker-demo-common.mjs';
const IMAGE = process.env.TIM_E2E_IMAGE ?? 'tim-turn-service';
const CONTAINER = process.env.TIM_E2E_CONTAINER ?? 'tim-e2e-llm';
const CONTAINER_PORT = 8787;
const HOST_PORT = Number(process.env.TIM_E2E_PORT ?? CONTAINER_PORT);
const BASE_URL = `http://127.0.0.1:${HOST_PORT}`;
const LEVEL = process.env.TIM_E2E_LEVEL ?? 'level-01';
const KEEP = process.argv.includes('--keep');

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const TRANSCRIPT =
    process.env.TIM_AGENT_TRANSCRIPT ??
    join(REPO_ROOT, '.agent-transcripts', `e2e-${LEVEL}-${stamp}.txt`);


/** Stop hard with a reason; the demo leaves the machine cleaner than it found it. */
function fail(reason) {
    demoFail({ prefix: '[e2e]', container: CONTAINER, keep: KEEP }, reason);
}

/** Wait until GET /health answers {"ok":true} (published port serving) - the shared poll. */
function health() {
    return waitForHealth(BASE_URL, fail);
}

async function main() {
    if (!process.env.TIM_AGENT_MODEL) {
        fail(
            'no model configured: set TIM_AGENT_MODEL (e.g. devstral-small-2:latest for the local Ollama daemon) ' +
                'and optionally TIM_AGENT_BASE_URL - see the header of this script',
        );
    }

    console.log(`[e2e] 1. clean state: docker rm -f ${CONTAINER} ; docker rmi -f ${IMAGE} (nothing pre-built is trusted)`);
    dockerQuiet(['rm', '-f', CONTAINER]);
    dockerQuiet(['rmi', '-f', IMAGE]);

    console.log(`[e2e] 2. build from scratch: docker build -t ${IMAGE} <repo root>`);
    docker(['build', '-t', IMAGE, REPO_ROOT]);

    const seedArgs =
        process.env.TIM_AGENT_SEED !== undefined ? ['-e', `TIM_AGENT_SEED=${process.env.TIM_AGENT_SEED}`] : [];
    console.log(
        `[e2e] 3. serve: docker run -d --name ${CONTAINER} -p ${HOST_PORT}:${CONTAINER_PORT} ` +
            `-e TIM_TURN_PORT=${CONTAINER_PORT}${seedArgs.length ? ' -e TIM_AGENT_SEED=<value>' : ''} ${IMAGE}`,
    );
    docker([
        'run', '-d', '--name', CONTAINER,
        '-p', `${HOST_PORT}:${CONTAINER_PORT}`,
        '-e', `TIM_TURN_PORT=${CONTAINER_PORT}`,
        ...seedArgs,
        IMAGE,
    ]);

    console.log(`[e2e]    wait for health: GET ${BASE_URL}/health`);
    await health();

    console.log(`[e2e] 4. level by config: POST ${BASE_URL}/level {"level":"${LEVEL}"}`);
    const levelRes = await fetch(`${BASE_URL}/level`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ level: LEVEL }),
    });
    const levelBody = await levelRes.json();
    if (levelRes.status !== 200 || levelBody.level !== LEVEL) {
        fail(`POST /level did not scope the session: HTTP ${levelRes.status} ${JSON.stringify(levelBody.result ?? levelBody)}`);
    }
    console.log(`[e2e]    -> session scoped to ${levelBody.level}; header: ${String(levelBody.observation).split(/\r?\n/)[0]}`);

    console.log('[e2e] 5. drive: the HOST LLM driver plays the game that lives in the container');
    console.log(
        `[e2e]    model: ${process.env.TIM_AGENT_MODEL} | turn boundary: TIM_AGENT_TURN_BASE_URL=${BASE_URL} | level: ${LEVEL}`,
    );
    const childEnv = { ...process.env, TIM_AGENT_TURN_BASE_URL: BASE_URL };
    const r = spawnSync('node', ['agent/driver.js', '--level', LEVEL, '--transcript', TRANSCRIPT], {
        cwd: REPO_ROOT,
        env: childEnv,
        stdio: 'inherit',
        timeout: 900_000,
    });
    if (r.error || r.status !== 0) {
        fail(
            `driver did not reach the goal: exit ${r.status}${r.error ? ` (${r.error})` : ''}` +
                ` - full round-trip transcript: ${TRANSCRIPT}`,
        );
    }
    if (!existsSync(TRANSCRIPT)) fail(`the driver wrote no transcript at ${TRANSCRIPT}`);

    const transcript = readFileSync(TRANSCRIPT, 'utf8');
    const lines = transcript.split(/\r?\n/);
    const outcomeLine = lines.find((l) => l.startsWith('outcome:')) ?? '(missing)';
    const turnsLine = lines.find((l) => l.startsWith('turns:')) ?? '(missing)';
    if (!outcomeLine.includes('goal-reached')) fail(`transcript does not record goal-reached: ${outcomeLine}`);

    if (KEEP) {
        console.log(`[e2e] KEEP: ${CONTAINER} left running at ${BASE_URL} (manual round-trip: POST ${BASE_URL}/turn)`);
    } else {
        console.log(`[e2e] 6. cleanup: docker rm -f ${CONTAINER}`);
        dockerQuiet(['rm', '-f', CONTAINER]);
    }
    console.log(
        `[e2e] PASS: image rebuilt from scratch, container published on ${BASE_URL}, and the model won ${LEVEL} ` +
            `through the container (${outcomeLine}, ${turnsLine}). Every round-trip is in the transcript: ${TRANSCRIPT}`,
    );
}

main().catch((e) => {
    fail(e?.stack ?? String(e));
});
