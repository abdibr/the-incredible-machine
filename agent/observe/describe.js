/**
 * describeWorld — the one observation entry point.
 *
 * Everything the solver and a future LLM see comes out of this one function:
 * level header, rasterised grid (+ legend key), state table and relation
 * graph. The output is a prompt-ready string.
 */

import { renderGrid } from './grid.js';
import { renderState } from './state.js';
import { renderGraph } from './graph.js';
import { renderLegendKey } from './legend.js';

const DEG = 180 / Math.PI;

/**
 * @param {import('../session.js').AgentSession} session
 * @param {object} [options]
 * @param {number|'auto'|'full'} [options.cell] grid resolution ('auto' picks
 *        the smallest legible cell; 'full' forces the precise 8px map)
 * @param {boolean} [options.grid] include the ASCII grid
 * @param {boolean} [options.key] include the legend key under the grid
 * @param {boolean} [options.state] include the state table
 * @param {boolean} [options.graph] include the relation graph
 * @returns {string}
 */
export function describeWorld(session, { cell = 'auto', grid = true, key = true, state = true, graph = true } = {}) {
    const level = session.levelData;
    const lines = [];
    if (level) {
        const goal = level.goal ?? null;
        const goalText = goal ? ` (${goal.type}, target ${goal.targetType}, zone ${goal.zoneId})` : '';
        lines.push(`${level.id ?? '(ad-hoc level)'} — ${level.name ?? 'unnamed'}${goalText}`);
    } else {
        lines.push('(no level loaded)');
    }

    if (!session.engine) {
        lines.push('(world not built)');
        return lines.join('\n').trimEnd();
    }

    if (grid) {
        const view = renderGrid(session.engine, { cell });
        lines.push(
            '',
            `world ${session.width}×${session.height}, cell ${view.cellSize}px (cols ${view.cols} × rows ${view.rows})`,
            ...view.lines,
        );
        if (key) lines.push('legend:', ...renderLegendKey());
    }

    if (state) {
        lines.push('state:', ...renderState(session.engine, session.goal));
    }

    if (graph) {
        lines.push(...renderGraph(session));
    }

    // Trim the trailing blank line; interior blanks stay significant.
    return lines.join('\n').replace(/\n+$/, '');
}