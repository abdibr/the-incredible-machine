# 19: Gun (revolver) + bullets

**Class:** missing object

**What to build:** A revolver whose trigger is pulled by rope tension — the rope-connector work (ticket 04) provides the pull: attach a rope to the trigger point and the appropriate pull direction fires a bullet along the gun's facing (interactions.csv I004: rope pulls gun_trigger → gun fires). A bullet is a short-lived fast projectile with limited interactions in this slice: pushes movable items and pops balloons (its fishbowl/cat effects belong to tickets 22–23). Fire is one-shot per pull. Toolbox icon, serialization, contract tests.

**Blocked by:** 04 (rope attach/pull mechanics).

**Status:** ready-for-agent

- [ ] Rope pull on the trigger fires a bullet in the gun's facing direction
- [ ] Bullet pushes light movable objects; bullet pops balloons (pop path reuses `pop()`)
- [ ] Bullet despawns on wall/exit contact; gun needs a re-pull before firing again
- [ ] Wrong pull direction does not fire (per reference precondition); contract tests