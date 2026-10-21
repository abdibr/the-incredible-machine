# 23: Fishbowl (shatters on impact; attracts the cat)

**Class:** missing object

**What to build:** Bob's fish bowl: a container object that shatters on contact with a moving item (interactions.csv I027: moving_object breaks fishbowl), emitting a break event; a shattered bowl attracts Pokey the Cat within reachable distance — the cat attempts to approach it (I028). The fish/water visuals can be minimal; the mechanics are: fragile-on-moving-contact, attractor-after-break. Also records its future consumer interactions (gun bullet, jack-in-the-box belong to later tickets).

**Blocked by:** 22 (cat exists to receive the attractor).

**Status:** ready-for-agent

- [ ] Moving object contacting the bowl shatters it (one-shot; static contact does not)
- [ ] Broken bowl attracts a nearby cat; cat approaches the bowl area
- [ ] Break event is reset-safe; contract tests + toolbox icon; full suite green