# Backlog prioritization — open unblocked issues

**Snapshot:** 2026-11-19 · fork `abdibr/the-incredible-machine` (`origin`) · derived from the open-issue list plus GitHub native issue dependencies (`issue_dependencies_summary`, open blockers only).

All `#N` references are issues on the fork's Issues tab. A ticket is *unblocked* when every blocker is closed; "gates" = open issues directly dependent on it (live counts, verified via `gh api .../dependencies/*`).

## Field overview

- **40 open issues, 20 unblocked** — none assigned. (Down from 64/22 on the 2026-10-27 snapshot.)
- Breakdown of the 20: 17 `ready-for-agent` work tickets, 1 tracking umbrella (#60), 2 `needs-triage` (#79, #83).
- Biggest blocked cluster: **#43 Content & palette pass** still waits on 12 tickets (the parts roster) — **#64 Watch 4/5** and **#39 Light chain** wait on 2 apiece.
- Highest direct leverage: #19 gates 5, #32 gates 4 (fuse tree), #28 gates 3 (rotary family).
- Since the 2026-10-27 snapshot: the **P2 program (#44–#50)**, the **knot series (#56–#59)**, **C1 seam (#75)** and the **fixed-timestep bug (#80)** all landed; the rope-seat burst (#84–#93) and P2-standards follow-throughs (#94–#97) were filed and closed in the same window. New on the board: **#83** (rope-family query fan, `needs-triage`) and **#91** (three-seat rope decision docs, `ready-for-agent`).

## Dependency map (anchors → open dependents)

| Anchor (unblocked) | Directly gates | Transitive payoff |
|---|---|---|
| #19 Rope as a connector (04) | #20, #25, #34, #39, #43 | Balloon-lift, pulley redirect, gun bullets, light chain, most of the content pass |
| #21 Candle lit/unlit (06) | #24, #32 | Fan-candle + switched outlet (#24 → #36); #32's fuse tree (dynamite #33, cannon #35, light chain #39) — four of #43's 12 blockers. **New edge this snapshot:** the fuse demo igniter is candle-flame contact |
| #28 Fan Belt (13) | #29, #30, #43 | Mouse motor; windmill → bellows (#30 → #31) |
| #37 Pokey the Cat (22) | #38, #43 | Fishbowl |
| #61 Watch 1/5 prefactor | #62 | #64 (needs #63 too), #65 |
| #63 Watch 3/5 sandbox posture | #64 | #65 |
| #76 C4 part 1 (stale-run retry bug) | #77 | #78 — the C4 recorder/loop series |
| #81 Bug pin: spring-under-throttle | #82 | The mass-faithful spring design decision |

Other unblocked chains: C4 #76 → #77 → #78; watch #62 → #64 → #65; rotary #30 → #31; electrics #24 → #36; fuse tree #32 → #33, #35.

## Start order, with reasons

1. **#81 Bug pin — spring-under-throttle regression (bug)** — the only unblocked bug. #80 (fixed-timestep stepping) landed on 10-28; #81 graduates its bugfile (`bug-20261027T151221Z-0txh`) into a permanent fixture + replay regression test per ADR 0006, pinning the dt² launch burst and the silent platform tunneling that #80's fix corrected. Small direct unlock (#82) but it is the guardrail for every spring/launch tune below, and it gates #82's design decision.
2. **#19 Rope as a connector (04)** — highest direct leverage on the board (5 dependents). Flagship user-named gap; also fixes level-04's hint advertising this unimplemented mechanic. Most of the toolbox roster hangs off rope infra.
3. **#61 + #63 Watch series seeds** — the two unblocked entries of the watch program (#60): #61 → #62 → #64, #63 → #64. With the P2 program (#44–#50) landed, watch is the agent-in-the-loop program's remaining half; #65 (live LLM turn source) only opens after #64.
4. **#76 C4 part 1** — cheapest chain entry: a real bug fix (fail-overlay retry appends to a stale run; restore `loop:reset` so the recorder closes runs) that re-opens the 3-for-1 C4 chain (#76 → #77 → #78).
5. **Content chain-heads: #28 Fan Belt, #21 Candle state, #37 Pokey Cat** — prefer over other content tickets: each opens a sub-chain. #21's payoff grew since the last snapshot — its new edge into #32 (fuse) means landing it unblocks #24 (fan-candle → electrics #36) *and* the fuse tree (#33, #35); #28 opens the rotary family (#29, #30 → #31); #37 → #38 fishbowl. #19 plus these three cover eleven of #43's 12 blockers; leaf #26 is the twelfth.
6. **Leaves (anytime fillers): #22, #23, #26, #27, #40, #41, #42, #73, #91** — no dependents, ready-for-agent. #27's rope-tug phase waits on #19 in prose (no dependency edge) but its impact path is independent. **#91 is new**: an ADR 0007 amendment + glossary rewrite recording the three-seat rope decision the just-landed seat program (#84–#93) settled — cheap doc work worth doing near any rope-adjacent ticket so docs don't drift from code.
7. **#79 + #83 — last, triage first** — both `needs-triage`, not `ready-for-agent`; triage before any work. #83 is small but touches a settled seam — C1 (#75) deliberately left the rope/free-rope two-query fan open, so confirm the family-query shape before scheduling; #79 remains the large architectural sweep, deferred until the seams above settle.

Not work tickets: #60 (watch-program tracking umbrella; #44 came and went with the P2 program).

## Ordering principle

Bug guardrail first (#81) → maximum-unlock node (#19) → program seeds (#61/#63) → cheap chain entries (#76) → chain-head content (#28/#21/#37) → leaves → triage-gated (#83, #79).

**Parallel note:** the rope/content cluster (#19/#21/#28/#37) and the agent-runtime cluster (#61/#63/#76) touch disjoint subsystems — safe to run concurrently in separate sessions. The C4 chain (#76–#78) and the watch chain (#61–#65) both graze the agent-session runtime, so keep those two in the same lane rather than parallel. Claim convention: `gh issue edit <n> --add-assignee @me` as the session's first write.

**Caveats:** this is a point-in-time snapshot — re-verify blockers live (`gh issue view <n>` or the dependencies API) before claiming; counts shift as tickets close.
