# ADR 0011 - The sandbox posture: goal-less agent sessions on the parts palette

- **Date**: 2026-11-21
- **Status**: Accepted
- **Scope**: the agent session's posture (agent/session.js constructor option) and the level document schema owner's second gate (js/levels/LevelManager.js). No gameplay, engine, goal-checking, watch-page or phase-2 changes; the player bundle's behavior is unchanged - the puzzle path of the shared `_validate` keeps its wordings byte for byte. Tests: tests/agent/session-sandbox-posture.test.js (issue #63).

## Context

Ticket #63: the agent session mirrors the game's Sandbox mode - an ad-hoc, goal-less session where the agent assembles a contraption from the full parts roster and runs it with no goal, therefore no verdicts. Today a session requires a typed goal (every load funnels through `levelManager.validateCustom`, the campaign-loader schema, issue #78) and budgets placements against the level's `availableParts`; a goal-less document cannot pass and there is no budget-less posture.

The game-side precedent is already there: SANDBOX play has no win/lose until a level is loaded (the editor readout is the goal truth), `GoalChecker` is mechanically inert without a goal, and the unauthored sandbox palette (PalettePanel, issue #69) offers the registered roster while a fresh Save writes the default palette - every registered type x `DEFAULT_PALETTE_COUNT` (10). The open design point was WHERE goal-less acceptance lives (a session load option vs a new validation posture) and whether the sandbox is restricted by the palette or unlimited.

## Decision

1. **The posture is the session's birth option**: `new AgentSession({ sandbox: true })`. One private flag governs the whole session lifecycle - the load gate, the placement budget, goal neutrality. It is not a load-time toggle, so a session cannot drift between postures mid-life; the default (`false`, the puzzle posture) is today's behavior to the byte.
2. **Goal-less acceptance is a second gate owned by the schema owner**: `levelManager.validateSandbox(data)`, `validateCustom`'s goal-less sibling, implemented as a `{ sandbox }` posture flag on the shared `_validate`. It relaxes exactly the three puzzle-owning fields for the posture that carries them - the typed goal, the `availableParts` budget and the ADR 0009 solution proof - while `id`, `name` and the `fixedObjects` array stay required, a ride-along goal must still carry its type, and a ride-along `availableParts` map must stay map-shaped. Puzzle documents never travel it: `validateCustom` keeps the typed-goal requirement and every wording byte-identical. The gate lives in the level owner (not the agent layer) so the document schema knowledge stays in one place.
3. **Sandbox runs judge no goal, by posture**: the sandbox session installs no private GoalChecker - no verdict can latch, no `goal:*` event can fire, even when a document carries a goal shape. A sandbox run rides its loop-fact budget to 'timeout' and `distanceToZone()` reads Infinity on a goal-less board; the run facts are the run seam's stream (issue #78) exactly as in the puzzle posture, and the EventRecorder stays free to log real interactions (a bucket catch remains data - it is not a verdict).
4. **The placement budget in the sandbox posture is the parts palette**: every registered type (`objectRegistry`, the roster) at the unauthored sandbox posture's default count - the game's DEFAULT_PALETTE_COUNT of 10, the "every type x10" palette an untweaked sandbox Save writes (issue #69) - minus placed. A sandbox document's `availableParts` is carry-through save data, never the constraint. The never-throw refusal shapes of `place` are unchanged and re-proven in the posture: over-palette keeps the budget-refusal wording and `remaining`, off-playfield keeps the clamp refusal and `clampedTo`, unregistered types refuse `unknown type`. The authored-palette install (a live editor affordance, reset on every SANDBOX entry) is deliberately not part of the session contract.
5. **Sandbox sessions ride the same phase-1 surface**: actions, turns and observations are posture-blind; the headless demo builds a ramp + ball contraption on an empty playfield through the action API and runs it to a result.

## Consequences

- The agent layer gains no validation schema knowledge: the session chooses the gate by posture, the schema owner keeps the schema.
- A valid minimal sandbox document is `{ id, name, fixedObjects }` - an empty playfield needs only an empty board array.
- Puzzle behavior is unchanged by construction: the sandbox branch returns before the puzzle-only checks; the existing suite pins the puzzle path's wordings.
- #64 (sandbox watch) can drive construction and runs over this posture with no new surface; combined with ADR 0010, watching a sandbox build never mutates player state and can never show a win/lose that does not exist - the sandbox posture judges nothing.
- If the game's default palette count ever changes, agent/session.js carries `SANDBOX_PALETTE_COUNT = 10` beside the parity comment; the placement tests pin the count once and flag the follow.

## Related

- ADR 0010 - the watch sidecar's agent-layer import allowance (the sandbox posture is agent-layer only; the sidecar is #64's work).
- ADR 0008 - the fixed-step discipline the sandbox trials step; ADR 0009 - the scene/solution rule this gate deliberately does not apply to sandbox boards.
- Issue #78 - the level-owner bootstrap (validateCustom / loadCustom); issue #69 - the palette panel, the source of the default count.
- Tests: tests/agent/session-sandbox-posture.test.js.
