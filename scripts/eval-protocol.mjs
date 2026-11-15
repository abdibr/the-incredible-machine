#!/usr/bin/env node
/**
 * eval-protocol - the ONE COMMAND of ticket #50 ("Agent P2 6/6: phase-2
 * exit eval - repeat-run protocol + level-02/03 stuck-point report"). The
 * default branch is deliberately markdown-free, so THIS header is the run
 * instructions, and the stub-provider tests (tests/agent/eval-protocol.test.js)
 * are the executable spec. The engine behind it is agent/eval.js.
 *
 * WHAT IT RUNS (fixed by design):
 *   level-01  must-solve-every-run  - the gate; one unsolved run fails the verdict
 *   level-02  attempt-and-diagnose  - unsolved is fine IF diagnosed
 *   level-03  attempt-and-diagnose  - same
 *   level-04  excluded by design (known-broken rope-attach/balloon mechanics)
 * Every level x seed is one REAL driver run (the OpenAI Agents SDK loop
 * against the configured provider), strictly sequential, with the world
 * construction seeded per seed (the TIM_AGENT_SEED seam, ticket #46).
 *
 * USAGE:
 *   node scripts/eval-protocol.mjs
 *   node scripts/eval-protocol.mjs --model "glm-5.3-flash:cloud" --seeds 1,2,3
 *
 * ENV / FLAGS (flags win over env; the report file is the diff surface):
 *   TIM_AGENT_MODEL / --model        REQUIRED. Model name as the provider
 *                                    knows it (quote colon-containing names).
 *   TIM_AGENT_BASE_URL / --base-url  OpenAI-compatible provider endpoint
 *                                    (e.g. http://127.0.0.1:11434/v1 for a
 *                                    local Ollama daemon). Unset -> SDK
 *                                    default OpenAI (needs OPENAI_API_KEY).
 *   OPENAI_API_KEY                   optional; only ever seen by the driver
 *                                    and never printed.
 *   TIM_AGENT_MAX_TURNS / --max-turns  hard driver-turn cap (default 20).
 *   TIM_EVAL_SEEDS / --seeds         csv of seeds, default 1,2,3 (N=3 runs
 *                                    per level; seeds pin world
 *                                    CONSTRUCTION randomness only - the
 *                                    report's determinism-caveats section
 *                                    names what that does and does NOT
 *                                    cover).
 *   TIM_EVAL_REPORT / --report       report file path (default
 *                                    .agent-transcripts/eval-report.txt - a
 *                                    gitignored log location, suitable for
 *                                    diffing two consecutive runs).
 *   TIM_EVAL_TRANSCRIPTS / --transcripts-dir  per-run transcript dir
 *                                    (default .agent-transcripts/eval;
 *                                    names level-<nn>-seed<k>.txt).
 *   TIM_AGENT_TURN_BASE_URL          must stay UNSET - the protocol is a
 *                                    HOST-mode measurement; driving the
 *                                    containerized turn service is
 *                                    scripts/e2e-demo.mjs (ticket #49).
 *                                    Setting it is a config error.
 *
 * STDOUT: the volatile-free summary (renderSummary) - byte-diffable across
 * two consecutive seeded invocations. THE REPORT FILE: renderReport() - a
 * compact per-level report (outcome, turns used, notable events, transcript
 * references, stuck-point diagnosis for unsolved runs) whose bytes are
 * identical across two seeded invocations EXCEPT the clearly fenced
 * "# BEGIN VOLATILE" wall-clock block. A stable-section difference between
 * two seeded runs is provider drift (sampling, model updates) - or a
 * protocol bug (check the transcripts).
 *
 * EXIT CODES: 0 gate passed (level-01 solved in every run); 1 gate failed -
 * the report is written anyway (that is the honest measurement); 2
 * configuration error (before any model call) or protocol crash - never a
 * silent false pass.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import process from 'node:process';

import {
    EVAL_ENV,
    renderReport,
    renderSummary,
    resolveEvalConfig,
    runProtocol,
} from '../agent/eval.js';

async function main() {
    const { errors, config } = resolveEvalConfig({
        argv: process.argv.slice(2),
        env: process.env,
    });
    if (errors.length || !config) {
        for (const e of errors) console.error(`[eval] config error: ${e}`);
        console.error(
            '[eval] usage: node scripts/eval-protocol.mjs - set TIM_AGENT_MODEL (e.g. glm-5.3-flash:cloud) and ' +
                'optionally TIM_AGENT_BASE_URL - see the header of scripts/eval-protocol.mjs',
        );
        process.exit(2);
    }

    const result = await runProtocol(config);

    // The report lands in the configured gitignored log location; its
    // stable sections diff byte-for-byte across seeded invocations.
    await mkdir(dirname(config.reportPath), { recursive: true });
    await writeFile(config.reportPath, renderReport(result), 'utf8');

    // stdout is ONLY the summary (volatile-free by contract).
    process.stdout.write(`${renderSummary(result)}\n`);

    process.exit(result.gate.passed ? 0 : 1);
}

main().catch((e) => {
    console.error(`[eval] fatal: ${e?.stack ?? String(e)}`);
    process.exit(2);
});