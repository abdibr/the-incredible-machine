# Backlog prioritization — open unblocked issues

**Snapshot:** 2026-10-27 · fork `abdibr/the-incredible-machine` (`origin`) · derived from the open-issue list plus GitHub native issue dependencies (`issue_dependencies_summary`, open blockers only).

All `#N` references are issues on the fork's Issues tab. A ticket is *unblocked* when every blocker is closed; "gates" = open issues directly dependent on it (live counts, verified via `gh api .../dependencies/*`).

## Field overview

- **64 open issues, 22 unblocked** — none assigned.
- Breakdown of the 22: 19 `ready-for-agent` work tickets, 2 tracking umbrellas (#60, #44), 1 `needs-triage` (#79).
- Biggest blocked cluster: **#43 Content & palette pass** waits on 12 tickets (the parts roster); **#65 Watch 5/5** waits on 3 (across two series).

## Dependency map (anchors → open dependents)

| Anchor (unblocked) | Directly gates | Transitive payoff |
|---|---|---|
| #19 Rope as a connector (04) | #20, #25, #34, #39, #43 | Balloon-lift, pulley, gun bullets, light chain, most of the content pass |
| #45 P2 1/6: `runTurn()` seam | #47, #48 | #49, #50, #65 — the whole P2 tail + Watch 5/5 |
| #56 Mid-chain knots | #57, #58, #59 | Rope-to-rope knots, piece severing, debug overlay/tooltips |
| #75 Spec (C1) rope-family seam | #76 | #77, #78 — the C4 recorder/loop series |
| #80 Fixed-timestep stepping (bug) | #81 | #82 — the regression/bugfile chain |
| #61 Watch 1/5 prefactor | #62 | #64 (needs #63 too), #65 |
| #63 Watch 3/5 sandbox posture | #64 | #65 |
| #46 P2 4/6 seeded determinism | #50 | (pairs with #45) |
| #28 Fan Belt (13) | #29, #30, #43 | Mouse motor, windmill, content pass |
| #21 Candle lit/unlit (06) | #24 | #24 → #43 |
| #37 Pokey the Cat (22) | #38, #43 | Fishbowl + content pass |

Other unblocked chains: C4 series #76 → #77 → #78 (each gated by its predecessor); P2 #47/#48 → #49; #49/#50 close P2.

## Start order, with reasons

1. **#80 Fixed-timestep physics stepping (bug)** — the only unblocked bug, fresh bugfile (`bug-20261027T151221Z-0txh`). Root defect: raw frame dt into a single `Engine.update`, so per-tick speeds scale with dt² — correct only at exactly 60 fps. Ranks first despite small unlock counts (#81/#82) because *every* physics-touching ticket below tunes against the sim clock (#22 domino tuning, #27 teeter-totter, #40 actuators, spring launch). Landing the clock late means re-tuning all of that.
2. **#19 Rope as a connector (04)** — highest direct leverage on the board (5 dependents). Flagship user-named gap; also fixes level-04's hint advertising this unimplemented mechanic. Most of the toolbox roster hangs off rope infra.
3. **#45 P2 1/6: turn boundary seam** — keystone of the agent-in-the-loop program (#44); single entry point to five downstream tickets. Prefactor-style seam → low risk.
4. **#56 Mid-chain knots + free-rope span** — second-biggest unguarded cluster (3 tickets).
5. **#75 Spec (C1) rope-family membership seam** — design already settled (grilled); mostly implementation. Cheapest "3-for-1": re-opens the C4 chain, where #76 fixes a real bug (fail-overlay retry appends to a stale run). Highest unlock-per-hour.
6. **#61 + #63 Watch series seeds** — both unblocked entries of the watch program (#60); #61 → #62 → #64, #63 → #64. Slightly lower because chain end #65 also needs #45/#48 — P2 seeds pay off first.
7. **#46 Seeded determinism** — unblocked despite numbering 4/6 (no edge from #45). Parallel companion to #45; once both land, the entire P2 tail (#47–#50) opens at once.
8. **Content chain-heads: #28 Fan Belt, #21 Candle state, #37 Pokey Cat** — prefer over other content tickets: each opens a sub-chain and clears the most of #43's 12 blockers.
9. **Leaves (anytime fillers): #22, #23, #26, #27, #40, #41, #42, #73** — no dependents. #27's rope-tug phase waits on #19 but its impact path is independent.
10. **#79 Composable parts — last** — `needs-triage`, not `ready-for-agent`; triage before any work. Large architectural chunk best deferred until the seams above settle.

Not work tickets: #60, #44 (tracking umbrellas).

## Ordering principle

Bug/foundation first (#80) → maximum-unlock nodes (#19, #45) → cheap high-density unlocks (#56, #75) → program seeds (#61/#63, #46) → chain-head content (#28/#21/#37) → leaves → deferred/triage (#79).

**Parallel note:** the rope/physics cluster (#19/#56/#80) and the agent-session cluster (#45/#46/#61) touch disjoint subsystems — safe to run concurrently in separate sessions. Claim convention: `gh issue edit <n> --add-assignee @me` as the session's first write.

**Caveats:** this is a point-in-time snapshot — re-verify blockers live (`gh issue view <n>` or the dependencies API) before claiming; counts shift as tickets close.