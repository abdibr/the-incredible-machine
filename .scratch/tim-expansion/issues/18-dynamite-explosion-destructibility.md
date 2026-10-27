# 18: Dynamite + explosion + destructibility classes

**Class:** missing object (+ the destructibility contract it introduces)

**What to build:** Dynamite detonates when its fuse completes (ticket 17 ignition event; the plunger alternative is later): a radial explosion impulse (impulse-field primitive from ticket 01 — reusable AoE with falloff, the clone's first explosion primitive) pushes nearby movable objects, and **destructibility classes** are introduced for static terrain: destructible (brick, wood — removed with a break animation/event) vs resistant (metal pipe — survives) (interactions.csv I024/I033/I034). The terrain barrier pieces themselves (brick, wood, metal pipe) land in this ticket as the minimal set required to demo the classes; wood slope / pipe curves are a later polish ticket.

**Blocked by:** 17 (fuse), 01 (impulse/zone primitive).

**Status:** ready-for-agent

- [ ] Fuse → dynamite → explosion: radial push on nearby movable objects with distance falloff
- [ ] Explosion destroys barrier objects in the destructible class; resistant-class barriers survive
- [ ] Brick, wood, metal-pipe barrier objects exist in the toolbox (static, snapshot-safe) with class annotations
- [ ] Removal events let reset/goal systems react; contract tests for classes; full suite green