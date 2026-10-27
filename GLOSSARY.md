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

> Connection UX is being redesigned (ADR 0007, `docs/adr/0007-rope-connection-redesign.md`): explicit click-to-connect replaces all proximity tying, knots generalize to any segment, and a `free-rope` toolbox type joins `rope` — see **Rope redesign (ADR 0007)** below. The engine seams (link realization, token round-trip) stand.

- **Endpoint (rope)** — one of a rope's two tying ends: 0 = the static start anchor, 1 = the free-chain last segment (no end anchor body exists). Tied with `attachEndpoint`; re-laid wholesale with `setEndpoints` (edit-time only). (ADR 0007: tying generalizes to any segment's tie point; endpoints are the chain's end squares.)
- **Attachment point** — a named, body-borne tying spot an object offers: `attachmentPoints` → `{ id, body, offset }`, world position via `getAttachmentWorldPoint(id)`. Contract on `BaseObject` (default none); Balloon offers `knot` (gone when popped), Bucket offers `rim`. (ADR 0007: offered points render as clickable target squares in the connect flow, shown when relevant.)
- **Knot** — one live rope-side tie `{ target, pointId }`, stored per endpoint (several may share an endpoint; one point may serve several ropes). Live refs only — tokens never live in runtime state. (ADR 0007 supersedes the per-endpoint form: a knot lives at any segment's tie point; several may ride one rope across segments.)
- **Knot reconcile** — the per-step convergence in `Rope.onBeforeUpdate`: realize missing knots as length-0, stiffness-0.9 engine links (offset as `pointB`), drop engine links that no longer match a knot, prune refs whose target popped/disposed/no longer registered. A severed rope realizes nothing. (ADR 0007 supersedes the severed case: piece severing has the surviving pieces realize the knots of their own segments.)
- **Ordinal token** — a knot's serialized form (`{ endpoint, targetType, targetOrdinal, pointId }`), written only by the board annotator `levelReset.serializePlacedBoard` (rope rows may carry `attachments`; `Rope.serialize()` never emits knots); `targetOrdinal` indexes the full board snapshot array (fixed objects first, placed parts after — stable order). (ADR 0007 schema: `{ segment, targetType, targetOrdinal, pointId }` — `segment` generalizes the old `endpoint` 0|1; same two-phase bind.)
- **Two-phase bind** — `restorePlacedFromSnapshot` deserializes *every* row first, then ropes resolve their tokens against the rebuilt board (`bindAttachment`); board/row count disagreement binds nothing (warned); unresolvable tokens drop (warned); a severed rope binds nothing.
- **Weld constraint** — a stiffness-1 distance constraint an object builds to hold its own dynamic parts in shape (Bucket: wall↔wall↔floor triangle + sensor pinned to floor); object-owned, exposed via `constraints`, skipped entirely when the object is fixed. Enables welded-movable containers without compound bodies (collision dispatch stays part-body keyed).
- **`rope:chain-converge`** — event from `Rope.restoreState` when a rewind revives a severed live rope to an intact snapshot: the rebuilding rope announces `{ rope, previous }` and the engine consumer (`_restoreRopeConstraints`) re-adds the rebuilt chain to its world (bus-global; guarded per engine).
- **Snap hint** — drag-time placement feedback while a tool-ghost rope hangs on the cursor: the renderer marks every board attachment point — faint dashed marker beyond reach, bright marker + tie-line when a clamped drop would tie. Gated by `ROPE_SNAP_RADIUS` (exported from `Rope.js`, shared with the DragDropManager placement snap) and suppressed in play modes. (ADR 0007: superseded — proximity tying and all snap/attract hints are removed in favor of the explicit connect flow.)

## Rope redesign (ADR 0007)

Decided, not yet built: the rope connection redesign (`docs/adr/0007-rope-connection-redesign.md`, the record the design grilling settled) lands across the fork's rope-redesign ticket set. New terms:

- **Connect flow** — the explicit click-to-connect interaction replacing ALL proximity tying: rope tie points render square handles, attachment-bearing objects render target squares when relevant; clicking a rope square seeks (preview line follows the cursor, valid targets glow), clicking a glowing target ties, Esc / re-click cancels, clicking a tied square unties (target stays). Lives in its own module that the drag-drop handler delegates to; the renderer draws squares, preview, glow. Edit-only — hidden in PLAY, in-flight seek cancelled at the last settled state on stage change.
- **Bundle** — the free rope's inert pre-tie form: a static coiled graphic with exactly one square entry point and no physics bodies (doesn't fall, can't be cut in play); selectable/movable via drawn bounds. First tie unrolls it into a chain hanging from the tie point; untying its only knot re-bundles it; deleting an untied bundle removes just the graphic + row.
- **Segment tie point** — any chain segment's addressable tying point (square handle); a knot token's `segment` index addresses it, generalizing the old `endpoint` 0|1. Mid-chain knots and rope-to-rope knots become first-class; the pinned rope is fixed-length (100 px default drop, length frozen on first tie, beyond-reach refusal) while the free rope re-lays/extends to any demanded span.
- **Sheave** — future-routing vocabulary: a grooved guide the rope's path bends over. Routing (a separate router object, future ADR) is a deterministic geometric rule rendered visibly — never serialized as a knot token, re-derived from geometry on restore. Pulleys expose no attachment squares; routed ropes sever whole-rope (overrides piece severing).

## Bug files (ADR 0006)

- **Bug file** — the exported JSON record of one sandbox visit: header (`schemaVersion`, `fileId`, engine facts, notes) + `build[]` + `runs[]`. Downloads as `bugfile-<fileId>.json` from the Editor panel; working copies live in gitignored `.scratch/bugfiles/`; graduated files live **verbatim** in `tests/fixtures/bugfiles/` and are replayed by the suite as regressions.
- **Session recorder** — `js/recorder/SessionRecorder.js` (DOM-free core + `browser.js` shims): always-on in SANDBOX; arms on `MENU → SANDBOX`, disarms when the visit leaves the sandbox family; the crash mirror makes sessions recoverable after a reload.
- **Build trace** — the `build[]` edit-event narrative with per-action object snapshots (rope knots as narrative tokens, ref `type#<instanceId>`); diagnostic only — never re-executed.
- **Run** — one play cycle inside a session: play-start **board snapshot** (the authoritative replay source) + the raw recorded dt stream + normalized events + sampled poses (every 6th tick default, dense = every tick, rolling budget, `endedBy` marker). Runs open on `loop:play` while stopped; pause/resume stays inside the run.
- **RefId** — the cross-session stable object reference: a board row's `customId` when it has one, else `type@<boardOrdinal>` (board order is what `serializePlacedBoard` annotates against). Matter body ids never leave a session.
- **Divergence report** — the harness's first record-vs-replay mismatch over the *replayable* topics (physics verdicts + canonical-ordered collision pairs) plus pose rows compared by tick; `node scripts/replay-bugfile.mjs <file>` prints it and exits 1 on any divergence.
- **`physics:collision`** — the recorder file's collision row, captured by the recorder's own `Matter.Events` hook with canonical pair ordering (Matter's a/b orientation is emergent, not stable across sessions). NOT a bus topic — bus dispatch stays matrix-only (ADR 0001).
- **Events-only mirror** — the ~2 s throttled `localStorage` projection (header + notes + build + run events + dt stream, never poses) from which a crashed/reloaded session is recoverable and exportable.

## Goals & editor (issues #11, #63, #66, #67, #68)

- **Goal zone** — the object (a bucket) whose named id equals `goal.zoneId`; `GoalChecker` wins on it via `bucket:caught`. Resolved by one shared helper, `resolveGoalZoneObject`, so the editor readout, the renderer and Save can never disagree about which object it is.
- **Goal-zone marker** — the dashed frame + "GOAL" caption the renderer draws around the goal zone in edit modes only. Live-view semantics: a loaded level marks only its own `goal.zoneId` object (nothing if that zone is gone); a goal-less sandbox (#63) marks the unnamed fixed bucket the next Save would stamp.
- **Goal readout** — the Editor panel's plain-language goal status: the live session line (goal-less until Load Level; warns when a loaded zone matches nothing) and the next-save line ("Save Level will use…", sandbox stamp-fallback semantics). Refreshed on enter, select change, level load and board changes.
- **Stamp fallback** — the sandbox rule for a zone without an explicit match: the FIRST unnamed fixed bucket, exactly the one `stampGoalZoneIds` names `bucket-goal` on Save. A "save view" (readout save-line) uses it; a "live view" (readout live-line, marker on loaded levels) never does.
- **Selection handle set** — which selection affordances a part offers, and which move/rotate/delete verbs are accepted: one state-driven policy in `js/ui/selectionHandles.js` (part state × stage posture, issues #68/#67). The renderer derives both what it draws and what it hit-tests from it; the DragDropManager gates its verbs with the same rows — offering, drawing, hit-testing and interacting can never disagree. The anchored part (#67) is one such row.
- **Sandbox authoring** — the SANDBOX posture that edits scenery in place: fixed parts keep their full handle set there (dragging a pinned goal bucket IS the #66 goal-zone authoring move), while every other stage leaves a pinned part only its pin handle — the unpin escape hatch. Same boundary for anchored parts, with the anchor handle as the un-anchor escape.
- **Anchored part** — the third part state (issue #67), beside **pinned scenery**: placed by the author in the sandbox (⚓ selection handle or A key), refused to the player in the edit stage (selection works; move/rotate/delete never start), yet physically dynamic at play — gravity applies, it can fall, roll, be hit and be caught. Anchoring never statics bodies (that distinction is the whole point); the three states are mutually exclusive through the BaseObject accessors (pinning absorbs the anchor, anchoring un-pins). Rows carry the `isAnchored` marker through serialize/save inside `fixedObjects`, and the rebuild-row rule (`levelObjectOptions`) honors it in every board reload/rewind. Rope/free-rope are out of scope until the connector redesign. An anchored bucket cannot be the goal zone — goal zones are pinned buckets.
