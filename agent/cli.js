/**
 * cli — headless entry point.
 *
 *   node agent/cli.js --level level-01 --solve
 *   node agent/cli.js --level level-02 --describe --cell 12.5
 *
 * Prints the describeWorld() observation block; with --solve it runs the
 * brute-force solver and reports winning placements + the final map, or a
 * clean unsolved diagnosis with the best trial's event log.
 */

import { AgentSession } from './session.js';
import { describeWorld } from './observe/describe.js';
import { solve } from './solver.js';

/**
 * Tiny argv parser (no deps): `--key value` / `--flag`.
 * @param {string[]} argv
 */
function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--solve') args.solve = true;
        else if (argv[i] === '--describe') args.describe = true;
        else if (argv[i].startsWith('--') && i + 1 < argv.length) {
            args[argv[i].slice(2)] = argv[++i];
        }
    }
    return args;
}

const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const session = new AgentSession();
    try {
        await session.loadLevel(args.level ?? 'level-01');
        console.log(describeWorld(session, { cell: args.cell ?? 'auto' }));

        if (args.describe && !args.solve) return; // observation only

        const secondsPerTrial = num(args.seconds, 5);
        const maxTrials = num(args.trials, 2000);
        const started = Date.now();
        const report = solve(session, { maxTrials, secondsPerTrial });
        console.log(`\nsolve: ${report.outcome} after ${report.trials} trials in ${((Date.now() - started) / 1000).toFixed(1)}s`);

        if (report.outcome === 'reached') {
            console.log('winning placements:');
            for (const p of report.placements) {
                const angle = p.angle ? `, { angle: ${(p.angle * (180 / Math.PI)).toFixed(1)}° }` : '';
                console.log(`  place(${p.type}, ${p.x}, ${p.y}${angle})`);
            }
            // Deterministic replay of the winning placements for the final view.
            session.placements.length = 0;
            session.placements.push(...report.placements);
            session.trial({ seconds: secondsPerTrial });
            console.log(describeWorld(session, { cell: args.cell ?? 'auto' }));
            console.log('goal reached');
        } else {
            console.log(report.diagnosis);
            if (report.best) {
                console.log('best trial event log:');
                for (const row of report.best.result.events.slice(-8)) {
                    console.log(`  t=${row.t}s  ${row.text}`);
                }
            }
            process.exitCode = 1;
        }
    } finally {
        session.dispose();
    }
}

main().catch((e) => {
    console.error('[agent] fatal:', e);
    process.exitCode = 1;
});