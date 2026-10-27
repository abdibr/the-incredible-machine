# 13: Fan Belt + rotary-power seam (source → consumer)

**Class:** missing object (+ the power contract it introduces)

**What to build:** Introduce the rotational-power contract: **sources** produce shaft rotation, **consumers** accept it, and a **fan belt** transfers rotation between a source and a consumer within a limited stretch distance (interactions.csv I009: powered_rotator powers fan_belt; I011: rotational power → conveyor; objects.csv: belt "not a rope; scissors cannot cut it"). The conveyor becomes a consumer: its speed is driven by the belt instead of a fixed place-time value (its upper surface drives objects; underside opposite — keep that). For the first demo the powered gear (ticket 03) acts as a source; real sources land in tickets 14–15.

Scope notes: belt is an object (toolbox icon, serialization, contract tests); belt↔rope distinction enforced (scissors do not cut belts — belt body must not match rope-sever rows); source/consumer interface names pinned in the session.

**Blocked by:** 03 (a live rotating source must exist to demo transmission).

**Status:** ready-for-agent

- [ ] Gear source → belt → conveyor: conveyor belt surface moves when the source turns
- [ ] Belt within stretch limit connects source and consumer; disconnected/over-stretched belt does not transmit
- [ ] Scissors cannot cut a fan belt (belt is not matched by rope-sever rows)
- [ ] Conveyor keeps its standalone default behavior when unbelted
- [ ] Contract tests + toolbox icon + serialization; full suite green