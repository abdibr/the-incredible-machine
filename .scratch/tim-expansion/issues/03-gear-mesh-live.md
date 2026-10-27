# 03: Gear meshing fires during real play (+ radius-based gear ratio)

**Class:** incomplete implementation

**What to build:** Two gears placed touching each other counter-rotate during actual play with no test harness involved. Today the gear-gear matrix row exists, but `meshWith()` only ever runs under tests because Matter suppresses static×static collision pairs (gears are static bodies), so live play never dispatches the pair. Fix the discovery path (e.g., proximity scan via the ADR 0002 seam, or another matrix-compatible dispatch that respects decision #5) so the existing `gear-gear` row fires live, and gears counter-rotate per the original behavior — interactions.csv I010 (gear rotates adjacent_gear) and the gear object row ("adjacent meshed gear rotates in opposite direction"). Note: the resources document opposite-direction rotation only, not any speed ratio; add proportional speeds as a documented assumption — gears exchange rotation proportional to their radii (ratio = r_small / r_large), pinned in the session. Gears keep being placed via the toolbox; no level content required.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Placing two touching gears in a running level → both spin in opposite directions without any scripted trigger
- [ ] Different radii produce proportional speeds (ratio = r_small / r_large — documented assumption; the original only specifies opposite-direction rotation)
- [ ] `meshWith()` seam semantics unchanged for tests; solution stays within the interaction-matrix architecture
- [ ] Regression test proves live dispatch (not only direct `resolve()` calls); full suite green

**Priority note:** highest-leverage existing-object defect after rope — unblocks belt demos (13) and balloon-gear interaction (11).