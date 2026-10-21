# 17: Fuse + burning-fuse chain

**Class:** missing object

**What to build:** Fuse segments placeable along a path; the burn front travels along the fuse over time; reaching the end raises an ignition event that lit-fuse **consumers** (cannon — ticket 20; dynamite — ticket 18; rocket/magnifier chains later) listen for (interactions.csv: lit_fuse ignites cannon I023 / dynamite I024 / rocket I025 — and a rising rocket can ignite another fuse, I025 result). **Ignition inputs:** the only fuse-ignition interaction the resources document is I021 — a light source illuminates the magnifying glass aligned with the fuse ("Magnified light ignites fuse"); that wiring lands with the light chain (ticket 24) and plugs into this ticket's `fuse:ignited` event seam. The demo igniter is candle-flame contact (ticket 06 state model) — a documented assumption, not a resource row: the dynamite trigger reads "Ignited by suitable flame/ignition event" and the candle is a "portable flame and light source", but there is no explicit flame-touches-fuse interaction row; pin the decision in the session. The original leaves burn speed/timing unspecified — pick a documented assumption constant. Fuse exists while burning; burn state is snapshot-safe (restore mid-burn is acceptable: restore to pre-burn or keep the front — decide in the session).

**Blocked by:** 06 (candle can be lit and has an active flame sensor). Not blocked by 24 — the magnifier path plugs into this ticket's event seam once the light chain lands.

**Status:** ready-for-agent

- [ ] Candle flame contact ignites a fuse segment (documented assumption — see What to build); burn front propagates along connected segments
- [ ] Burn completes → emits the lit-fuse ignition event (consumed by 18/20 when they land; the magnifier path from 24 plugs into the same seam)
- [ ] Fuse remains connectable along bends (segment-to-segment adjacency rule pinned in session)
- [ ] Burn state restores deterministically per the chosen policy; contract tests + toolbox icon