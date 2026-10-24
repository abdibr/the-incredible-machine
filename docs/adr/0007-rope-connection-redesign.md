# ADR 0007 — Rope connection redesign: click-to-connect, segment knots, free ropes

- **Date:** 2026-10-23
- **Status:** Accepted
- **Scope:** the rope connection redesign — one internal `Rope` class exposed as the toolbox types `rope` and `free-rope`; explicit click-to-connect tying; the chain/knot model (segment-indexed addressing, token schema); span semantics (fixed length vs unlimited); the free rope's inert bundle; piece severing; wholesale drag-untie; edit-only affordances; future-routing compatibility. The decision record the redesign's implementation tickets cite.

> **Numbering note.** The rope-redesign ticket set (fork issue #51 plus the implementation tickets it gates, #52–#59, filed 2026-10-23) references this record as its "ADR 0006". The 0006 slot was already claimed on 2026-10-21 by the session bug-file record (`docs/adr/0006-session-bug-file.md`), so this record ships as **ADR 0007** — same decisions, next number. Any "ADR 0006" citation in those ticket bodies resolves here.

## Context

ADR 0005 landed rope as a connector: a chain of segment bodies anchored to the board, knots as live refs realized per step as engine links (ADR 0004's seam), and the ordinal-token round-trip. Its tying UX, however, is guesswork: placement snaps and ties a drop landing within `ROPE_SNAP_RADIUS` (24 px) of a rope endpoint or attachment point, and pull-to-tie yanks the whole fresh drop within `ROPE_ATTRACT_RADIUS` (64 px) onto the nearest endpoint. Hints make the prediction visible but it is still a prediction. There is no way to tie rope to rope, no way to tie mid-chain, no length control, no anchorless rope, and a cut destroys every engine link at once (co-termination) rather than splitting the chain honestly.

A design grilling session settled the full redesign, every decision user-confirmed (2026-10-23). These decisions retire the proximity model, generalize what a knot is, add the second rope type, and keep the rope future-proof for routed paths (roster issue #25, *rope routes through pulley*) without designing routing here.

Constraints inherited unchanged from the codebase: the engine link seam `attachConstraint`/`detachConstraint` realized lazily per reconcile step (ADR 0004), the board snapshot / `serializePlacedBoard` two-phase ordinal bind (ADR 0005), the object lifecycle contract (ADR 0003), and the interaction matrix keying matchers on object `type` strings (ADR 0001).

## Decision

1. **One `Rope` class, two toolbox types.** The toolbox exposes `rope` (pinned) and `free-rope` (anchorless) as distinct `type` strings — the registry's dedup, the toolbox UX, and the interaction matrix (whose matchers key on type strings) treat them as two families — but both are the same internal class with the same chain, knot, token, tie, and sever machinery; the type differences are configuration, not subclasses.
2. **Tying is explicit click-to-connect — ALL proximity tying dies.** A rope renders square handles at its tie points; objects that offer attachment points (balloon knot, bucket rim) show target squares when relevant. Clicking a rope square enters a seek state: a preview line follows the cursor and valid target squares glow. Clicking a glowing target creates the knot (engine link realized as usual); Esc or re-clicking the seeking square cancels; clicking an already-tied square unties that knot (the target stays, the rope side frees). Dropping a rope simply places it; dragging never ties; no snap or attract hint renders. The classic rope's physics behavior — hangs, swings, carries payloads — is unchanged; only how ties are made changes. The connect flow lives in its own module that the drag-drop handler delegates to; the renderer draws squares, preview, and glow.
3. **A rope is a chain of segment bodies, and the whole chain is tieable.** The chain model of ADR 0005 carries forward, now load-bearing: every segment body can carry a knot. Segment count derives from the current span (a density target around 40 px per segment, sensibly capped) and applies to both types, so long spans render and simulate sanely. Mid-chain segments show their own square handles.
4. **Span semantics per type.** The pinned `rope` is fixed-length: a fresh drop hangs 100 px straight down; while untied, dragging its free-end square re-lays the rope to follow the cursor, clamping at the minimum viable span instead of breaking the chain; the first tie freezes the length; a tie click aimed beyond the rope's reach is refused with feedback (red handle flash + "rope too short" tooltip) instead of silently snapping or stretching. Tied, it behaves as max-length-plus-slack — never a rigid rod. The `free-rope` has no length property at all: any tie re-lays/extends the chain to span whatever is demanded ("unlimited" = tie far, re-lay to reach); earlier knots survive every re-lay.

5. **A free rope starts as an inert bundle.** Before its first tie it is a static, coiled bundle — no physics bodies at all (it does not fall, lands nothing, and candle/scissors ignore it), selectable and movable via its drawn bounds, presenting exactly one square entry point. The first tie through that square spawns the real chain hanging from the chosen attach point, the untied end dangling below as the next handle. Untying its only knot reverts it to a bundle; deleting an untied bundle removes just the graphic + row. From its first tie on, it behaves like any rope (span semantics of decision 4; mid-chain knots of decision 3).
6. **Knots are segment-indexed; the token schema grows `segment`.** Straight from the design session, the knot token schema is:

   `{ segment, targetType, targetOrdinal, pointId }`

   `segment` generalizes the old `endpoint` 0|1 to any chain segment index (the old form is its degenerate case: 0 → first segment, 1 → last segment), and the two-phase ordinal bind resolves targets exactly as before. Several knots may ride one rope across different segments (including both ends); deleting a target prunes only its knots. Rope-to-rope tying is the same mechanism with the target itself a rope: a rope's endpoint/segment squares are valid seek targets, and the knot realizes as a body-to-body zero-length engine link through the same token seam.

7. **Cutting severs into connected components (piece severing).** A candle/flame or scissors cut severs exactly where it hits — only the chain constraint at the cut segment dies — splitting the chain into its surviving connected components; each **piece** keeps the knots attached to its own segments, realizes them in play, and falls carrying its payloads; a pinned rope's anchor-side piece stays hung from the board anchor; repeated cuts yield more pieces. This replaces sever-as-total-demolition for plain ropes: the engine's sever consumer becomes piece-aware, so links belonging to surviving segments stand instead of dying with the cut.
8. **Dragging a tied rope unties it wholesale.** Moving a tied rope unties ALL its knots in one act — the targets stay exactly where they are and the rope comes loose as a whole. Per-knot untying remains available through the connect flow's tied-square click.
9. **Squares, seek, and tooltips are edit-only affordances.** Visible and interactive in EDITING/SANDBOX only; during PLAY nothing is visible or tieable, and any stage change (entering PLAY, leaving a sandbox mode) cancels in-flight seek/drag at the last settled state. The one deliberate exception is the debug overlay (issue #59): explicitly-enabled live debugging may render during play — a debugging affordance, not an editing one; knot tooltips stay suppressed in PLAY.

### Future-routing compatibility (recorded here, designed later)

- **Chain-based rope so paths can bend.** A chain of segments is what lets a routed path change direction: sheave/guide support first, the sliding exchange (rope paying through a pulley) later.
- **Mid-chain attach machinery doubles as wrap-point machinery.** Segment tie points and the attach machinery they drive are the same mechanism a routed wrap point needs; routing attaches nothing new.
- **One rope identity, piece severing, and a routed special case.** A routed rope stays a rope — same class, same tokens, same knots; routing special-cases its sever policy.
- **Routing is a deterministic geometric rule, rendered visibly, NOT a knot.** The routed path is computed from geometry and drawn on screen; it is never serialized as a knot token — restore re-derives it from geometry, like any geometry-derived state.
- **Pulleys expose no attachment squares.** The shipped two-platform Pulley stays closed to rope tying.
- **Future routing is a separate router object.** Nothing of the router lands in the rope set; it gets its own ADR.

**Deferred:** routed ropes override piece severing with a **whole-rope sever** — that special case is decided in the future routing ADR, not here.

## Out of scope

- **EditorPanel save brokenness** — pre-existing; placed-rows persistence continues to ride the per-play placed snapshot annotation path.
- **Ball attachment points** — the ball family offers none; tying to balls is not part of this set.
- **Routed pulley design** — future routing ADR (roster issue #25 stays the placeholder).

## Consequences

- The proximity surface disappears from the public rope API: `ROPE_SNAP_RADIUS`/`ROPE_ATTRACT_RADIUS`, DragDrop's placement snap (`_snapObjectToRopes`) and pull-to-tie translation, and the snap/attract hint renderers (`_drawRopeSnapHints`/`_drawRopeEndpointHints`) die with their guesswork contracts; the proximity test contracts are rewritten as click-flow contracts (tie / cancel / untie / beyond-reach refusal).
- Two registered types double the matrix bookkeeping: every row that must catch a rope (scissors blades, candle flame) is declared for `rope` and `free-rope`, or matched by body label.
- The snapshot/token seam keeps its shape: `serializePlacedBoard` emits `segment` tokens and restore binds two-phase as before; boards and bug files written with `endpoint` tokens restore through the degenerate mapping (endpoint 0 → first segment, 1 → last), pinned down with regression tests in the mid-chain ticket.
- The engine sever consumer (`_detachRopeConstraints` with co-termination, ADR 0005 decision 4) becomes piece-aware: links at surviving segments must survive a cut rather than die with it.
- The bundle is the one rope state with zero engine presence; board snapshots carry it as a plain row until its first tie, and the recorder's refIds/token narration need no change (its build-trace knot tokens stay narrative).
- Edit-only affordances add a UI interaction mode (seek) gated by stage, cancelled cleanly on every stage change; PLAY boards show no rope UI.
- Debugging gains new surfaces: per-square knot tooltips (segment, target type + id, pointId, realized/pending, severed) and a live overlay of segment outlines + realized links + bind warnings — for humans and AFK agents alike.
- Fixed-end knots (segment 0, the pinned anchor) must realize with **zero gap**: the anchor stays pinned at the rope's spawn point, so the connect flow pulls a movable target to the anchor at tie time (a rigid translate) before realizing the knot. Level-fixed targets are immovable and are excluded; the direct rope API and restore paths tie in place and keep their no-move contract. The pull clamps with the same `clampObjectToPlayfield` placement invariant — a pull must never park the tied target inside a boundary wall, where the knot would accept a residual gap (a gentle settle at play start) instead.

## Related

- ADR 0005 — rope as a connector (superseded in part; see its head note): link realization, token round-trip, welded buckets, and chain rest lengths stand; the connection UX does not.
- ADR 0004 (engine link seam), ADR 0003 (lifecycle + placed restore), ADR 0001 (matrix; type-keyed matchers), ADR 0006 (bug files record knot tokens narratively).
- Fork issues #51 (this record's ticket), #52–#59 (the implementation set it gates); parent roster issue #19; roster issue #25 (future routed pulley, placeholder for the routing ADR).