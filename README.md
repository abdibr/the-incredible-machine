# The Incredible Machine — Web Clone

A browser-based Rube Goldberg puzzle game inspired by the 1993 classic by Jeff Tunnell Productions / Dynamix / Sierra On-Line.

## 🎮 How to Play

Place objects on the board to build a chain-reaction machine that achieves the level goal. Hit **Play** to watch your contraption in action. If it doesn't work, **Reset** and try again!

## 🚀 Quick Start

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Run tests
npm test
```

## 🏗️ Project Structure

```
├── index.html              ← Entry point
├── css/style.css           ← All styling (TIM-classic theme)
├── js/
│   ├── main.js             ← App bootstrap & mode switching
│   ├── EventBus.js         ← Pub/sub event system
│   ├── engine/             ← Physics engine & game loop
│   ├── objects/            ← Game object classes
│   ├── ui/                 ← Toolbox, controls, overlays
│   ├── levels/             ← Level manager & puzzle JSONs
│   └── render/             ← Canvas renderer
└── tests/                  ← Unit tests (Vitest)
```

> **Testing notes:** plain `npm test` — Vitest 4 removed the old `--reporter=basic` flag. On Windows, npm's stderr can surface in PowerShell as `NativeCommandError` noise; `cmd /c npm test` avoids it.

## 🤝 Multi-Agent Development

This project is developed using a two-agent parallel workflow:

- **Agent A** (`agent-a/engine-and-objects`): Physics engine + all 15 game objects
- **Agent B** (`agent-b/ui-and-puzzles`): UI shell, puzzle system, level editor

Both agents branch from `main` (shared scaffold), develop independently, and merge via pull requests.

## 📋 Tech Stack

- **Vite** — Build tool / dev server
- **Matter.js** — 2D physics engine
- **HTML5 Canvas** — Rendering
- **Vanilla JavaScript** — ES Modules, no frameworks
- **Vitest** — Unit testing
