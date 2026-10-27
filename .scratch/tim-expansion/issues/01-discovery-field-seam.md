# 01: Object-level discovery & field-effect seam (prefactor)

**Class:** prefactor (foundation — unblocks airflow, explosion, light families)

**What to build:** The engine's discovery seam (`/docs/adr/0002`) gains object-level queries — fetch registered objects by canonical type and by body label — plus an overlap-based zone query (today's zone test is center-inside-only, so a large body whose center sits outside a zone is invisible to it), and a reusable impulse-field primitive extracted from Fan's private per-frame wind zone (directional cone/rect, distance falloff, force application to movable bodies). Fan is refactored onto the primitive with behavior indistinguishable from today (per its regression tests). No new user-visible behavior; this is "make the change easy, then make the easy change."

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Object-level query by type and by body label exists on the discovery seam (documented in ADR 0002), replacing the hand-rolled scan Scissors does today
- [ ] Overlap-based zone query handles large bodies whose center is outside the zone; center-inside variant kept where needed
- [ ] Impulse-field primitive extracted; Fan uses it; fan regression tests pass unchanged
- [ ] Full suite green (`npm test`)