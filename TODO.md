# Work Plan — Broken Functionality Fixes

Audit date: 2026-10-18
Scope: Read-only audit of the full codebase (45 files). No code changed yet.
Baseline: `npm test` -> 22 passed (Vitest 4; note `--reporter=basic` was removed, use plain `npm test`).
Architecture verdict: core engine/renderer/toolbox are sound; breakage is in the integration layer - features are half-wired.

Legend: [ ] = todo, [~] = in progress, [x] = done.

---

## Phase 1 - CRITICAL: gameplay blockers (game cannot be played as designed)

### 1.1 Goal system never fires - levels are unwinnable
- [x] Restore named object ids: `customId` field on `BaseObject` (separate from the auto-increment physics `id`), resolved from level JSON `data.id` in every object class's `deserialize()` and in `main.js _setupLevel` via `objectRegistry.create(..., customId: objData.id)`.
- [x] Implement goal checker as `js/goals/GoalChecker.js` (+ `stampGoalZoneIds` editor-save parity helper):
  - [x] Listen on `bucket:caught`: target type must match `goal.targetType` and bucket `customId` must match `goal.zoneId` -> emit `goal:reached { levelId }` (latched once per attempt).
  - [x] Fail condition on `loop:frame`: target body ends up below world height -> emit `goal:failed { levelId, reason }`; re-arms on every `level:loaded` and PLAYING attempt.
- [x] Verify display path: `js/ui/GoalOverlay.js` win ("🎉 Puzzle Complete!") / fail ("😅 Try Again!") overlays — verified live E2E (2026-10-18): win overlay shown on level-01 bucket catch.
- [x] Verify progression path: `js/levels/LevelManager.js` on `goal:reached` -> `markComplete` — console logged `[LevelManager] Completed: level-01`; level-02 unlocked in the level select.
- [x] Wire "Next Level" flow end-to-end (`overlay:next-level` in `main.js` -> `levelManager.loadLevel`): clicked "➡ Next Level" in the win overlay -> level-02 "Across the Gap" loaded.
- [x] EditorPanel parity: custom saved levels hard-code `zoneId: 'bucket-goal'` (`js/ui/EditorPanel.js`) — matches checker convention; `stampGoalZoneIds` stamps unnamed saved buckets.
- Acceptance: level-01, drop ball into bucket, play -> win overlay appears, level marked complete, next level loads. ✅ Verified live E2E 2026-10-18 (boot → level select → #01 → drag ball @ (700,300) → play → catch in bucket → win overlay → next level), plus `npm test`: 11 files / 105 tests pass (`goals.test.js`, `custom-id.test.js`). NOTE: level select shows on boot (MENU) — the level loads only when its card is clicked; coordinate clicks aimed at the canvas/toolbar are swallowed by the level-select overlay while it is open.

### 1.2 Reset destroys the player's machine - iteration loop broken
- [x] `state._savedPlacedSnapshot` is written (`js/main.js:43,157,259`) but never read by anything.
- [x] In `_resetLevel()`, for level modes: restore player-placed objects from `_savedPlacedSnapshot` (deserialize + re-add to render list; bodies re-added on next play) instead of wiping them.
- [x] Sandbox mode: decide intended reset semantics (parts return to edit positions vs. clear all) and implement consistently.
- Acceptance: place parts, play, reset -> parts are back at edit-mode positions; play/reset cycles are repeatable and stable. ✅ (`ticket/08-reset`, snapshot/restore path incl. `PhysicsEngine` id-matched restore)

### 1.3 Rope severing does nothing physically
- [x] `Rope.sever()` (`js/objects/Rope.js:122-127`) only sets a flag and emits `rope:severed` (no listener); its Matter constraints are never removed.
- [x] Add removal path: PhysicsEngine subscribes to `rope:severed` (or rope gets an engine/world hook) and removes `Rope.constraints` from the `Composite`.
- [x] Confirm candle (flame sensor) and scissors collisions reach `Rope.onCollision` -> `sever()` through the existing collision dispatch (wiring already exists in PhysicsEngine).
- Acceptance: rope touching candle flame physically detaches on screen and in physics. ✅ (`ticket/02-rope`, 7 tests green)

### 1.4 Popped balloons leave invisible colliders
- [x] `Balloon.pop()` (`js/objects/Balloon.js:80-84`) only sets `_popped`; `bodies` getter returns `[]` and draw no-ops, but the Matter body stays in the world forever (invisible, still buoyant/colliding).
- [x] On pop: remove `this._body` from the physics world (engine hook or `physics:object-remove-request` event) then dispose.
- Acceptance: popped balloon stops interacting with the world immediately; no phantom body remains. ✅ (`ticket/07-balloon`)

---

## Phase 2 - HIGH: dead controls & one-way event wiring

### 2.1 Speed button is a no-op
- [x] `PlayControls` emits `controls:speed`; no subscriber anywhere. `GameLoop.cycleSpeed()` is only called by unit tests.
- [x] Subscribe in `main.js`: `eventBus.on('controls:speed', () => state.gameLoop.cycleSpeed())`.
- [x] Optional UX: show current speed (button tooltip or debug header).
- Acceptance: clicking fast-forward during play visibly cycles 0.5x / 1x / 2x motion. ✅ (`ticket/04-speed`)

### 2.2 Dead events - wire or prune (document decision per event)
- [x] `loop:frame` (GameLoop) - WIRED: GoalChecker per-frame fail detection (issue #11).
- [x] `physics:collision` (PhysicsEngine) - PRUNED: its only consumer was the balloon ghost test, which now observes Matter `collisionStart` directly.
- [x] `physics:object-added` / `physics:object-removed` (`js/engine/PhysicsEngine.js:75,99`) - PRUNED: no listener anywhere.
- [x] `canvas:resized` (`js/main.js:88`) - PRUNED: renderer reads canvas dimensions per frame.
- [x] `loop:reset` (`js/engine/GameLoop.js:121`) - PRUNED: no listener; reset side-effects happen inline.
- [x] `bucket:caught` - WIRED in 1.1 (GoalChecker).
- [x] `balloon:popped` - WIRED in 1.4 (PhysicsEngine removes the body).
- [x] `rope:severed` - WIRED in 1.3 (PhysicsEngine detaches constraints).
- [x] `controls:speed` - WIRED in 2.1 (main.js -> GameLoop.cycleSpeed; GameLoop also emits `loop:speed`).
- Acceptance: every emitted event has at least one listener, or its emit is removed. ✅ (`ticket/12-dead-events` sweep)

---

## Phase 3 - MEDIUM: object behavior fixes

### 3.1 Fan wind zone broken for rotated fans
- [x] `js/objects/Fan.js:70-79` computes axis-aligned bounds with `halfWidth = FAN_WIDTH`, `halfHeight = windRange` - only correct at angle 0 (e.g. a 90-deg fan projects a tall-narrow zone instead of wide-flat).
- [x] Make rotation-aware: transform each body position into fan-local space (translate/rotate) and use local rectangle test with halfWidth = FAN_WIDTH, halfHeight = windRange/2; keep distance falloff.
- Acceptance: 90-deg-rotated fan blows bodies to its face direction; wind zone matches the drawn wind lines. ✅ (`ticket/06-fan`)

### 3.2 Pulley is not coupled
- [x] `js/objects/Pulley.js:57-76`: each platform hangs from its own fixed world anchor under the pivot with fixed length; no left<->right coupling. "One side up when other goes down" is not implemented.
- [x] Implement true coupling: shared-rope math (transfer length between the two constraints per step) or per-frame force transfer in `onBeforeUpdate` when either platform is loaded.
- Acceptance: adding weight to one platform raises the other. ✅ (`ticket/13-pulley`)

### 3.3 Mouse direction jitter
- [x] `js/objects/Mouse.js:107-112` reverses on collision with ANY non-mouse object (dynamic bodies cause flip-flopping); wall/edge probes only see static bodies.
- [x] Add debounce (cooldown frames) before reversing; only reverse on significant front-facing contacts; optionally account for relative velocity of dynamic bodies.
- Acceptance: mouse walks and pushes light objects deterministically; no rapid oscillation. ✅ (`ticket/09-mouse`; deterministic-play work partly in `ticket/10-snapshot`; engine sleeping left OFF by decision)

### 3.4 Gear physics is cosmetic
- [x] `js/objects/Gear.js`: physics body is a plain static circle; teeth are visual-only; static-body rotation does not push other bodies in Matter.js.
- [x] Decision needed: implement interaction (tangential impulse on contact in `onBeforeUpdate`, or kinematic-dynamic body with motor torque) or document as a known limitation in README/work-log.
- Acceptance: decision documented; if implemented, objects visibly ride the gear teeth. ✅ (`ticket/14-gear`: tangential tooth traction in `onBeforeUpdate`; signature `(engine, dt)`)

### 3.5 Snapshot restore robustness
- [x] `PhysicsEngine.restoreSnapshot` maps `snapshot[i] -> objects[i]` by index - silently corrupts poses if object count/order changed between take and restore (deleted/popped objects).
- [x] Match by body id instead of index, or validate count/order and fail loudly (re-take snapshot) on mismatch.
- Acceptance: deleting an object mid-play, then pausing/resetting, does not teleport other objects. ✅ (`ticket/10-snapshot`: id-matched poses, drift detection via `physics:snapshot-mismatch` + snapshot retake, exact-replay state incl. vertices/positionImpulse/motion/sleepCounter)

---

## Phase 4 - Repo hygiene (all done via `ticket/03-hygiene`)

### 4.1 Merge-conflict markers
- [x] `work-log.md` contains unresolved `<<<<<<< HEAD` markers - resolve and rewrite the log coherently. ✅

### 4.2 Encoding artifacts
- [x] `js/engine/GameLoop.js` and `js/engine/PhysicsEngine.js`: BOM + mojibake (em-dash shown as `ΓÇÓ`-style artifacts) in comments - re-save as clean UTF-8 without BOM and fix the comment text. ✅ (byte-level sweep; also fixed a BOM+mojibake em-dash in `js/render/ObjectRenderer.js`)

### 4.3 Dead testing module
- [x] `js/testing/MockObjects.js` (754 lines): `registerMockObjects()` is never called - delete the file, or move under `tests/` if still useful for UI harnesses. ✅ (deleted - superseded by real `registerAllObjects()`)

### 4.4 README accuracy
- [x] `README.md:35` documents `audio/ <- Sound effects`; the folder and any sound system do not exist. Remove from tree or mark "planned". ✅ (removed; `tests/` documented as existing)

### 4.5 Test/runner notes
- [x] Document in README/work-log: Vitest 4 removed `--reporter=basic`; use plain `npm test`. ✅
- [x] PowerShell quirk: npm stderr can surface as `NativeCommandError` noise; prefer `cmd /c npm test`. ✅

---

## Phase 5 - Reviewer follow-ups (post-integration review, 2026-10-18)

Closing reviewer pass over `main...integration/broken-functionality-fixes` (suite 11 files / 105 tests green at review time). Finding #1 ([major], goal-overlay handlers left the GameLoop RUNNING across mode switches) was fixed immediately by the orchestrator; the rest are minor/latent backlogs:

- [x] `js/goals/GoalChecker.js` `init()`: four permanent eventBus subscriptions, no re-init guard or `dispose()` - capture unsubscribes, add `dispose()` or guard init-once. — ✅ 2026-10-18 `ticket/17-goal-lifecycle`: `init()` is guarded init-once (`_unsubscribes.length > 0` short-circuits a second call) and captures the four subscriptions in `_unsubscribes`; the new `dispose()` drains them and clears goal/level state, so a dispose()→init() round-trip re-subscribes exactly once and stacked handlers can no longer double `goal:reached`/`goal:failed`. Three lifecycle tests in `goals.test.js` (double-init, detach-on-dispose, re-init works again).
- [x] `js/engine/PhysicsEngine.js` `restoreState`: equal-count path zips by index before the body-id pose check, so a mid-play remove+add can misapply one object's state to another - compute the body-id pose set first, restore only by id (latent: no production mid-play removal today). — ✅ 2026-10-18 `ticket/15-physics-restore-id`: `restoreSnapshot()` builds a body-id → serialized-state map (`snapByIdSet`) and hands the per-object behavioral `restoreState(data)` only to the object whose live body-id set matches — the same identity the pose restore already keys off, so the equal-count index zip can no longer misapply one object's state to another after a remove+add. Regression: `engine.test.js` "restores behavioral state by body id, not index, on an equal-count remove+add".
- [x] `tests/reset.test.js` level-mode helper sets a dead `obj._goalId` instead of passing `customId: objData.id` through `registry.create` - use the production seam so the reset tests exercise the real goal-zone path. — ✅ 2026-10-18 `ticket/16-reset-customid`: `buildFixedObjects()` now mirrors `main.js _setupLevel` and passes `customId: objData.id` through `registry.create`; the dead `_goalId` stub is gone and the reset suite exercises the real goal-zone path (new `levelReset.buildFixedObjects` test asserts `placed[0].customId === 'bucket-goal'`).
- [x] `js/objects/Gear.js` `_applyToothTraction` uses deprecated `Matter.SAT.collides` - switch to `Matter.Collision.collides(...)` (removes deprecation noise and future break risk). — ✅ 2026-10-18 `ticket/19-gear-collision-api`: `Matter.SAT.collides` → `Matter.Collision.collides` in `Gear.js`, plus the same deprecated call in `Conveyor.js` and `Spring.js` (same two-arg shape, `collision.collided` checks unchanged); deprecation noise gone, suite stayed green.
- [x] `js/objects/Pulley.js` `_isTeleport()` can false-positive on a hard rider impact (>0.35px in one step), spuriously re-deriving the rope split mid-play - implement `Pulley.restoreState()` (seam already called by PhysicsEngine) to reset cached poses instead of heuristics. — ✅ 2026-10-18 `ticket/20-pulley-restore-state`: `Pulley.restoreState()` implemented on the seam `PhysicsEngine` already calls — cached platform poses invalidated and a one-shot rope re-sync latch set, consumed by the next `onBeforeUpdate`; the `_isTeleport()` pose-jump heuristic is deleted entirely, so a hard rider impact (>0.35px/step) can no longer spuriously re-derive the split mid-play. Two new `pulley.test.js` tests (no mid-play re-derivation; exactly-once re-sync after a snapshot restore).
- [x] `js/objects/Mouse.js` the shared 30-frame reversal cooldown swallows ledge reversals after a ball-push reversal (mouse can walk ~22px off an edge) - add a separate short edge-probe cooldown. — ✅ 2026-10-18 `ticket/21-mouse-edge-cooldown`: ledge probes now use their own `EDGE_PROBE_COOLDOWN_FRAMES = 6` debounce (`_reverseFromEdge()`); the 30-frame contact/wall debounce is untouched. Suite 12 files / 123 tests green (two new ledge tests: direct seam + post-bump plank-fall regression).
- [x] `js/ui/EditorPanel.js` save stamps `bucket-goal` onto EVERY unnamed fixed bucket, so multi-bucket custom levels trivially satisfy `goal.zoneId` - stamp only the first unnamed bucket (or reject multiple unnamed buckets on save). — ✅ 2026-10-18 `ticket/18-stamp-first-bucket`: `stampGoalZoneIds` (the editor-save parity helper in `GoalChecker.js`, called by `EditorPanel.save`) now names only the FIRST unnamed fixed bucket with the goal-zone id; later unnamed buckets keep no `id`, while named ids and non-buckets stay untouched, so multi-bucket custom saves no longer trivially satisfy `goal.zoneId` on every catch. Test: "stamps only the FIRST unnamed bucket when several unnamed buckets are saved".

---

## Manual QA checklist (run after each phase)

- [x] Level-01: win screen on goal, markComplete + unlock works, Next Level loads level-02. ✅ 2026-10-18 in-browser at a 714×471 window: Bowling Ball → (700,300), Play → "🎉 Puzzle Complete!", "➡ Next Level" → "Across the Gap".
- [x] Reset keeps player-placed parts; repeated play/reset cycles stable (no leaked bodies in world after full reset). ✅ `ticket/08-reset` + `ticket/10-snapshot` unit coverage, and live: Retry from the win overlay restored the ball (count stays 0, ball visible); replay → win again on the same board.
- [x] Speed button cycles during play visibly. ✅ `tests/speed-wiring.test.js` (GameLoop speed cycles; label/tooltip follow `loop:speed`).
- [x] Candle burns rope → rope detaches; balloon pops on scissors/flame → no ghost collider remains. ✅ `tests/rope.test.js` (flame-sever + constraint removal in the same beat), `tests/balloon.test.js` (pop removes the body on Matter `collisionStart`).
- [x] Rotated fan blows correctly; pulley couples; mouse walks planks without jitter. ✅ unit: fan rotation-aware wind zone, pulley true coupling, mouse debounce/front-facing tests.
- [x] Level select → sandbox → menu round-trip leaves no stale bodies/ghosts. ✅ live 2026-10-18: sandbox enter (parts ∞, clean canvas), ball placed, Reset-without-play leaves the sandbox untouched (`ticket/08` semantics); console clean throughout.
- [x] `npm test` green (22 passed or updated count with new tests). ✅ final tip: 11 files / 105 tests, all green after the full ticket wave + reviewer fix.

## Future ideas (out of scope unless requested)
- [ ] Sound system (matches README's aspirational `audio/` entry).
- [ ] Editor: place fixed objects; goal types beyond the hard-coded select.
- [ ] Level JSON schema validation on load (catch unknown types/missing ids early).