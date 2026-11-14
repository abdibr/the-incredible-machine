# ADR 0006 — Session bug files: sandbox recorder + snapshot-authoritative replay

- **Date**: 2026-10-21
- **Status**: Accepted
- **Scope**: physics-bug reproduction workflow — an always-on SANDBOX session recorder exporting a "bug file" (JSON download), a Node/vitest replay harness with a divergence report, the `Balloon` bob-phase serialization fix, and the missing `object:rotated` edit event. Plan doc: `docs/plans/session-bug-file-recorder.md`.

## Context

Physics bugs reach the contributor as live play sessions only. The agent interface (`agent/`) proves the repo can debug by replaying trials headlessly (`AgentSession`: fresh engine per trial, fixed `dt`, `loop:frame` per step), but there is no path from a *browser bug report* to that harness: the reporter can only describe what happened, and any hand-rebuilt repro drifts from the original. The recorder must be zero-attention in SANDBOX (bugs surface while playing, not while preparing to play) and must survive a crashed/reloaded tab.

Two hard facts shape the design:

- The browser `GameLoop` steps with **variable rAF dt** (capped 50 ms, floor 16.67) — unlike `AgentSession`'s fixed `dt`. A replay stepping fixed 1000/60 would not reproduce a recorded run. Determinism in Matter.js is per *exact* dt sequence, not per tick count.
- `Balloon.onBeforeUpdate` applies `Math.sin(_bobPhase) · 0.00005` x-force every step and `_bobPhase = Math.random()` at construction — the one true nondeterminism in a constructed world (candle flicker etc. are render-only). `Balloon.serialize()` does not carry it.

## Decision

1. **Snapshot-authoritative replay.** A run's play-start board snapshot (`serializePlacedBoard`, ADR 0005's two-phase rope bind) is the only source of truth the harness rebuilds from; the recorded `build[]` trace is narrative. Replay recreates the world by fresh deserialize (construction IS the restore) — never by replaying commands against the trace.
2. **The recorded dt stream is part of the run.** Each run stores every step's actual dt (ms, 6-decimal rounded) and `loop:speed` events; the harness consumes that exact sequence (re-applying `setTimeScale` at its ticks) instead of a fixed step. Bit-exactness therefore extends to 2×-speed recordings.
3. **Cross-session identity = refIds, not Matter ids.** Matter body ids are per-session; pose rows and collision pairs are normalized to board-order-derived refs (`customId` when the board row has one, else `type@<rowOrdinal>`), with Matter body labels preserved as the per-body discriminator. Boundary walls record their wall label. `physics:snapshot-mismatch` records counts only.
4. **Collisions recorded by the recorder, not the bus.** The recorder attaches its own `Matter.Events.on(engine, 'collisionStart')` hook and records pairs under `physics:collision` in the bug file. No bus topic exists; dispatch continues to flow only through the interaction matrix (ADR 0001) — the pruned per-object collision hook stays dead, and no production code consumes the file's collision rows.
5. **`Balloon` phase becomes serialized state.** `serialize()` emits the *live* `bobPhase` (a stored `_options.bobPhase` would go stale as it advances), `deserialize` seeds it. Side effect: saved levels and editor files become phase-exact too.
6. **Trace completeness**: `DragDropManager` emits `object:rotated { id, angle }` on rotate mouse-up (rotate moves previously emitted nothing), so a build trace reconstructs pose history.
7. **Session semantics.** A session is one SANDBOX visit (arms on `MENU → SANDBOX`, disarms on exit to `EDITING`/`MENU`). Runs open on `loop:play` while the mirrored loop state is stopped (fresh plays rebuild via `beginPlay`; PAUSED resumes keep the run) and close on `controls:reset`, a mode change out of PLAYING/PAUSED/WON, or export. Tick labels = completed steps at emission; pose rows are sampled every Nth tick (6 ≈ 10 Hz, dense = 1) with a rolling per-run budget; events are never truncated.
8. **Crash survival is events-only.** A ~2 s throttled `localStorage` mirror carries header + notes + build + run events + dt stream (poses excluded), capped. After a reload the previous session is recoverable/exportable (poses flagged lost); the mirror never feeds live replay.
9. **One collector for both directions.** The replay harness drives a second recorder *instance* (passive) against the rebuilt engine and compares recorded vs replayed streams — event rows by `(tick, topic, data)` and pose rows by tick — so the recording conventions live in exactly one implementation (`js/recorder/SessionRecorder.js`), eliminating convention drift. Only "replayable" topics (physics verdicts + collisions) participate in comparison; command rows (`controls:*`, `mode:changed`, `loop:pause/speed`) are narrative.
10. **Exactness caveat, documented**: replay is bit-exact against the same code version and the same JS engine's Math library (trig/sin implementations may differ across browsers); the harness reports (rather than hides) any divergence.

## Consequences

- Bug reports become file references: `node scripts/replay-bugfile.mjs bugfile-….json` prints a divergence report (first mismatching tick, recorded vs replayed values) and exits non-zero on mismatch; graduated files drop verbatim into `tests/fixtures/bugfiles/` as regression fixtures.
- Cost: the recorder always subscribes in sandbox (cheap: flat event rows + 6th-tick samples); downloads can be large when dense mode is left on (budgeted by the pose cap).
- The browser dt stream makes recordings environment-true but slightly larger than fixed-dt would be; the `physics:snapshot-mismatch` event remains meaningful only for live sessions.
- `Balloon` round-trips now carry a live state value; option-stability of serialize→deserialize (ADR 0003 C3) is preserved because the phase is written from the live field, not accumulated in `_options`.

## Related

- ADR 0001 (interaction matrix), ADR 0003 (lifecycle contract / restore seam, `AgentSession` precedent), ADR 0005 (rope connector / `serializePlacedBoard` tokens)
- ADR 0008 — fixed-timestep stepping: the browser-loop variable-dt fact in Context is superseded (rows are now uniform `1000/60`); decision 2's dt-tape mechanism stands unchanged
- `js/recorder/*`, `scripts/replay-bugfile.mjs`, `js/reset/levelReset.js`, `js/engine/GameLoop.js`, `agent/session.js`
- `docs/plans/session-bug-file-recorder.md`

## Amendment (2026-11-14) — the saved span is a restored spawned free rope's restore lay (issue #93)

Verdict on `bug-20261114T021258Z-ufzs` ("the free rope disconnects from the other rope without a reason"): **recorded-correct**. The recording's run rebuilt under then-current code diverged at `event-count 3 vs 0` — the free rope's tail segments contact `bucket-wall` at ticks 77/79/82 of the recorded dt tape in the live run, but the rebuild's tail never touches anything. The culprit restore path is **not** issue #57's attachment-point/reconcile work (those govern link realization — the inbound-pairs desired set — and never move bodies): it is the restored spawned free rope's token-bind birth, `bindPlacedTokens → bindAttachment → attachEndpoint('anchor', …) → _spawnChain`, which lay the chain `straight down` from the tie point (the fresh-coil birth of issue #55) while honoring only the row's saved `length`. The board snapshot's free-rope row carries the hand's *re-laid span as real state* — `length` 86.209 **and** `endPoint` (120.55, 290.06), laid across the pinned rope's chain — and the reporter's own sandbox rewind shows the same path live (the build trace's `rope:chain-spawned` right after the run's `controls:reset`). The drift predates the rope train (the straight-down spawn is there in issue #55); this bug file is simply the first committed recording whose play-start board holds a hand-laid spawned free rope, so the gap surfaced now.

Decision, per decision 1 (snapshot-authoritative replay): a restored spawned free rope re-derives its chain from the row exactly as the live world held it — the saved span's **direction** included. `_spawnChain` now lays along `_spanDirection()` when the rope's span is a row's real state (`_authoredSpan` — the `spawned` discriminator `FreeRope.deserialize` already passes), falling back to the documented straight-down birth for a fresh coil (no span of its own) and for a collapsed bundle's nulled `endPoint`. Live play never changes: a live first tie still births a straight-down chain. With it, the fixture replays bit-exactly (3 events, 23 pose rows).

Pinned in `tests/replay.test.js` (the committed-fixture regression: the verbatim file is `tests/fixtures/bugfiles/bug-20261114T021258Z-ufzs.json`) and in `tests/rope-to-rope.test.js` (the tie repro: a tie click on the recorded board realizes the rope-to-rope knot and survives the token seam; the flow paints a rope-side refused tie instead of swallowing it — no silent refusal). Full suite at amendment time: 59 files / 667 tests, all green.