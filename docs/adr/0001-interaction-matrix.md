# ADR 0001 — Interaction Matrix as the single dispatch point for object-to-object reactions

- **Date:** 2026-10-18
- **Status:** Accepted
- **Scope:** Candidate C1 of the interaction-documentation architecture review (improve-codebase-architecture); folds in C4 (walls/boundaries as documented null-participants) and C5 (per-row test obligation).

## Context

Before this change, deciding "what reacts to this contact?" was scattered across the codebase:

- An `onCollision(other, pair)` hook on `BaseObject` (default no-op) implemented in 8 of the 16 object classes, each re-deciding its own gating with different vocabularies: object `type` strings, Matter **body labels**, and Matter **body identity**.
- `PhysicsEngine` double-dispatched every `collisionStart` pair into both objects (`objA.onCollision(objB, pair)` and vice versa), so mutual reactions (e.g. meshing gears) relied on dispatch order.
- Six objects also ran per-frame world scans (`onBeforeUpdate`) for interactions that are conceptually collision-driven.
- Nothing recorded which pairings exist, which are deliberate non-pairings, or which bodies (walls, sensors) take part. Concrete defects found during the review: rope severed by candle **wax** (no label gate), gears reaching through to another instance's private `_angularSpeed`.

## Decision

1. **`js/interactions/InteractionMatrix.js` + `js/interactions/rules.js`** hold the entire registry of reactions. Each row is an unordered pair declaration: `{ id, summary, actor, target, handler, test }` with matchers `{ type, label?, predicate? }`.
2. **Engine keeps the plumbing; matrix owns the rules; objects act.** `PhysicsEngine._setupCollisionEvents` maps pair bodies to owner objects and calls `interactions.resolve(objA, objB, pair)` once. The matrix tries both orientations per row (unordered `a ✕ b` ≡ `b ✕ a`), fires every matching row in registration order, and handlers route to the acting object's **public behavior methods** (`rope.sever()`, `balloon.pop()`, `bucket.registerCatch()`, `gear.meshWith()`, `scissors.snapShut()`, `mouse.reverseFromContact()`, `spring.armLaunch()`, `trampoline.stretch()`).
3. **Matching vocabulary:** rows key on object `type`, refined by Matter **label** (`'candle-flame'`, `'scissors-blade'` — pair-wide, since labels are unique per object family) and by `predicate` matchers that delegate to decision methods living on the owning object (`isCatchContact`, `isSnapTrigger`, `isRelevantContact`, `isLaunchTrigger`). This keeps local state local while centralizing *who reacts to whom*.
4. **`onCollision` is deleted** from `BaseObject` and all 8 implementers. There is no dual path; behavior state and animation (`onBeforeUpdate`) stay on the objects.
5. **Per-row pairwise tests** in `tests/interactions.test.js` drive the matrix seam; the row's `test` field names its test. Direct-onCollision test call sites were rewritten to the matrix (`mouse.test.js`, `scissors.test.js`).
6. **Walls are documented null-participants, not an adapter.** Boundary bodies are never mapped to objects, so a wall `collisionStart` pair never enters `resolve()` at all — the engine's owner lookup returns null and dispatch is skipped (`PhysicsEngine._setupCollisionEvents`). `docOnly: true` rows in the table (walls; silent classes Ball/Ramp/Conveyor/Fan/Domino/Pulley/Candle) record the deliberate empty cells, each pinned by its named contract test — 'boundary walls are null participants' drives a live engine with a wildcard spy row and proves wall contacts fire zero rows. Because nothing in the matrix can react to a wall contact, the two deliberate consumers of the wall bodies live outside it: Mouse's own ground/wall static probes, and `GoalChecker._checkOffWorld`, which detects a playfield escape (object below the canvas, e.g. tunneled past a wall) as `goal:failed`.
7. **Documentation is generated from the table:** `npm run docs:interactions` → `docs/interactions.md`; a sync test fails when the file drifts from `rules.js`.

## Bugs fixed by the migration (behavior changes)

- **Rope no longer severs on candle wax.** The row requires the `'candle-flame'` labeled body in the pair; the old `type === 'candle'` check cut on wax too. Covered by a regression test.
- **Gear meshing no longer reaches through to `other._angularSpeed`.** `Gear.meshWith()` / `applyGearDrive()` form a public seam; the row's handler fires both directions, reproducing the old double-dispatch outcome exactly (verified for asymmetric speeds).

## Behavior deliberately preserved (with notes)

- **Balloon pops on any candle body, wax included** (`balloon-candle` row). The old Balloon check keyed on the candle object. Restricting flame-only would be a gameplay change — recorded as a candidate refinement, not made here.
- Balloon pops on any scissors body (blade sensors or handles); rope snap-in-fan and closed-blade semantics unchanged; mouse debounce/front-facing/head-on gates, bucket dedupe-by-id and catchType filter, spring cooldown — all preserved verbatim via decision methods.

## Consequences

- **One place answers "what reacts to what"** — the table *is* the documentation (`docs/interactions.md` renders it), and gaps are visible as empty cells, not folklore.
- New interactions need exactly one row + one test; no engine changes.
- Cost: each collision `collisionStart` pair walks the row list (≤ 12 rows, cheap at this scale).
- Trade-off: predicate matchers assume **real object instances** — `resolve()` must only receive registered `BaseObject`s (the engine guarantees this; tests must use real instances too, since both orientations are evaluated).
- Rows only cover `collisionStart`. Persistent/geometry interactions (conveyor surface, fan wind, rope constraints) legitimately remain in `onBeforeUpdate`.

## Out of scope (follow-up candidates)

- Sleeping-body wake asymmetry: `Body.applyForce` users (Fan/Conveyor/Spring/Balloon) don't wake sleepers; only Gear/Pulley wake (candidate C2).
- Lifecycle contract: `restoreState` parity for `Bucket._caught` / `Spring._triggered/_cooldown`; dead `onAfterUpdate` hook; `EditorPanel` emitting `level:loaded` past `LevelManager` (candidate C3).
- collisionActive/collisionEnd rows; migrating goal-catch matching onto the matrix.