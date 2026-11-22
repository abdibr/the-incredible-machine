/**
 * solver — the scripted baseline solver (the proof).
 *
 * Deterministic brute force with NO model in the loop: enumerate candidate
 * placements (target alone on a lattice, then one helper part with the
 * target anchored at derived drop spots), run each as a fresh `trial()`,
 * and early-exit when GoalChecker latches `goal:reached`. When nothing
 * reaches, report the best partial (final target-to-zone distance).
 *
 * Ordering heuristic: lattice points sorted by distance to the goal zone,
 * so "drop the ball straight into the bucket" style wins surface early.
 *
 * That drop is the TUTORIAL's lesson, not a generic solution: it wins a level
 * without exercising a single authored part, so the search allows it only
 * where the level teaches it (TARGET_PLACEABLE_LEVELS) and says so everywhere
 * else. The machine-level search - build the target's path out of the
 * authored helpers - is the open gap (issue #104).
 */

import { objectRegistry } from '../js/objects/ObjectRegistry.js';
import { place, reset as resetPlacements, trial } from './actions.js';

/**
 * The levels whose lesson IS placing the goal target: level-01 drops a ball
 * straight into the bucket, and that is what the level is teaching.
 *
 * Everywhere else the same drop is a degenerate shortcut - it reaches the
 * goal without using one authored part (level-03 skips the dominoes and the
 * fan, level-04 the balloon and rope, level-06 the ramps) - so the scripted
 * baseline refuses to place the target there. The search that would win those
 * levels honestly builds the target's path from the level's own helpers and
 * is not built yet (issue #104).
 * @type {ReadonlyArray<string>}
 */
export const TARGET_PLACEABLE_LEVELS = Object.freeze(['level-01']);

/** Angle set per helper type (radians). Ramps need tilt; others sit flat. */
export const DEFAULT_ANGLES = {
    ramp: [0, Math.PI / 12, -Math.PI / 12, Math.PI / 6, -Math.PI / 6],
    conveyor: [0, Math.PI / 12, -Math.PI / 12],
};

/** Goal-zone center straight from level data (no engine needed). */
export function zoneCenter(session) {
    const goal = session.goal;
    if (!goal || goal.type !== 'object_in_zone') return null;
    const fixed = (session.levelData.fixedObjects ?? []).find((d) => d.id === goal.zoneId);
    return fixed ? { x: fixed.x, y: fixed.y } : null;
}

/** Lattice points across the playfield, deterministically ordered. */
function latticePoints(session, lattice, zone) {
    const points = [];
    for (let y = lattice; y < session.height; y += lattice) {
        for (let x = lattice; x < session.width; x += lattice) {
            points.push({ x, y });
        }
    }
    if (zone) {
        points.sort((a, b) =>
            Math.hypot(a.x - zone.x, a.y - zone.y) - Math.hypot(b.x - zone.x, b.y - zone.y));
    } else {
        points.sort((a, b) => a.y - b.y || a.x - b.x);
    }
    return points;
}

/**
 * Drop spots just above a helper part's geometry: one above its lowest
 * Matter vertex, one above its highest — the target rolls down toward
 * whichever end faces the zone.
 */
function dropSpotsFrom(session, type, x, y, angle) {
    const probe = objectRegistry.create(type, x, y, { angle });
    const vertices = probe.bodies[0]?.vertices ?? [];
    if (vertices.length === 0) return [{ x, y: y - 40 }];
    const lowest = vertices.reduce((a, v) => (v.y > a.y ? v : a));
    const highest = vertices.reduce((a, v) => (v.y < a.y ? v : a));
    return [
        { x: lowest.x, y: lowest.y - 18 },
        { x: highest.x, y: highest.y - 10 },
    ];
}

/**
 * May the search place the goal's target part here - and if not, why not?
 *
 * Two different refusals, both worth naming instead of blaming an empty
 * candidate list:
 *
 * - `budgeted: false` - the level ships the target ALREADY IN THE SCENE
 *   (level-02's ball is fixed + anchored) and budgets only the helpers, so
 *   `availableParts` carries no count for the target type;
 * - `allowed: false` - the target IS budgeted, but dropping it straight into
 *   the goal is the tutorial's lesson, not this level's (TARGET_PLACEABLE_LEVELS).
 *
 * `placeable` is the conjunction: the only thing candidatePlacements needs.
 * @param {import('./session.js').AgentSession} session with a level loaded
 * @returns {{ targetType: string, budgeted: boolean, allowed: boolean, placeable: boolean }}
 */
export function targetPlacement(session) {
    const targetType = session.goal?.targetType ?? 'ball';
    const budgeted = (session.budget()?.[targetType] ?? 0) > 0;
    const allowed = TARGET_PLACEABLE_LEVELS.includes(session.levelData?.id ?? '');
    return { targetType, budgeted, allowed, placeable: budgeted && allowed };
}

/**
 * Yield candidate placement lists (each list = one trial's placements).
 * @yields {Array<{type:string,x:number,y:number,angle:number}>}
 */
export function* candidatePlacements(session, { lattice = 50 } = {}) {
    // Every family below places the goal target itself - the tutorial's move.
    // Where the level is not the tutorial there is nothing to yield: the
    // helper-only machine search is the open gap (issue #104).
    if (!targetPlacement(session).placeable) return;
    const goal = session.goal;
    const parts = Object.entries(session.levelData?.availableParts ?? {}).filter(([, n]) => n > 0);
    const zone = zoneCenter(session);
    const targetType = goal?.targetType ?? 'ball';
    const helpers = parts.map(([t]) => t).filter((t) => t !== targetType);

    // 1) target alone in free fall (bucket directly below ⇒ classic win)
    for (const p of latticePoints(session, lattice, zone)) {
        yield [{ type: targetType, x: p.x, y: p.y, angle: 0 }];
    }

    // 2) one helper at a lattice pose; target at geometry-derived drop spots
    for (const helper of helpers) {
        for (const p of latticePoints(session, lattice, zone)) {
            for (const angle of DEFAULT_ANGLES[helper] ?? [0]) {
                for (const spot of dropSpotsFrom(session, helper, p.x, p.y, angle)) {
                    yield [
                        { type: helper, x: p.x, y: p.y, angle },
                        { type: targetType, x: spot.x, y: spot.y, angle: 0 },
                    ];
                }
            }
        }
    }
}

/**
 * Steppable spelling of the solve loop (issue #62): the EXACT search
 * solve() owns, yielded one judged candidate at a time so a page can
 * spread the search over frames - the watch sidecar drives this facade on
 * its own cadence instead of blocking on the whole search. Each yield
 * reports the progress a page can render: trials judged so far, the
 * candidate that was just judged, its trial result, and the current best
 * partial. The final report is the generator's done value - the SAME
 * object shape solve() returns - and the winning placements stand on the
 * session exactly as solve() leaves them. The all-at-once solve() is the
 * composition of this facade (issue #61 pattern); the two cannot drift.
 * @param {import('./session.js').AgentSession} session
 * @param {{ maxTrials?: number, secondsPerTrial?: number, lattice?: number }} [options]
 * @returns {Generator<{trials: number, candidate: object[], placements: object[],
 *            result: object, best: object|null},
 *            { outcome: 'reached'|'unsolved', trials: number, placements?: object[],
 *              result?: object, best?: object, diagnosis?: string }>}
 */
export function* solveTrials(session, { maxTrials = 2000, secondsPerTrial = 30, lattice = 50 } = {}) {
    if (!session.levelData) throw new Error('[solver] load a level first (session.loadLevel)');
    const trialOptions = { seconds: secondsPerTrial, dt: 1000 / 60 };
    let trials = 0;
    let best = null;
    for (const candidate of candidatePlacements(session, { lattice })) {
        if (trials >= maxTrials) break;
        resetPlacements(session);
        let valid = true;
        for (const step of candidate) {
            const r = place(session, step.type, step.x, step.y, { angle: step.angle });
            if (!r.ok) { valid = false; break; } // over budget / off-playfield - skip combo
        }
        if (!valid) continue;
        const result = trial(session, trialOptions);
        trials++;
        if (result.outcome === 'reached') {
            return { outcome: 'reached', trials, placements: [...session.placements], result };
        }
        if (Number.isFinite(result.distance) && (!best || result.distance < best.score)) {
            best = { score: result.distance, result, placements: [...session.placements] };
        }
        yield { trials, candidate: [...candidate], placements: [...session.placements], result, best };
    }
    const { targetType, budgeted } = targetPlacement(session);
    const diagnosis = best
        ? `unsolved - best attempt ended ${Math.round(best.score)}px from the zone (${best.result.outcome})`
        : budgeted
            // Budgeted but refused: the drop is the tutorial's lesson, not
            // this level's - the machine search is what is missing.
            ? `unsolved - this level is not the tutorial, so the search will not drop the goal target (${targetType}) ` +
                `straight into the goal; the helper-only machine search that builds its path is not built yet (issue #104)`
            // The candidate list was empty for a reason worth naming: the
            // level's target is scene furniture, so every candidate the
            // generator yields is refused for want of budget.
            : `unsolved - the goal target (${targetType}) is not placeable here: availableParts budgets the helpers only, ` +
                `so the ${targetType} is already in the scene and no candidate can build one`;
    return { outcome: 'unsolved', trials, best, diagnosis };
}

/**
 * Run the solve loop to completion (the all-at-once spelling). This is
 * the composition of solveTrials - one loop over its yields - so the
 * solver contract this return shape pins (solver.test.js) and the watch
 * page's incremental drive stay the one search by construction (issue #62,
 * ADR 0010).
 * @param {import('./session.js').AgentSession} session
 * @param {{ maxTrials?: number, secondsPerTrial?: number, lattice?: number }} [options]
 * @returns {{ outcome: 'reached'|'unsolved', trials: number, placements?: object[],
 *            result?: object, best?: object, diagnosis?: string }}
 */
export function solve(session, options = {}) {
    const iterator = solveTrials(session, options);
    for (;;) {
        const next = iterator.next();
        if (next.done) return next.value;
    }
}
