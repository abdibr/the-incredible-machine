# Glossary — The Incredible Machine (web clone)

Single-context domain vocabulary. Architecture decisions live in `docs/adr/`; the generated interaction reference is `docs/interactions.md`. Keep entries short; this file is the term index for the whole codebase.

## Objects & bodies

- **Object (game object)** — one interactive thing in the puzzle; a `BaseObject` subclass instance with a stable `type` string (e.g. `'rope'`, `'scissors'`). Lives in `js/objects/`.
- **Body** — a Matter.js rigid body owned by an object; an object may own several (e.g. Scissors: two blade sensors + two solid handles).
- **Body label** — the Matter body's string `label` (e.g. `'candle-flame'`, `'scissors-blade'`, `'bucket-sensor'`). Labels are unique per object family and are the fine-grained discriminator between an object's bodies.
- **Sensor body** — a Matter body with `isSensor: true`: reports collisions, exerts no physical force (candle flame, scissors blades, bucket catch zone).
- **Boundary walls** — the four static playfield walls (`wall-floor/left/right/ceiling`) created inside `PhysicsEngine`. They are *not mapped to objects*, so they never enter interaction dispatch — documented null-participants (ADR 0001 decision 6). Objects cannot react to wall contacts; the deliberate wall consumers outside the matrix are Mouse's static-body probes and `GoalChecker`'s off-world (tunneling → `goal:failed`) check.
- **Custom id** — a named id from level JSON (`"id": "bucket-goal"`), separate from the auto-increment instance `id` used for snapshots/dedup.

## Interaction matrix

- **Interaction matrix** — `js/interactions/` (`InteractionMatrix.js` + `rules.js`): the single registry of object-to-object reactions; `PhysicsEngine` feeds `collisionStart` pairs into `resolve()`.
- **Row** — one declaration in `rules.js`: `{ id, summary, actor, target, handler, test }`. The row is the unit of documentation and testing.
- **Actor / target** — the reacting object / its counterpart. Handlers receive them in canonical `(actor, target)` order.
- **Matcher** — a row side's accept condition: `{ type, label?, predicate? }`; an empty matcher is a wildcard. `type` keys on the object type string; `label` requires the collision pair to contain that labeled body; `predicate` delegates to a decision method on the object.
- **Handler** — `(actor, target, pair) => void`; routes to the actor's public behavior method. Behavior itself stays on the object.
- **Decision method** — object-owned, state-dependent accept check used by predicate matchers (`Bucket.isCatchContact`, `Scissors.isSnapTrigger`, `Mouse.isRelevantContact`, `Spring.isLaunchTrigger`). Pure: no state changes.
- **Behavior method** — object-owned action invoked by handlers (`rope.sever()`, `balloon.pop()`, `bucket.registerCatch()`, `gear.meshWith()`, `scissors.snapShut()`, `mouse.reverseFromContact()`, `spring.armLaunch()`, `trampoline.stretch()`).
- **Canonical orientation** — rows are unordered pairs; `resolve` tries both orientations so dispatch order never matters.
- **docOnly row** — a row with `docOnly: true` that never dispatches; documents deliberate empty cells (boundary walls, silent classes).
- **Silent class** — an object class that declares no reaction rows (Ball, Ramp, Conveyor, Fan, Domino, Pulley, Candle): contacts affect *other* objects, never them.
- **collisionStart pair** — one Matter contact event between two bodies; the only dispatch point the matrix covers. Persistent/geometry interactions (conveyor surface, fan wind) legitimately live in `onBeforeUpdate`.

## Engine & lifecycle (history)

- **onCollision hook** — the pre-matrix per-object collision hook; *removed* 2026-10-18 (ADR 0001). Do not reintroduce; add a row instead.
- **Snapshot / restoreState** — play/reset determinism seam: `PhysicsEngine.takeSnapshot/restoreSnapshot` restores bodies; objects with behavioral state re-apply it via `restoreState` (Mouse, Pulley, Scissors).
- **Event bus** — `js/EventBus.js` decoupled events (`rope:severed`, `balloon:popped`, `bucket:caught`, level flow). PhysicsEngine consumes severing/removal; GoalChecker consumes catches.

## Discovery & wake (ADR 0002)

- **Discovery seam** — the only way game objects scan the world: `PhysicsEngine.queryTouching()` (SAT-precision contacts), `queryZone()` (position-in-local-rect), `queryPoint()` (vertex-precise point probe). Objects never call Matter query APIs directly.
- **Wake-on-act** — an object wakes (`wakeBodies()`) exactly the bodies it acts on, right before applying a force/constraint: asleep bodies skip force integration in Matter, so acting without waking silently does nothing.
- **Discovery never wakes** — the query methods are pure reads; sleeping candidates come back asleep. Sleep state has a single writer: `wakeBodies()`.
- **Movable-non-wall-non-own policy** — default discovery matches dynamic bodies only; boundary walls (`wall-*` labels) and statics are opt-ins per call (`includeWalls` / `includeStatic`), and a caller never discovers its own bodies.

## Lifecycle & restore (ADR 0003)

- **Lifecycle contract** — every object goes create → play (`onBeforeUpdate` per step) → restore (`restoreState` across a play/reset cycle) → dispose; optional seams (`onBeforeUpdate`, `restoreState`) are default no-ops on `BaseObject`. A new object type must satisfy the conformance sweep in `tests/object-contract.test.js`.
- **restoreState** — the snapshot-restore seam: `PhysicsEngine.restoreSnapshot()` re-apposes bodies by body id, then calls `restoreState` on body-id-matched objects for behavioral state only (never positions). Transient state resets "cycles start clean" (Bucket catches, Spring trigger, Trampoline stretch, Mouse cooldowns); Gear is snapshot-faithful (drive from the serialize ride-along).
- **Dual restore paths** — *physics restore* (`GameLoop.reset()`): same instances, body-id matched, `restoreState` seam. *Placed restore* (`js/reset/levelReset.js`): fresh deserialize from the placed snapshot — construction IS the restore, new ids.
- **loadCustom** — the only seam for ad-hoc level data (editor JSON import): installs `LevelManager._currentLevel` and emits `level:loaded` exactly like `loadLevel(id)`; UI never emits `level:loaded` directly.