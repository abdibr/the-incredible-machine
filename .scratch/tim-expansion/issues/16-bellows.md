# 16: Bellows (press → airflow burst)

**Class:** missing object

**What to build:** A bellows pressed from above or below emits an airflow burst that pushes movable objects and can spin a windmill in its effective zone (objects.csv bellows row: "Produces airflow; can move balloons and turn windmills"; interactions.csv I013 covers bellows airflow → windmill). It exercises the impulse-field primitive (ticket 01) as a one-shot burst rather than a continuous zone (contrast with fan). Demo: a weight falls on the bellows → nearby balloon shoved / windmill spins briefly.

**Blocked by:** 15 (windmill exists to receive the airflow demo), 01 (field primitive).

**Status:** ready-for-agent

- [ ] Press (impact from above or below) triggers a one-shot airflow burst
- [ ] Burst pushes balloons/movable objects within effective range
- [ ] Burst spins a windmill within range (belt-conveyable per 13/15 semantics)
- [ ] Re-press re-triggers (no sticky one-shot); contract tests + toolbox icon