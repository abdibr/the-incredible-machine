/**
 * cli-flags - the tiny argv parser shared by the agent CLIs (driver.js,
 * eval.js, server.js): `--key value` pairs only, no deps, no extras.
 * One copy - three entry points with the same flag semantics must not
 * drift by copy-paste (agent/cli.js has its own script-local parser on
 * purpose: it also consumes bare `--flag` switches).
 */

/**
 * Parse `--key value` argv pairs into an object (unknown flags ignored).
 * @param {string[]} argv
 */
export function parseFlags(argv) {
    const flags = {};
    for (let i = 0; i < argv.length; i++) {
        if (argv[i].startsWith('--') && i + 1 < argv.length) {
            flags[argv[i].slice(2)] = argv[++i];
        }
    }
    return flags;
}