# TIM Expansion — Gap Plan & Ticket Index

Source of truth this plan came from: `resources/incredible_machine_original_dos_*` (49 desired objects, 39 interactions, mechanics JSON), audited against the implementation on 2026-10-21 by four parallel investigation agents (desired-state compile, object audit, interaction audit, known-state audit).

## Gap summary

- **Interaction coverage:** 10 of 39 desired interactions exist (rope severing ×2, balloon pops ×2, bucket catch, gear mesh [declared but dead in live play], scissors snap+sweep, mouse reverse, spring launch, trampoline stretch).
- **Engine prerequisites blocking whole families:** (a) object-level query + overlap zones + reusable impulse-field primitive (Fan's wind field is private, `queryZone` is center-inside-only); (b) runtime constraint attach/detach (rope connectors cannot exist without it).
- **Existing-object incompleteness (priority per user):** rope cannot attach to anything at all; gear meshing never fires during real play; candle permanently lit; fan always-on and cannot extinguish candles; balloon buoyancy cannot lift payloads and pops on wax/handle; conveyor untriggerable; rope can't route through pulley; domino friction constants backwards.
- **Missing objects:** 32 normal + 4 seasonal (fan belt, mouse motor, windmill, teeter-totter, gun, cannon/rocket, fuse/dynamite, electrical chain, light chain, cat, fishbowl, terrain wall set, long-tail actuators).

## Ticket map (dependency order)

```
Tier 0 (foundation + existing objects)
01 discovery-field-seam ─┬─> 09 fan-blow-out ──> 21 electric-chain
                         ├─> 15 windmill ──────> 16 bellows
                         ├─> 18 dynamite
                         └─> 24 light-chain
02 runtime-constraints ──> 04 rope-connector ─┬─> 05 balloon-lift
                                              ├─> 10 rope-through-pulley
                                              ├─> 19 gun-bullets
                                              └─> (24)
03 gear-mesh-live ─┬─> 11 airflow-into-gear
                   └─> 13 fan-belt-power ──> 14 mouse-motor
                                            └─> 15 windmill
06 candle-state ──> 09, 17 fuse-chain ─┬─> 18 dynamite
                                       └─> 20 cannon
07 domino-tuning   08 balloon-pop-fidelity   12 teeter-totter (rope part via 04)
22 cat-mouse ──> 23 fishbowl     26 balls     27 seasonal     28 content-pass (waves)
25 long-tail cluster (split later; parts depend on 04 / 13 / 17)
```

## Using these tickets

Each `issues/NN-*.md` file is a tracer-bullet slice: demoable on its own, sized for one context window. They are skeletons — a follow-up "pin-down" session per ticket fills exact acceptance criteria and implementation notes before it is picked up.

Publishing: this machine has no `gh` CLI, so tickets start as local files in dependency order. When ready, publish each to the fork's GitHub Issues (`origin`/`abdibr/the-incredible-machine`), wire **native blocked-by edges** per `docs/agents/issue-tracker.md`, and apply `ready-for-agent`. Do not re-emit issues against `upstream`.

Glossary vocabulary (`GLOSSARY.md`): use the canonical type strings and ADR terms (interaction matrix rows, body labels, discovery seam, lifecycle/restore contract) in all ticket text.