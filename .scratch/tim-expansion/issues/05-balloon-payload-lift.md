# 05: Balloon can lift (and hold) a payload

**Class:** incomplete implementation

**What to build:** Balloon buoyancy is tuned so a tethered balloon can hoist and hold a small payload (e.g., a bucket or weight) without either runaway acceleration or sagging to the floor — the original balloons restrain/lift objects via rope (objects.csv balloon row, rope restraint; interactions I039). Keep the bobbing/wobble aesthetic; keep `pop()` behavior untouched. The demo doubles as the flagship rope-connector scenario: balloon + rope + weight rises when the run starts.

**Blocked by:** 04 (rope connector — the payload must be tethered).

**Status:** ready-for-agent

- [ ] Tethered balloon lifts a small payload and holds it airborne at stable height
- [ ] Lift behavior is deterministic across reset (snapshot restore shows the same rise)
- [ ] Balloon still bobs/wobbles and still pops per ticket 08's pop fidelity
- [ ] Balance values are named constants with a comment tying them to the expected payload mass range