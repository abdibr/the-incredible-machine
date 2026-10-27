# 21: Electrical chain starter — switched outlet powers the fan

**Class:** missing object (+ electrical-power contract)

**What to build:** The first electrical slice: a switched outlet that supplies power while its switch is on, and the existing fan becomes a powered **electrical consumer** — the fan only blows while connected and receiving power (interactions.csv I015: switched_outlet powers electrical_appliance; I019: electrical power powers fan; objects.csv fan row lists "receives electrical power"). The connection model (adjacency/cable distance, pinned in the session) is deliberately minimal; the generator/motor/solar extensions build on the same contract later.

Note: ticket 09 gives the fan a manual on/off; this ticket supersedes the manual toggle with a powered/idle mode wherever an outlet connection exists (decide the precedence rule in the session).

**Blocked by:** 09 (fan on/off state model).

**Status:** ready-for-agent

- [ ] Switched outlet exists (toggleable, toolbox icon, serialization)
- [ ] Fan connected to a powered outlet blows; unpowered/disconnected fan is idle
- [ ] Toggling the switch off stops the airflow immediately (candle interaction respects it via 09's row)
- [ ] Contract tests for the connect model; full suite green