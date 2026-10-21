# 07: Domino toppling tuning

**Class:** bug

**What to build:** A falling domino reliably topples the next one instead of sliding over/through it. The current body constants are physically backwards (static friction lower than sliding friction: 0.3 vs 0.6), the base can slip at impact, and chain pushes rely entirely on emergent Matter behavior with no anti-slide tuning. Fix the constants and, if needed, anchor-style base behavior so placed chains produce clean chain reactions. Demo: place a chain, drop a ball on the first → the whole row topples in sequence.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] friction constants corrected (static friction ≥ sliding friction)
- [ ] Ball dropped on the first domino topples a vertical chain of 3+ without chain members sliding sideways past neighbors
- [ ] Snapshot/restore reproduces the same topple
- [ ] Tuning values justified in comments; full suite green