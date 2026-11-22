import { describe, it, expect, afterEach } from 'vitest';
import { AgentSession } from '../../agent/session.js';
import { renderGrid, pickAutoCell, AUTO_CELLS } from '../../agent/observe/grid.js';
import { glyphForBody, orientedCell } from '../../agent/observe/legend.js';
import { place } from '../../agent/actions.js';

/** Cells of one object as `{ row, text }` for the grid lines inside the frame. */
function bandOf(view, obj) {
    const cell = view.cellSize;
    const top = 1; // line 0 is the top frame
    const b = obj.bounds; // object AABB: { x, y, width, height }
    const y0 = Math.max(0, Math.floor(b.y / cell));
    const y1 = Math.floor((b.y + b.height - 1e-6) / cell);
    const x0 = Math.max(0, Math.floor(b.x / cell));
    const x1 = Math.floor((b.x + b.width - 1e-6) / cell);
    const rows = [];
    for (let cy = y0; cy <= y1; cy++) {
        // inside the frame each line is '#' + cols + '#', so col c sits at 1 + c
        rows.push({ cy, text: view.lines[top + cy].slice(1 + x0, 1 + x1 + 1) });
    }
    return rows;
}

/** The one object of `type` at roughly (x, y) - placed parts have no customId. */
function objectNear(engine, type, x, y) {
    return [...engine.getObjects()].find((o) => o.type === type && o.customId == null
        && Math.abs(o.x - x) < 30 && Math.abs(o.y - y) < 30);
}

/** @type {import('../../agent/session.js').AgentSession|null} */
let session = null;

afterEach(() => {
    session?.dispose();
    session = null;
});

describe('observe/grid', () => {
    it('paints the level-01 bucket inside a framed map and skips boundary walls', async () => {
        session = new AgentSession();
        await session.loadLevel('level-01');
        const view = renderGrid(session.engine, { cell: 10 });

        // Frame rows are solid '#', width = cols + 2; the ruler adds 2 lines.
        expect(view.lines[0]).toBe('#'.repeat(view.cols + 2));
        expect(view.lines[view.lines.length - 3]).toBe('#'.repeat(view.cols + 2));
        expect(view.lines).toHaveLength(view.rows + 4); // + top/bottom frame + 2 ruler lines

        // The goal bucket's glyph block is painted somewhere in the map.
        const painted = view.lines.join('\n');
        expect(painted).toMatch(/U/);
        expect(painted).toMatch(/v/); // catch sensor zone stays visible

        // Absolutely no 'O' (ball) — only the fixed bucket exists so far.
        expect(painted).not.toMatch(/O/);

        // Ruler note is present and references the cell size.
        expect(view.lines.at(-1)).toContain(`1 col = 10px`);
    });

    it("grid: 'full' forces the precise 8px map (125×75)", async () => {
        session = new AgentSession();
        await session.loadLevel('level-01');
        const view = renderGrid(session.engine, { cell: 'full' });
        expect(view.cols).toBe(125);
        expect(view.rows).toBe(75);
        expect(view.cellSize).toBe(8);
    });

    it("grid: 'auto' picks a candidate cell that keeps objects separated", async () => {
        session = new AgentSession();
        await session.loadLevel('level-01');
        const cell = pickAutoCell(session.engine);
        expect(AUTO_CELLS).toContain(cell);
        const view = renderGrid(session.engine, { cell: 'auto' });
        expect(AUTO_CELLS).toContain(view.cellSize);
    });

    it('the ramp glyph follows the plank tilt: descending right, ascending right, flat, steep', () => {
        // body.angle is screen-space (y grows down): +0.45 is downhill to the right.
        expect(orientedCell('ramp', 0.45)).toBe('\\');
        expect(orientedCell('ramp', -0.45)).toBe('/');
        expect(orientedCell('ramp', 0)).toBe('='); // not '-' - the spring platform owns that
        expect(orientedCell('ramp', 1.4)).toBe('|');
        expect(orientedCell('ball', 0.45)).toBeNull(); // only tilt-reading types
    });

    it('paints a rotated ramp as its own tilted plank, not its bounding box', async () => {
        session = new AgentSession();
        await session.loadLevel('level-02');
        place(session, 'ramp', 500, 250, { angle: 0.45 });
        session.materializeBoard();

        const ramp = objectNear(session.engine, 'ramp', 500, 250);
        expect(ramp).toBeTruthy();
        const view = renderGrid(session.engine, { cell: 8 });
        const band = bandOf(view, ramp);

        // Tilted: the band is a parallelogram - each row sits further right
        // than the row above it, so the bbox corners are NOT all painted.
        const span = (text) => {
            const painted = [...text].map((c, i) => (c === '.' ? -1 : i)).filter((i) => i >= 0);
            return { start: painted[0], end: painted.at(-1) };
        };
        // The AABB's first/last rows can be empty (the plank's corners are
        // rounded off by the rotation), so compare the first and last rows
        // that actually carry cells.
        const paintedRows = band.map((r) => span(r.text)).filter((s) => s.end >= 0);
        const top = paintedRows[0];
        const bottom = paintedRows.at(-1);
        expect(top.start).toBeLessThan(bottom.start); // leans down-right: the band slides right
        expect(top.end).toBeGreaterThanOrEqual(0);   // and both ends still paint
        expect(bottom.end).toBeGreaterThan(top.end);
        // Every painted cell carries the tilt glyph, none the old fixed '//' one.
        const painted = band.map((r) => r.text).join('');
        expect(painted).toMatch(/\\/);
        expect(painted).not.toMatch(/[/=]/);
    });

    it('a ramp tilted the other way reads as the other slash', async () => {
        session = new AgentSession();
        await session.loadLevel('level-02');
        place(session, 'ramp', 500, 250, { angle: -0.45 });
        session.materializeBoard();

        const ramp = objectNear(session.engine, 'ramp', 500, 250);
        const view = renderGrid(session.engine, { cell: 8 });
        const painted = bandOf(view, ramp).map((r) => r.text).join('');
        expect(painted).toMatch(/\//);
        expect(painted).not.toMatch(/[\\-]/);
    });

    it('unknown object types get the fallback glyph', () => {
        expect(glyphForBody('ferris-wheel', undefined)).toBe('??');
        expect(glyphForBody('ball', undefined)).toBe('OO');
    });
});
describe('observe/grid - thin bodies never vanish (the fallback that justified bbox fill)', () => {
    /** A stub engine exposing only what the rasteriser reads. */
    function engineOf(body, type = 'ramp') {
        const obj = { type, bodies: [body] };
        return {
            width: 200, height: 100,
            world: { bodies: [body] },
            getObjects: () => new Set([obj]),
        };
    }

    it('a plank thinner than a cell still paints its bounds box', () => {
        // 60 x 1 px sliver across the middle: no cell centre can fall inside it.
        const body = {
            label: '', angle: 0,
            bounds: { min: { x: 40, y: 50 }, max: { x: 100, y: 51 } },
            vertices: [{ x: 40, y: 50 }, { x: 100, y: 50 }, { x: 100, y: 51 }, { x: 40, y: 51 }],
        };
        const view = renderGrid(engineOf(body), { cell: 8 });
        const painted = view.lines.slice(1, -3).join('').replace(/[#.]/g, '');
        expect(painted.length).toBeGreaterThan(0); // it is on the map, not missing
        expect(painted).toMatch(/=/); // and a horizontal ramp reads flat
    });

    it('a normal body paints its outline and leaves its bbox corners empty', () => {
        const body = {
            label: '', angle: 0,
            bounds: { min: { x: 40, y: 44 }, max: { x: 100, y: 56 } },
            vertices: [{ x: 40, y: 44 }, { x: 100, y: 44 }, { x: 100, y: 56 }, { x: 40, y: 56 }],
        };
        const view = renderGrid(engineOf(body), { cell: 8 });
        const rows = view.lines.slice(1, -3).map((l) => l.slice(1, -1));
        // 12px tall in 8px cells: the top and bottom cell rows hold no centre.
        const paintedRows = rows.filter((r) => /[^.]/.test(r));
        expect(paintedRows.length).toBeGreaterThan(0);
        expect(paintedRows.length).toBeLessThanOrEqual(2);
    });
});
