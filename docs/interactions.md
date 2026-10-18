# Object Interaction Matrix

Generated from `js/interactions/rules.js` — run `npm run docs:interactions` to regenerate.
A sync test in `tests/interactions.test.js` fails when this file drifts from the table.

## How dispatch works

`PhysicsEngine` maps each Matter `collisionStart` pair to its two owner objects and calls
`InteractionMatrix.resolve(ownerA, ownerB, pair)`.
Rows are unordered pair declarations — `resolve` tries both orientations and calls the handler
with the canonical (actor = reactor, target = counterpart) order. Rows fire in registration order;
several may legitimately fire for the same pair. Rows marked `docOnly` never dispatch.

State-dependent decisions (`predicate` matchers) delegate to decision methods on the owning
object (`isCatchContact`, `isSnapTrigger`, `isRelevantContact`, `isLaunchTrigger`), keeping
local state local. Effect code routes to the object's public behavior methods.

## Reaction rows

| Row | Reactor (actor) | Counterpart (target) | Effect | Per-row test |
| --- | --- | --- | --- | --- |
| `rope-candle-flame` | `rope` · rope (any segment) | `candle` · via label `candle-flame` · candle flame (label 'candle-flame') | A rope segment touching a candle flame burns through and severs. | rope ✕ candle-flame severs; rope ✕ candle wax does not |
| `rope-closed-scissors-blade` | `rope` · rope (any segment) | `scissors` · via label `scissors-blade` · scissors, closed, via label 'scissors-blade' | A rope touching the blade bodies of snapped-shut scissors is cut. | rope ✕ closed-scissors blade severs; open blades and handles never cut |
| `balloon-scissors` | `balloon` · balloon | `scissors` · any scissors body | A balloon pops on contact with any scissors body (blade or handle). | balloon ✕ scissors pops (any body) |
| `balloon-candle` | `balloon` · balloon | `candle` · any candle body | A balloon pops on contact with any candle body (wax or flame). | balloon ✕ candle pops (wax or flame) |
| `bucket-catch` | `bucket` · bucket, via its 'bucket-sensor' body, catchType filter | any object | The bucket registers a catch when a matching object touches its sensor zone. | bucket ✕ matching object via sensor emits bucket:caught once per object |
| `gear-gear` | `gear` · gear | `gear` · gear | Two touching gears mesh: each drives the other to counter-rotate at its own speed. | gear ✕ gear meshes mutually through the public mesh seam |
| `scissors-snap` | `scissors` · scissors, open, via its 'scissors-handle' bodies; ignores ropes and statics | any object | A dynamic weight landing on a scissors handle snaps the levers shut (one-shot). | scissors ✕ dynamic weight on handle snaps; rope/static/blade contacts never do |
| `mouse-reverse` | `mouse` · mouse, head-on & front-facing contact; ignores other mice | any object | A mouse reverses on significant, front-facing, head-on contacts (debounced). | mouse ✕ head-on contact reverses once within the debounce window |
| `spring-trigger` | `spring` · spring, via its 'spring-platform' body, off cooldown | any object | Something landing on the spring platform compresses and arms the launch. | spring ✕ platform contact triggers; cooldown suppresses retriggers |
| `trampoline-stretch` | `trampoline` · trampoline | any object | Any contact involving the trampoline plays the stretch animation. | trampoline ✕ any contact stretches |

## Documented null-participants

These rows are part of the matrix documentation but never dispatch:

- **boundary-wall** — Boundary walls collide with everything physically but participate in no interaction rows.
- **ball/ramp/conveyor/fan/domino/pulley/candle** — Ball, Ramp, Conveyor, Fan, Domino, Pulley and Candle declare no reaction rows — contacts affect other objects, never them.
