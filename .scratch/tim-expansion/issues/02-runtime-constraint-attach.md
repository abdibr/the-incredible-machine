# 02: Runtime constraint attach/detach engine API (prefactor)

**Class:** prefactor (foundation — unblocks every rope-connector ticket)

**What to build:** The engine can attach a constraint between two already-registered, live objects at runtime, and detach a single constraint without removing either object. Constraint links are part of snapshots (captured/restored through the existing restore seam, ADR 0003), and the wake/discovery policy applies. Today constraints are only added/removed wholesale with an object, and the sole runtime detach path is the rope-sever event handler. No user-visible behavior by itself — this is the seam under "rope as a connector," balloon tethers, pulley routing, and cut-releases-payload.

**Blocked by:** None (can start immediately) — pairs cleanly with ticket 01.

**Status:** ready-for-agent

- [ ] Engine API attaches a constraint between two live registered objects
- [ ] Per-constraint detach: bodies keep existing, object state stays consistent
- [ ] Attached links survive snapshot capture/restore (restore-by-id path respected)
- [ ] Unit tests for attach/detach/restore; full suite green