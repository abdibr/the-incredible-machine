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
- **Object-level query** — `queryObjectsByType(type)` / `queryObjectsByBodyLabel(label)` (ADR 0002 amendment): discovery returning registered game objects instead of raw bodies, filtered by `type` or by owning a labeled body; a pure read over the registry, with opt-in self-exclusion (`excludeOwner`).
- **Overlap zone** — `queryZoneOverlap(referenceBody, zone)` (ADR 0002 amendment): zone matching by bounds intersection instead of centre-inside, so large bodies whose centre is outside a narrow zone are still discovered; ordering/policy/shape identical to `queryZone`.
- **Impulse field** — `applyImpulseField(sourceBody, {zone, range, force, direction?, match?})` (ADR 0002 amendment): the engine's shared directional-force law — source-local rect zone (position-inside or bounds match), linear distance falloff from the source centre, mass-scaled force along a source-local direction (default "up"), wake-on-act in the same call. Fan wind is the first consumer.

## Lifecycle & restore (ADR 0003)

- **Lifecycle contract** — every object goes create → play (`onBeforeUpdate` per step) → restore (`restoreState` across a play/reset cycle) → dispose; optional seams (`onBeforeUpdate`, `restoreState`) are default no-ops on `BaseObject`. A new object type must satisfy the conformance sweep in `tests/object-contract.test.js`.
- **restoreState** — the snapshot-restore seam: `PhysicsEngine.restoreSnapshot()` re-apposes bodies by body id, then calls `restoreState` on body-id-matched objects for behavioral state only (never positions). Transient state resets "cycles start clean" (Bucket catches, Spring trigger, Trampoline stretch, Mouse cooldowns); Gear is snapshot-faithful (drive from the serialize ride-along).
- **Dual restore paths** — *physics restore* (`GameLoop.reset()`): same instances, body-id matched, `restoreState` seam. *Placed restore* (`js/reset/levelReset.js`): fresh deserialize from the placed snapshot — construction IS the restore, new ids.
- **loadCustom** — the only seam for ad-hoc level data (editor JSON import): installs `LevelManager._currentLevel` and emits `level:loaded` exactly like `loadLevel(id)`; UI never emits `level:loaded` directly.
## Runtime constraint links (ADR 0004)

- **Constraint link** — a Matter constraint created and managed by `PhysicsEngine` (`attachConstraint`/`detachConstraint`/`getAttachedConstraints`) between two registered objects' bodies; individually detachable at runtime.
- **Object-owned constraint** — a constraint a game object builds for its own structure (rope segment chains); never registered by the engine, not detachable through the link seam, removed wholesale with its object.
- **Co-termination** — the engine policy that removing an object detaches every link endpoined at its bodies: an orphaned endpoint would drag the survivor toward a dead body forever.
- **Link record** — the plain-data capture of a link's effective parameters (body ids, anchor points, stiffness, damping, length) that rides the snapshot seam (ADR 0003).

## Rope connector (ADR 0005)

- **Endpoint (rope)** — one of a rope's two tying ends: 0 = the static start anchor, 1 = the free-chain last segment (no end anchor body exists). Tied with `attachEndpoint`; re-laid wholesale with `setEndpoints` (edit-time only).
- **Attachment point** — a named, body-borne tying spot an object offers: `attachmentPoints` → `{ id, body, offset }`, world position via `getAttachmentWorldPoint(id)`. Contract on `BaseObject` (default none); Balloon offers `knot` (gone when popped), Bucket offers `rim`.
- **Knot** — one live rope-side tie `{ target, pointId }`, stored per endpoint (several may share an endpoint; one point may serve several ropes). Live refs only — tokens never live in runtime state.
- **Knot reconcile** — the per-step convergence in `Rope.onBeforeUpdate`: realize missing knots as length-0, stiffness-0.9 engine links (offset as `pointB`), drop engine links that no longer match a knot, prune refs whose target popped/disposed/no longer registered. A severed rope realizes nothing.
- **Ordinal token** — a knot's serialized form (`{ endpoint, targetType, targetOrdinal, pointId }`), written only by the board annotator `levelReset.serializePlacedBoard` (rope rows may carry `attachments`; `Rope.serialize()` never emits knots); `targetOrdinal` indexes the full board snapshot array (fixed objects first, placed parts after — stable order).
- **Two-phase bind** — `restorePlacedFromSnapshot` deserializes *every* row first, then ropes resolve their tokens against the rebuilt board (`bindAttachment`); board/row count disagreement binds nothing (warned); unresolvable tokens drop (warned); a severed rope binds nothing.
- **Weld constraint** — a stiffness-1 distance constraint an object builds to hold its own dynamic parts in shape (Bucket: wall↔wall↔floor triangle + sensor pinned to floor); object-owned, exposed via `constraints`, skipped entirely when the object is fixed. Enables welded-movable containers without compound bodies (collision dispatch stays part-body keyed).
- **`rope:chain-converge`** — event from `Rope.restoreState` when a rewind revives a severed live rope to an intact snapshot: the rebuilding rope announces `{ rope, previous }` and the engine consumer (`_restoreRopeConstraints`) re-adds the rebuilt chain to its world (bus-global; guarded per engine).
- **Snap hint** — drag-time placement feedback while a tool-ghost rope hangs on the cursor: the renderer marks every board attachment point — faint dashed marker beyond reach, bright marker + tie-line when a clamped drop would tie. Gated by `ROPE_SNAP_RADIUS` (exported from `Rope.js`, shared with the DragDropManager placement snap) and suppressed in play modes.
