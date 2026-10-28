# ADR 0008 — Fixed-timestep physics stepping (accumulator in GameLoop)

- **Date**: 2026-10-27
- **Status**: Accepted
- **Scope**: browser `GameLoop` stepping contract (`js/engine/GameLoop.js`) — the seam between wall-clock rAF frames and `PhysicsEngine.step`. Recorder, replay harness, and `PhysicsEngine` are untouched. Tests: `tests/fixed-timestep.test.js` (TDD; issue #80).

## Context

ADR 0006 made replay bit-exact by recording the browser loop's **variable rAF dt** (capped 50 ms, floor 16.67) verbatim and feeding it back. That treats the symptom: a bug file replays exactly, but the underlying live simulation is frame-rate dependent — a variable-size dt changes Matter.js integration and sleep behavior, so a ball on a ramp follows a different trajectory at 30 fps than at 60 fps. Live reproduction thus depends on the reporter's monitor, and replay can only follow the recording's own path.

`AgentSession` already runs fixed `dt = 1000/60` headlessly (`agent` module). ADR 0006's decision 2 was deliberately a general mechanism — a per-step dt tape that replay consumes verbatim — so the browser loop could be moved onto the same discipline without touching recorder, replay, or engine.

## Decision

1. `GameLoop` steps physics only in exact quanta of `FIXED_STEP_MS = 1000 / 60` (an exportable constant, the identical double `AgentSession.trial()` uses as its `dt` default). Frames of any rate feed an accumulator; physics never sees a dt other than `FIXED_STEP_MS`.
2. Per rAF frame: cap the raw frame dt at the existing `_maxDt` (50 ms) — the over-cap part is dropped (spiral-of-death bound, at most ~3 catch-up quanta per frame), the sub-quantum remainder carries forward. Then drain whole quanta: one quantum = `Engine.update` + `_elapsed` increment + one `loop:frame{dt, elapsed}` emission, in the `step → elapsed → emit` order the replay harness mirrors (ADR 0006 decision 2). Frames that accumulate less than one quantum emit nothing.
3. Still exactly one `loop:frame` emission per `Engine.update`, which is the recorder's unit of work — so recorded dt streams become uniform 1000/60 rows that replay consumes verbatim exactly as before (row value ≡ `AgentSession.trial()`'s `dt` default).
4. `play()` and `reset()` re-zero the accumulator; the dt≤0 priming path right after `play()` yields exactly one fixed step (previously a hardcoded ~16.67 guess).
5. `cycleSpeed`/timeScale wiring is unchanged: speed scales `timing.timeScale` inside `Engine.update`, so a 2× recording remains a 1000/60 tape whose replay re-applies `setTimeScale` (regression-tested against the `ball-drop-ramp` fixture).
6. The render callback runs once per frame after the drain (it is a view-side callback; consumer order-dependence begins and ends with the per-quantum emits).

## Consequences

- Simulation is frame-rate independent: the accepted test drives the same spring/ball world at 60 fps, 30 fps, and jittered per-frame dt, landing all runs at the same tick count, then compares `timing.timestamp` and body positions bit-exactly (`===`).
- Bug files stop depending on the reporter's monitor for live reproducibility; the recorded dt tape (ADR 0006) degenerates to a constant — the mechanism stays as the safety net for legacy files and future variability, and existing fixtures (e.g. `ball-drop-ramp recorded at a fixed-step loop`) replay bit-exactly as before.
- Cost: when the display is slow, sim time drags behind wall-clock (over-cap time is dropped) — the standard fixed-step trade; the 50 ms cap keeps stalls bounded to ~3 catch-up quanta.
- The previous `if (dt <= 0) dt = 16.67` magic number is replaced by the exported `FIXED_STEP_MS`.

## Related

- ADR 0006 — supersedes its Context's variable-dt browser figure; decision 2's dt-tape mechanism stands (rows are now uniform `1000/60`)
- `tests/fixed-timestep.test.js`, `agent/session.js` (the fixed-`DT` precedent), `js/recorder/replay.js`, `js/recorder/SessionRecorder.js`