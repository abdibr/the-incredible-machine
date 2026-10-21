# 11: Airflow herds a balloon into a turning gear → pop

**Class:** missing interaction

**What to build:** A balloon carried by fan airflow contacts a rotating gear and pops (interactions.csv I037 — precondition "Airflow moves balloon into target", result "Balloon can contact gear and pop, or hit scissors and pop"; note the row's target label reads windmill_or_scissors while its result names gear/scissors — we mirror the result. Pop-on-turning-gear is also directly documented: balloon effects "Can be popped by bullet, closing scissors, or turning gear" and gear effects "turning gear can pop balloon"). Requires a matrix row `balloon ✕ gear` gated on a predicate "this gear is actively turning" (the gear-power contract from ticket 03) and a `balloon.pop()` handler — the same public-seam pattern as existing rows. The airflow itself already pushes movable bodies; the new part is the pop-on-turning-gear behavior only (not on an idle gear).

**Blocked by:** 03 (gears actually rotate during live play).

**Status:** ready-for-agent

- [ ] Fan pushes balloon into a turning gear → balloon pops
- [ ] Balloon resting against an idle/non-rotating gear does not pop
- [ ] Pop path reuses existing `pop()`/`balloon:popped` semantics (no new dispose logic)
- [ ] Regression test with real objects; full suite green