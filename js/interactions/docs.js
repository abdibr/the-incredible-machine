/**
 * docs.js — markdown rendering of the interaction table.
 *
 * Shared by scripts/generate-interactions-doc.mjs (writes docs/interactions.md)
 * and the sync test in tests/interactions.test.js (fails when the file drifts
 * from js/interactions/rules.js).
 */

/** Render one matcher side as a short human phrase. */
function describeSide(matcher) {
    if (!matcher) return 'any object';
    const parts = [];
    if (matcher.type) parts.push(`\`${matcher.type}\``);
    if (matcher.label) parts.push(`via label \`${matcher.label}\``);
    if (matcher.match) parts.push(matcher.match);
    return parts.join(' · ');
}

/**
 * Render the full table as markdown.
 * @param {object[]} rows - the rows from js/interactions/rules.js
 * @returns {string} markdown document
 */
export function renderInteractionDoc(rows) {
    const active = rows.filter((row) => !row.docOnly);
    const docOnly = rows.filter((row) => row.docOnly);

    const lines = [];
    lines.push('# Object Interaction Matrix', '');
    lines.push(
        'Generated from `js/interactions/rules.js` — run `npm run docs:interactions` to regenerate.',
        'A sync test in `tests/interactions.test.js` fails when this file drifts from the table.',
        ''
    );
    lines.push('## How dispatch works', '');
    lines.push(
        '`PhysicsEngine` maps each Matter `collisionStart` pair to its two owner objects and calls',
        '`InteractionMatrix.resolve(ownerA, ownerB, pair)`.',
        'Rows are unordered pair declarations — `resolve` tries both orientations and calls the handler',
        'with the canonical (actor = reactor, target = counterpart) order. Rows fire in registration order;',
        'several may legitimately fire for the same pair. Rows marked `docOnly` never dispatch.',
        '',
        'State-dependent decisions (`predicate` matchers) delegate to decision methods on the owning',
        'object (`isCatchContact`, `isSnapTrigger`, `isRelevantContact`, `isLaunchTrigger`), keeping',
        'local state local. Effect code routes to the object\'s public behavior methods.',
        ''
    );
    lines.push('## Reaction rows', '');
    lines.push('| Row | Reactor (actor) | Counterpart (target) | Effect | Per-row test |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const row of active) {
        lines.push(
            `| \`${row.id}\` | ${describeSide(row.actor)} | ${describeSide(row.target)} | ${row.summary} | ${row.test ?? '—'} |`
        );
    }
    lines.push('', '## Documented null-participants', '');
    lines.push('These rows are part of the matrix documentation but never dispatch:');
    lines.push('');
    for (const row of docOnly) {
        lines.push(`- **${row.actor.type}** — ${row.summary}`);
    }
    lines.push('');
    return lines.join('\n');
}