# 28: Content & palette pass — levels exercising the full roster

**Class:** incomplete implementation (content)

**What to build:** Shipped levels and the editor palette catch up with the mechanics as they land. Today's shipped levels (01–05) use only 10 of 17 registered types; seven types are placeable but never exercised (tennis-ball, baseball, conveyor, gear, pulley, candle, scissors), and the goal pattern does not use the bucket's `catchType` filter. Deliver in waves matching the feature tickets (rope/tether level after 04–05; fuse/cannon/gun level after 17–20; belt/motor level after 13–15; cat/bowl level after 22–23). Also folds in the existing backlog "future ideas" that block this pass: editor fixed-object placement + goal-type expansion, and level JSON schema validation on load. Fixes the placed-bucket-in-editor leak noted in the object audit.

**Blocked by:** the feature waves it exercises (04/05, 09/11, 13–15, 17/18/20, 22/23) — incremental; first wave gates on rope-connector.

**Status:** ready-for-agent (in waves)

- [ ] One shipped level per released feature wave demos it end-to-end (machine solvable + reset-safe)
- [ ] Every registered type appears in at least one shipped level
- [ ] Editor: fixed-object placement, goal-type expansion, bucket leak fix
- [ ] Level JSON schema validation on load (existing future-idea item)