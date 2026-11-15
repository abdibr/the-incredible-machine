/**
 * rng - opt-in seeded PRNG for agent sessions (phase-2 ticket 4/6).
 *
 * Agent trials must be reproducible run-over-run: with a seed configured,
 * every Math.random draw made while a session's world is built (Balloon
 * color/bob phase, Candle flicker phase at construction time) comes from
 * this generator instead of the global one, so two same-seed sessions
 * produce byte-identical trials. The browser bundle never imports agent/,
 * and with no seed configured nothing here is consulted - live behavior is
 * unchanged.
 *
 * Generator: mulberry32 (public domain, Tommy Ettinger) - tiny, fast,
 * one closure word of state, [0,1) doubles over the full 32-bit seed space.
 */

/** Env var that seeds an agent session when no explicit seed option is given. */
export const SEED_ENV_VAR = 'TIM_AGENT_SEED';

/**
 * Resolve a seed candidate (ctor option value, or TIM_AGENT_SEED env text)
 * into a 32-bit uint, or null when unseeded / unusable. Bad values never
 * throw - they warn loudly and fall back to today's unseeded behavior.
 * @param {number|string|null|undefined} value
 * @returns {number|null} uint32 seed, or null for unseeded
 */
export function resolveSeed(value) {
    if (value === undefined || value === null) return null;
    if (typeof value === 'string' && value.trim() === '') return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) {
        console.warn(
            `[agent/rng] ignoring invalid seed: "${String(value)}" (expect a non-negative number, or unset ${SEED_ENV_VAR})`,
        );
        return null;
    }
    return Math.floor(n) % 4294967296;
}

/**
 * Build the seeded generator for one construction window. AgentSession
 * re-creates it per rebuild, so repeated builds of the same level +
 * placements replay the exact same draw sequence within a session too.
 * @param {number} seed uint32
 * @returns {() => number} draws in [0, 1)
 */
export function createSeedRng(seed) {
    let a = (Math.trunc(Number(seed)) || 0) >>> 0;
    return function next() {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}