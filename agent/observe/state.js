/**
 * state — the per-object one-line state table.
 *
 * The grid shows *where*; this shows *what*: fixed vs dynamic, motion verdict,
 * and interaction readiness in the `extra` column. Only public getters are
 * read (ADR 0003 lifecycle contract) — no reach-ins, no invented fields.
 */

import { isRopeFamily } from '../../js/objects/Rope.js';

const DEG = 180 / Math.PI;

/** Stable display id: named level id when present, else `type-<instanceId>`. */
export function objectId(obj) {
    return obj.customId ?? `${obj.type}-${obj.id}`;
}

/**
 * Motion verdict from the object's primary body (public Matter body only).
 * @param {object} obj - BaseObject instance
 * @returns {string} '—' | 'falling' | 'rising' | 'moving' | variant with spin
 */
function motionOf(obj) {
    const body = obj.bodies.find((b) => b && b.position) ?? null;
    if (!body) return '—';
    const { x, y } = body.velocity ?? { x: 0, y: 0 };
    const speed = Math.hypot(x, y);
    const spins = Math.abs(body.angularVelocity ?? 0) > 0.01;
    if (speed < 0.6 && !spins) return '—';
    let verdict;
    if (Math.abs(y) > Math.abs(x)) verdict = y > 0 ? 'falling' : 'rising';
    else verdict = x > 0 ? 'moving →' : 'moving ←';
    return spins ? `${verdict}, spinning` : verdict;
}

/**
 * Interaction-readiness extras — ONLY verified public getters (audit of
 * js/objects/*.js is the source of truth; an entry is skipped when absent).
 */
function extrasOf(obj, goal) {
    const extras = [];
    if (goal?.zoneId && obj.type === goal.targetType) extras.push('target-type');
    if (obj.type === 'bucket' && obj.customId === goal?.zoneId) extras.push('goal-zone');
    if (obj.type === 'bucket') extras.push(`caught:${obj.caughtCount ?? 0}`);
    // The rope family (issue #83) gates through membership, not a per-type
    // fan: SEVERED / intact is the family-wide fact every member gets free
    // with the roster - a third family member joins the table with the
    // roster append alone - and the free member's own line stays explicit
    // through its public flags: isFree splits the member off, BUNDLED
    // names the coil, TIED names a hanging chain.
    if (isRopeFamily(obj)) {
        if (obj.isSevered) extras.push('SEVERED');
        else if (obj.isFree) extras.push(obj.isFreeBundle ? 'BUNDLED' : 'TIED');
        else extras.push('intact');
    }
    if (obj.type === 'balloon') extras.push(obj.isPopped ? 'POPPED' : 'intact');
    if (obj.type === 'scissors') extras.push(obj.isClosed ? 'closed' : 'open');
    return extras;
}

/**
 * Footprint from the body's own rectangle, so a turned part keeps the size it
 * was authored with. `bounds` is the axis-aligned box, which grows as the part
 * rotates (a 120×12 plank at 26° read "113×63" and invited coordinate math on
 * a shape that no longer existed). Only exact for quad bodies; every other
 * shape keeps the AABB it has always reported.
 * @param {object} obj - BaseObject instance
 * @returns {string|null} "W×H" in game units, or null when not a quad
 */
function footprintOf(obj) {
    const body = obj.bodies.find((b) => b && b.position && Array.isArray(b.vertices) && b.vertices.length === 4);
    if (!body) return null;
    const [a, b, c] = body.vertices;
    const w = Math.hypot(a.x - b.x, a.y - b.y);
    const h = Math.hypot(b.x - c.x, b.y - c.y);
    return w >= h ? `${Math.round(w)}×${Math.round(h)}` : `${Math.round(h)}×${Math.round(w)}`;
}

/**
 * One row per object in the live world.
 * @param {object} physics - PhysicsEngine instance
 * @param {object} [goal] - level goal (for target/goal-zone flags)
 * @returns {object[]} { id, type, pos, angle, size, flags, motion, extra }
 */
export function stateRows(physics, goal = null) {
    const rows = [];
    for (const obj of physics.getObjects()) {
        const b = obj.bounds;
        const firstBody = obj.bodies.find((body) => body && body.position);
        const pos = firstBody
            ? `${Math.round(firstBody.position.x)},${Math.round(firstBody.position.y)}`
            : `${Math.round(obj.x)},${Math.round(obj.y)}`;
        rows.push({
            id: objectId(obj),
            type: obj.type,
            pos,
            angle: `${(obj.angle * DEG).toFixed(0)}°`,
            size: footprintOf(obj) ?? (b ? `${Math.round(b.width)}×${Math.round(b.height)}` : '—'),
            flags: obj.isFixed ? 'fixed' : 'dynamic',
            motion: motionOf(obj),
            extra: extrasOf(obj, goal).join(', ') || '—',
        });
    }
    return rows;
}

/**
 * Render the state table as aligned text lines (header + separator + rows).
 * @param {object} physics - PhysicsEngine instance
 * @param {object} [goal] - level goal
 * @returns {string[]}
 */
export function renderState(physics, goal = null) {
    const rows = stateRows(physics, goal);
    const cols = ['id', 'type', 'pos', 'angle', 'size', 'flags', 'motion', 'extra'];
    const width = {};
    for (const col of cols) {
        width[col] = Math.max(col.length, ...rows.map((r) => String(r[col]).length));
    }
    const line = (cells) => cells.map((c) => String(c).padEnd(width[c.col])).join('  ');
    const header = line(cols.map((col) => ({ col, toString: () => col })));
    const separator = cols.map((col) => '-'.repeat(width[col])).join('  ');
    return [header, separator, ...rows.map((r) => line(cols.map((col) => ({ col, toString: () => r[col] }))))];
}