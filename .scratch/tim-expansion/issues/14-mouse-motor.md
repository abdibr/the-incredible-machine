# 14: Mouse Motor (bump → temporary rotational output)

**Class:** missing object

**What to build:** A mouse motor: any object bumping it starts it producing rotational power for a limited time (interactions.csv I031: object activates mouse_motor; I036: bowling ball → mouse motor demo). It is a rotary **source** for the fan-belt seam (ticket 13): motor → belt → conveyor carries a ball. Output duration is a named constant (original duration is unspecified — choose a sensible value and document the assumption). Toolbox icon, serialization, contract tests.

**Blocked by:** 13 (belt/power seam must exist).

**Status:** ready-for-agent

- [ ] Bump from a moving object starts the motor (with a debounce; no re-trigger spam)
- [ ] While running, motor drives a belt-connected conveyor
- [ ] Output is time-limited and expires; motor returns to idle
- [ ] Matrix row documents I031 mapping; contract tests + toolbox icon