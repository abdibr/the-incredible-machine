import { describe, it, expect, afterEach } from 'vitest';
import { AgentSession } from '../../agent/session.js';
import { renderGrid, pickAutoCell, AUTO_CELLS } from '../../agent/observe/grid.js';
import { glyphForBody } from '../../agent/observe/legend.js';

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

    it('unknown object types get the fallback glyph', () => {
        expect(glyphForBody('ferris-wheel', undefined)).toBe('??');
        expect(glyphForBody('ball', undefined)).toBe('OO');
    });
});