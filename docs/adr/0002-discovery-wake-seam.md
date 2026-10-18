# ADR 0002 — PhysicsEngine discovery & wake seam for all per-frame world scanning

- **Date:** 2026-10-18
- **Status:** Accepted
- **Scope:** Candidate C2 of the interaction-documentation architecture review (follow-up from ADR 0001's out-of-scope list). Includes the sleeping-rider behavioral fix and the test surface pinning the shared policy.

## Context

ADR 0001 centralized collision reactions in the interaction matrix, but per-frame *discovery* — "what is near/touching/inside my zone right now?" — stayed scattered across six objects running their own `onBeforeUpdate` world scans (`Composite.allBodies` + `Query.collides`/`Query.region` variants, each re-implementing its own gating for walls, statics, and owned bodies). Meanwhile the engine enabled Matter sleeping (`enableSleeping: true`, ticket/09-mouse), and sleeping bodies skip force integration entirely: a rider asleep on an armed spring platform was never launched, a ball asleep on a belt never carried. The only ad-hoc wakes (`Gear`, `Pulley`) proved the rest of the force users had the same latent bug.

The scanning code also reached past the engine into Matter internals (`Matter.Query`, `Matter.Sleeping.set`) with no shared policy and no test surface: nothing recorded who is discoverable (walls? static props? the scan object's own bodies?) or who may wake whom.

## Decision

1. **`PhysicsEngine` owns discovery and waking.** Four seam methods, the only approved way for objects to scan the world or wake a body:
   - `queryTouching(actor, { sourceBodies?, includeStatic?, includeWalls? })` — SAT-precision contacts (`Query.collides` semantics: bounds broadphase + candidate-part iteration + `Collision.collides`), like Matter's per-frame pair selection.
   - `queryZone(referenceBody, { cx, cy, width, height }, { includeStatic?, includeWalls? })` — region-grade discovery. The rect is expressed in the reference body's **local frame** (offset `cx/cy` from its center) and rotates with it; matching is **body-position-inside-rect** (a body whose bounds merely graze the zone does not match). Broadphase is `Query.region` over the rotated rect's enclosing AABB.
   - `queryPoint(point, { excludeOwner? })` — a Matter `Query.point` probe (bounds pass, then per-part vertices test); statics and walls are included by design (Mouse uses it for ground/edge/wall probes).
   - `wakeBodies(targets)` — the single writer of sleep state (`Sleeping.set(body, false)`); accepts a body, an array, and tolerates nulls.
2. **Shared discovery policy** (all three query methods): candidates are world bodies; **boundary walls** (`wall-*` labels) are skipped unless `includeWalls`; **static bodies** are skipped unless `includeStatic`; **the caller's own bodies** are always skipped (owner resolved from the registered game objects via `addObject`/`removeObject`; `sourceBodies` substitutes `actor.bodies` as the collision sources when given). **Discovery never wakes** — it is a pure read; sleeping bodies are returned asleep. ADR 0001's matrix semantics are untouched: `collisionStart` still wakes through Matter's own wake-on-collision.
3. **Wake-on-act closes the sleeping-rider defect.** Objects wake exactly the bodies they act on, immediately before acting: Spring launch (`queryTouching({ sourceBodies: [platform] })` → `wakeBodies` → launch force), Conveyor belt drive, Fan wind, Gear tooth traction, Pulley platform coupling, Balloon buoyancy. Force delivery on a sleeping body is undefined (Matter skips integration), so acting on a body without waking it is now a review smell.
4. **Migration is total.** Spring, Fan, Conveyor, Gear, Pulley, Balloon, and Mouse now call only the seam in `onBeforeUpdate`; the Matter scan primitives (`Composite.allBodies`, `Query.*`, `Sleeping.set`) exist **only** in `js/engine/PhysicsEngine.js`. One documented exception: `Gear` keeps `Matter.Collision.collides` per discovered pair — discovery runs through the seam, but traction needs the contact's normal/tangent data that the seam deliberately does not return.
5. **Test surface:** `tests/engine-query.test.js` pins the policy (touch/zone/point precision, static/wall/owner opt-ins, zone placement + rotation semantics, discovery-never-wakes, `wakeBodies` tolerance) and the wake-on-act integrations (a pre-slept ball is launched by an armed spring, carried by a belt, dragged by gear teeth; a pre-slept balloon still rises). Legacy test callers that faked the engine were migrated to real `PhysicsEngine` instances (the interactions spring full-cycle test).

## Bugs fixed by the migration (behavior changes)

- **Sleeping riders act.** Asleep-on-top candidates are woken as part of the acting object's per-frame pass, so they receive the launch/belt/traction/buoyancy force on the same frame they're discovered. Covered by four wake-on-act integration tests.
- **No other behavior change.** Default discovery (no flags) reproduces the old ad-hoc gating: dynamic, non-wall, non-own bodies — verified object by object during migration.

## Consequences

- One policy, one implementation, one test suite for all world scanning; new objects call the seam and never import Matter query/sleep APIs.
- Cost: each call walks `Composite.allBodies` (previously each object did its own walk; at this object count the engine-side walk is equivalent).
- `queryZone` placement is **position-based** — deliberately documented by tests so future zone features don't silently become bounds-overlap.
- The `Gear` contact-data exception is the only Matter scan outside the engine and is covered by this ADR.

## Related

- ADR 0001 (interaction matrix; discovery for collision reactions stays in `_setupCollisionEvents`, this ADR covers `onBeforeUpdate` scanning).
- `tests/engine-query.test.js` — the policy's executable contract.