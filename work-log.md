# Work Log — The Incredible Machine (Web Clone)

## 2026-10-23 — Hardening: ramp surface material restored (trampoline follow-up)

The general follow-up from the trampoline fix (`43486d4`): `js/objects/Ramp.js` declared a static body's material (`friction 0.5 / restitution 0.1`) that matter-js's static flip silently zeroed (→ 1 / 0). For today's population it is behaviorally inert — pairs resolve at `max(live restitutions)` / `min(live frictions)`, every ball variant (restitution ≥ 0.3, friction ≤ 0.5) dominates or washes out the blend, and even a domino resting on a ramp only shifts pair friction 0.6 → 0.5 — but it was a landmine: any future tuning of the ramp's surface would silently do nothing, exactly as nearly happened with the trampoline's 0.95. The ramp now re-asserts its declared material right after body creation, same pattern as Trampoline.js, via named constants `RAMP_FRICTION` / `RAMP_RESTITUTION` with the rationale documented at the constants.

- `tests/ramp.test.js` (new, 2 tests): declared friction 0.5 / restitution 0.1 survive the implicit static flip; and a dead ball (restitution forced to 0 — no shipped variant can exercise the ramp's own 0.1 through the pair's `max()`) dropped on a flat ramp rebounds at ≈ −0.57 vy after an 8.2 vy impact (pair restitution 0.1, ~0.9 px hop) where the pre-fix zeroed material measured exactly 0 (calibration: `.scratch/probe-ramp.mjs`). Full suite: **33 files / 356 tests, all green** (`cmd /c npm test`).
- ADR 0006 invariants intact: the committed fixture `tests/fixtures/bugfiles/ball-drop-ramp.json` still replays **bit-exactly** — the recording's bowling ball (restitution 0.3 > the ramp's 0.1, friction 0.4 < 0.5) dominates or washes out both pair blends either way — and the trampoline/spring regression suites are untouched.
- Remaining instances of the same static-flip disease, all currently inert (documented, left for a future pass): **Gear** friction 0.8, **Pulley** 0.6, **Conveyor belt** 0.9, **Spring platform** restitution 0.1 (documented in both bug issue bodies), **Bucket** walls/floor friction 0.3 — the last only when the bucket is `isFixed` (a fixed bucket runs its walls at a visitor's friction instead of the declared 0.3).
## 2026-10-23 — Bugfix: trampoline fabric had no bounce; spring never launched its rider (two bug files)

Two user-recorded sandbox sessions (ADR 0006 bug files) exposed physics objects whose runtime behavior didn't match what the code declares.

- **Trampoline (bug-20261023T174706Z-0oca)** — *"trampoline has no bounce .. a heavy ball should bounce high from a trampoline"*. matter-js `Body.setStatic()` zeroes a static body's restitution (and forces friction 1), and the `isStatic: true` *option* flows through that same setter inside `Body.create` — so the fabric's declared restitution 0.95 / friction 0.3 were silently discarded. Pairs resolve at `max(live restitutions)`, so landings bounced at the ball's 0.3 (recorded rebound ratio 0.241). `js/objects/Trampoline.js` re-asserts the fabric material right after body creation. Post-fix rebound ratio 0.897 (impact vy 9.29 → rebound −8.33, apex y≈300 on the tilted fabric vs the bug's ~417). Commit `43486d4` on `integration/broken-functionality-fixes`; `tests/trampoline.test.js` (new, 2 tests).
- **Spring (bug-20261023T180834Z-gwce)** — *"the ball did not bounce from the spring ??"*. The pair resolves at the landing ball's own restitution 0.3 (the spring platform's declared 0.1 is zeroed by the same static flip), so the ball rebounded ~9 px above the platform during the 13-tick compression window — and the release burst, applied only to bodies `queryTouching` finds *at release*, went nowhere; the 30-tick cooldown then swallowed the re-landings and the ball rolled off to sleep (recorded: contact t31, collisions t48/t53, rest at (275, 364) through lastTick 196). Worse, the burst was an *absolute* force 0.08 and matter integrates `Δv = F/m·dt²`, so launch speed was inversely proportional to mass (bowling ≈ 2.7 px/tick, tennis ≈ 24.6). `js/objects/Spring.js` now remembers the bodies that armed a launch (`_riders`, bounded by `SPRING_CAPTURE_RADIUS = 160`) and bursts riders ∪ touching bodies at release with force × body.mass (≈ 22 px/tick for every mass); `restoreState` clears the riders too.
- **`js/interactions/rules.js`** — spring row handler passes the contact's owner object to the seam: `handler: (spring, other) => spring.armLaunch(other)` (row text/docs unchanged).
- **Tests**: `tests/spring.test.js` (new, 3 tests — recorded-scenario drop launches to the ceiling; bowling vs tennis leave at the same ≈ 22 px/tick; a rider airborne at release still gets its burst); `tests/engine-query.test.js` launch test re-pinned (measured ≈ −22, threshold −10; was ≈ −2.5 / −1); `tests/object-contract.test.js` restore test also pins the riders reset. Full suite **32 files / 354 tests green**.
- **Verification**: fresh recording of the spring bug scenario through the `SessionRecorder` harness replays **bit-exactly** (6 events / 40 pose rows, ADR 0006 intact) — contact t31 (as recorded), launch t44 @ vy −21.0, apex at the ceiling y≈18 vs the recording's no-launch rest at y≈364. The original bugfile now diverges *deliberately*: the recorded run's next collision is the ball re-landing on the spring at t48, the fixed replay's is `wall-ceiling` at t62. Post-fix harness: `.scratch/verify-spring-fix.mjs`.
- Housekeeping: `dist/` rebuilt locally (untracked) so the preview bundle carries both fixes.

## 2026-10-23 — Bugfix: editor panel (and 🐞 Bug File section) never rendered when entering Sandbox

User report: "I don't see any button in the UI". The panel never rendered in the live app: `#editor-overlay` was nested **inside** `#overlay-container`, whose `hidden` class `LevelSelect`/`GoalOverlay` toggle on every mode change — and the 🔧 Sandbox Mode button calls `levelSelect.hide()` (which re-hides the shared shell) **before** `setMode(AppMode.SANDBOX)`, so a `display:none` ancestor swallowed the floating panel no matter what its own classes said. Caught only by the pending manual browser pass; no test exercised ancestor visibility.

- **`index.html`** — `#editor-overlay` moved out of `#overlay-container` as a sibling (the "floats independently" intent in `EditorPanel._show()`'s comment is now true in the DOM); the modal shell keeps only goal/level-select overlays.
- **`js/ui/EditorPanel.js`** — `_show()` comment updated to document the placement constraint (no code change; the build/show logic was already correct).
- **`tests/editor-overlay-structure.test.js`** (new, 2 tests) — pins the index.html structure (`#editor-overlay` exists exactly once and never inside the balanced `<div id="overlay-container">…</div>` block), and the real sandbox-entry sequence (`levelSelect.hide()` → `mode:changed` SANDBOX, fake-DOM conventions per `speed-wiring.test.js`): panel + every ancestor carry no `hidden`, 🐞 Bug File controls present (label, status line, notes, dense toggle, 💾 Export, 🩹 Recover hidden-by-default), honest idle status `not recording`; leaving SANDBOX still hides the panel.
- Rebuilt `dist/` (`npm run build`) so the preview bundle carries the fix.
## 2026-10-21 — Session bug-file recorder + bit-exact replay harness (ADR 0006)

Physics bugs are now reportable as **files** instead of playthroughs. An always-on SANDBOX session recorder captures each visit (build trace + play runs with per-play board snapshots, raw dt stream, normalized play events, sampled poses) and exports one self-contained "bug file" JSON download; a Node/vitest replay harness rebuilds each run from its snapshot, re-steps the exact recorded dt sequence, and prints a divergence report. The grilling interview locked all 16 decisions (plan doc `docs/plans/session-bug-file-recorder.md`; ADR `docs/adr/0006-session-bug-file.md`).

- **`js/recorder/`** (new) — `schema.js` (SCHEMA v1 constants, topic vocabulary, refIds = `customId` else `type@<ordinal>`, pose/rounding helpers, canonical collision-pair ordering), `SessionRecorder.js` (DOM-free bus-driven recorder: session/run state machine mirroring the GameLoop, build trace with per-action snapshots incl. rope-knot tokens, poses every 6th tick with rolling budget + dense toggle, raw unrounded dt rows — the bit-exactness load-bearing detail, events-only ~2s localStorage mirror + crash-recovery stash, export), `replay.js` (Node-safe replay + divergence report; drives a second passive recorder as comparison collector — one implementation of every recording convention), `meta.js`/`browser.js` (app identity + download/localStorage shims; Node never imports package.json directly).
- **`js/objects/Balloon.js`** — `_bobPhase` (the one physics-affecting construction randomness) is now serialized **live** from `serialize()` and restored via `deserialize`; bug files, board snapshots, and editor-saved levels are therefore phase-exact.
- **`js/ui/DragDropManager.js`** — rotate drops now emit `object:rotated { id, angle }` (rotate previously emitted nothing — recordable-trace gap).
- **`js/ui/EditorPanel.js`** — 🐞 Bug File section: status line, free-text notes input, dense (60 Hz) toggle, 💾 Export, 🩹 Recover-crashed-session.
- **`js/main.js`** — recorder wiring (board/snapshot/engine/playfield accessors + localStorage mirror adapter + `beforeunload` flush).
- **`scripts/replay-bugfile.mjs`** — CLI: `node scripts/replay-bugfile.mjs <bugfile.json> [--run N] [--until tick] [--json] [--quiet]`; exit 1 on divergence. **`scripts/make-bugfile-fixture.mjs`** — regenerates graduated fixtures.
- **`tests/recorder.test.js`** (22 tests), **`tests/replay.test.js`** (5 tests incl. the committed fixture `tests/fixtures/bugfiles/ball-drop-ramp.json` replaying bit-exactly), **`tests/helpers/replayBugFile.js`**.
- **Docs**: ADR 0006; plan doc status; GLOSSARY gained "Bug files (ADR 0006)" (bug file, session recorder, build trace, run, refId, divergence report, `physics:collision`, events-only mirror).
- Live finding from the harness builder: Matter's collisionStart pair orientation (`bodyA/bodyB`) is **emergent** and flippers across sessions even when the simulation is bit-identical (pose rows matched 40/40 in the first cross-process replay) — pairs are now canonically ordered at record time.
- Status: `npm test` — 27 files / **345 tests, all green**; `npm run build` compiles; CLI smoke replays the fixture bit-exactly. GitHub issue deferred (`gh` not on this machine; body ready at `.scratch/issue-body.md`).

## 2026-10-21 — Rope↔payload tying: pull-to-tie (near-miss drops now tie, no play-start yank)

Manual playtest found the object-side tie seam's blind spot: dropping a bucket near a hanging rope's free end never wrote a knot — the bucket's `rim` point (an invisible mouth-edge offset) sat ~54 px from the rope end, outside the 24 px tie radius — so on play the bucket free-fell past the rope; and even an in-radius tie left a ≤ 24 px residual for the length-0 link to yank closed on the first play step.

- **`js/objects/Rope.js`** — new shared constant **`ROPE_ATTRACT_RADIUS = 64`** beside `ROPE_SNAP_RADIUS` (one number, one meaning across the placement pull and the glow hints).
- **`js/ui/DragDropManager._snapObjectToRopes`** — pull-to-tie: the nearest board rope endpoint (anchor or free end) within the attract reach translates the whole fresh drop (`setPosition`, boundary re-clamped) so its attachment point lands **exactly** on that endpoint; then the existing nearest-wins ≤ `ROPE_SNAP_RADIUS` tie pass runs (winner at 0 px ties exactly; the rigid translation preserves every other candidate's distance, so multi-rope/multi-knot boards are untouched). Rope-side tying/re-lay unchanged (decision 10 contract intact).
- **`js/render/Renderer._drawRopeEndpointHints`** — the glow rule now mirrors the seam: bright = within tie range, or the single global attract winner (the drop is pulled only onto that one); the rest stay faint dashed — green still means yes.
- **`tests/rope-snap-hints.test.js`** — pull-to-tie cases: bucket pulled onto the end from 40 px (rim lands exactly on it), out-of-reach drop left unmoved/unattached, two-rope nearest-wins pull with the farther in-range knot surviving the move, attract-ring glow + tie-line preview; the old "graze" geometries were inside the new reach and moved beyond it. 21 → 25 tests; full suite **27 files / 318 tests green** (`cmd /c npm test`).
- **Docs**: `docs/adr/0005-rope-as-connector.md` decision 11 records pull-to-tie (and supersedes decision 10's residual-closes-on-play claim for placement-time tying).

## 2026-10-21 — Agent play interface, phase 1 landed (observation layer, action API, solver)

Per `docs/plans/agent-play-interface-phase-1.md` — the game is now drivable headlessly by a program. New top-level `agent/` directory (Node ESM, sibling of `js/`; the browser bundle does NOT import it — zero changes to `js/**`):

- **`agent/session.js` — AgentSession**: owns engine + registry bootstrap + goal checking + world rebuild. Level by id (`node:fs/promises` under `js/levels/puzzles/`) or as a plain object (ad-hoc). Every trial rebuilds a **fresh engine** from `fixedObjects` + placements via the production seam (mirrors `main.js _setupLevel`: `objectRegistry.create(type, x, y, { angle, isFixed, customId })`), and arms a private **`GoalChecker` instance** (dispose → init per rebuild) with the same `level:loaded` / `mode:changed` / `loop:frame` seams the live app and `tests/goals.test.js` drive — goal detection needed no changes. `trial({ seconds, dt })` → `{ outcome: reached|failed|timeout, elapsed, events, distance, snapshot }`.
- **`agent/actions.js`** — place / remove / rotate / nudge / reset / trial; every action returns a result object and never throws on bad input. Budget-checked against `availableParts`; off-playfield rejects with the clamped position (via `clampObjectToPlayfield`); level `fixedObjects` are immutable, only agent placements are addressable (type + 0-based slot).
- **`agent/observe/`** — legend.js (2-char glyphs per type + functional-sensor overrides: bucket catch zone `v`, candle flame `f`, spring platform `-`, painted by priority so an open bucket mouth stays visible); grid.js (bounds-box fill — the verified point-sampling fix — `#` frame, 10-column ruler, `auto` cell picking smallest of {8, 10, 12.5, 16} keeping ≥1 blank row/col between objects, `full` = the precise 125×75 map, `wall-*` excluded); state.js (one aligned line per object: id / type / pos / angle / size / flags / motion / extra — extras only from the AUDITED public getter surface: `Bucket.caughtCount`, `Rope.isSevered`, `Balloon.isPopped`, `Scissors.isClosed`; nothing invented); events.js (eventBus → bounded ring buffer of timestamped sentences, fixed topic list — EventBus has no wildcard); graph.js (goal / phys / touch / fired + dormant hints, each from a real source of truth: level goal, constraint links, active Matter pairs, recorder rows, `DEFAULT_INTERACTION_ROWS`); describe.js (`describeWorld(session)` — the one prompt-ready entry point).
- **`agent/solver.js`** — deterministic brute force, no model in the loop: target-alone lattice trials first (points ordered by distance-to-zone), then one helper part with the target at geometry-derived drop spots from its Matter vertices; `maxTrials` cap; reaches early-exit; unsolved reports the best partial (final target→zone px distance) as a diagnosis.
- **`agent/cli.js`** — `node agent/cli.js --level level-01 --solve` / `--describe`. **DoD proven live: level-01 solved in 1 trial** (`place(ball, 700, 500)` — zone-distance ordering puts the direct drop first), printing winning placements, the final ASCII map with `caught:1` state and `relations: goal … status: reached`, then `goal reached`.
- **`tests/agent/`** — 20 new tests (grid 4, state 3, graph 3, actions 7, solver 3): the level-01 win through the REAL GoalChecker seam, bounded clean failure + diagnosis on a level the solver cannot win, format pins (frame/ruler/columns), budget/off-playfield validation, dormant wildcard-target hints. Full suite: **27 files / 314 tests, all green** (`cmd /c npm test`).
- Implementation notes: `PhysicsEngine.getObjects()` returns the live **Set** — spread before array ops (`.find`/`.map` on a Set throws; caught by the first test run). Solver lattice defaults 50 px (plan sketched 25; zone-distance ordering made the coarse lattice win immediately — revisit only when a level needs it).

## 2026-10-21 — Discovery seam phase 2: object-level queries, overlap zones, impulse field (issue #16)

- **Object-level seam queries**: `queryObjectsByType(type)` / `queryObjectsByBodyLabel(label)` return registered game objects (owner registry) filtered by type, or by owning any body with that label — replaces the hand-rolled world scan Scissors did for its blade-snap target discovery. Pure reads, same discovery policy as the body-level probes they wrap.
- **Overlap zones**: `queryZoneOverlap(referenceBody, zone)` — `queryZone` semantics with bounds-based matching (a body whose centre is outside the rect but whose bounds reach in still matches); ordering, policy and return shape identical to `queryZone`.
- **Impulse-field primitive**: `applyImpulseField(sourceBody, { zone, range, force, direction?, match? })` — one engine-side law for directional per-frame fields: candidates in a source-local rect zone (position-inside, or `match: 'overlap'` for bounds), `force = direction · field.force · (1 − dist/range) · body.mass` with `direction` in the source frame (default local "up"; 90° maps local −y to +x), wake-on-act folded into the same call, dist-0 and beyond-range candidates excluded, returns the acted bodies.
- **Fan is now a thin wrapper**: `onBeforeUpdate` supplies the zone/range/force dials and blade animation to `applyImpulseField`; all fan regression tests pass unchanged (discovery had already been the seam's `queryZone` since the original migration).
- **Tests**: `tests/engine-query.test.js` → 34 (5 object-level incl. pure-read + removed-object rules; 4 zone-overlap precision vs position-inside on unrotated + 90° zones; 6 impulse-field: law values at 0.75/0.25 falloff, 90° rotation, statics/own-body skips, wake-on-act with outsiders asleep, zone-corner/degenerate-distance bounds, overlap-match pillar case). Full suite: 17 files / **221 tests, all green**.
- **Docs**: ADR 0002 gained an amendment section (decisions 1–4); glossary "Discovery & wake" extended with object-level query, overlap zone, impulse field.

## 2026-10-18 — Lifecycle contract & restore parity (candidate C3, ADR 0003)

- **Dead hook removed**: `PhysicsEngine.step()` no longer dispatches `onAfterUpdate` (zero implementers anywhere — contract noise); the step is pre-hooks + `Engine.update` only.
- **Lifecycle declared on `BaseObject`** (create → play → restore → dispose, ADR 0003 decision 1): `restoreState(data)` is now an optional default no-op on the base class — the snapshot-restore seam (engine re-apposes bodies by body id, then calls this for behavioral state only); the docblock states which hooks are optional vs mandatory.
- **restoreState parity landed**: `Bucket` (`_caught.clear()`), `Spring` (trigger/compression/cooldown armed-fresh), `Trampoline` (`_stretch = 0`) — transient resets, "cycles start clean" (snapshots are pre-play; Mouse-pattern). `Gear` is snapshot-faithful: restores `_angularSpeed` from the serialized `options.angularSpeed` ride-along — **the gear ✕ gear meshing reversal no longer survives a same-instance restore** (a replay-divergence bug the candidates card had missed: the matrix's `meshWith`/`applyGearDrive` mutates drive mid-play).
- **Contract bug found by the sweep and fixed**: every class's `deserialize` feeds angle/isFixed through the options channel, so `BaseObject` kept them in `_options` and serialize→deserialize→serialize round-trips grew phantom keys. `BaseObject`'s constructor now strips the lifecycle keys (`customId`/`angle`/`isFixed`) — round-trips stable for all 17 registered types (grep-verified: zero `_options.angle/isFixed` consumers).
- **Dual restore paths documented** (ADR 0003): physics restore (same instances, body-id matched, `restoreState` seam) vs placed restore (`levelReset.js` — fresh deserialize, construction IS the restore). Boundaries recorded: rope-severed/balloon-popped are unrecoverable by design (body-id set divergence skips the seam); cosmetic animation (candle flicker, belt stripes, fan spin) not preserved.
- **EditorPanel `level:loaded` bypass closed** (C3-adjacent bug): editor-imported JSON routes through `LevelManager.loadCustom(data)` → `_currentLevel` installed → reset (`getCurrentLevel()`) rebuilds the right level and `goal:reached` marks the right id (now `id`-guarded so id-less levels can't persist `'undefined'` progress). Previously Reset after an import rebuilt the previous puzzle.
- **Tests**: new `tests/object-contract.test.js` (15 tests) — registry sweep pins the contract for every registered type (17: round-trip stability, callable seams, zero event-bus listener leaks across attach/detach); parity pins Bucket/Spring/Trampoline/Gear restore semantics plus the existing Mouse/Scissors/Pulley contracts; engine-level `restoreSnapshot` integration + removed-object identity rule; `loadCustom` routing and the id guard.
- **Docs**: `docs/adr/0003-lifecycle-contract.md` (decision 1–5, bugs fixed, consequences); ADR 0001 out-of-scope C3 row marked implemented; glossary gained "Lifecycle & restore (ADR 0003)".
- Status: `npx vitest run` — 16 files / **193 tests, all green**.

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

## 2026-10-19 — Rope tying made visible (issue 04 placement UX)

The placement-time rope tying shipped in `833fe4c` (ADR 0005 decision 7) was real but invisible: the 24 px snap was silent, no drag-time markers existed, and the post-drop ring was a hair-thin 5 px circle — a player had no way to see tying happen or aim for it.

- **Drag-time snap hints** (`Renderer._drawRopeSnapHints`, driven by a live drag-state window the renderer reads each frame): while a tool-ghost rope hangs on the cursor, every board attachment point renders — a faint dashed marker when beyond reach, and a bright marker with a tie-line when a clamped drop of the current mouse position would tie (ghost endpoint within radius of the point). Hints use the same body positions the placement snap matches on, so green always means "yes".
- **One constant, two consumers:** `ROPE_SNAP_RADIUS` moved to a `Rope.js` export; `DragDropManager` imports it instead of carrying its own copy (no import cycle — hints render straight off DragDropManager's drag state).
- **Knot ring strengthened** (`_drawRopeKnots`): r 5→7, darker stroke, solid core — the tie is a visible structure, not a hairline.
- **Toolbox copy:** rope/balloon/bucket descriptions now explain tying ("drop an end on the knot / the rim / ties to ropes").
- New `tests/rope-snap-hints.test.js` (9 tests): the drop-tie seam in DragDropManager (tie on a 22 px drop, out-of-range 40 px stays free, nearest-wins, re-lay after anchor ties) + hint rendering (ghost-rope gating, bright-within/faint-beyond, knot ring, hint suppression in play modes) + the strengthened knot ring. Full suite: **22 files / 282 tests, all green** (`cmd /c npm test`). Verified in-browser via Playwright (Sandbox drag flow: faint marker far, green tie ring within radius, gold knot ring after the drop; no console errors).

## 2026-10-21 — Rope tying made order-independent (issue 04, object-side mirror)

The placement tie fired only while the rope was the dragged part: a placed rope's endpoints sat inert when a balloon or bucket was dropped onto them, and a popped balloon forced re-laying the whole rope.

- **DragDropManager._snapObjectToRopes** — runs for every non-rope placement: each attachment point of the dropped object ties every board rope endpoint (anchor or free end) within `ROPE_SNAP_RADIUS`, via the same `attachEndpoint` knot refs, nearest-wins and lazy length-0/0.9 links as rope-side tying. The laid rope is deliberately **not re-layed** (re-laying could drag existing knots on its other endpoint); the ≤ 24 px residual closes on the first play step. Delete-then-replace just works: the dead ref is pruned by the first reconcile step and cannot block the fresh tie.
- **Renderer._drawRopeEndpointHints** — the object-side mirror of `_drawRopeSnapHints`: while a knot-bearing part hangs on the cursor, every board rope endpoint renders faint-dashed beyond reach or bright green + tie-line when the drop would tie (same clamped-position math as the tie seam). Severed/disposed ropes are skipped; rope ghosts are unchanged (they keep `_drawRopeSnapHints`).
- **Toolbox copy:** the rope description is now order-neutral ("drop either part right up close to the other").
- Rope-to-rope tying stays intentionally unsupported (ropes expose no attachment points) — decision 10 documents it.
- `tests/rope-snap-hints.test.js` 9 → 21 tests: object-side tie to free end / anchor / bucket rim, out-of-range no-op, severed skip, one knot holding two ropes, replace-after-delete, first-play-step engine-link realization; hints: bright + tie-line, faint dashed, mixed styles on one rope, severed skip. Full suite: **22 files / 294 tests, all green** (`cmd /c npm test`). Verified in-browser via Playwright (rope dropped, balloon placed onto its free end: green tie-hint ring on hover, gold knot ring after the drop, balloon stays tethered during play; no console errors). ADR 0005 decision 10.

