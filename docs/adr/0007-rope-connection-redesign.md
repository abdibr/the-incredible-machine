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

## Amendment (2026-11-01) — span-derived counts, tie seats, and the pinned freeze (issue #56)

Builds decisions 3 and 4 out without reopening them, but three points narrow what the decisions literally say. Recorded here because the code now depends on them.

1. **The count rule is bounded and per-family at the tie (§ decision 3, "applies to both types").** `Rope.segmentsForSpan(span)` is the count rule — ~40 px per segment (`SEGMENT_DENSITY_PX`), floored at `SEGMENTS` (6, the classic fresh drop) and capped at `MAX_SEGMENTS` (16), invalid spans answering the floor — and it governs birth, every re-lay and the hand's re-span. What decision 3 leaves open is a **tie** that needs more reach on an already-authored chain: a pinned rope's tie-grow freezes the count and grows only the span (a tie may lengthen the rope, never reshape the level's chain, so the end seat stays the end seat), while a free rope's tie-grow re-derives it (its span *is* its chain). So the span-derived count applies to both types at birth, re-lay and hand; at the tie-grow seam the pinned family is the documented exception.
2. **The last link's rest length is 1.5 pitches when the tail is appended (§ ADR 0005 decision 12).** ADR 0005 made every chain link's rest length equal its laid spacing, which holds for a centre-laid chain. An appended tail body lands *on* the end point (a re-lay that grew has to reach the point it was given), so its link is half a pitch longer than a centre-laid seat would be; keeping the spacing there would over-stretch the chain and snap the tail back inboard on the first step. The invariant therefore reads: rest lengths equal laid distances — centre-laid seats keep the spacing, an appended tail keeps its laid distance.
3. **A free rope's seek stays armed after a tie (§ decision 2, "the tie ends the seek").** "Multiple sequential ties keep all earlier knots intact" (issue #56's acceptance criterion) requires it: a free rope's span is the aim's property, so every later target ties as far as anything on the board and the flow must not close after the first knot. A pinned rope keeps decision 2 exactly — its tie ends the seek at a settled state. The reach gate follows the same split: `isPointWithinReach` answers `true` unconditionally for the free family and holds the end seat's `(count − 0.5)/count` of the span for the pinned one.

Vocabulary this amendment fixes, now in `GLOSSARY.md`: **seat**, **tie-grow**, **re-lay**, **span-derived count**, **authored span**, **persisted chain count (`options.segments`)**, **length freeze**.

Test surface at amendment time: `tests/rope-span.test.js` (count rule, re-lay tail trades, the frozen re-lay, the persisted count vs a re-root) and `tests/rope-ties.test.js` (seat addresses, several knots per seat, per-target pruning) are the executable contract. Full suite: 53 files / 601 tests, all green.

## Amendment (2026-11-13) — reach follows the seat (issue #86)

Narrows § decision 4 and the previous amendment's point 3: with named tie seats answering (#84, #85), the pinned rope's beyond-reach refusal gates **per seat** — a chain seat's tie click is measured against that seat's own covering circle `seatFraction(seat, count)` of the frozen length (the end seat's circle is the chain capacity, so its number is unchanged; a mid tie beyond the mid seat's reach is refused outright instead of tying and demanding a large grow). Two provisos survive unchanged from § decision 4: the aim-tolerance slack past a seat's circle still reaches — the tie it allows **grows the span just enough for the chain to rest under that seat** (`attachEndpoint`'s per-seat covering grow), and never shrinks the rope; and the **anchor seat** keeps the whole-rope capacity circle, because its knot realizes at the anchor itself and consumes no chain. The free family still refuses nothing at any distance. The gate lives in `Rope.isPointWithinReach(x, y, slack, segment)`; the connect flow passes the seeking seat at its tie gate and its glow, so what glows is exactly what ties.

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
## Amendment (2026-11-13) — tokens name their seats by role (issue #88)

Narrows § decision 6 (the previous amendment already re-seated live knots by role through `_keepSeats`, issue #87; this amendment gives the SAVED token the same count-independence): a placed rope's saved knots record their seat as the role it plays — the **seat token** `{ seat: 'anchor'|'mid'|'end', targetType, targetOrdinal, pointId }` — the role read at save time through the rope's own `getTieSeats()` answer, and restoring re-binds each knot to the same seat of the restored chain whatever that chain's count (a mid token onto a 12-chain is the 12-chain's middle). A knot on a seat no named seat covers (the segment-index API's ties) is not silently re-seated at save: it keeps the legacy numeric token and migrates at bind.

Legacy boards keep loading: `segment` (issue #56) and `endpoint` (issue 04) tokens migrate in `Rope._migrateTieToken` — anchor → anchor, restored chain's end → end, any other seat → the nearest of the three named seats by span position (`nearestNamedSeat`; exact integer distance arithmetic, ties anchor-ward) — each with a warning, nothing throws; a seat-role name on a rope that restored without a chain (a free bundle) drops with a warning and the rest of the board restores. Save → load → save is idempotent: the migrated state re-saves as named seats and warns no more.

The live surface is unchanged: refs stay segment-indexed, `attachEndpoint`/`detachEndpoint` tie through indices, the build-trace narration stays narrative (issue #56 amendment's proviso). The `targetOrdinal` two-phase bind is untouched.

Test surface at amendment time: `tests/rope-seat-tokens.test.js` is the executable contract (save naming, count-independent restore, legacy migration + idempotence, the chain-less drop); token-shape asserts in `tests/connector-reset.test.js`, `tests/rope-ties.test.js`, `tests/free-rope.test.js`, `tests/connect-flow.test.js` and `tests/recorder.test.js` follow the schema. Full suite: 58 files / 642 tests, all green.

## Amendment (2026-11-13) — the count is the span's rule at every seam (issue #89)

Retires the previous amendment's point 1 rider: the tie-grow seam is no longer an exception, and the persisted chain count is gone with it. The visible consequence, accepted deliberately: **a pinned rope's tie-grown chain is re-derived from its span on load rather than replayed frozen**.

- **One covering rule.** A tie-grow's covering re-lay re-derives the count from the grown span for BOTH families — `Rope.setEndpoints` has one mode (the `resegment: false` frozen variant is retired), and `Rope.segmentsForSpan(span)` is the count rule at every seam: birth (ctor/`_layChainFrom`), re-lay, tie-grow and restore alike. Because the seats re-seat by role (#87), knots land on their seats through any re-count, so the frozen count's reason (stable seat indices) is gone.
- **No chain count on the row.** `Rope.serialize` writes `length`, `lengthFrozen`, `endPoint` and `severed` — never a `segments` key — and `Rope.deserialize`/`FreeRope.deserialize` pass no count. A restore re-derives the chain from the span; save → load → save is idempotent by arithmetic (the knot tokens re-bind at the re-derived chain's own role seats and the covering gate re-derives the same fraction, so it cannot fire again per cycle). A pre-#89 row's stale `segments` key still loads — it is simply ignored.
- **Where the pinned/free split still earns itself:** the **length freeze** (a pinned rope's first tie freezes the span; `relayFreeEnd` re-orients on the frozen circle only) and the **reach refusal** (`isPointWithinReach` gates the pinned family per seat, answers `true` unconditionally for the free family). The counting is not part of the split any more.

Test surface at amendment time: `tests/rope-span.test.js` (the one-mode re-lay, the one covering rule, the row without a chain count, the stale-count row, the re-root) and `tests/pinned-rope-length.test.js` (the freeze holds the span, not the count) carry the rule; `tests/rope-seat-keeps.test.js` and `tests/rope-seat-tokens.test.js` pin the round-trips. Full suite: 58 files / 645 tests, all green.
## Amendment (2026-11-13) — segment indices are no longer seats (issue #90)

Supersedes § decision 6's addressing (the previous amendments layered the roles on top; this one removes the index beneath them): a knot is addressed by its seat ROLE and nothing else. `Rope.attachEndpoint`/`Rope.detachEndpoint`/`Rope.isPointWithinReach` take `'anchor' | 'mid' | 'end'` — an unknown seat name is refused with a clear error; live refs carry their seat; `getTieSeats()` answers role/body/worldPoint/reach and no seat index; the tie-token schema is the role form only, and the connect flow's seek is a role (`{ rope, role }`), so a tie-grow's re-count can no longer strand a seek on a stale index.

Deleted with the surface: `Rope.validSegment` (the −1…MAX_SEGMENTS−1 schema range), `seatFraction`'s index arithmetic (the arithmetic is role-keyed), the legacy numeric token migration (`_migrateTieToken`'s `segment`/`endpoint` forms — each refuses at bind with a clear warning, nothing throws), and `_keepSeats` (issue #87's re-seating pass, whose whole job was keeping literal indices on their roles — roles keep themselves by resolution). **Two knots cannot share a seat through the API or through a restore**: the per-seat gate (issue #85) is the only counting rule, and a seat can only ever be named three ways.

Consequences, accepted deliberately: boards and bug files saved before #90 lose their rope knots at load (warned per token, the rest of the board restores — re-tie and re-save); the bug-file download schema bumps to v3 (`js/recorder/schema.js`).

Test surface at amendment time: `tests/rope-seats.test.js` (the three-seat answer), `tests/rope-ties.test.js` (the role gate, one knot per seat, realization), `tests/rope-seat-tokens.test.js` (role tokens; numeric/garbage refusals) and `tests/rope-seat-keeps.test.js` (roles keep themselves across re-counts) are the executable contract; the schema-following suites (`connect-flow`, `rope-span`, `pinned-rope-length`, `free-rope`, `rope-connector`, `connector-reset`, `recorder`) were rewritten to roles. Full suite: 58 files / 644 tests, all green.

## Amendment (2026-11-13) — rope-to-rope knots (issue #57)

Builds § decision 6's rope-to-rope half as its own ticket slice (the ticket's own
acceptance criteria are the narrowing authority): **a rope's endpoint bodies are
attachment points** — `Rope.attachmentPoints` answers `anchor` (the pinned nail, or
a spawned free chain's moving knot) and `end` (the tail), offset 0, named by the
seat roles the bodies bear, so a rope's endpoint squares are valid seek targets and
clicking one from any rope's seeking square knots rope-to-rope through the same
connect flow, the same reconcile and the same seated ordinal token bind. The mid
seat stays seat-square-only (not a target) — the endpoint squares are the scope.
A bodyless free bundle answers no points: its coil square remains a seek entry for
its own ties (the bundle never accepts an incoming knot — no body to bear a link).

Four policies ride along:

- **The reconcile's desired set names its inbound pairs** (issue #57): each rope's
  per-step desired set also includes the pairs other live ropes' knots tie into its
  attachment points (`{its seat body, the bearer body here}`). Without it, the
  stale-link scan that releases a rope's own former links would read an incoming
  knot at one of its bodies as a stale link and kill it every step — the inbound
  pair stands while the holder's ref lives (untie, dispose, engine removal and
  severing all stop the counting at their own gates) and dies with it. Same
  unordered pair either way, so whichever rope reconciles first realizes the link
  once (the exists check) and the holder's untie is what drops it.
- **A severed rope holds no knots from either side** (the pre-piece-severing
  policy, made symmetric by the tie direction). `attachEndpoint` refuses a severed
  rope-family target; the connect flow offers no target squares for one; the
  reconcile prunes into-knots whose target is severed. The sever consumer
  co-terminates the engine links; the prune kills the refs that would re-realize
  them — nothing dangles. Rewinds do not resurrect a pruned knot (the same
  accepted shape as the popped-balloon prune).
- **Rope targets are exempt from the anchor-seat tie pull** — a rope endpoint is
  structure, not a payload: no nail relocation, no whole-chain drag onto the pin.
  The knot lands in place and settles the residual gap at play, the same policy as
  immovable targets. The target side keeps the attachment-point rule — one point
  serves every rope that ties it; one knot per seat stays the seeking rope's gate.
- **The two-phase bind gained a retry** (`bindPlacedTokens` in
  `js/reset/levelReset.js`, mirrored by the replay board builder): a token whose
  target rope has laid no chain at bind time defers instead of dropping, because
  the target free rope can birth its chain during its own anchor token's bind pass
  (issue #55) a board position after the caller's. Passes repeat while tokens keep
  landing (at most one pass per binder), then one strict pass drops leftovers with
  warnings — nothing stays pending, nothing arrives silently. A plain
  `bindAttachment(board)` call is strict exactly as before.

Glossary terms: **Rope as a tie target**, **Severed-target refusal**,
**Bind-order deferral**. Test surface at amendment time: `tests/rope-to-rope.test.js`
(the offering, the click flow, the realization, the snapshot seam, the sever
policy — 17 tests) is the executable contract; `tests/connect-flow.test.js` and
`tests/rope-ties.test.js` follow the additive target-square reality. Full suite:
59 files / 662 tests, all green.

## Amendment (2026-11-21) - tie compliance under sustained load (issue #102)

The knot link's realize values are kept, with the measured bound recorded - a
decision with a number, not a tuning change. The length-0 knot link realizes at
`stiffness 0.9` against the chain's `0.8` links, and raising the pin toward
rigidity re-introduces the solver instability those values were chosen for; some
compliance is what keeps the settle stable. What ticket #102 recorded as visible
drift (a mid seat resting 77.3px from its rim knot after the probe's 230-beat
settle, a dynamic bucket dragging the chain) was measured before issue #98's
re-seat landed; at this amendment's tip the covering re-lay and the re-seat put
the seat onto its knot at tie time (issue #87's ride, issue #98's lay), and the
settled read of the probe scenario verbatim (the covered mid tie grows the span
to ~746, then 230 beats at 60Hz) is the tight story:

- **Static targets settle at ~0.4px** seat-to-knot (the scenario's payload
  bucket held fixed; ~0.4px measured, never above ~0.5px in the late window).
- **A heavy payload dragged under sustained load settles at ~0.25px** (the
  falling bucket carried through the settle; no sampled beat above ~1.4px).

The recorded bound is the ceiling, deliberately loose: **the probe scenario's
settled seat-to-knot distance stays at or under 80px** - pinned by
`tests/rope-tie-compliance.test.js` (both halves above) so a future tuning
change cannot silently worsen the drift; softening or stiffening the knot link
reopens this amendment deliberately, with a new stability measurement, never by
edit.

Test surface at amendment time: `tests/rope-tie-compliance.test.js` is the
executable contract (the sustained-load ceiling, the static settle budget). Full
suite: 76 files / 862 tests, all green.
