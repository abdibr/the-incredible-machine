/**
 * grid — rasterise the physics world to ASCII lines.
 *
 * Every non-wall body paints its bounds box with its owner object's glyph
 * (functional sensors via legend label overrides). A column ruler and a
 * `#` frame make absolute coordinates readable, because `place` needs them.
 *
 * Verified (docs/plans/agent-play-interface-phase-1.md): point sampling
 * misses thin bodies; bounds-box fill is the approach that reads correctly.
 */

import { glyphForBody, priorityForBody, renderLegendKey } from './legend.js';

/** boundary walls sit outside the play area and must be skipped */
const WALL_RE = /^wall-/;

/** candidate cell sizes for `grid: 'auto'` (smallest legible wins) */
export const AUTO_CELLS = [8, 10, 12.5, 16];

const FRAME = '#';

/**
 * Collect paintable bodies (non-wall) with owner types, ready to sort by
 * paint priority.
 * @param {object} physics - PhysicsEngine instance
 * @returns {Array<{label: string, type: string, min: object, max: object, priority: number}>}
 */
function paintList(physics) {
    const typeByBody = new Map();
    for (const obj of physics.getObjects()) {
        for (const body of obj.bodies) {
            if (body) typeByBody.set(body, obj.type);
        }
    }
    const items = [];
    for (const body of physics.world.bodies) {
        const type = typeByBody.get(body);
        if (!type) continue; // boundary walls & any unregistered body
        if (WALL_RE.test(body.label ?? '')) continue;
        items.push({
            label: body.label ?? '',
            type,
            min: body.bounds.min,
            max: body.bounds.max,
            priority: priorityForBody(body.label),
        });
    }
    // Paint order: plain bodies first — sensors/flames repaint over them.
    items.sort((a, b) => a.priority - b.priority);
    return items;
}

/**
 * Rasterise the world to lines at one cell size (no ruler — callers compose).
 * @param {object} physics
 * @param {number} cellPx
 * @returns {{ lines: string[], cellSize: number, cols: number, rows: number, extents: Map<string, object> }}
 */
function rasteriseAt(physics, cellPx) {
    const width = physics.width;
    const height = physics.height;
    const cols = Math.max(1, Math.round(width / cellPx));
    const rows = Math.max(1, Math.round(height / cellPx));

    const cells = Array.from({ length: rows }, () => Array.from({ length: cols }, () => '.'));
    /** @type {Map<string, {minCx:number,maxCx:number,minCy:number,maxCy:number}>} */
    const extents = new Map();

    for (const item of paintList(physics)) {
        const id = item.type;
        const x0 = Math.max(0, Math.floor(item.min.x / cellPx));
        const x1 = Math.min(cols - 1, Math.floor((item.max.x - 1e-6) / cellPx));
        const y0 = Math.max(0, Math.floor(item.min.y / cellPx));
        const y1 = Math.min(rows - 1, Math.floor((item.max.y - 1e-6) / cellPx));
        for (let cy = y0; cy <= y1; cy++) {
            for (let cx = x0; cx <= x1; cx++) {
                cells[cy][cx] = glyphForBody(item.type, item.label).charAt((cx - x0) % 2);
            }
        }
        if (x1 < x0 || y1 < y0) continue; // clipped away entirely
        const ext = extents.get(id) ?? { minCx: x0, maxCx: x1, minCy: y0, maxCy: y1 };
        if (!extents.has(id)) extents.set(id, ext);
        else {
            ext.minCx = Math.min(ext.minCx, x0); ext.maxCx = Math.max(ext.maxCx, x1);
            ext.minCy = Math.min(ext.minCy, y0); ext.maxCy = Math.max(ext.maxCy, y1);
        }
    }

    const body = cells.map((row) => FRAME + row.join('') + FRAME);
    const top = FRAME.repeat(cols + 2);
    return { lines: [top, ...body, top], cellSize: cellPx, cols, rows, extents };
}

/**
 * `grid: 'auto'` — smallest cell whose raster keeps ≥1 fully blank row or
 * column between every pair of distinct objects. Falls back to the coarsest
 * cell when nothing qualifies.
 * @param {object} physics
 * @returns {number} the chosen cell size in px
 */
export function pickAutoCell(physics) {
    let fallbackView = null;
    for (const cell of AUTO_CELLS) {
        const view = rasteriseAt(physics, cell);
        if (!fallbackView) fallbackView = view;
        if (separated(view.extents)) return cell;
    }
    return fallbackView ? fallbackView.cellSize : AUTO_CELLS[AUTO_CELLS.length - 1];
}

/** every pair of distinct objects has ≥1 blank cell between them, on some axis */
function separated(extents) {
    const list = [...extents.values()];
    for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
            const a = list[i];
            const b = list[j];
            const gapX = Math.max(a.minCx - b.maxCx, b.minCx - a.maxCx); // blank cols between
            const gapY = Math.max(a.minCy - b.maxCy, b.minCy - a.maxCy); // blank rows between
            if (gapX < 2 && gapY < 2) return false; // need ≥2 col/row spread for a blank between
        }
    }
    return true;
}

/**
 * Render the gridded world with frame and ruler.
 * @param {object} physics
 * @param {{ cell?: number|'auto'|'full' }} [options] 'auto' picks the smallest
 *        legible cell; 'full' forces the precise 8px map (125×75)
 * @returns {{ lines: string[], cellSize: number, cols: number, rows: number }}
 */
export function renderGrid(physics, { cell = 'auto' } = {}) {
    const cellSize = cell === 'auto' ? pickAutoCell(physics) : cell === 'full' ? 8 : cell;
    const view = rasteriseAt(physics, cellSize);

    // Ruler: a '|' mark every 10 columns so px offsets can be counted out.
    const marks = Array.from({ length: view.cols }, (_, c) => (c % 10 === 0 ? '|' : ' '));
    view.lines.push(` ${marks.join('')}`);
    view.lines.push(` ruler: each '|' = ${(10 * cellSize).toFixed(0)}px, top-left = (0,0), 1 col = ${cellSize}px`);

    return { lines: view.lines, cellSize, cols: view.cols, rows: view.rows };
}

export { renderLegendKey };