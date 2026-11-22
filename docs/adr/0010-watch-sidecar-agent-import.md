# ADR 0010 - The watch sidecar may import the agent layer; the game bundle still may not

- **Date**: 2026-11-21
- **Status**: Accepted
- **Scope**: browser entry points and the import rule between them (`watch.html` + `js/watch/` vs `index.html` + `js/main.js`), and the level-loading plumbing of `agent/session.js`. No gameplay, engine, recorder, editor or progress behavior changes; the player bundle is untouched. Tests: `tests/watch/` (issue #62).

## Context

The phase-1 charter (docs/plans/agent-play-interface-phase-1.md) and the in-flight phase-2 rule pinned: "the browser bundle stays untouched - nothing in the web app imports the agent layer" (recorded in the phase-2 tracking charter and in code comments, e.g. agent/rng.js). The rule defended the game's production bundle from agent-layer weight and from reversed dependencies.

Watch mode (watch tracking charter, issue #60) breaks it on purpose: the only way a human can watch the agent drive the game is a browser page running the same headless `AgentSession`, unwrapped over time. The phase-1 surface - observations, the never-throw action API, the solver, the event rows, and (since #61) the steppable trial - is exactly the watch page's driving contract; no new surface was added for watching. The boundary is therefore amended for one site only, and the amendment is recorded here as the decision (it previously lived only in scratch charters and comments).

## Decision

1. The watch sidecar site (`watch.html` -> `js/watch/`) may import the agent layer: `agent/session.js`, `agent/solver.js`, `agent/actions.js`, and the `agent/observe/*` presentation helpers.
2. The game bundle still may not: nothing reachable from `index.html` -> `js/main.js` - equivalently, no module under `js/` outside `js/watch/` - may import `agent/`, and nothing may import the watch code. The agent-layer one-way rule stands: `agent/` may read production modules; production modules never read agent or watch paths in their import graph.
3. Watching never mutates player state: a watched run latches nothing but the session's own verdict - it writes no progress marks. A watched win marks no completion: the sidecar never runs levelManager.init(), the arm of the goal:reached -> markComplete progress mark hook (the only progress-mark site), never constructs a SessionRecorder, and never opens an editor or palette panel; the sidecar reuses none of those components. Its canvas renderer is a fresh Renderer class instance on the watch page's own canvas; the game's canvas and its renderer singleton are untouched.
4. Watched trials are the same deterministic trials the all-at-once trial judges: the sidecar drives the phase-1 surface only - placements through the action API, trials through the steppable seam (#61 beginTrial/advanceTrial/finalizeTrial) in bounded, wall-clock-paced advance batches (ADR 0008's accumulator discipline), so the page never blocks for a whole trial; solver searches ride the steppable solve facade (`solveTrials`, one judged candidate per scheduled tick), of which `solve()` is the composition.
5. The AgentSession fs level loader stays Node-only: `loadLevel(id)` refuses with a readable error in a browser. The watch sidecar fetches the served level JSON itself (the same URL the campaign loader pulls) and calls `loadLevel` with the parsed level data object. The session constructor reads the seed environment only where a `process` exists; browser sessions are unseeded, and physics determinism keeps the watched trials the trials trial() judges.

## Consequences

- Second browser entry: `vite.config.js` `build.rollupOptions.input` lists `index.html` and `watch.html`; the dev server serves `/watch.html`; the production build emits both entries. The game bundle's import graph is unchanged (pinned by import-graph scans in tests/watch/boundary.test.js).
- A browser page can now load `agent/` modules: the layer's only node builtin reference is the fs level loader's lazy dynamic import, which never executes on the watch path.
- Player progress, bug files and editor state are unreachable from a watched run by construction: the level manager's progress hook is never armed in the sidecar, and the recorder/editor components are never constructed there.
- Known-broken mechanics stay data: a solver that cannot win (level-04 remains the deliberate clean-failure case) ends the page cycle with its diagnosis - reported, not fixed.

## Related

- The phase-2 turn-service rule ("nothing in the web app imports the agent layer") is superseded for the watch sidecar only; the game bundle rule stands.
- ADR 0008 - the fixed-timestep pacing discipline the watch batches mirror; ADR 0006 - the recorder, untouched by watching; #61 - the steppable trial seam, the watch page's stepping surface.
- Tests: `tests/watch/boundary.test.js` (the decision, the entries, the import graph, the player-state posture, the Node-only loader), `tests/watch/watch-flow.test.js`, `tests/watch/solver-stepping.test.js`.

