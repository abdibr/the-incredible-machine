# The Incredible Machine — Web Clone

A browser-based Rube Goldberg puzzle game inspired by the 1993 classic by Jeff Tunnell Productions / Dynamix / Sierra On-Line.

## 🎮 How to Play

Place objects on the board to build a chain-reaction machine that achieves the level goal. Hit **Play** to watch your contraption in action. If it doesn't work, **Reset** and try again!

## 🧩 Custom Levels

The sandbox is also an authoring tool. Place and pin your fixed furniture, set a goal with the editor's Goal readout, and hit **Save Level** to download the level as a JSON file. From the level-select screen, **Import custom level** opens that file as a *player* — the same solving posture a campaign card gives:

- the header shows the level's **name + a plain-language goal line** (🎯),
- fixed furniture is locked (only the pin handle remains; parts you place behave as usual),
- the toolbox is constrained to exactly the parts the level saved (`availableParts`),
- the goal bucket wins the level — a catch in any other bucket, or a wrong object in the goal bucket, changes nothing.

A broken or truncated file is refused with a readable inline error at level select — it is never half-built on the board. (The sandbox's own import stays lenient on purpose: it opens broken saves for repair.)

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
