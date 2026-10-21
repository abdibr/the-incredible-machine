# 08: Balloon pop fidelity — flame and effective scissors contact only

**Class:** bug (records ADR 0001's refinement candidate as a decision)

**What to build:** The balloon pops on the candle **flame** body and on the scissors' effective contact area — not on candle wax, not on the scissors handle bodies (per the parts reference: "can be popped by bullet, closing scissors, or turning gear"). ADR 0001 deliberately deferred this refinement ("balloon pops on any candle body, wax included — recorded as a candidate refinement"); this ticket makes it the decided behavior via label/predicate matchers in the existing matrix rows, plus updated regression tests. Turning-gear pop belongs to ticket 11, bullets to ticket 19.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Balloon ignores candle wax contact (no pop), pops on flame-body contact
- [ ] Balloon ignores handle contact, pops on effective scissors contact area
- [ ] ADR 0001 refinement note updated to reference this decision
- [ ] Regression tests updated; full suite green