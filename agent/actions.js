/**
 * actions — the action API. place / remove / rotate / nudge / reset / trial.
 *
 * Every action returns a result object and NEVER THROWS on bad input — a
 * model (or script) will send bad input constantly. Placements are the
 * session's source of truth; the world is rebuilt fresh on `trial()`, so
 * actions are cheap bookkeeping, not physics.
 */

import { objectRegistry } from '../js/objects/ObjectRegistry.js';
import { clampObjectToPlayfield } from '../js/objects/BaseObject.js';

/** @typedef {{ ok: boolean, error?: string, [key: string]: any }} ActionResult */

/**
 * Place a part: budget-checked against level availableParts; rejects unknown
 * types / over-budget / off-playfield (center clamps against the object's
 * own bounds at the current pose — same rule as drag-drop).
 *
 * @param {import('./session.js').AgentSession} session
 * @param {string} type
 * @param {number} x
 * @param {number} y
 * @param {{ angle?: number }} [options]
 * @returns {ActionResult}
 */
export function place(session, type, x, y, { angle = 0 } = {}) {
    try {
        if (!session.levelData) return { ok: false, error: 'no level loaded' };
        if (!objectRegistry.has(type)) return { ok: false, error: `unknown type: ${type}` };
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
            return { ok: false, error: `x,y must be numbers (got ${x}, ${y})` };
        }
        const budget = session.budget()[type] ?? 0;
        if (budget <= 0) {
            return { ok: false, error: `no budget left for ${type}`, remaining: session.budget() };
        }
        // Probe the footprint off-world first: reject instead of silently
        // clamping, so placement coordinates stay meaningful to the caller.
        const probe = objectRegistry.create(type, x, y, { angle });
        const clamped = clampObjectToPlayfield(probe, x, y, session.width, session.height);
        const moved = Math.hypot(clamped.x - x, clamped.y - y);
        if (moved > 0.01) {
            return { ok: false, error: 'off-playfield — center would clamp to', clampedTo: clamped };
        }
        session.placements.push({ type, x, y, angle });
        return { ok: true, type, x, y, angle, budgetLeft: session.budget()[type] };
    } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
}

/**
 * Resolve a placed part by type + 0-based slot (e.g. the 2nd placed ramp).
 * @private
 * @returns {{ index: number, placement: object }} or null
 */
function findPlacement(session, type, slot = 0) {
    let seen = -1;
    for (let i = 0; i < session.placements.length; i++) {
        if (session.placements[i].type === type && ++seen === slot) return { index: i, placement: session.placements[i] };
    }
    return null;
}

/**
 * Remove a placed part (level fixedObjects are immutable — only agent
 * placements are addressable).
 * @param {import('./session.js').AgentSession} session
 * @param {string} type
 * @param {number} [slot] 0-based occurrence among that type's placements
 * @returns {ActionResult}
 */
export function remove(session, type, slot = 0) {
    const found = findPlacement(session, type, slot);
    if (!found) return { ok: false, error: `no placed ${type} #${slot} to remove` };
    const [placement] = session.placements.splice(found.index, 1);
    return { ok: true, removed: placement, budgetLeft: session.budget()[type] ?? 0 };
}

/**
 * Rotate a placed part (absolute radians; rebuild applies it at place time).
 * @param {import('./session.js').AgentSession} session
 * @returns {ActionResult}
 */
export function rotate(session, type, slot = 0, radians = 0) {
    if (!Number.isFinite(radians)) return { ok: false, error: `angle must be a number (got ${radians})` };
    const found = findPlacement(session, type, slot);
    if (!found) return { ok: false, error: `no placed ${type} #${slot} to rotate` };
    found.placement.angle = radians;
    return { ok: true, angle: radians };
}

/** Move a placed part by an offset. */
export function nudge(session, type, dx, dy, slot = 0) {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
        return { ok: false, error: `dx,dy must be numbers (got ${dx}, ${dy})` };
    }
    const found = findPlacement(session, type, slot);
    if (!found) return { ok: false, error: `no placed ${type} #${slot} to nudge` };
    found.placement.x += dx;
    found.placement.y += dy;
    return { ok: true, x: found.placement.x, y: found.placement.y };
}

/** Wipe all placements (the machine, not the level). */
export function reset(session) {
    const count = session.placements.length;
    session.placements.length = 0;
    return { ok: true, cleared: count };
}

/**
 * Trial passthrough — a fresh world every run, judged by GoalChecker.
 * @param {import('./session.js').AgentSession} session
 * @param {{ seconds?: number, dt?: number }} [options]
 * @returns {object} the trial result
 */
export function trial(session, options = {}) {
    try {
        return session.trial(options);
    } catch (e) {
        return { outcome: 'error', error: e instanceof Error ? e.message : String(e) };
    }
}