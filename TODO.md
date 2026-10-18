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
- [ ] `state._savedPlacedSnapshot` is written (`js/main.js:43,157,259`) but never read by anything.
- [ ] In `_resetLevel()`, for level modes: restore player-placed objects from `_savedPlacedSnapshot` (deserialize + re-add to render list; bodies re-added on next play) instead of wiping them.
- [ ] Sandbox mode: decide intended reset semantics (parts return to edit positions vs. clear all) and implement consistently.
- Acceptance: place parts, play, reset -> parts are back at edit-mode positions; play/reset cycles are repeatable and stable.

### 1.3 Rope severing does nothing physically
- [ ] `Rope.sever()` (`js/objects/Rope.js:122-127`) only sets a flag and emits `rope:severed` (no listener); its Matter constraints are never removed.
- [ ] Add removal path: PhysicsEngine subscribes to `rope:severed` (or rope gets an engine/world hook) and removes `Rope.constraints` from the `Composite`.
- [ ] Confirm candle (flame sensor) and scissors collisions reach `Rope.onCollision` -> `sever()` through the existing collision dispatch (wiring already exists in PhysicsEngine).
- Acceptance: rope touching candle flame physically detaches on screen and in physics.

### 1.4 Popped balloons leave invisible colliders
- [ ] `Balloon.pop()` (`js/objects/Balloon.js:80-84`) only sets `_popped`; `bodies` getter returns `[]` and draw no-ops, but the Matter body stays in the world forever (invisible, still buoyant/colliding).
- [ ] On pop: remove `this._body` from the physics world (engine hook or `physics:object-remove-request` event) then dispose.
- Acceptance: popped balloon stops interacting with the world immediately; no phantom body remains.

---

## Phase 2 - HIGH: dead controls & one-way event wiring

### 2.1 Speed button is a no-op
- [ ] `PlayControls` emits `controls:speed`; no subscriber anywhere. `GameLoop.cycleSpeed()` is only called by unit tests.
- [ ] Subscribe in `main.js`: `eventBus.on('controls:speed', () => state.gameLoop.cycleSpeed())`.
- [ ] Optional UX: show current speed (button tooltip or debug header).
- Acceptance: clicking fast-forward during play visibly cycles 0.5x / 1x / 2x motion.

### 2.2 Dead events - wire or prune (document decision per event)
- [ ] `loop:frame` (GameLoop) - candidate: goal checker per-step polling (wire) else prune.
- [ ] `physics:collision` (PhysicsEngine) - candidate: debug logging only -> prune.
- [ ] `physics:object-added` / `physics:object-removed` (`js/engine/PhysicsEngine.js:75,99`) - candidate: EditorPanel/object-count display, else prune.
- [ ] `canvas:resized` (`js/main.js:88`) - candidates: Renderer/GhostLayer re-snap; prune if unused.
- [ ] `loop:reset` (`js/engine/GameLoop.js:121`) - prune, or hook animation-state resets.
- [ ] `bucket:caught` - wired in 1.1.
- [ ] `balloon:popped` - used by 1.4, else prune after fix.
- [ ] `rope:severed` - used by 1.3, else prune after fix.
- [ ] `controls:speed` - wired in 2.1.
- Acceptance: every emitted event has at least one listener, or its emit is removed.

---

## Phase 3 - MEDIUM: object behavior fixes

### 3.1 Fan wind zone broken for rotated fans
- [ ] `js/objects/Fan.js:70-79` computes axis-aligned bounds with `halfWidth = FAN_WIDTH`, `halfHeight = windRange` - only correct at angle 0 (e.g. a 90-deg fan projects a tall-narrow zone instead of wide-flat).
- [ ] Make rotation-aware: transform each body position into fan-local space (translate/rotate) and use local rectangle test with halfWidth = FAN_WIDTH, halfHeight = windRange/2; keep distance falloff.
- Acceptance: 90-deg-rotated fan blows bodies to its face direction; wind zone matches the drawn wind lines.

### 3.2 Pulley is not coupled
- [ ] `js/objects/Pulley.js:57-76`: each platform hangs from its own fixed world anchor under the pivot with fixed length; no left<->right coupling. "One side up when other goes down" is not implemented.
- [ ] Implement true coupling: shared-rope math (transfer length between the two constraints per step) or per-frame force transfer in `onBeforeUpdate` when either platform is loaded.
- Acceptance: adding weight to one platform raises the other.

### 3.3 Mouse direction jitter
- [ ] `js/objects/Mouse.js:107-112` reverses on collision with ANY non-mouse object (dynamic bodies cause flip-flopping); wall/edge probes only see static bodies.
- [ ] Add debounce (cooldown frames) before reversing; only reverse on significant front-facing contacts; optionally account for relative velocity of dynamic bodies.
- Acceptance: mouse walks and pushes light objects deterministically; no rapid oscillation.

### 3.4 Gear physics is cosmetic
- [ ] `js/objects/Gear.js`: physics body is a plain static circle; teeth are visual-only; static-body rotation does not push other bodies in Matter.js.
- [ ] Decision needed: implement interaction (tangential impulse on contact in `onBeforeUpdate`, or kinematic-dynamic body with motor torque) or document as a known limitation in README/work-log.
- Acceptance: decision documented; if implemented, objects visibly ride the gear teeth.

### 3.5 Snapshot restore robustness
- [ ] `PhysicsEngine.restoreSnapshot` maps `snapshot[i] -> objects[i]` by index - silently corrupts poses if object count/order changed between take and restore (deleted/popped objects).
- [ ] Match by body id instead of index, or validate count/order and fail loudly (re-take snapshot) on mismatch.
- Acceptance: deleting an object mid-play, then pausing/resetting, does not teleport other objects.

---

## Phase 4 - Repo hygiene

### 4.1 Merge-conflict markers
- [ ] `work-log.md` contains unresolved `<<<<<<< HEAD` markers - resolve and rewrite the log coherently.

### 4.2 Encoding artifacts
- [ ] `js/engine/GameLoop.js` and `js/engine/PhysicsEngine.js`: BOM + mojibake (em-dash shown as `ΓÇÓ`-style artifacts) in comments - re-save as clean UTF-8 without BOM and fix the comment text.

### 4.3 Dead testing module
- [ ] `js/testing/MockObjects.js` (754 lines): `registerMockObjects()` is never called - delete the file, or move under `tests/` if still useful for UI harnesses.

### 4.4 README accuracy
- [ ] `README.md:35` documents `audio/ <- Sound effects`; the folder and any sound system do not exist. Remove from tree or mark "planned".

### 4.5 Test/runner notes
- [ ] Document in README/work-log: Vitest 4 removed `--reporter=basic`; use plain `npm test`.
- [ ] PowerShell quirk: npm stderr can surface as `NativeCommandError` noise; prefer `cmd /c npm test`.

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