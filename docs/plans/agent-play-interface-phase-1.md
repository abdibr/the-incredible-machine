# Agent Play Interface — Phase 1: observation layer, action API, scripted solver

Status: **planned, not started** (2026-10-21). The earlier design discussion lived in conversation only; this file is the record.

## Goal

Make the game drivable *headlessly by a program* — and, later, by a text-only LLM — by giving it three things:

1. a **text observation contract** (what the world looks like, in a form a model can read),
2. an **action API** (what a program can do to the world, with validation),
3. a **scripted solver** that beats a real level using only 1 + 2, proving the interface is sufficient before any model is in the loop.

The agent framework and the Docker container are **out of scope for this phase**; everything here is designed so that phase is a thin adapter over `describeWorld()` + the actions.

Chosen direction (user decision): **solver-first**. Prove the observation layer with a deterministic brute-force solver, iterate the formats on evidence, then wrap in a framework.

## Why this is feasible (verified facts)

Probed on 2026-10-21 against the working tree, not assumed.

| Claim | Evidence |
|---|---|
| Headless stepping works without rAF/`GameLoop` | `new PhysicsEngine(1000,600)` + `objectRegistry.create()` + manual `step(1000/60)` loop; a dropped ball was caught: `bucket:caught = ['ball']`, ball settled at `y=557`. |
| Stepping is cheap | 400 steps ≈ **6 ms**. A 5 s trial (300 steps) is negligible ⇒ a solver can brute-force placement. |
| `PhysicsEngine` adds 4 `wall-*` bodies | `wall-floor` bounds `y 600→650`, `wall-left` `x -50→0`, `wall-right` `x 1000→1050`, `wall-ceiling` `y -50→0` — all *outside* the play area; any rasteriser must skip them. |
| Rasterising reads fine | At 8 px/cell (125×75), AABB containment drew ramp / ball / bucket recognisably in ASCII. |
| Sampling cell centres is fragile | A 120×12 ramp occupied `0` cells at 64×40 and 100×60 but several at 8 px — point sampling misses thin bodies at some cell sizes. **Use bounds/vertex containment, not point sampling.** |
| Levels need `angle` as well as `x,y` | `level-02` fixed ramp at `(150,200)`; `objectRegistry.create('ramp', 150, 200, {isFixed:true, angle:0.35})` rotates correctly (`body.angle = 0.350`). |
| Registry surface | `objectRegistry.getAll() / create / deserialize / getByCategory / getCategories / has`; **17 types**: `ball, tennis-ball, baseball, ramp, conveyor, trampoline, fan, spring, gear, pulley, domino, balloon, bucket, candle, rope, scissors, mouse`. |
| Baseline green | `npx vitest run` → 18 files / **243 tests pass**. |

## Architecture — new files, zero changes to existing modules

```
agent/                      ← new top-level dir, Node ESM, mirrors js/ conventions
  session.js                AgentSession — owns engine + registry + goal checking + world rebuild
  observe/
    legend.js               glyph + key table (shared by grid & state)
    grid.js                 rasterise(world, {cell}) → ASCII lines
    state.js                per-object one-line state table
    graph.js                relation graph (physical / interaction / goal edges)
    events.js               eventBus → bounded ring buffer of readable occurrences
    describe.js             describeWorld(session) — the one entry point
  actions.js                place / remove / rotate / nudge / reset / trial
  solver.js                 scripted baseline solver (the proof)
  cli.js                    node agent/cli.js --level level-01 --solve
tests/agent/
  grid.test.js  state.test.js  graph.test.js  actions.test.js  solver.test.js
```

Conventions to follow (from the existing codebase): named exports, JSDoc file headers in the style of `js/engine/*.js`, vitest `describe/it/expect`, `registerAllObjects()` bootstrap before touching `objectRegistry`.

## 1. Observation contract

One entry point returns all views, so the solver and the future LLM see identical information:

```js
describeWorld(session, { cell = 8, grid = 'auto', state = true, graph = true }) → string
```

### 1a. ASCII grid — `observe/grid.js`

- **Glyph per object instance**, 2 chars wide so shapes read as blocks: ball `@O`, ramp `/=/`, bucket `#b#`, spring base/platform `[s` / `s]`, rope segments `~?`, etc.
- Pick the glyph by **priority** (bucket sensor > candle flame > plain body) so an open bucket mouth is not hidden by its walls.
- Fill each body's **bounds box** (multi-body objects paint all bodies), skipping `wall-*`.
- Empty cell → `.` for stable row shapes; trim trailing newline.
- Column ruler + border, because absolute coordinates matter for `place`.
- `grid: 'auto'` — smallest cell from `{8, 10, 12.5, 16}` that keeps ≥1 blank row/column between distinct objects (legible); `grid: 'full'` forces 125×75 for precise work.

### 1b. State table — `observe/state.js`

The grid shows *where*; this shows *what*. Fixed columns, one line per object:

```
id        type      pos       angle  size    flags        motion   extra
ball-1    ball      505,356   0°     35×36   dynamic      falling  —
ramp-f    ramp      150,200   20°    120×12  fixed        —        —
bucket-1  bucket    700,480   0°     50×40   fixed        —        goal-zone, caught:0
balloon-1 balloon   …         …      …       dynamic      rising   lift:0, payload:none
rope-1    rope      …         …      —       —            taut     anchored:no !
fan-1     fan       …         …      40×50   fixed        on       wind 60×120 →
```

`extra` carries **interaction readiness** — "rope attached to nothing", "balloon lifting nothing", "spring not armed" — because these are exactly what a solver/LLM must reason about.

### 1c. Relation graph — `observe/graph.js`

Three edge kinds, each from a real source of truth (no invented topology):

| Edge | Source |
|---|---|
| `phys` — constraint link (rope↔balloon, pulley↔rope) | runtime constraint links (ADR 0004) + `Rope` / `Pulley` constraint arrays |
| `inter` — declared interaction that is live (touching / in zone) | `DEFAULT_INTERACTION_ROWS` (`js/interactions/rules.js`), labelled by row id |
| `goal` — the win condition resolved to concrete instances | `GoalChecker` + level goal |

Plus a `dormant` list: every **active matrix row** whose two types are both present but not in contact. A free hint generator straight out of `rules.js`.

Rendered as an ASCII adjacency list, stable ordering by id:

```
relations
  goal     ball-1 ──▶ bucket-1    (object_in_zone, zone=bucket-goal)  status: unmet
  phys     rope-1 ── balloon-1    (rope end A)
  touch    ball-1 ~ ramp-f        (resting)
  fired    bucket-catch  ball-1 ⇄ bucket-1   0x
  dormant  spring-trigger  spring-1 ── ball-1   (spring not armed)
```

### 1d. Event log — `observe/events.js`

`EventBus` already emits `goal:reached`, `goal:failed`, `bucket:caught`, `rope:severed`, `balloon:popped`, `loop:*`, `level:loaded`. Subscribe for the duration of a trial, keep a bounded buffer, render sentences:

```
trial #7 — 5.00s / 300 steps → TIMEOUT (ball-1 at 640,300, peak 410,120)
  t=0.42s  rope-1 severed (candle-flame)
  t=1.12s  bucket-goal caught ball-1   <- REACHED @1.12s
```

This turns an opaque simulation into a causal narrative — the single highest-value signal for an agent.


## 2. Action API — `agent/actions.js`

Every action returns a result object and **never throws on bad input** (a model will send bad input constantly).

```
place(type, x, y, { angle = 0 })   budget-checked against level availableParts;
                                   rejects unknown type / over-budget / off-playfield
remove(id)                         only agent-placed parts; level fixedObjects are immutable
rotate(id, radians)
nudge(id, dx, dy)
reset()                            wipe placements, re-instantiate the level
trial({ seconds = 5, dt = 1000/60, keepBest = false })
    → { outcome: 'reached'|'failed'|'timeout', elapsed, events, snapshot }
```

Implementation notes:

- `trial()` rebuilds a **fresh world every run** (level objects re-created from `fixedObjects`, then placements re-applied). That gives independent, deterministic trials and sidesteps the ADR 0003 restore caveats.
- `trial()` steps the engine **and** emits `loop:frame` per step — exactly what `GoalChecker` listens to, so goal detection needs no change (this is also how `tests/goals.test.js` drives it).
- No DOM, no rAF, no `GameLoop` dependency.
- Part budgeting mirrors `availableParts`; `remove` returns the part.

## 3. The proof — `agent/solver.js`

Deterministic brute force, no model:

```
for each permutation of (parts → coarse 25 px lattice positions, a few hundred combos):
    for each angle in a small set (0, ±15°, ±30° for ramps):
        outcome = trial({ seconds: 5 })
        if reached: return the winning placement
```

Cap `maxTrials` (default 2000 ≈ tens of seconds). When nothing reaches, report the best partial result (e.g. "ball came within N px of the zone").

**Definition of done**

- `node agent/cli.js --level level-01 --solve` prints winning placements, the final ASCII map, and "goal reached".
- `tests/agent/solver.test.js`: beats **level-01**; on a level that is currently impossible (e.g. `level-04`, which needs runtime rope→object attach — missing per `.scratch/tim-expansion/README.md`) it **fails cleanly with a diagnosis** rather than hanging. That failure is a feature: it documents where the mechanics are still missing, which is what an LLM will hit too.
- Snapshot tests pin grid / state / graph formats so later changes are deliberate.

## 4. What this buys the later Docker / LLM phase

- `describeWorld()` is already a **prompt-ready string**; tools map 1:1 onto `actions.js`.
- The solver's search reveals which observations matter; the state table and dormant edges get tuned on evidence *before* an expensive model is in the loop.
- A single `runTurn(actionJson) → { observation, result }` boundary means the container can be a ~40-line `@openai/agents` `tool()` wrapper **or** a plain JSON-RPC loop — the framework choice stays open. (Both OpenAI Agents SDK JS/TS and Microsoft Agent Framework were examined; MS's is Python/.NET with no Docker-native story, OpenAI's is JS/TS and needs containerising by hand.)

## 5. Risks and how they get checked

1. **Private state** — some readiness data may live in `_private` fields with no getter. Fix: read only public getters; if a class needs one, add a **read-only getter** following the `BaseObject` lifecycle contract (ADR 0003), never reach into `_`.
2. **Rope noise** — 7 bodies per rope will crowd the grid; the state table + `phys` edges are the primary rope signal, the grid secondary.
3. **Grid legibility** — the big unknown; `cell: 'auto'` is the hedge, and grid snapshot tests will expose mistakes quickly.
4. **Determinism** — any `Math.random` in object classes would make trials incomparable. Grep for it before the solver lands; seed or eliminate.

## 6. Build order

`legend` → `grid` → `state` → `events` → `session` + `actions` → `graph` → `solver` → `cli`, TDD alongside each. Finish with `npx vitest run` confirming the existing 243 tests stay green (`npm test`).

## References

- `docs/adr/0003-*` lifecycle & restore contract; `docs/adr/0004-runtime-constraint-links.md` (graph source)

## Open questions for the next session

These are deliberately unresolved — they get answered by evidence from the solver, not by guessing:

1. **Glyph assignment** — 17 types must map onto distinguishable 2-char glyphs. Draft set needs to be proven legible on `level-03` (dominoes + fan + ball) before it is frozen.
2. **State-table `extra` fields** — which per-class getters exist today vs. which need a new read-only getter. Audit `js/objects/*.js` public surface first; do not invent fields.
3. **`dormant` hints** — should they be printed by default, or behind a `describeWorld(…, {hints:true})` flag? Default-on risks inflating the prompt; default-off risks the agent not knowing what is possible.
4. **Solver search space** — 25 px lattice × angle set × part permutations may blow up past `maxTrials` on `level-02` (3 parts). Decide whether to add a seeded random search or a greedy "score by final distance to zone" ranking.
5. **Where `agent/` lives long-term** — it is a sibling of `js/` on purpose (browser bundle must not import it). If phase 2 containerises, the Docker build context should copy `js/`, `agent/`, and `package.json` only — not `tests/` or `.scratch/`.

## Out of scope (recorded so nobody re-litigates it here)

- Docker image, LLM calls, prompts, tool-call plumbing — phase 2.
- Fixing broken mechanics from `.scratch/tim-expansion/README.md` (rope attach, gear meshing, candle state, conveyor). Phase 1 *reports* them via clean solver failures; it does not fix them.
- UI changes. The web app is untouched by this plan.

- `js/interactions/rules.js` + `docs/interactions.md` (interaction rows)
- `js/levels/puzzles/level-01..05.json`
- `.scratch/tim-expansion/README.md` (gap audit: which mechanics are still missing)
