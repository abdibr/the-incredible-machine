# 12: Teeter-Totter (lever translating impact to movement/rope tug)

**Class:** missing object

**What to build:** A teeter-totter object: one side pressed (by a falling/rolling object) rotates the board so the opposite end moves — flinging a resting object upward or sideways, and (once rope attachment exists) tugging a rope attached to the raised/lowered end (interactions.csv I006: teeter_totter moves opposite_end — "potentially moving an object or pulling attached rope"; objects.csv teeter_totter row). Static pivot, physics board, placement-sensitive. Toolbox icon, serialization, contract tests per the object lifecycle contract (ADR 0003).

Demo without rope: ball drops on one end → a resting ball on the other end is launched. Demo with rope (after 04): the descending end pulls a rope tied to it.

**Blocked by:** None (can start immediately). Rope-tug capability is gated on ticket 04 — the impact-only path lands first.

**Status:** ready-for-agent

- [ ] Impact on one end launches/ballistics a resting object on the other end
- [ ] Board physics feel like a lever (not a seesaw platform ride): pivot fixed, ends oscillate and settle
- [ ] (After 04) rope attached to an end is tugged when that end rises/falls
- [ ] Contract tests + toolbox icon + serialization; full suite green