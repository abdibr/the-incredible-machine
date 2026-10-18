# Work Log — The Incredible Machine (Web Clone)

## 2026-02-23 — Project Kickoff

### Planning
- Researched original TIM game mechanics, visual style, and object catalog
- Researched Matter.js 2D physics engine capabilities (constraints, composites, collision categories)
- Drafted comprehensive implementation plan with multi-agent architecture
- Defined 15 core game objects for v1
- User approved plan with two changes: match original TIM art style, remove grid snapping

### Scaffold Setup
- Initialized Vite project with vanilla JS template
- Installed Matter.js (production) and Vitest (dev)
- Created full project directory structure
- Implemented shared scaffold files on `main`:
  - `index.html` — CSS Grid layout with canvas, toolbox panel, control bar
  - `css/style.css` — Full TIM-inspired theme (beveled borders, classic palette)
  - `js/main.js` — App entry point with mode state machine
  - `js/EventBus.js` — Pub/sub event system for decoupled module communication
  - `js/objects/BaseObject.js` — Shared interface contract for all game objects
  - `js/objects/ObjectRegistry.js` — Central catalog/factory for game objects
- Initialized Git repo, pushed to GitHub
- Created branches: `agent-a/engine-and-objects`, `agent-b/ui-and-puzzles`
- Prepared Agent B task instructions document

## 2026-02-24 — Agent A: Engine & Objects

### Implementation (branch: `agent-a/engine-and-objects`)
- PhysicsEngine: Matter.js wrapper — object lifecycle, collision forwarding, snapshot/restore, boundary walls, hit-testing
- GameLoop: play/pause/reset state machine — speed scaling (1×/2×), capped delta-time, snapshot management
- ObjectRenderer: per-object drawing delegation, selection handles, ghost previews, debug overlays
- 15 game objects (17 registry entries): Ball (3 variants), Ramp, Conveyor, Trampoline, Fan, Spring, Domino, Gear, Pulley, Balloon, Bucket, Candle, Rope, Scissors, Mouse
- registerAllObjects: bootstrap registration across 4 categories
- Unit tests: 22 tests — engine, loop, serialization, registry — all pass ✅

### Verification
- All 22 unit tests pass
- Committed and pushed to `agent-a/engine-and-objects`
- Created PR #2: `agent-a/engine-and-objects` → `main`

## 2026-02-24 — Agent B: UI & Puzzle System

### Implementation (branch: `agent-b/ui-and-puzzles`)
- Created 10 mock objects with TIM-style Canvas 2D drawing (`js/testing/MockObjects.js`)
- Implemented Canvas Renderer with render loop, hit-testing, ghost preview, selection handles (`js/render/Renderer.js`)
- Implemented Play Controls with Play/Pause/Reset/Speed buttons + keyboard shortcuts (`js/ui/PlayControls.js`)
- Implemented Toolbox panel with category grouping, canvas icons, inventory tracking (`js/ui/Toolbox.js`)
- Implemented DragDropManager for freeform drag-and-drop placement, move, rotate, delete (`js/ui/DragDropManager.js`)
- Implemented Level Manager with JSON loading, validation, localStorage progress, level sequencing (`js/levels/LevelManager.js`)
- Implemented Level Select screen with level cards, difficulty stars, lock/unlock state (`js/ui/LevelSelect.js`)
- Implemented Goal Overlay for win/fail states with stats and navigation buttons (`js/ui/GoalOverlay.js`)
- Implemented Editor Panel for sandbox mode with save/load level, goal type, test button (`js/ui/EditorPanel.js`)
- Created 5 starter puzzles: First Steps, Across the Gap, Chain Reaction, Lighter Than Air, Mouse Trap
- Wired all modules into `main.js` with mode transition events and render loop

### Verification
- Vite build: ✅ 16 modules, 0 errors
- Committed 15 files (2845 insertions), pushed to `agent-b/ui-and-puzzles`
- Created PR #1: `agent-b/ui-and-puzzles` → `main`

## 2026-02-24 — Integration

- Merged PR #1 (Agent B) and PR #2 (Agent A) into `main`
- Resolved work-log merge conflict
- Replaced mock objects with `registerAllObjects()` — 15 real game object classes
- Wired `PhysicsEngine` + `GameLoop` into play/pause/reset controls
- Vite build: ✅ 37 modules, 0 errors
- 22 unit tests pass
- Pushed integration commit to `main`

## 2026-10-18 — Repo Hygiene Sweep (issue #3)

- Resolved the truncated conflict block left in this log (`<<<<<<< HEAD` / `=======` markers with no `>>>>>>>` side surviving): both narratives are now kept as one chronological account above (Kickoff → Agent A → Agent B → Integration).
- Encoding sweep via byte-level scan of all tracked files: re-saved `js/engine/GameLoop.js` and `js/engine/PhysicsEngine.js` (UTF-8 BOM + CP437-style mojibake comments: `ΓÇö`→—, `ΓöÇ`→─, `├ù`→×) as clean UTF-8 without BOM; comments now read correctly. Byte scan also found `js/render/ObjectRenderer.js` had a BOM + one mojibake em-dash — fixed the same way. Comments only; no code lines changed.
- Removed dead `js/testing/MockObjects.js` (754 lines; `registerMockObjects()` never called, zero imports, zero events emitted — superseded by real `registerAllObjects()` during integration).
- README: removed the non-existent `audio/` folder from the project tree (no sound system in the repo), added `tests/`, and documented test-running notes: plain `npm test` (Vitest 4 removed `--reporter=basic`), and prefer `cmd /c npm test` on Windows to avoid PowerShell `NativeCommandError` stderr noise.
- Regression: `npm test` green before and after all edits — 22 passed.

