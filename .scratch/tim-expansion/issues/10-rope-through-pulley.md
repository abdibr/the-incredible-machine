# 10: Rope routes through pulley to redirect pull

**Class:** missing interaction

**What to build:** A rope can be routed through the pulley wheel so a pull applied on one side is redirected to the other side (interactions.csv I005: pulley redirects rope_force). This extends the rope-connector work (ticket 04): rope segments attach to two endpoints and pass through the pulley; tension on one side loads the other. Combines naturally with the pulley's existing load-coupling platforms, but the core demo is rope-level: tie a payload on one side, pull (or hang a weight) on the other, and the payload lifts through the wheel.

**Blocked by:** 04 (rope connector; engine constraint API from 02 already implied).

**Status:** ready-for-agent

- [ ] Rope can be placed routed through a pulley between two attachments
- [ ] Pull/weight on one side lifts or moves the payload on the other side via the wheel
- [ ] Severing any reachable rope segment releases the restrained payload (consistent with 04's sever semantics)
- [ ] Routing survives snapshot/restore; rope and pulley regression tests green