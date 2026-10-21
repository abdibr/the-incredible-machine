# 22: Pokey the Cat + Mort chase behaviors

**Class:** missing object

**What to build:** Pokey the Cat: an animal object attracted to visible mice — it approaches, and if it reaches the mouse, it eats it (interactions.csv I029). Mort the Mouse (already registered) gains the flee side: when the cat is detected nearby the mouse runs away, and the size asymmetry holds — the mouse can pass through gaps too small for the cat (I030; objects.csv animal rows). Visibility/distance/approach heuristics are qualitative in the reference ("visibility, distance and path accessibility matter") — pin concrete constants in the session (reuse the mouse's walker/discovery patterns rather than pathfinding). Mouse-eaten behavior must respect the lifecycle contract (eat = dispose with event).

Demo: place cat and mouse on a floor; cat approaches; mouse flees through a one-mouse-wide gap.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Cat detects and approaches visible mice within a documented radius
- [ ] Cat reaches mouse → mouse eaten (event emitted, object disposed cleanly, reset-safe)
- [ ] Mouse flees from detected cat; passes gaps the cat cannot enter
- [ ] Heuristic constants documented; contract tests + cat toolbox icon; full suite green