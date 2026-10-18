/**
 * Regenerates docs/interactions.md from the interaction table in
 * js/interactions/rules.js. Invoked via `npm run docs:interactions`; a
 * sync test in tests/interactions.test.js verifies the file stays fresh.
 */
import { writeFileSync } from 'node:fs';
import { DEFAULT_INTERACTION_ROWS } from '../js/interactions/rules.js';
import { renderInteractionDoc } from '../js/interactions/docs.js';

const target = new URL('../docs/interactions.md', import.meta.url);
writeFileSync(target, renderInteractionDoc(DEFAULT_INTERACTION_ROWS));
console.log(`docs/interactions.md written (${DEFAULT_INTERACTION_ROWS.length} rows)`);