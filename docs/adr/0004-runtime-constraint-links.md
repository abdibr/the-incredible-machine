# ADR 0004 — Engine-owned runtime constraint links (attach/detach seam)

- **Date:** 2026-10-21
- **Status:** Accepted
- **Scope:** Ticket 02, issue #17 (runtime constraint attach/detach engine API; prefactor under the rope-connector family). Covers `tests/constraint-attach.test.js` — the seam's executable contract.

## Context

Matter constraints enter the world today only wholesale with the object that builds them: rope chains are created inside `Rope` and leave with the rope, and the single runtime detach path is the rope-sever event row. The upcoming connector behaviors — balloon tethers, pulley routing, cut-releases-payload — need links between two *already-registered, live* objects at runtime, removable one at a time, consistent across snapshots, and correct around Matter sleeping (ADR 0002): a link attached to sleeping endpoints is a silent no-op (sleepers skip force integration), and a link removed from a sleeping body leaves it frozen mid-air forever.

## Decision

1. **`PhysicsEngine` owns runtime links.** `attachConstraint(bodyA, bodyB, options?)` creates the constraint, adds it to the world, wakes both endpoints, and tracks it in an internal registry; `detachConstraint(constraint)` removes exactly one link; `getAttachedConstraints()` lists them in attach order. Endpoints must be bodies of registered game objects (`_assertAttachEndpoint`) — boundary walls and raw bodies are not attachable.
2. **Object-owned constraints stay out of the registry.** Constraints an object builds for its own structure (rope segment chains) are never registered, are not detachable through this seam, and leave with their object. `detachConstraint` throws on anything not engine-attached (error message pinned by test) so foreign and object-owned constraints can't be silently mutated.
3. **Only defined option keys are forwarded.** Matter's `Constraint.create` extends defaults unconditionally — an explicit `length: undefined` would clobber the Matter-computed default instead of deferring to it. `attachConstraint` copies `pointA/pointB/length/stiffness/damping` per key only when defined.
4. **Links record effective parameters.** The registry stores a plain record per link — body ids plus `pointA/pointB/length/stiffness/damping` **read back after `Constraint.create`** — so Matter-computed defaults (e.g. length derived from the bodies) are captured faithfully for the snapshot seam.
5. **Wake-on-act applies in both directions.** Attach wakes both endpoints; detach wakes both (a freed sleeper would float forever with force integration skipped, per ADR 0002's rule that acting on a body without waking it is a review smell).
6. **Co-termination on removal.** `removeObject` (and equivalent evictions) calls `_detachConstraintsTouching(departingBodyIds)`: every engine link endpointed at a leaving body is detached. An orphaned endpoint would keep dragging its survivor toward a dead body forever. Survivors' links are untouched.
7. **Links ride the restore seam (ADR 0003).** `takeSnapshot` captures the live link set as records (every (re)snapshot carries current link state; the next take overwrites). `restoreSnapshot` first detaches all live links, then re-attaches snapshot-time links **by body id** only when *both* endpoint bodies are still alive — a mid-play object removal never resurrects a dangling link. `clearSnapshot` drops the records.

Not covered (intentionally): pulley gearing as multi-link composition, and object-owned constraint lifecycle — future tickets compose on this seam.

## Consequences

- One registry, one path: tether/pulley/cut-payload consumers get attach, individual detach, co-termination and snapshot-consistency for free instead of re-implementing `Composite.add/remove` bookkeeping.
- Matter 0.20 quirk pinned by test: `Constraint.postSolveAll` wakes constraint endpoints on every `Engine.update`, so a constrained body cannot stay asleep across a step — a parked-asleep endpoint is observable only between an explicit park and the next step (documented in the test header).
- Cost: `getAttachedConstraints()` copies keys per call and snapshot payloads grow with link count; both negligible at puzzle scale.
- The registry is keyed by constraint instance — consumers keep the instance returned by `attachConstraint` (or pull from `getAttachedConstraints`) to detach.

## Related

- ADR 0002 (wake-on-act policy inherited by attach/detach), ADR 0003 (snapshot/restore seam the link records ride).
- Issue #17 (ticket 02) on the fork's tracker.
- `tests/constraint-attach.test.js` — 14 tests; full suite 18 files / 235 tests green at time of writing.