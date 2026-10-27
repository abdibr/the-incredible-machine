# Plan — Sandbox session bug-file recorder + replay

Interview-set design (grilling session, all decisions user-confirmed). ADR: `docs/adr/0006-session-bug-file.md`.

> **Status: implemented.** Full suite 27 files / 345 tests green; production build compiles; CLI smoke replays the committed fixture bit-exactly (6 events, 40 pose rows). The GitHub issue is the one deferred deliverable (`gh` CLI not present on the build machine; body prepared at `.scratch/issue-body.md`).

## Problem

Physics bugs are reported by *playing*; the coding agent currently has no artifact to work from — it can only try to re-reproduce by guesswork. We need an always-on, zero-attention recorder in SANDBOX mode that exports a self-contained **bug file** (one JSON download): the story of one sandbox visit — build steps + play runs — plus a **replay harness** that re-simulates a bug file and reports where the world diverges. Graduated bug files become committed regression fixtures.

## Decisions (locked)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Artifact | Event log + sampled poses + replayable runs; pose data doubles as eyeballing fallback when replay diverges |
| 2 | Delivery | Browser **download** (`bugfile-<UTC-slug>.json`, `fileId` inside); attach to issue or drop in repo (working copies in gitignored `.scratch/bugfiles/`) |
| 3 | Fidelity | **Bit-exact** against the same code version: balloon `_bobPhase` captured via `serialize()`/`deserialize` (also makes saved levels phase-exact); exactness caveat = same browser Math lib, documented in ADR |
| 4 | Granularity | Events always (never truncated) + pose sampling every 6th tick (~10 Hz) default, **dense (60 Hz)** toggle, rolling pose-row budget; pose rows **per body incl. velocity** |
| 5 | Structure | `build[]` (ordered edit trace) + `runs[]`; each run = own tick stream + **play-start board snapshot** |
| 6 | Arming | **Always-on in SANDBOX** (buffers cheap); single 💾 Export button in the Editor panel |
| 7 | Replay truth | **Play-start board snapshot is authoritative** (proven `serializePlacedBoard` + two-phase bind, ADR 0005); `build[]` is diagnostic narrative only — no command re-execution |
| 8 | Harness | **Both**: `scripts/replay-bugfile.mjs` CLI + vitest helper, sharing one divergence-report core in `js/recorder/replay.js` |
| 9 | Metadata | `schemaVersion, fileId, createdAtUtc, playfield, engine{...}, appVersion, userAgent, notes` — free-text **notes input in the Editor panel** |
| 10 | Crash survival | **Throttled ~2 s events-only localStorage mirror**; post-crash "recover session" export (poses marked lost) |
| 11 | Collisions | Recorded **by default** — captured by the recorder via `Matter.Events.on(engine, 'collisionStart')` hook (no new bus topic; bus-global dispatch still routes only through the interaction matrix, ADR 0001 intact); fires once per *new* contact, so no resting-stack flood |
| 12 | Pose rows | Per-body `[refId, bodyLabel, x, y, angle, vx, vy]`, 3-decimal rounded; velocity columns are often the diagnosis |
| 13 | Graduation | Verbatim fixture in `tests/fixtures/bugfiles/`; helper replays it as the regression test |
| 14 | Trace gaps | Add the missing `object:rotated` emission in `DragDropManager` (rotate drop currently emits nothing) |
| 15 | Lifecycle | Fresh session each SANDBOX entry from MENU; survives build→play→reset→edit→play inside the visit; session ends on exit to MENU/EDITING |
| 16 | Deliverables | Plan doc + ADR + one GitHub issue → implement now |

## Cross-cutting facts the design relies on

- **Variable dt in the browser**: `GameLoop._frame` steps `physics.step(dt)` with raw rAF deltas (capped 50 ms, floor 16.67); only `agent/session.js` steps fixed `dt`. ⇒ **replay must consume the recorded per-tick dt stream**, not a fixed step. The `loop:speed` → `PhysicsEngine.setTimeScale` events are recorded and re-applied at their ticks (`engine.timing.timeScale`).
- **Run boundaries derive from loop state**, mirrored by the recorder from `loop:play` / `loop:pause` / `controls:reset` / `mode:changed`: a run opens on `loop:play` while stopped (fresh play re-serializes in `beginPlay`; PAUSED resume keeps the open run) and closes on `controls:reset`, a mode change out of PLAYING/PAUSED/WON, or session export ("open at export").
- **Body identity across browser-vs-replay**: Matter body ids are assigned per session and will not match ⇒ poses/collisions are normalized to **refIds**: `customId` when the board row has one, else `type@<rowOrdinal>` in board-snapshot order (stable by construction — `serializePlacedBoard` annotates ropes against that same order). Collision pair labels that hit boundary walls record their wall label (`wall-floor` etc.) — documented null-participants never map to objects.
- Sandbox board snapshots include isFixed rows (goal zone etc.) — replay deserializes **all** rows and two-phase-binds ropes against the full board, mirroring `restorePlacedFromSnapshot` minus the fixed-skip (fixed-skip exists only because level modes rebuild fixed objects from level JSON; here the snapshot *is* the level).
- `goal:reached` requires a `GoalChecker` on the bus; the harness attaches a private one (the `AgentSession` pattern) only when the run context carries a goal (custom-level sandbox visits).

## File plan

```
js/recorder/
  meta.js           — app name/version (package.json import; vite+vitest resolve it)
  schema.js         — SCHEMA_VERSION, sampling/budget constants, topic vocabulary,
                      normalization helpers (refId, pose rounding, collision pairs, header)
  SessionRecorder.js— DOM-free core: bus subscription, session/run state machine,
                      build trace, dt stream, pose sampler, export JSON, (optional)
                      injected mirror-store adapter for crash recovery
  replay.js         — DOM-free replay + divergence report (Node-safe)
  browser.js        — browser-only shims (download, localStorage adapter); imported by UI only
js/ui/EditorPanel.js     — Bug-file section: notes input, dense toggle, 💾 Export,
                           recover-crashed-session button, status line
js/main.js               — sessionRecorder.init({ getObjects }) wiring
js/ui/DragDropManager.js — emit object:rotated {id, angle} on rotate mouseup
js/objects/Balloon.js    — serialize()/deserialize bobPhase round-trip
scripts/replay-bugfile.mjs    — CLI: replay a bug file, print divergence report, exit code
tests/fixtures/bugfiles/      — graduated verbatim fixtures (one committed sample)
tests/helpers/replayBugFile.js— vitest wrapper
tests/recorder.test.js        — recorder unit tests
tests/replay.test.js          — record≈replay end-to-end + divergence detection
```

## Bug-file schema v1 (download shape)

```jsonc
{
  "schemaVersion": 1,
  "fileId": "bug-20261021T093045Z-x7q2",
  "createdAtUtc": "2026-10-21T09:30:45Z",
  "appVersion": "1.0.0", "matterVersion": "0.20.0",
  "userAgent": "…",
  "playfield": { "width": 1000, "height": 600 },
  "engine": { "gravityX": 0, "gravityY": 1, "enableSleeping": true, "fixedStep": false },
  "notes": "balloon passes through ramp on 3rd bounce",
  "context": { "mode": "SANDBOX", "levelId": null, "goal": null },
  "build": [ { "seq": 0, "event": "object:placed", "ref": "ramp#14",
               "snapshot": { "type": "ramp", "x": 300, "y": 200, "angle": 0.78,
                             "isFixed": false, "options": { }, "attachments"?: [ ] } } ],
  "runs": [ {
    "index": 0,
    "boardSnapshot": [ /* serializePlacedBoard rows, incl. isFixed + rope attachment tokens */ ],
    "refTable": [ { "ref": "ball@3", "type": "ball" } ],
    "dt": { "policy": "recorded", "values": [16.67, 16.71] },
    "events": [ { "seq": 21, "tick": 120, "topic": "rope:severed", "data": { "ref": "rope@5" } },
                { "seq": 22, "tick": 180, "topic": "physics:collision",
                  "data": { "a": "ball@3", "aBody": null, "b": "ramp@7", "bBody": "ramp-face",
                            "aStatic": false, "bStatic": false } } ],
    "poses": { "interval": 6, "rows": [ [120, ["ball@3", null, 512.3, 201.8, 0.012, 2.301, 0.4]] ],
               "posesTruncated": false },
    "timeScale": [ { "tick": 400, "speed": 2 } ],
    "lastTick": 1809, "endedBy": "controls:reset"
  } ]
}
```

Edit topics (`build[]`): `object:placed`, `object:moved`, `object:rotated`, `object:removed`, `level:loaded`, `mode:changed`.
Play topics (`runs[].events`): collision pairs (see above), `rope:severed`, `rope:chain-converge`, `balloon:popped`, `bucket:caught`, `goal:reached`, `goal:failed`, `physics:snapshot-mismatch` (counts only — Matter ids don't survive the session), `controls:pause`, `controls:reset`, `controls:speed`, `loop:speed`, `mode:changed`.

## Implementation checklist

Implementation notes (what actually shipped):
- dt rows are recorded **unrounded** (JSON preserves doubles; rounding would break bit-exactness) — `roundDt` stays a schema utility for other consumers.
- Collision pairs are recorded with **canonical side ordering** (`canonicalCollisionPair`) — Matter's `bodyA/bodyB` orientation is emergent and can differ across sessions even when the simulation is bit-identical (observed live in the harness).
- `toJSON()` runs through an explicit `_runToDoc` mapping — internal Maps (`instanceRef`, `bodiesById`) never leak into exports (Maps JSON-serialize as `{}`).
- The replay observer reuses `SessionRecorder` (passive) so record/replay conventions share one implementation.

- [x] `js/recorder/schema.js` — constants + normalization (pure, Node-safe)
- [x] `js/recorder/SessionRecorder.js` — core recorder (bus-driven; DOM-free)
- [x] `js/recorder/replay.js` — replay + divergence report core (Node-safe)
- [x] `js/recorder/meta.js` + `browser.js` shims
- [x] `Balloon.js` bobPhase round-trip (+ tests)
- [x] `DragDropManager.js` `object:rotated`
- [x] `EditorPanel.js` bug-file section + wiring; `main.js` recorder init
- [x] `scripts/replay-bugfile.mjs` + `tests/helpers/replayBugFile.js` + `scripts/make-bugfile-fixture.mjs`
- [x] `tests/recorder.test.js` (22 tests) + `tests/replay.test.js` (5 tests, incl. the committed fixture)
- [x] GLOSSARY.md new terms; work-log entry
- [x] Full suite green (345 tests) + CLI smoke run bit-exact
- [ ] GitHub issue — **deferred**: `gh` CLI not installed on this machine; ready-to-run command + body at `.scratch/issue-body.md`

## Explicit non-goals / accepted caveats

- Sandbox-mode wiring only (module is generic; level-mode arming is a later ticket).
- Crash recovery keeps **events only**; poses are lost and marked so.
- No browser-side replay UI (CLI + vitest only, v1).
- No recording of render-only randomness (candle flicker) — visual state is not part of the physics contract.
- Exactness holds for the same code version **and** Math lib (documented), and assumes the recorded dt stream is replayed verbatim.