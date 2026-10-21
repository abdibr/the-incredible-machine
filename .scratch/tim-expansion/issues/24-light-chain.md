# 24: Light chain — flashlight, drawstring light, magnifying glass, solar outlet

**Class:** missing object (+ light seam)

**What to build:** The light/fire family: a **flashlight** (button-pressed light source, orientation adjustable), a **drawstring light** (rope pull turns it on — I022), a **magnifying glass** (focuses a light beam to ignite a nearby fuse — I021), and a **solar outlet** (suitable light drives an electrical appliance — I017). Uses the discovery seam (ticket 01) for a light/ray region primitive; drawstring depends on rope attachment (ticket 04); magnifier's demo target is the fuse chain (ticket 17). Suggested split in the pin-down session if the slice proves too wide: (a) flashlight + magnifier + fuse ignition, then (b) drawstring light, then (c) solar outlet.

**Blocked by:** 01 (region/ray seam), 04 (rope attach for drawstring), 17 (fuse to ignite).

**Status:** ready-for-agent

- [ ] Flashlight emits a directional light region when its button is pressed
- [ ] Flashlight → magnifying glass alignment (documented tolerance) ignites an adjacent fuse
- [ ] Rope pull toggles the drawstring light on
- [ ] Solar outlet in a light region powers a connected fan-class appliance (I017/I019 reuse)
- [ ] Contract tests + toolbox icons for all four; full suite green