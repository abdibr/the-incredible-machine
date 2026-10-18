# Work Plan — Broken Functionality Fixes

Audit date: 2026-10-18
Scope: Read-only audit of the full codebase (45 files). No code changed yet.
Baseline: `npm test` -> 22 passed (Vitest 4; note `--reporter=basic` was removed, use plain `npm test`).
Architecture verdict: core engine/renderer/toolbox are sound; breakage is in the integration layer - features are half-wired.

Legend: [ ] = todo, [~] = in progress, [x] = done.

---

## Phase 1 - CRITICAL: gameplay blockers (game cannot be played as designed)

### 1.1 Goal system never fires - levels are unwinnable
- [ ] Restore named object ids: `static deserialize()` in all 15 object classes ignores `data.id`; `main.js _setupLevel` never assigns `spec.id`. Keep `BaseObject.id` auto-increment for physics refs, add a `customId` field resolved from level JSON so `"zoneId": "bucket-goal"` can resolve.
- [ ] Implement goal checker (suggest `js/goals/GoalChecker.js` or a block in `main.js`):
  - [ ] Listen on `bucket:caught` (emitted by `js/objects/Bucket.js:102`, currently no listener).
  - [ ] Per-step check (reuse `loop:frame` or hook in GameLoop) of level `goal`: if target object (by `goal.targetType`: `ball`, `mouse`) is caught by the zone matching `goal.zoneId` -> emit `goal:reached { levelId }`.
  - [ ] Add fail condition and emit `goal:failed` (minimum: target falls off-world below canvas; optional per-level time limit).
- [ ] Verify display path (no change expected): `js/ui/GoalOverlay.js:60-66` already listens for `goal:reached`/`goal:failed`.
- [ ] Verify progression path (no change expected): `js/levels/LevelManager.js:37` already listens for `goal:reached` -> `markComplete` -> unlocks/next.
- [ ] Wire "Next Level" flow end-to-end (`overlay:next-level` in `main.js` -> load next level id).
- [ ] EditorPanel parity: custom saved levels hard-code `zoneId: 'bucket-goal'` (`js/ui/EditorPanel.js:190`) - confirm convention matches checker.
- Acceptance: level-01, drop ball into bucket, play -> win overlay appears, level marked complete, next level loads.

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

## Manual QA checklist (run after each phase)

- [ ] Level-01: win screen on goal, markComplete + unlock works, Next Level loads level-02.
- [ ] Reset keeps player-placed parts; repeated play/reset cycles stable (no leaked bodies in world after full reset).
- [ ] Speed button cycles during play visibly.
- [ ] Candle burns rope -> rope detaches; balloon pops on scissors/flame -> no ghost collider remains.
- [ ] Rotated fan blows correctly; pulley couples; mouse walks planks without jitter.
- [ ] Level select -> sandbox -> menu round-trip leaves no stale bodies/ghosts.
- [ ] `npm test` green (22 passed or updated count with new tests).

## Future ideas (out of scope unless requested)
- [ ] Sound system (matches README's aspirational `audio/` entry).
- [ ] Editor: place fixed objects; goal types beyond the hard-coded select.
- [ ] Level JSON schema validation on load (catch unknown types/missing ids early).