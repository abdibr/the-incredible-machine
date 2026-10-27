# 20: Cannon + cannonball (fuse-fired)

**Class:** missing object

**What to build:** A cannon with a fuse point: when the lit-fuse ignition event (ticket 17) reaches the cannon's fuse, it launches a cannonball along its facing at high speed (interactions.csv I023: lit_fuse ignites cannon). The cannonball is the heaviest ball — it does not bounce normally; free-fall cannonballs and barrel-launched behavior may differ (documented in objects.csv cannonball row). The cannonball striking scissors from above closes them (existing snap rows already implement weight-on-handle → snap → rope sever — interactions.csv I035 chain). Toolbox icon, serialization, contract tests.

**Blocked by:** 17 (fuse chain).

**Status:** ready-for-agent

- [ ] Fuse ignition event at the cannon's fuse point launches a cannonball along facing
- [ ] Cannonball lands on scissors handle → scissors snap and sever ropes (end-to-end C001 chain demo)
- [ ] Cannonball does not bounce like the other balls (heavy, low restitution)
- [ ] Contract tests + toolbox icon; full suite green