/**
 * InteractionMatrix — the single registry of who reacts to whom.
 *
 * Every object-to-object reaction in the game is declared as one row in
 * `rules.js`; the engine feeds each Matter collisionStart pair through
 * `resolve()` and the matrix routes it to the owning object's behavior
 * method. Nothing else in the codebase decides "should I react to this
 * contact?" — objects no longer carry `onCollision`.
 *
 * A row is unordered: pair rows key on `(a, b)` regardless of which side
 * Matter reported first, and `resolve` tries both orientations and calls
 * the handler with the canonical `(actor, target)` order the row declares.
 * Several rows may legitimately fire for the same pair (e.g. a trampoline
 * also stretching under a candle), so all matching rows fire in
 * registration order.
 *
 * Rows are also the documentation source: `describe()` feeds
 * `docs/interactions.md` (generated via `scripts/generate-interactions-doc.mjs`;
 * a sync test fails when the file drifts from the table).
 */

export class InteractionMatrix {
    /**
     * @param {object[]} [rows=[]] - initial rows (see rules.js for shape)
     */
    constructor(rows = []) {
        /** @type {object[]} */
        this._rows = [];
        for (const row of rows) this.define(row);
    }

    /**
     * Register a row. Rows are matched in registration order.
     * @param {object} row - { id, summary, actor, target, handler, [test], [docOnly] }
     */
    define(row) {
        if (!row.id) throw new Error('Interaction row missing id');
        if (!row.actor || !row.target) throw new Error(`Interaction row ${row.id} missing actor/target matchers`);
        if (!row.docOnly && typeof row.handler !== 'function') {
            throw new Error(`Interaction row ${row.id} missing handler`);
        }
        this._rows.push(row);
    }

    /**
     * Route one collision pair: fire every row that matches, with the
     * canonical orientation the row declares (actor first).
     *
     * @param {import('../objects/BaseObject.js').default} a - owner of pair.bodyA (or null/undefined-safe object)
     * @param {import('../objects/BaseObject.js').default} b - owner of pair.bodyB
     * @param {Matter.Pair} pair - the raw Matter pair
     * @returns {string[]} ids of the rows that fired (registration order)
     */
    resolve(a, b, pair) {
        const fired = [];
        for (const row of this._rows) {
            if (row.docOnly) continue; // documentation-only rows never dispatch

            // Orientation 1: a is the actor, b the target.
            if (matches(row.actor, a, b, pair) && matches(row.target, b, a, pair)) {
                row.handler(a, b, pair);
                fired.push(row.id);
                continue;
            }
            // Orientation 2: b is the actor, a the target.
            if (matches(row.actor, b, a, pair) && matches(row.target, a, b, pair)) {
                row.handler(b, a, pair);
                fired.push(row.id);
            }
        }
        return fired;
    }

    /**
     * Human-readable view of the table for docs/tests.
     * @returns {object[]} the rows in registration order (live references)
     */
    get rows() {
        return this._rows;
    }
}

/**
 * Does `matcher` accept this object (with its `other` and `pair` for context)?
 *
 * Matcher shape (all fields optional):
 * - `{ type: 'gel' }`                — object type equality
 * - `{ label: 'candle-flame' }`      — the collision pair must contain a body
 *                                      with this Matter label (labels are unique
 *                                      per object family, so pair-wide is safe)
 * - `{ predicate: (obj, other, pair) => bool }` — state-dependent decision;
 *                                      should delegate to a decision method on
 *                                      the object to stay out of this table
 * - `{}` / omitted fields            — wildcard: matches any object
 *
 * @param {object} matcher
 * @param {import('../objects/BaseObject.js').default} obj - candidate
 * @param {import('../objects/BaseObject.js').default} other - the counterpart object
 * @param {Matter.Pair} pair
 * @returns {boolean}
 */
function matches(matcher, obj, other, pair) {
    if (!matcher) return true;

    if (matcher.type && obj.type !== matcher.type) return false;

    if (matcher.label) {
        const labelled = pair.bodyA?.label === matcher.label || pair.bodyB?.label === matcher.label;
        if (!labelled) return false;
    }

    if (matcher.predicate && !matcher.predicate(obj, other, pair)) return false;

    return true;
}

export default InteractionMatrix;