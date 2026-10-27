#!/usr/bin/env node
/**
 * replay-bugfile — replay a recorded sandbox bug file and print a
 * divergence report (ADR 0006 / docs/plans/session-bug-file-recorder.md).
 *
 * Usage:
 *   node scripts/replay-bugfile.mjs <bugfile.json> [--run N] [--until tick] [--json] [--quiet]
 *
 *   --run N     replay only run N (default: all runs)
 *   --until T   stop stepping at tick T (triage aid; comparison is capped too)
 *   --json      machine-readable report on stdout
 *   --quiet     only the one-line per-run summary
 *
 * Exit codes: 0 = every compared run replayed exactly; 1 = divergence or
 * parse failure; 2 = usage error.
 */
import { readFile } from 'node:fs/promises';
import { replayBugFile } from '../js/recorder/replay.js';

const args = process.argv.slice(2);
const positional = [];
const flags = { run: null, until: null, json: false, quiet: false };
for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') flags.json = true;
    else if (arg === '--quiet') flags.quiet = true;
    else if (arg === '--run') flags.run = Number(args[++i]);
    else if (arg === '--until') flags.until = Number(args[++i]);
    else positional.push(arg);
}

const badRun = flags.run !== null && Number.isNaN(flags.run);
const badUntil = flags.until !== null && Number.isNaN(flags.until);
if (positional.length === 0 || badRun || badUntil) {
    console.error('usage: node scripts/replay-bugfile.mjs <bugfile.json> [--run N] [--until tick] [--json] [--quiet]');
    process.exit(2);
}

let file;
try {
    file = JSON.parse(await readFile(positional[0], 'utf8'));
} catch (e) {
    console.error(`[replay-bugfile] could not read/parse "${positional[0]}": ${e.message}`);
    process.exit(1);
}

const result = replayBugFile(file, {
    runIndex: Number.isFinite(flags.run) ? flags.run : null,
    untilTick: Number.isFinite(flags.until) ? flags.until : Infinity,
});

if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
} else if (flags.quiet) {
    for (const line of result.summary) console.log(line);
} else {
    console.log(
        `bug file ${file.fileId ?? '?'} — schema ${file.schemaVersion ?? '?'},`
        + ` app ${file.appVersion ?? '?'}, matter ${file.matterVersion ?? '?'}`
    );
    if (file.notes) console.log(`notes: ${file.notes}`);
    for (const r of result.runReports) {
        if (r.ok) {
            console.log(
                `run ${r.runIndex}: OK — ${r.compared.events} event(s), ${r.compared.poses} pose row(s) match`
                + ` (lastTick ${r.lastTickRecorded})`
            );
        } else {
            console.log(`run ${r.runIndex}: DIVERGED at ${r.divergence?.kind ?? r.note ?? ''}`);
            console.log(`  recorded: ${JSON.stringify(r.divergence?.recorded ?? r.divergence ?? null)}`);
            console.log(`  replayed: ${JSON.stringify(r.divergence?.replayed ?? null)}`);
        }
    }
    console.log(result.ok ? '✅ replay matches the recording' : '❌ replay diverged — see above');
}

process.exitCode = result.ok ? 0 : 1;