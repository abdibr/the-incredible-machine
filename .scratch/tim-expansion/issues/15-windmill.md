# 15: Windmill (airflow → rotational output)

**Class:** missing object

**What to build:** A windmill converts airflow reaching its effective zone into rotational power (interactions.csv I013: fan_or_bellows_airflow powers windmill; I014: windmill powers belt-connected rotator/consumer). It is a rotary **source** on the fan-belt seam (ticket 13): fan → windmill → belt → conveyor. Uses the discovery/field seam (ticket 01) for airflow detection; rotation output direction follows airflow direction. Toolbox icon, serialization, contract tests.

**Blocked by:** 13 (power seam), 01 (field/impulse primitive).

**Status:** ready-for-agent

- [ ] Fan airflow into the windmill's effective zone spins the windmill
- [ ] Spinning windmill drives a belt-connected conveyor
- [ ] Idle (no airflow) windmill is inert
- [ ] Contract tests + toolbox icon; full suite green