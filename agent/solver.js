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
 */

import { objectRegistry } from '../js/objects/ObjectRegistry.js';
import { place, reset as resetPlacements, trial } from './actions.js';

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
 * Yield candidate placement lists (each list = one trial's placements).
 * @yields {Array<{type:string,x:number,y:number,angle:number}>}
 */
export function* candidatePlacements(session, { lattice = 50 } = {}) {
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
 * Run the solve loop.
 * @param {import('./session.js').AgentSession} session
 * @param {{ maxTrials?: number, secondsPerTrial?: number, lattice?: number }} [options]
 * @returns {{ outcome: 'reached'|'unsolved', trials: number, placements?: object[],
 *            result?: object, best?: object, diagnosis?: string }}
 */
export function solve(session, { maxTrials = 2000, secondsPerTrial = 5, lattice = 50 } = {}) {
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
            if (!r.ok) { valid = false; break; } // over budget / off-playfield → skip combo
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
    }
    const diagnosis = best
        ? `unsolved — best attempt ended ${Math.round(best.score)}px from the zone (${best.result.outcome})`
        : 'unsolved — no valid candidate placements existed';
    return { outcome: 'unsolved', trials, best, diagnosis };
}