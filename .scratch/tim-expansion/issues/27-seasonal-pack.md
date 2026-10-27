# 27: Seasonal parts pack (pumpkin, christmas tree, shamrock, valentine balloon)

**Class:** missing object

**What to build:** The four date-specific seasonal parts per the reference: **pumpkin** (freeform gravity part, frictional horizontal movement), **christmas tree** (static barrier, explosion-resistant — joins the destructibility classes from ticket 18), **irish shamrock** (light, slightly bouncy), **valentine balloon** (heart balloon: inverted-rise balloon that **cannot be popped by any means**). Availability gating (date-based toolbox exposure) is optional polish — registry/toolbox placement is the core. Demo: each placed object behaves per its row in the reference CSV.

**Blocked by:** None core (18 only if tree's explosion-resistance is wired in this slice; otherwise defer that annotation).

**Status:** ready-for-agent

- [ ] All four registered with correct physics class (gravity direction, bounce, mass feel)
- [ ] Valentine balloon is un-poppable (no row/predicate ever pops it); tree is explosion-resistant
- [ ] Optional: date-gated toolbox visibility behind a clearly documented flag
- [ ] Contract tests + toolbox icons; full suite green