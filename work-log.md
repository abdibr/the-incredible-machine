# Work Log — The Incredible Machine (Web Clone)
## 2026-10-18 — Discovery & wake seam, ADR 0002 (candidate C2, sleeping-rider defect)

- **Seam landed in `PhysicsEngine`**: `queryTouching(actor, {sourceBodies, includeStatic, includeWalls})` (Query.collides-grade SAT), `queryZone(referenceBody, {cx,cy,width,height}, opts)` (local-frame rect, rotates with the reference, **position-based** matching, AABB broadphase), `queryPoint(point, {excludeOwner})` (Query.point semantics, statics/walls included), `wakeBodies(targets)` (the single `Sleeping.set` writer, null-tolerant). Shared policy: walls and statics skipped unless opted in, the caller never discovers its own bodies (owner registry via `addObject`/`removeObject`), discovery is a pure read (never wakes).
- **All six scanning objects migrated onto the seam** — Spring (`queryTouching({sourceBodies:[platform]})`), Conveyor/Gear (`queryTouching`), Fan (`queryZone`), Pulley (`queryTouching({sourceBodies:[support]})`), Mouse (three `queryPoint({excludeOwner:this})` probes). `wakeBodies` added pre-force in Spring/Conveyor/Fan/Gear/Pulley/Balloon — **the sleeping-rider defect is closed** (a rider asleep on an armed spring/belt/balloon now receives the force; previously Matter skipped integration for asleep bodies and the machines stalled).
- **Matter scan primitives are engine-only now** (`Composite.allBodies`/`Query.*`/`Sleeping.set` grep-clean outside `PhysicsEngine.js`); the one documented exception is `Gear`'s per-pair `Matter.Collision.collides` for traction contact normals (discovery itself goes through the seam) — recorded in ADR 0002 decision 4.
- **Tests**: new `tests/engine-query.test.js` (24 tests) pins touch/zone/point precision, static/wall/owner opt-ins, zone placement + rotation (90° maps the cone from −y to +x), discovery-never-wakes, `wakeBodies` tolerance, and four pre-slept wake-on-act integrations (spring launch vy ≈ −2.5, belt Δvx ≈ 0.22, gear carry, balloon rise). Legacy fake-engine test callers: `interactions.test.js` spring full-cycle patched onto a real `PhysicsEngine(800, 600)` + `engine.addObject(spring)` (frame-13 launch calls `engine.queryTouching` → the old `{ world: emptyWorld }` fake threw TypeError); `gear.test.js`/`balloon.test.js` legacy fakes audited safe (behind `Gear`'s `!engine?.queryTouching` guard / non-scanning paths); `mouse.test.js` already used a real engine. Fixed a latent parse error in `tests/fan.test.js` (`import { Sleeping } from Matter` → `const { Sleeping } = Matter`).
- **Docs**: `docs/adr/0002-discovery-wake-seam.md` (this ADR, decision 1–5); ADR 0001 out-of-scope row C2 marked implemented; glossary gained the "Discovery & wake (ADR 0002)" section (seam, wake-on-act, discovery-never-wakes, policy).
- Status: `npx vitest run` — 15 files / **178 tests, all green**.
## 2026-10-18 — Broken-functionality fix pipeline (integration/broken-functionality-fixes)

Wave-1 merge series onto the integration branch, one branch per audit item:

- `9e4679b` `ticket/03-hygiene` — Phase 4 sweep (work-log conflict markers, BOM/mojibake, dead MockObjects.js, README accuracy, npm/Vitest notes). Back to green.
- `d0e8f40` `ticket/08-reset` — reset preserves the player's placed machine via the saved placed-snapshot; `PhysicsEngine` snapshot/restore hardening for play/reset cycles.
- `1d6bbb4` `ticket/02-rope` — `Rope.sever()` now physically removes the rope's constraints/world segments on `rope:severed` (candle + scissors reach it through the existing collision dispatch).
- `8b213dd` `ticket/07-balloon` — popped balloons remove their Matter body from the world immediately; no invisible colliders after pop.
- `1193e57` `ticket/04-speed` — `controls:speed` wired to `GameLoop.cycleSpeed()` in `main.js`.
- `6a41386` `ticket/06-fan` — rotation-aware wind zone (local-space rectangle test + distance falloff).
- `a64fa69` `ticket/13-pulley` — true shared-rope coupling: weight on one platform raises the other.
- `08e73a4` `ticket/09-mouse` — direction-jitter debouncing; front-facing/static contacts only; **hook contract change**: `step()` now calls `onBeforeUpdate(engine, dt)` (engine-first, dt is explicit ms), and the branch set engine `enableSleeping: true`. Both ripple: Pulley.js still had the old signature (traction silently early-returned — `.world` on a dt number) — fixed in `570a8b2` to `(engine, dt)`. Sleeping experiment disabled after review (mouse-jitter cycle tests don't depend on it; determinism now carried by the snapshot restore) — an earlier claim that Sleeping was disabled via an explicit `enableSleeping: false` + amended commit `a13a5cf` was inaccurate (no such commit exists in any ref) and is corrected here: production keeps Matter's default `enableSleeping ?? true`, determinism is carried by the `ticket/10-snapshot` snapshot restore.
- `2aa0513` + `820b60e` `ticket/14-gear` — tooth traction in `onBeforeUpdate`; Gear also carried the old `(dt, engine)` signature (carry silently dead: partial speeds in tests were emergent kicks from `Body.setAngle` rotating the approximated circle's polygon facets, not real carry) — signature fixed, all green.
- `6502a3c` `ticket/10-snapshot` — `restoreSnapshot` matches recorded poses to live bodies **by Matter body id** (never index), restores exact-replay state (vertices last, `positionImpulse`, motion/sleepCounter), detects snapshot↔world drift in both directions, warns + emits `physics:snapshot-mismatch` and self-heals by re-taking the snapshot. One real merge conflict in `PhysicsEngine.js` resolved by unioning both designs (ours' behavior restore zip + exact-replay extras, theirs' id-index + drift/retake).

Status: `npm test` — 11 files / **105 tests, all green** (re-verified on the integration tip after the wave-2 merges and the reviewer #1 overlay fix). TODO.md updated through Phase 5 (reviewer minors backlog); the wave-2 merges and the closing QA gate are recorded below.
Wave-2 merges + closing gate (same day):

- `a30a0fb` `ticket/11-goals` — Goal system end-to-end on top of the #5 prefactor: `GoalChecker` (win via matching `bucket:caught` with `type`+`zoneId` filters, off-world fail on `loop:frame`, re-armed per attempt), GoalOverlay + next-level wiring, 14 goal tests.
- `dec6c78` `ticket/12-dead-events` — pruned `physics:collision`, `physics:object-added/removed`, `canvas:resized`, `loop:reset`; balloon ghost test rewritten on Matter `collisionStart`.
- Reviewer pass over `main...HEAD` — suite 11 files / 105 tests green at `dec6c78`; verdict FIX-FIRST on one [major]: the three goal-overlay handlers left the GameLoop RUNNING across overlay-driven mode switches (next `controls:play` early-returned past the play-start snapshot; the stale snapshot false-triggered the mismatch re-baseline on the next reset; unowned rAF behind MENU/EDITING). Fixed in `e2d4117`: `overlay:next-level` / `overlay:retry` / `overlay:menu` now run a guarded `gameLoop.reset()` + renderer-loop restart before the board/mode change (mirrors `controls:reset`). Minors #2–#9 → TODO Phase 5 backlog; #9's stale doc claims corrected in this log's status line above.
- `ticket/15-qa` gate (run by the orchestrator) — final tip: 11 files / 105 tests, all green. Browser pass at a 714×471 window: level-01 drag-Bowling-Ball → play → win overlay → Retry restores the board (ball visible, count stays 0) → replay → win again → Next Level loads level-02 "Across the Gap"; sandbox enter (parts ∞) → placement → Reset-without-play leaves the sandbox untouched; console clean throughout.
Phase-5 reviewer-minor wave (same day — one merge per item, `ticket/15` → `ticket/20`; `ticket/21` below):

- `55d53f8` `ticket/15-physics-restore-id` — Phase 5 #2: `PhysicsEngine.restoreSnapshot()` indexes behavioral snapshot entries by their body-id set (`snapByIdSet`) before applying anything and routes `obj.restoreState(data)` only to the object whose live body ids match — the equal-count path can no longer zip by index and misapply one object's state to another after a mid-play remove+add. New `engine.test.js` regression: "restores behavioral state by body id, not index, on an equal-count remove+add".
- `48cc87d` `ticket/16-reset-customid` — Phase 5 #3: reset tests build fixed level objects through the production seam — `buildFixedObjects()` passes `customId: objData.id` via `registry.create` (mirrors `main.js _setupLevel`), replacing the dead `obj._goalId` stub, so the reset suite exercises the real goal-zone matching path (`placed[0].customId === 'bucket-goal'`).
- `124ba59` `ticket/17-goal-lifecycle` — Phase 5 #1: GoalChecker `init()` guarded init-once (`_unsubscribes.length > 0` short-circuit) with all four subscriptions captured in `_unsubscribes`; new `dispose()` drains them and clears goal/level state — dispose→init round-trips re-subscribe exactly once. Three lifecycle tests (double-init, detach-on-dispose, re-init works again).
- `0589aa5` `ticket/18-stamp-first-bucket` — Phase 5 #7: editor-save parity helper `stampGoalZoneIds` now stamps `bucket-goal` onto only the FIRST unnamed fixed bucket; later unnamed buckets keep no `id` (named ids and non-buckets untouched), so multi-bucket custom saves no longer trivially satisfy `goal.zoneId` on every catch.
- `6f1ea3d` `ticket/19-gear-collision-api` — Phase 5 #4: deprecated `Matter.SAT.collides` → `Matter.Collision.collides` in `Gear.js`, `Conveyor.js`, and `Spring.js`; same two-arg call shape, suite stayed green.
- `85b1d2c` `ticket/20-pulley-restore-state` — Phase 5 #5: `Pulley.restoreState()` implemented on the seam `PhysicsEngine` already calls — cached platform poses invalidated + one-shot rope re-sync latch consumed by the next `onBeforeUpdate`; the `_isTeleport()` pose-jump heuristic deleted, so hard rider impacts never spuriously re-derive the split mid-play (2 tests: no mid-play re-derivation + exactly-once re-sync after a snapshot restore).
- `ticket/21-mouse-edge-cooldown` — Phase 5 #6: mouse edge-probe reversals use a separate short `EDGE_PROBE_COOLDOWN_FRAMES = 6` debounce (`_reverseFromEdge()`) instead of sharing the 30-frame contact cooldown — a ball-push reversal no longer silences a genuine ledge reversal (old behavior: ~22px overshoot then falling off the plank). Contact/wall jitter debounce untouched. 12 files / 123 tests green (two new mouse tests: a deterministic "reverses at a ledge despite an active contact cooldown" seam test and a stepped "doesn't walk off a plank after a ball bump" regression).

Phase-5 wrap-up — all seven reviewer minors landed (`ticket/15`–`ticket/21`); TODO.md Phase 5 boxes are all `[x]` with per-ticket evidence notes; suite 12 files / 123 tests green.
User-report wave (same day — scissors rework; logged after the fact):

- `545451e` scissors rework — `Scissors` now **rests open** (two blade sensors + two solid handle bodies behind the pivot) and cuts only after a **dynamic weight lands on a handle**: `_snapShut()` is mass-gated (light/flimsy contacts such as rope segments brushing a handle don't fire) and one-shot, easing 120 ms into a near-parallel pose that stays shut; the snap severs any rope with a segment inside the open-blade fan at snap time. `Rope.onCollision` was gated to match — candle still severs on any contact, scissors only via a closed-state `'scissors-blade'`-labeled pair, so a rope resting between open blades is neither cut nor triggered. The closed state round-trips through `serialize()`/`restoreState()` (`options.closed`), so play/reset snapshot cycles replay deterministically and a snapshot restore reopens a snapped-shut pair only if it was serialized open. Rendering: a per-lever shank now connects the red handle rings to the blades on the placed object (canvas pixel probes — 0 empty samples across the former ring→blade gap on both levers), and the toolbox icon was rebuilt around the pivot (flood-fill from the screw reaches 177/177 drawn pixels; 1 connected component vs 3 floating islands before); registry description updated. New `tests/scissors.test.js` (8 tests) + 2 rope blade-gating tests; suite 13 files / **133 tests, all green**.

## 2026-02-23 — Project Kickoff

### Planning
- Researched original TIM game mechanics, visual style, and object catalog
- Researched Matter.js 2D physics engine capabilities (constraints, composites, collision categories)
- Drafted comprehensive implementation plan with multi-agent architecture
- Defined 15 core game objects for v1
- User approved plan with two changes: match original TIM art style, remove grid snapping

### Scaffold Setup
- Initialized Vite project with vanilla JS template
- Installed Matter.js (production) and Vitest (dev)
- Created full project directory structure
- Implemented shared scaffold files on `main`:
  - `index.html` — CSS Grid layout with canvas, toolbox panel, control bar
  - `css/style.css` — Full TIM-inspired theme (beveled borders, classic palette)
  - `js/main.js` — App entry point with mode state machine
  - `js/EventBus.js` — Pub/sub event system for decoupled module communication
  - `js/objects/BaseObject.js` — Shared interface contract for all game objects
  - `js/objects/ObjectRegistry.js` — Central catalog/factory for game objects
- Initialized Git repo, pushed to GitHub
- Created branches: `agent-a/engine-and-objects`, `agent-b/ui-and-puzzles`
- Prepared Agent B task instructions document

## 2026-02-24 — Agent A: Engine & Objects

### Implementation (branch: `agent-a/engine-and-objects`)
- PhysicsEngine: Matter.js wrapper — object lifecycle, collision forwarding, snapshot/restore, boundary walls, hit-testing
- GameLoop: play/pause/reset state machine — speed scaling (1×/2×), capped delta-time, snapshot management
- ObjectRenderer: per-object drawing delegation, selection handles, ghost previews, debug overlays
- 15 game objects (17 registry entries): Ball (3 variants), Ramp, Conveyor, Trampoline, Fan, Spring, Domino, Gear, Pulley, Balloon, Bucket, Candle, Rope, Scissors, Mouse
- registerAllObjects: bootstrap registration across 4 categories
- Unit tests: 22 tests — engine, loop, serialization, registry — all pass ✅

### Verification
- All 22 unit tests pass
- Committed and pushed to `agent-a/engine-and-objects`
- Created PR #2: `agent-a/engine-and-objects` → `main`

## 2026-02-24 — Agent B: UI & Puzzle System

### Implementation (branch: `agent-b/ui-and-puzzles`)
- Created 10 mock objects with TIM-style Canvas 2D drawing (`js/testing/MockObjects.js`)
- Implemented Canvas Renderer with render loop, hit-testing, ghost preview, selection handles (`js/render/Renderer.js`)
- Implemented Play Controls with Play/Pause/Reset/Speed buttons + keyboard shortcuts (`js/ui/PlayControls.js`)
- Implemented Toolbox panel with category grouping, canvas icons, inventory tracking (`js/ui/Toolbox.js`)
- Implemented DragDropManager for freeform drag-and-drop placement, move, rotate, delete (`js/ui/DragDropManager.js`)
- Implemented Level Manager with JSON loading, validation, localStorage progress, level sequencing (`js/levels/LevelManager.js`)
- Implemented Level Select screen with level cards, difficulty stars, lock/unlock state (`js/ui/LevelSelect.js`)
- Implemented Goal Overlay for win/fail states with stats and navigation buttons (`js/ui/GoalOverlay.js`)
- Implemented Editor Panel for sandbox mode with save/load level, goal type, test button (`js/ui/EditorPanel.js`)
- Created 5 starter puzzles: First Steps, Across the Gap, Chain Reaction, Lighter Than Air, Mouse Trap
- Wired all modules into `main.js` with mode transition events and render loop

### Verification
- Vite build: ✅ 16 modules, 0 errors
- Committed 15 files (2845 insertions), pushed to `agent-b/ui-and-puzzles`
- Created PR #1: `agent-b/ui-and-puzzles` → `main`

## 2026-02-24 — Integration

- Merged PR #1 (Agent B) and PR #2 (Agent A) into `main`
- Resolved work-log merge conflict
- Replaced mock objects with `registerAllObjects()` — 15 real game object classes
- Wired `PhysicsEngine` + `GameLoop` into play/pause/reset controls
- Vite build: ✅ 37 modules, 0 errors
- 22 unit tests pass
- Pushed integration commit to `main`

## 2026-10-18 — Repo Hygiene Sweep (issue #3)

- Resolved the truncated conflict block left in this log (`<<<<<<< HEAD` / `=======` markers with no `>>>>>>>` side surviving): both narratives are now kept as one chronological account above (Kickoff → Agent A → Agent B → Integration).
- Encoding sweep via byte-level scan of all tracked files: re-saved `js/engine/GameLoop.js` and `js/engine/PhysicsEngine.js` (UTF-8 BOM + CP437-style mojibake comments: `ΓÇö`→—, `ΓöÇ`→─, `├ù`→×) as clean UTF-8 without BOM; comments now read correctly. Byte scan also found `js/render/ObjectRenderer.js` had a BOM + one mojibake em-dash — fixed the same way. Comments only; no code lines changed.
- Removed dead `js/testing/MockObjects.js` (754 lines; `registerMockObjects()` never called, zero imports, zero events emitted — superseded by real `registerAllObjects()` during integration).
- README: removed the non-existent `audio/` folder from the project tree (no sound system in the repo), added `tests/`, and documented test-running notes: plain `npm test` (Vitest 4 removed `--reporter=basic`), and prefer `cmd /c npm test` on Windows to avoid PowerShell `NativeCommandError` stderr noise.
- Regression: `npm test` green before and after all edits — 22 passed.

## 2026-10-18 — Interaction Matrix (architecture candidate C1)

- Replaced the scattered `onCollision` hook (BaseObject default + 8 implementers) with a declarative **interaction matrix**: `js/interactions/InteractionMatrix.js` (routing engine) + `js/interactions/rules.js` (the row table). `PhysicsEngine` collisionStart dispatch now maps pair bodies → owner objects and calls `interactions.resolve(objA, objB, pair)` once; rows are unordered pair declarations matched in both orientations, firing in registration order. Handlers route to new public behavior seams (`rope.sever()`, `balloon.pop()`, `bucket.isCatchContact/registerCatch()`, `gear.meshWith()/_applyGearDrive()` — fixes the old reach-through to `other._angularSpeed` — `scissors.isSnapTrigger/snapShut()`, `mouse.isRelevantContact/reverseFromContact()`, `spring.isLaunchTrigger/armLaunch()`, `trampoline.stretch()`); `onCollision` is deleted everywhere (no dual path).
- **Bug fix:** rope no longer severs on candle **wax** — the `rope-candle-flame` row requires the `'candle-flame'` labeled body (previously `other.type === 'candle'` cut on any candle body). **Behavior deliberately preserved:** balloons still pop on wax/any candle body and on any scissors body (flagged as a refinement candidate in the ADR, not changed).
- Table coverage: 10 dispatching rows (rope ✕ candle-flame, rope ✕ closed-scissors-blade, balloon ✕ scissors, balloon ✕ candle, bucket ✕ sensor-catch, gear ✕ gear, scissors ✕ handle-weight, mouse ✕ head-on contact, spring ✕ platform contact, trampoline ✕ any contact) + 2 docOnly rows documenting null-participants (boundary walls; silent classes Ball/Ramp/Conveyor/Fan/Domino/Pulley/Candle).
- Docs: `docs/interactions.md` is generated from the table (`npm run docs:interactions`, `scripts/generate-interactions-doc.mjs`) with a sync test that fails on drift; `docs/adr/0001-interaction-matrix.md` records the decision; root `GLOSSARY.md` added (term index per `docs/agents/domain.md` layout).
- Tests: new `tests/interactions.test.js` — every row ships with a pairwise contract test through the matrix seam (22 tests); `mouse.test.js` (8 call sites) and `scissors.test.js` (6 call sites) rewritten off the removed `onCollision` hook. Suite **14 files / 155 tests, all green** (`cmd /c npm test`).

## 2026-10-18 — C4 follow-through: walls & boundaries as documented null-participants

- Audit of interaction-architecture candidate C4 ("walls & boundaries as first-class pair participants"): the fold into C1 was already landed with the `boundary-null` docOnly row (ADR 0001 decision 6 — "documented null-participants, not an adapter"); this pass closed the gaps that left the fold incomplete:
  - The two docOnly rows' `test` fields named tests that did not exist — 'boundary walls are null participants' and 'silent classes have no reaction rows' had no tests at all (the only docOnly coverage was the generic 'docOnly rows never dispatch'). `tests/interactions.test.js` now ships both, named exactly as the rows declare (ADR decision 5 — "the row's `test` field names its test" — is now true for all 12 rows; interactions suite 22 → 24 tests):
    - **boundary walls are null participants** — drives a **live `PhysicsEngine`**: a wildcard spy row registered on the engine's matrix, a bowling ball dropped onto the boundary floor, a Matter `collisionStart` listener as the positive control (`wallPairs > 0`), and the spy stays silent — proving wall pairs never enter `resolve()` at all (owner lookup returns null → dispatch skipped), not merely that a synthetic wall object resolves to nothing.
    - **silent classes have no reaction rows** — drives all seven silent classes (Ball, Ramp, Conveyor, Fan, Domino, Pulley, Candle) through `resolve()` in both orientations.
  - ADR 0001 decision 6 extended to record the load-bearing consequence of the decision: wall contacts are invisible to the matrix **by construction**, so the two deliberate wall consumers live outside it — Mouse's ground/wall static probes and `GoalChecker._checkOffWorld` (below-canvas target, e.g. tunneled past a wall → `goal:failed`), the two compensations the C4 card cites. GLOSSARY "Boundary walls" entry updated to match.
- Behavior unchanged — tests/docs only. Suite **14 files / 157 tests, all green** (`cmd /c npm test`). The adapter alternative (registering a lightweight `Boundary` object so wall pairs become dispatchable) stays rejected per ADR 0001; revisiting it means reopening that ADR.

