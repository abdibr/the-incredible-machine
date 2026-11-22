# Ticket groups — launchable implement-spec sets

**Snapshot:** 2026-11-21 · fork `origin` (`abdibr/the-incredible-machine`) · 42 open issues read with `gh`, native
dependencies (`/issues/<n>/dependencies/blocked_by`) verified live.

Purpose: cut the open backlog into **sets that can each be launched as one `implement-spec` run** (the
`docker agent run …ex09-implement-spec\agent.yaml` cycle), respecting the ticket task graph and keeping
concurrent runs off each other's files.

Every group is a slug + a spec pointer + the ticket list. Anything blocked by an open ticket **outside** its
group is called out; nothing inside a group waits on another group by accident.

## The graph, in one look

```
rope tie fidelity      #100 ─┬─▶ #98     #99  #101  #103  #83  #91
                             └─▶ #102
rope connector         #19 ──┬─▶ #20  #25  #34    (#27 rope-tug prose only)
fire / air / electric  #21 ──┬─▶ #24 ──▶ #36
                             └─▶ #32 ──┬─▶ #33
                                       ├─▶ #35
                                       └─▶ #39  (also needs #19)
rotary power           #28 ──┬─▶ #29
                             └─▶ #30 ──▶ #31
content leaves         #37 ──▶ #38     #22  #23  #26  #41  #42
agent watch            #61 ──▶ #62 ──┐
                       #63 ─────────┴─▶ #64 ──▶ #65
physics polish         #73   #82
capstone               #43  (blocked by 12 tickets across the groups above)
held                   #79 (needs-triage, architectural)   #40 (must be split into 6 sub-tickets)
tracking, not work     #60
```

Frontier today (open, unblocked): 19, 21, 22, 23, 26, 27, 28, 37, 40, 41, 42, 61, 63, 73, 79, 82, 83, 91,
99, 100, 101, 103.

## The groups

| # | Slug | Tickets | Count | Internal order | Blocked by outside the group | Files it owns (conflict domain) | Spec status |
|---|---|---|---|---|---|---|---|
| 1 | `rope-ties` | 100, 98, 102, 99, 101, 103, 83, 91 | 8 | 100 → {98, 102}; rest free | — | `js/objects/Rope.js`, `ConnectFlow`, `BaseObject`, `Balloon.draw`, `Scissors` query, ADR 0007 + GLOSSARY | **ready** — `.scratch/rope-ties/spec.md` (also cites `.scratch/spec-c1-rope-family.md` for #83) |
| 2 | `rope-connector` | 20, 25, 34, 27 (close #19 first) | 4 | 27 free; rest after #19 closes | — | `Rope.js`, `ConnectFlow`, `Balloon`, `Pulley`, `Gun`, `TeeterTotter`, interaction matrix | **ready** — `.scratch/rope-connector/spec.md` |
| 3 | `fire-air-electrics` | 21, 24, 32, 33, 35, 36, 39 | 7 | 21 → {24, 32}; 24 → 36; 32 → {33, 35}; 39 last | **#19** (rope) for #39 — land group 2 first, or accept #39 parked to the end | Candle, Fan, Fuse, Dynamite, Cannon, Outlet, Light, impulse-field seam, matrix | **ready** — `.scratch/fire-air-electrics/spec.md` |
| 4 | `rotary-power` | 28, 29, 30, 31 | 4 | 28 → {29, 30}; 30 → 31 | — | FanBelt seam, Conveyor, MouseMotor, Windmill, Bellows | **ready** — `.scratch/rotary-power/spec.md` |
| 5 | `content-leaves` | 22, 23, 26, 37, 38, 41, 42 | 7 | 37 → 38; rest free | — | Domino, Balloon pop rows, Gear×Balloon row, Cat/Mouse, Ball variants, seasonal registry | **ready** — `.scratch/content-leaves/spec.md` |
| 6 | `agent-watch` | 61, 62, 63, 64, 65 | 5 | 61 → 62; 63 → 64; {62,63} → 64 → 65 | — | `agent/`, sidecar page, zero game-engine churn | **ready** — `.scratch/watch-tickets/parent.md` |
| 7 | `physics-polish` | 73, 82 | 2 | independent | — | Gears, Spring launch contract | **ready** for #73; **#82 needs the energy-model pick ratified first** — `.scratch/physics-polish/spec.md` |
| 8 | `content-palette` | 43 | 1 | — | all of 19,20,24,26,28,29,30,32,33,35,37,38 | levels + palette | **ready** — `.scratch/content-palette/spec.md`; must run last |
| — | held | 79, 40 | 2 | — | — | — | #79 triage; **#40 says "do not implement as one ticket"** — split it first |

42 open issues accounted for: 8+4+7+4+7+5+2+1+2 + #19 (closed before its set) + tracking #60 = 42.

## Waves (keep same-domain groups out of one wave)

Implement-spec runs each merge into their **own** `integration/<slug>` branch; the cross-group merge into
`develop` is the human's step. Same-domain runs would still fight inside their own worktrees only if two
tickets in the *same* run collide — they do not — but different runs touching the same files produce painful
final merges. Hence:

| Wave | Launch | Why together |
|---|---|---|
| 1 | `rope-ties`, `rotary-power`, `agent-watch` | Rope-tie files, rotary parts, and the agent/sidecar are disjoint. Watch is the fastest win (spec already exists). |
| 2 | `rope-connector`, `physics-polish` | Both need the rope files that wave 1 rewrote; gear/spring are separate from rope. |
| 3 | `fire-air-electrics` | #39 needs #19 closed by wave 2. Owns candle/fan/fuse/light + the impulse-field seam. |
| 4 | `content-leaves` | Shares `Balloon.js` + interaction-matrix rows with wave 3; run after it to avoid the merge. |
| 5 | `content-palette` (#43) | Capstone: needs the roster from waves 1–4. |
| anytime | #40 split session, #79 triage | Pure setup work; no implement-spec run. |

If you only ever launch one at a time, the order above is also the recommended order.

## Spec prep before launching

`implement-spec` stops when the spec or the tickets are missing. Every group now has one:

| Slug | Spec |
|---|---|
| `rope-ties` | `.scratch/rope-ties/spec.md` |
| `rope-connector` | `.scratch/rope-connector/spec.md` |
| `fire-air-electrics` | `.scratch/fire-air-electrics/spec.md` |
| `rotary-power` | `.scratch/rotary-power/spec.md` |
| `content-leaves` | `.scratch/content-leaves/spec.md` |
| `agent-watch` | `.scratch/watch-tickets/parent.md` (pre-existing) |
| `physics-polish` | `.scratch/physics-polish/spec.md` |
| `content-palette` | `.scratch/content-palette/spec.md` |

The specs were authored from the ticket bodies plus a read of the modules each group touches; every
"Implementation Decision" cites a file or a ticket. Decisions worth a human veto before a run:

- `rope-ties`: #102 closes as **wontfix with a measured bound** (compliance kept); the balloon's decorative
  string is dropped entirely; the free-rope seek **advances to the next free seat** (not auto-cancel).
- `rope-connector`: #19 is **closed before launch** as the delivered umbrella (its residue is #98–#103);
  balloon lift is raised by **density**, not force; pulley routing is a **layout waypoint + rope-collidable
  wheel**, no new constraint.
- `fire-air-electrics`: the radial blast is `applyImpulseField`'s **`shape: 'radial'`**; fuse restores to
  **pre-burn**; an outlet **supersedes** the fan's manual toggle.
- `physics-polish`: #82 picks the **energy model** (`Δv ∝ 1/√m`, `M_REF = 1`). The ticket asks for a veto or a
  pick before any agent starts — treat this as the gate.
- `content-leaves`: the valentine balloon **rises like a balloon** (resources row wins over the ticket's
  "inverted-rise" wording); `bowling` is already the default ball, so #41 is really "add basketball".

Also before wave 1:

- **Blocker text is stale.** Ticket bodies say `Blocked by: 04`, `Blocked by: 13` — those are the *old local
  ticket numbers*, not issue numbers. Tell the lead in the kickoff to use native dependencies
  (`issue_dependencies_summary.blocked_by`, open blockers only) and ignore the legacy text. (Editing ~20
  issue bodies is the alternative; the kickoff line is cheaper.)
- **Base on `develop`, not `main`.** Step 3 of the cycle branches from the default branch; `main` is
  release-only and carries no `*.md`.
- **`node_modules` in worktrees.** Test commands run inside `..\<slug>-wt\<NN>-…`, which has no
  `node_modules`. Either `npm ci` once per worktree or junction the checkout's `node_modules` into each
  worktree before the run, or implementers will report failing suites.
- **Relabel `#83`** `needs-triage` → `ready-for-agent` if it ships in group 1 (its design is already settled
  in `.scratch/spec-c1-rope-family.md`).
- **Stale worktrees:** `D:\games\C4-wt` and `D:\games\Agent_P2_followup-wt` are leftover directories (git no
  longer tracks them as worktrees) — safe to delete.

## Kickoff lines (PowerShell, from the repo root)

The cycle takes the slug and everything it would otherwise stop to ask for. `--yolo` skips approval prompts;
drop it if you want to watch each risky call.

```powershell
# wave 1 · rope tie defects + rope docs
docker agent run D:\agents_proj\docker_agents\ex09-implement-spec\agent.yaml --yolo "Slug: rope-ties. GitHub tracker via gh, per docs/agents/issue-tracker.md. Integration branch based on develop, not main. Use native issue dependencies for blocked-by (open blockers only); ignore legacy 'Blocked by: 04'-style local numbers in bodies. Tickets: #100, #98, #102, #99, #101, #103, #83, #91. Spec: .scratch/rope-ties/spec.md. Run the implement-spec cycle. Seams: rope-connector, rope-ties, rope-knots, connect-flow, balloon, rope-family test files."

# wave 1 · rotary power seam + parts
docker agent run D:\agents_proj\docker_agents\ex09-implement-spec\agent.yaml --yolo "Slug: rotary-power. GitHub tracker via gh, per docs/agents/issue-tracker.md. Integration branch based on develop, not main. Use native issue dependencies for blocked-by (open blockers only); ignore legacy 'Blocked by: 13'-style local numbers in bodies. Tickets: #28, #29, #30, #31. Spec: .scratch/rotary-power/spec.md. Run the implement-spec cycle. Seams: gear, fan, interactions, engine-query test files."

# wave 1 · agent watch (spec ready)
docker agent run D:\agents_proj\docker_agents\ex09-implement-spec\agent.yaml --yolo "Slug: agent-watch. GitHub tracker via gh, per docs/agents/issue-tracker.md. Integration branch based on develop, not main. Use native issue dependencies for blocked-by (open blockers only). Tickets: #61, #62, #63, #64, #65. Spec: .scratch/watch-tickets/parent.md. Run the implement-spec cycle. Seams: tests/agent/session-run-lifecycle.test.js, tests/agent/turn.test.js, plus the watch-page tests the tickets name."

# wave 2 · rope connector chain
# wave 2 · first close the delivered umbrella so its dependents unblock:
#   gh issue close 19 --comment "Delivered by ADR 0005 + ADR 0007; review residue split into #98-#103."
docker agent run D:\agents_proj\docker_agents\ex09-implement-spec\agent.yaml --yolo "Slug: rope-connector. GitHub tracker via gh, per docs/agents/issue-tracker.md. Integration branch based on develop, not main. Use native issue dependencies for blocked-by (open blockers only); ignore legacy 'Blocked by: 04'-style local numbers. Tickets: #20, #25, #34, #27. Spec: .scratch/rope-connector/spec.md. Run the implement-spec cycle. Seams: rope-connector, rope-seats, balloon, pulley, interactions test files."

# wave 2 · gear phase align + spring launch contract (#82 needs your decision first)
docker agent run D:\agents_proj\docker_agents\ex09-implement-spec\agent.yaml --yolo "Slug: physics-polish. GitHub tracker via gh, per docs/agents/issue-tracker.md. Integration branch based on develop, not main. Tickets: #73, #82. Spec: .scratch/physics-polish/spec.md. Run the implement-spec cycle. Seams: gear, fixed-timestep, interactions test files."

# wave 3 · fire / air / electric chain (after #19 is closed)
docker agent run D:\agents_proj\docker_agents\ex09-implement-spec\agent.yaml --yolo "Slug: fire-air-electrics. GitHub tracker via gh, per docs/agents/issue-tracker.md. Integration branch based on develop, not main. Use native issue dependencies for blocked-by (open blockers only); ignore legacy 'Blocked by: 17'-style local numbers. Tickets: #21, #24, #32, #33, #35, #36, #39. Spec: .scratch/fire-air-electrics/spec.md. Run the implement-spec cycle. Seams: fan, interactions, engine-query, object-contract test files."

# wave 4 · content leaves (after fire-air-electrics)
docker agent run D:\agents_proj\docker_agents\ex09-implement-spec\agent.yaml --yolo "Slug: content-leaves. GitHub tracker via gh, per docs/agents/issue-tracker.md. Integration branch based on develop, not main. Use native issue dependencies for blocked-by (open blockers only); ignore legacy 'Blocked by: 13'-style local numbers. Tickets: #22, #23, #26, #37, #38, #41, #42. Spec: .scratch/content-leaves/spec.md. Run the implement-spec cycle. Seams: balloon, domino, mouse, interactions, object-contract test files."

# wave 5 · capstone
docker agent run D:\agents_proj\docker_agents\ex09-implement-spec\agent.yaml --yolo "Slug: content-palette. GitHub tracker via gh, per docs/agents/issue-tracker.md. Integration branch based on develop, not main. Ticket: #43. Spec: .scratch/content-palette/spec.md. Run the implement-spec cycle. Seams: goals, level-import, editor-palette, solution-scenes test files."
```

Each run leaves `integration/<slug>` plus its worktree behind (step 9 keeps the integration worktree). The
final merge of the integration branches into `develop` is yours; expect overlap only where two groups touch
the interaction matrix or the parts registry.

## Open questions to settle before launch

1. **Group sizes:** `rope-ties` (8) and `fire-air-electrics` (7) are long for one sequential run. Split
   `rope-ties` into `rope-tie-defects` (#100, #98, #102, #99) + `rope-tie-presentation` (#101, #103, #83,
   #91) if you want shorter sessions; they share files, so run them back to back.
2. **#40** must be split (6 sub-tickets: metal hook, boxing glove, jack-in-the-box, rocket, monkey bike,
   bird cage) before it can be any group's ticket. That split is a `/to-tickets` session, not an
   implement-spec run.
3. **#82** needs the mass-faithful launch model chosen by a human (the body asks for a veto or a pick)
   before an agent implements it.
4. **#79** stays out until triage decides whether composable parts are worth the sweep.
