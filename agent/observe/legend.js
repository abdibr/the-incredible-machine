/**
 * legend — the glyph table shared by the grid rasteriser and the state views.
 *
 * Every registered object type maps to a 2-char glyph, so painted shapes read
 * as blocks in the ASCII grid. Body-level label overrides keep functional
 * sensors visible (an open bucket mouth must not disappear under its walls).
 *
 * Long parts that the player turns — ramps today — read their TILT instead of
 * a fixed pair of slashes: a ramp drawn `//` whatever its rotation told the
 * model to slide the ball the wrong way, so `orientedCell()` picks the
 * character from the body angle in screen space (y grows downward), and the
 * painted plank then runs the way it will actually deflect.
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
    'ramp': '//', // the fallback when a caller has no angle; orientedCell() wins in the grid
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
 * Tilt-reading glyphs. `down` is the cell for a plank whose right end sits
 * lower (screen-space angle > 0), `up` its mirror, `flat` and `steep` the
 * near-horizontal / near-vertical cases.
 * @type {Record<string, {flat: string, down: string, up: string, steep: string}>}
 */
export const ORIENTED_GLYPHS = {
    ramp: { flat: '=', down: '\\', up: '/', steep: '|' },
};

/** |sin(angle)| at or below which a plank reads flat (~10°) */
export const FLAT_SLOPE = 0.18;
/** |sin(angle)| at or above which a plank reads vertical (~57°) */
export const STEEP_SLOPE = 0.84;

/** Legend row for each tilt-reading type (the plain `glyph  type` row would lie). */
const ORIENTED_LEGEND = {
    ramp: '\\/  ramp - the glyph follows the tilt: \\ descends to the right, / ascends to the right, = flat, | steep',
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
 * The tilt character for a body, or null when its type does not read tilt.
 * Angle is the Matter body angle in screen space (y grows down), so a
 * positive sin means the body's long axis descends to the right.
 * @param {string} type
 * @param {number|undefined} angle - radians
 * @returns {string|null} one cell character
 */
export function orientedCell(type, angle) {
    const set = ORIENTED_GLYPHS[type];
    if (!set) return null;
    const slope = Math.sin(angle ?? 0);
    const steepness = Math.abs(slope);
    if (steepness <= FLAT_SLOPE) return set.flat;
    if (steepness >= STEEP_SLOPE) return set.steep;
    return slope > 0 ? set.down : set.up;
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
    const rows = Object.entries(GLYPHS).map(([type, glyph]) =>
        (type in ORIENTED_GLYPHS ? `  ${ORIENTED_LEGEND[type]}` : `  ${glyph}  ${type}`));
    rows.push('  v   bucket catch zone   f  candle flame   -  spring platform');
    rows.push('  #   frame / wall    .   empty    |   10-column ruler mark');
    return rows;
}
