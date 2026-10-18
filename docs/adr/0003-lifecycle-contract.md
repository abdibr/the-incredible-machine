# ADR 0003 — Object lifecycle contract & the restore seam

- **Date**: 2026-10-18
- **Status**: Accepted
- **Scope**: candidate C3 of the interaction-architecture candidates report (follow-up from ADR 0001's out-of-scope list; companion to ADR 0002's discovery & wake seam). Includes the C3-adjacent finding: `EditorPanel` emitted `level:loaded` directly, past `LevelManager`.

## Context

The object contract was split and only partially populated:

- **`serialize()` / `static deserialize()`** — implemented by all classes, but every `deserialize` re-feeds `angle`/`isFixed` through the constructor's options channel; `BaseObject` kept those lifecycle keys inside `_options`, so serialize→deserialize→serialize round-trips were unstable (phantom keys accumulated per rebuild).
- **`restoreState(data)`** — implemented by only 3 classes (Mouse, Pulley, Scissors); `PhysicsEngine.restoreSnapshot()` calls it (body-id-set match) as a behavioral-state seam, yet `Bucket._caught`, `Spring._triggered/_compression/_cooldown`, `Trampoline._stretch` — and `Gear._angularSpeed` via matrix meshing (`applyGearDrive`) — survived a same-instance physics restore.
- **`onAfterUpdate`** — a dead hook: dispatched from `PhysicsEngine.step()` with zero implementers anywhere, not even declared on `BaseObject`.
- The gaps were masked in the live app: the visible reset paths (`controls:reset` → `_resetLevel`) rebuild instances from level data (fresh deserialize = fresh state). The same-instance physics restore (`GameLoop.reset()` → `restoreSnapshot()`) — the path tests drive and future mid-play resets will use — replayed stale state.
- **C3-adjacent bug**: `EditorPanel._applyLoadedLevel` emitted `level:loaded` directly. `LevelManager._currentLevel` stayed on the previous puzzle, so `controls:reset` (`_resetLevel` → `getCurrentLevel()`) rebuilt the wrong level and `goal:reached` (`markComplete(_currentLevel.id)`) keyed completion against a foreign level (or `undefined`).

## Decision

1. **Lifecycle contract declared on `BaseObject`** — create → play (`onBeforeUpdate` each step, in-world) → restore (`restoreState` across a play/reset cycle) → dispose (out of the world). `onBeforeUpdate(engine, dt)` and `restoreState(data)` are optional default no-ops; `draw`/`static deserialize` are mandatory; `dispose` must be overridden when the class owns Matter state. The engine re-apposes recorded poses by body id first, then calls `restoreState` on body-id-matched objects — subclasses handle behavioral state only, never positions.
2. **Dead hook removed** — the `onAfterUpdate` dispatch block is deleted from `PhysicsEngine.step()`. Post-step work belongs to the next step's `onBeforeUpdate` or the interaction matrix's contact handlers (there is deliberately no per-object collision hook either — ADR 0001).
3. **Lifecycle keys stripped from the options channel** — `BaseObject`'s constructor destructures `customId`, `angle`, `isFixed` out; they are identity/pose/placement, not behavior. `serialize → deserialize → serialize` is now stable for every class (the conformance sweep proves it).
4. **`restoreState` parity, classified by state kind**:
   - *Transient reset ("cycles start clean")* — `Bucket` (`_caught.clear()`; GoalChecker re-arms per attempt, the dedupe key is released), `Spring` (trigger/compression/cooldown → armed-fresh), `Trampoline` (`_stretch = 0`). Snapshots are only taken at play start (`GameLoop.play()` → `takeSnapshot()`), so snapshot-time state IS the fresh state. Mouse's cooldown resets already followed this rule.
   - *Snapshot-faithful* — `Gear` restores `_angularSpeed` from the record's `options.angularSpeed` ride-along: meshing mutates the drive mid-play, and the pose restore cannot know — the restore undoes a live reversal so the replay starts from the snapshot-time drive.
   - *Deliberately no override* — option-driven or cosmetic state only (Ball/Ramp/Domino; Fan/Conveyor blade/belt animation; Candle flicker); and the unrecoverable-by-design cases (Rope severed: constraints left the world; Balloon popped: body evicted — the body-id set diverges and the seam correctly does not fire). Documented boundary, not a bug.
5. **One seam for level data** — ad-hoc levels (editor JSON import) route through `LevelManager.loadCustom(data)`: installs `_currentLevel` and emits `level:loaded` exactly like `loadLevel(id)`, keeping reset (`getCurrentLevel()`) and progression consistent (`goal:reached` → `markComplete`, now id-guarded so id-less levels never persist `'undefined'`). UI modules never emit `level:loaded` directly.

## Bugs fixed (behavior)

- A mid-play gear ✕ gear reversal no longer survives a same-instance restore — the replay starts from the snapshot-time drive.
- Replayed attempts no longer inherit the previous attempt's bucket catches, spring trigger/cooldown, or trampoline stretch through the physics-restore path.
- After importing a level through the editor, **Reset rebuilds the imported level** (previously the last puzzle), and winning an id-less custom level no longer writes `'undefined'` into progress storage.
- Serialize round-trips are stable: no phantom option keys accumulate across deserialize cycles.

## Consequences

- The contract is checkable: `tests/object-contract.test.js` sweeps every registered type — round-trip stability, callable lifecycle seams, zero event-bus listener leaks across attach/detach — and pins the parity semantics. A new object type fails the suite until it honors the contract. That is the point.
- Cost: every object inherits a one-line no-op `restoreState`; `PhysicsEngine.restoreSnapshot()`'s per-object `typeof` guard is now defensive only.
- Known boundary: cosmetic animation state (candle flicker phase, conveyor stripes, fan blade spin) is not preserved across restores — visual-only, unseeded; accepted here.
- The dual restore identity is now explicit: *physics restore* = same instances, body-id matched, `restoreState` seam (`GameLoop.reset()`); *placed restore* = fresh deserialize with new ids (`js/reset/levelReset.js`) — construction IS the restore.

## Related

- ADR 0001 (interaction matrix; this ticket's C3 row), ADR 0002 (discovery & wake seam)
- `js/objects/BaseObject.js`, `js/engine/PhysicsEngine.js` (`restoreSnapshot`), `js/levels/LevelManager.js` (`loadCustom`), `js/reset/levelReset.js`
- `tests/object-contract.test.js`