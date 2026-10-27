/**
 * legend — the glyph table shared by the grid rasteriser and the state views.
 *
 * Every registered object type maps to a 2-char glyph, so painted shapes read
 * as blocks in the ASCII grid. Body-level label overrides keep functional
 * sensors visible (an open bucket mouth must not disappear under its walls).
 *
 * Paint priority decides who wins an overlapping cell — plain bodies paint
 * first, then the candle flame sensor, then the bucket catch sensor, so the
 * bucket's open mouth reads even where its walls overlap the sensor rect.
 */

/** @type {Record<string, string>} 2-char glyph per registered object type */
export const GLYPHS = {
    'ball': 'OO',
    'tennis-ball': 'oo',
    'baseball': 'Oo',
    'ramp': '//',
    'conveyor': '<>',
    'trampoline': 'TT',
    'fan': 'FF',
    'spring': 'SS',
    'gear': 'GG',
    'pulley': 'PP',
    'domino': 'II',
    'balloon': '@o',
    'bucket': 'UU',
    'candle': '^^',
    'rope': '~~',
    'scissors': 'XX',
    'mouse': 'mm',
};

/** @type {Record<string, string>} body-label overrides (functional sensors) */
export const LABEL_GLYPHS = {
    'bucket-sensor': 'vv', // the catch zone — draw inside the bucket mouth
    'candle-flame': 'ff',  // the flame sensor — distinct from the wax
    'spring-platform': '--',
};

/** Higher paint priority paints last (wins the cell). Default 0. */
export const PAINT_PRIORITY = {
    'candle-flame': 1,
    'bucket-sensor': 2,
    'spring-platform': 2,
};

/**
 * Glyph for an object type.
 * @param {string} type
 * @returns {string} 2-char glyph ('??' for unknown types)
 */
export function glyphFor(type) {
    return GLYPHS[type] ?? '??';
}

/**
 * Glyph for a specific body of an object (label overrides win over type).
 * @param {string} type - owning object type
 * @param {string|undefined} label - Matter body label
 * @returns {string} 2-char glyph
 */
export function glyphForBody(type, label) {
    return LABEL_GLYPHS[label] ?? GLYPHS[type] ?? '??';
}

/**
 * Paint priority for a body label (default 0 = plain body).
 * @param {string|undefined} label
 * @returns {number}
 */
export function priorityForBody(label) {
    return label && label in PAINT_PRIORITY ? PAINT_PRIORITY[label] : 0;
}

/**
 * The legend key the describeWorld() output prints under every grid, so a
 * reader (model or human) can decode glyphs without our source.
 * @returns {string[]} printable key lines
 */
export function renderLegendKey() {
    const rows = Object.entries(GLYPHS).map(([type, glyph]) => `  ${glyph}  ${type}`);
    rows.push('  v   bucket catch zone   f  candle flame   -  spring platform');
    rows.push('  #   frame / wall    .   empty    |   10-column ruler mark');
    return rows;
}