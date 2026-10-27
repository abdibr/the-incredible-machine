# 26: Ball family completion (bowling ball, basketball)

**Class:** missing object

**What to build:** The full ball family per the parts reference, as Ball variants: **bowling ball** (heavy — the canonical trigger for teeter-totters, mouse motors, dominoes), and **basketball** (light, very bouncy). Tennis and baseball variants already exist but are unused content-wise (ticket 28 covers level use). Cannonball belongs to ticket 20. Demo: observable weight/bounce diversity on slopes, trampolines, and dominoes.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Bowling ball and basketball registered variants with distinct density/restitution constants
- [ ] Relative behavior matches reference ordering (bowling ≫ basketball in weight; basketball most elastic among non-cannonballs)
- [ ] Variant serialization round-trips (existing Ball variant serialization pattern)
- [ ] Toolbox icons + contract tests; full suite green