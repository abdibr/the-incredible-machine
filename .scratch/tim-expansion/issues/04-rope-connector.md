# 04: Rope as a connector — attach endpoints, cut releases the payload

**Class:** incomplete implementation (flagship gap; user-named example "rope has no useful use case")

**What to build:** A rope can be placed with either endpoint attached to another object (balloon, bucket, ramp, teeter-totter end — any object exposing an attachment point; fixed playfield anchors continue to work). While the rope holds, the attached object is restrained/suspended by it; when the rope is severed (existing rows: candle flame, closed scissors) the payload is released and responds to its own gravity (restrained balloon rises, suspended bucket falls — interactions.csv I039, rope_cut releases bucket_or_balloon). Also fixes the known content bug: level-04's hint ("attach balloons to rope, connect rope to the fixed ramp") currently advertises this unimplemented mechanic.

Scope notes for the pin-down session: place-time attach UX in the drag-drop flow; which objects get attachment points first (balloon + bucket are enough to demo); serialization of the link through the restore contract; keep the fixed-anchor rope as the default behavior.

**Blocked by:** 02 (runtime constraint attach/detach engine API).

**Status:** ready-for-agent

- [ ] Rope endpoint attaches to a placeable object at place-time; multiple attachment points supported
- [ ] Tethered balloon strains against the rope while running; severed rope → balloon rises
- [ ] Suspended bucket hangs from rope; severed rope → bucket falls
- [ ] Old behavior preserved: single static-anchor ropes still placeable and severable
- [ ] Link survives snapshot/restore; object-contract tests pass
- [ ] Level-04 hint text matches implemented mechanic