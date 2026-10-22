/**
 * graph — the relation graph: goal / phys / touch / fired edges plus dormant
 * hints, each from a real source of truth (no invented topology).
 *
 *   goal    resolved from the level goal + object customIds/types
 *   phys    runtime constraint links (engine-attached + object-owned arrays)
 *   touch   active Matter collision pairs remapped to owner objects
 *   fired   recorded interaction events (e.g. bucket catches), by count
 *   dormant every active interaction-matrix row whose two types are both in
 *           the world but currently not touching — a free hint generator
 */

import { DEFAULT_INTERACTION_ROWS } from '../../js/interactions/rules.js';
import { objectId } from './state.js';

/** Maximum dormant hints printed before summarising the rest. */
const DORMANT_CAP = 12;

/**
 * Build a map from Matter body → owning object for the live world.
 * @param {object} physics
 * @returns {Map<object, object>}
 */
function ownerByBody(physics) {
    const map = new Map();
    for (const obj of physics.getObjects()) {
        for (const body of obj.bodies) {
            if (body) map.set(body, obj);
        }
    }
    return map;
}

/**
 * All constraint links between distinct game objects (phys edge source).
 * Deduplicated by constraint identity; object-owned chains (rope/pulley) and
 * engine-attached links both count.
 */
function physEdges(session, ownerByBody) {
    const seen = new Set();
    const edges = [];
    const push = (constraint) => {
        if (!constraint || seen.has(constraint)) return;
        seen.add(constraint);
        const a = ownerByBody.get(constraint.bodyA);
        const b = ownerByBody.get(constraint.bodyB);
        if (a && b && a !== b) edges.push([a, b]);
    };
    for (const c of session.engine.getAttachedConstraints()) push(c);
    for (const obj of session.engine.getObjects()) {
        for (const c of obj.constraints ?? []) push(c);
    }
    return edges;
}

/**
 * Active contact pairs between distinct game objects (touch edge source).
 */
function touchEdges(session, ownerByBody) {
    const pairs = session.engine.engine?.pairs?.list ?? [];
    const seen = new Set();
    const edges = [];
    for (const pair of pairs) {
        if (!pair.isActive) continue;
        const a = ownerByBody.get(pair.bodyA);
        const b = ownerByBody.get(pair.bodyB);
        if (!a || !b || a === b) continue;
        const key = a.id < b.id ? `${a.id}:${b.id}` : `${b.id}:${a.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push([a, b]);
    }
    return edges;
}

/**
 * Render the relation graph for the session's live world.
 * @param {import('../session.js').AgentSession} session
 * @returns {string[]}
 */
export function renderGraph(session) {
    const lines = ['relations'];
    if (!session.engine) return [...lines, '  (no live world)'];

    const goal = session.goal;
    const owner = ownerByBody(session.engine);
    const objects = [...session.engine.getObjects()];

    // ── goal edge ──
    if (goal?.type === 'object_in_zone') {
        const zone = objects.find((o) => o.customId === goal.zoneId);
        const targets = objects.filter((o) => o.type === goal.targetType);
        if (zone && targets.length > 0) {
            const status = session.lastOutcome ? `status: ${session.lastOutcome}` : 'status: unmet';
            lines.push(
                `  goal     ${objectId(targets[0])} ──▶ ${objectId(zone)}    (${goal.type}, zone=${goal.zoneId})  ${status}`,
            );
        }
    }

    // ── phys edges ──
    for (const [a, b] of physEdges(session, owner)) {
        lines.push(`  phys     ${objectId(a)} ── ${objectId(b)}`);
    }

    // ── touch edges ──
    for (const [a, b] of touchEdges(session, owner)) {
        lines.push(`  touch    ${objectId(a)} ~ ${objectId(b)}`);
    }

    // ── fired rows (from the session's recorded events) ──
    const counts = new Map();
    for (const row of session.lastEventSentences ?? []) {
        if (row.who) {
            const key = `${row.who} ⇄ ${row.where}`;
            counts.set(key, (counts.get(key) ?? 0) + 1);
        }
    }
    for (const [key, n] of counts) {
        lines.push(`  fired    bucket-catch  ${key}  ${n}x`);
    }

    // ── dormant hints ──
    const present = new Set(objects.map((o) => o.type));
    const edgesTouching = [...physEdges(session, owner), ...touchEdges(session, owner)];
    const dormant = [];
    for (const row of DEFAULT_INTERACTION_ROWS) {
        if (row.docOnly) continue;
        const actorType = row.actor?.type;
        const targetType = row.target?.type;
        if (!actorType || actorType.includes('/') || !present.has(actorType)) continue;
        // Wildcard targets match every OTHER present type (e.g. spring-trigger
        // is dormant against any present counterpart it is not touching).
        const targetTypes = targetType
            ? [targetType]
            : [...present].filter((t) => t !== actorType);
        const actors = objects.filter((o) => o.type === actorType);
        let pairs = [];
        for (const tt of targetTypes) {
            const touching = edgesTouching.some(([a, b]) =>
                (a.type === actorType && b.type === tt) || (b.type === actorType && a.type === tt),
            );
            if (touching) continue;
            pairs = pairs.concat(actors.flatMap((a) => objects.filter((o) => o.type === tt).map((b) => [a, b])));
        }
        for (const [a, b] of pairs) {
            dormant.push(`  dormant  ${row.id}  ${objectId(a)} ── ${objectId(b)}`);
        }
    }
    if (dormant.length > 0) {
        lines.push(...dormant.slice(0, DORMANT_CAP));
        if (dormant.length > DORMANT_CAP) lines.push(`  … ${dormant.length - DORMANT_CAP} more dormant pairings`);
    }
    return lines;
}