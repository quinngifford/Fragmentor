# Current Development Status

## Current focus

Projects now have two modes, chosen when they are created along with the granularity and optionally the language. The agent guide is a third of its old length, and the code of blocks with children is generated. Next: animated navigation and block appearance on the canvas, then watching values flow through a running block, with breakpoints.

## Working

- **Two modes, chosen when a project is created.** **New project…** asks what Fragmentor should do with the code (structured or visual), how finely to divide it (required) and optionally the language, and writes those into `fragmentor.json` before any agent starts. The folder can be empty or already hold code; starting a structured project over existing code asks for confirmation and says to commit first. `fragmentor init --mode … --granularity … [--language …]` does the same for an agent.
- **Structured mode.** Typed ports, capability ports that flow down by name, and straight-line plus per-item iteration. The code of a block with children is generated from its wires, so it cannot drift from the diagram; code someone wrote there is reported, never overwritten. The agent writes the leaves and the tests.
- **Visual mode.** The diagram describes existing code. Each block points at the file or function it stands for, such as `src/pricing.ts#priceOrder`, and its types are free text. `fragmentor check` reports pointers that lead nowhere, and treats gaps in the wiring as warnings. The inspector shows the code a block points at; the test bench, saved tests and code generation are hidden. Fragmentor never changes the code.
- **Agent guide.** `FRAGMENTOR.md` is written for the one project it sits in: its mode, its language and its granularity. It is about 150 lines for a structured project and 60 for a visual one, down from 375. Its worked examples are held by test to pass the checks exactly as shown. New projects also get `AGENTS.md` and `CLAUDE.md`, which point at it and are never rewritten.
- **Small block files.** The folder gives a block its id, having children is what makes it a composite, ports and capabilities can be written as just their type, and anything empty can be left out.
- **Packages.** A block may import packages installed in the project; checking and running find them in the project's `node_modules`. Node's built-in modules are refused, because effects go through capabilities.
- **Language packs.** TypeScript is generated, typechecked and run. Python gets contracts and composite code, but is not checked or run.
- **Running blocks and saved tests.** A block runs in a separate process against given values, with substitutes for its capabilities, checked against its contract on both sides. Tests live in `cases.json` beside each block.
- **Desktop application.** Opens a project, draws its diagram and redraws it as the agent works, keeping the view and selection. Problems are listed against their blocks, a half-written file shows a banner over the last good diagram, and unsaved edits warn when the file changes underneath them. Leaf code can be edited; generated code is read-only.
- **The application checks itself.** `npm run check:app` plays an agent against a throwaway project, from the new-project form through a switch to visual mode, and saves screenshots to `dist/self-check*.png`. The command fails if any step fails.

## Not built yet

- Zoom animation between levels, and blocks animating in as the agent creates them.
- Recording the values on wires, watching them flow, and breakpoints.
- Showing code problems in the application. Only `fragmentor check` reports them.
- Running or checking Python code.
- Stale-state propagation, and per-block granularity overrides.

## Known problems or uncertainties

- **Neither mode has been run with a real agent.** Everything an agent does has been exercised by tests and the self-check. Whether an agent follows the shorter guide well is untested, and so is whether it maps an existing codebase faithfully in visual mode or rebuilds one safely in structured mode.
- **Rebuilding existing code is up to the agent.** Fragmentor warns the person and tells the agent to make sure the code is committed, but cannot enforce either.
- **Packages can reach the outside world** without a capability. Only Node's built-in modules are refused.
- **Visual pointers are found by name, not by parsing.** A pointer to a name that only appears in a comment still passes.
- **Python module resolution is unsettled.** Generated Python composites assume a block's folder is on the path and its children are packages beneath it. Nothing runs Python yet, so nothing depends on the answer.
- **The `fragmentor` command needs `npm link` once.** Without it an agent cannot find the command. The guide tells the agent to ask for it.
- **A redraw takes the cursor out of the code editor.** The unsaved text is kept, but the focus and cursor position are not.
- **An edit conflict is warned about, not prevented.** Saving over a file the agent has since changed replaces the agent's change.
- **Reading the clock or randomness directly is not detected.**
- **Wires carry whole port values.** There is no way to take one field out of an object on a wire.
- **The port type language has no recursion**, so it cannot describe its own types.
- **An optional port is not quite the same in both packs.** Python also permits an explicit null.
- **A block cannot appear twice in one parent**, because children are identified by folder.
- No conditional or error-handling vocabulary exists on the diagram. Branching lives inside leaves until an example proves that insufficient.

## Human verification needed

- **Starting a project in both modes.** Run `npm run app`, choose **New project…**, and try each mode in an empty folder and in a folder holding some code. Then open Claude Code or Codex in the folder and ask for a small program (structured) or a diagram of the code (visual). Things to judge: whether the form is clear, whether the agent follows the guide, and whether the diagram keeps up.
- **The application in ordinary use.** Running a block from the test bench; whether dragging, zooming and the code panel feel right.

## Current checkpoint

- The tag `checkpoint/pre-modes` marks `main` as it was before this work, known good. The work is on the branch `modes-and-debugger`, one commit per milestone, each with a passing suite.

## Next major steps

1. Canvas animation: zoom into a block and back out of it, and animate blocks and wires in as the agent creates them.
2. Watching dataflow: record every block call in a run, replay it along the wires, and pause the run at breakpoints.
3. Run both modes with a real agent, and tighten `FRAGMENTOR.md` wherever the agent goes wrong.
4. Show everything `fragmentor check` finds in the application, code problems included.

## Status-file rule

Keep this file as a concise snapshot of current truth.

Do not use it as a chronological development diary. Git already stores history.

Remove or replace stale information instead of endlessly appending updates.
