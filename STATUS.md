# Current Development Status

## Current focus

Projects have two modes, chosen when they are created along with the granularity and optionally the language. The agent guide is a third of its old length and the code of blocks with children is generated. The canvas zooms between diagrams and brings in blocks as the agent writes them, and a run can be watched on the diagram and paused at breakpoints. The inspector has been rebuilt to read as a ladder, with coloured code and an edge that can be dragged. Next: running both modes with a real agent.

## Working

- **Two modes, chosen when a project is created.** **New project…** asks what Fragmentor should do with the code (structured or visual), how finely to divide it (required) and optionally the language, and writes those into `fragmentor.json` before any agent starts. The folder can be empty or already hold code; starting a structured project over existing code asks for confirmation and says to commit first. `fragmentor init --mode … --granularity … [--language …]` does the same for an agent.
- **Structured mode.** Typed ports, capability ports that flow down by name, and straight-line plus per-item iteration. The code of a block with children is generated from its wires, so it cannot drift from the diagram; code someone wrote there is reported, never overwritten. The agent writes the leaves and the tests.
- **Visual mode.** The diagram describes existing code. Each block points at the file or function it stands for, such as `src/pricing.ts#priceOrder`, and its types are free text. `fragmentor check` reports pointers that lead nowhere, and treats gaps in the wiring as warnings. The inspector shows the code a block points at; the test bench, saved tests, code generation and breakpoints are hidden. Fragmentor never changes or runs the code.
- **Agent guide.** `FRAGMENTOR.md` is written for the one project it sits in: its mode, its language and its granularity. It is about 150 lines for a structured project and 60 for a visual one, down from 375. Its worked examples are held by test to pass the checks exactly as shown. New projects also get `AGENTS.md` and `CLAUDE.md`, which point at it and are never rewritten.
- **Small block files.** The folder gives a block its id, having children is what makes it a composite, ports and capabilities can be written as just their type, and anything empty can be left out.
- **Packages.** A block may import packages installed in the project; checking and running find them in the project's `node_modules`. Node's built-in modules are refused, because effects go through capabilities.
- **Language packs.** TypeScript is generated, typechecked and run. Python gets contracts and composite code, but is not checked or run.
- **Running blocks and saved tests.** A block runs in a separate process against given values, with substitutes for its capabilities, checked against its contract on both sides. Tests live in `cases.json` beside each block.
- **Watching a run.** Every run from the test bench is played back on the diagram at a pace a person can follow: blocks light up as they run, data pulses along the wires into them, and each wire keeps the value it carried, with the full value in the inspector. A composite is watched from inside. A block run once per item shows how many of its calls are done, and the inspector steps between them. Clicking the dot beside a block's name, or ticking the box in the inspector, sets a breakpoint: the run stops before that block with what reached it on show, and **Continue**, **Step** and **Stop** steer it. Time spent paused counts neither against the time limit nor in the run's duration. While the run is held, the wires that are carrying a value go on flowing, so a paused diagram still shows where the data is. The canvas waits for the run to settle before it goes to where the run is held, because letting one held call go hands the breakpoint to the next in the queue for a moment. Saved tests can be watched too.
- **Desktop application.** Opens a project, draws its diagram and redraws it as the agent works, keeping the view and selection. Problems are listed against their blocks, a half-written file shows a banner over the last good diagram, and unsaved edits warn when the file changes underneath them. Leaf code can be edited; generated code is read-only. **Close project** puts it away and shows the start screen again.
- **The inspector.** It reads as a ladder: the block, the areas it is divided into — what it promises, its code, its tests — then the sections in each area, then the named parts of a section. Each rung is smaller and quieter than the one above it. Code is coloured, whether it is being read or typed in, by a scanner that knows TypeScript, Python and JSON. The edge between the diagram and the inspector can be dragged to make room for code, and how wide it was left is remembered.
- **Canvas motion.** Opening a block zooms into it until its own diagram takes over, and going back up zooms out of it into the diagram around it; unrelated jumps fade. Blocks and buses the agent adds are brought in one after another, and new blocks flash in the hierarchy. Opening a project animates nothing, and the system's reduced-motion setting turns it all off.
- **The application checks itself.** `npm run check:app` plays an agent against a throwaway project: the new-project form, the agent's first system arriving, a block added while the person watches, zooming into a block, a run paused at a breakpoint and stepped and continued to the end, the inspector dragged wider, the project closed again, a switch to visual mode, and the older checks. Anything the window logs as an error fails the check. It saves screenshots to `dist/self-check*.png`, and the command fails if any step fails.

## Not built yet

- Showing code problems in the application. Only `fragmentor check` reports them.
- Running or checking Python code.
- Stale-state propagation, and per-block granularity overrides.

## Known problems or uncertainties

- **Neither mode has been run with a real agent.** Everything an agent does has been exercised by tests and the self-check. Whether an agent follows the shorter guide well is untested, and so is whether it maps an existing codebase faithfully in visual mode or rebuilds one safely in structured mode.
- **Rebuilding existing code is up to the agent.** Fragmentor warns the person and tells the agent to make sure the code is committed, but cannot enforce either.
- **Packages can reach the outside world** without a capability. Only Node's built-in modules are refused.
- **Visual pointers are found by name, not by parsing.** A pointer to a name that only appears in a comment still passes.
- **Watching has limits.** A run records its first 2000 block calls, and a value larger than about 200 KB is described rather than shown. Breakpoints last until the project is closed; they are not saved with it.
- **Held calls take turns.** When several calls are held at once, as with a block run once per item, Continue lets go of one at a time while the breakpoint stays set; taking the breakpoint away lets the rest go too. Step goes into the call it lets go.
- **Code colouring is scanned, not parsed.** A quote inside a regular expression is read as the start of a string, which spoils the colours on that line and no further. Nothing depends on the colours being right.
- **Inside a block run more than once, the call shown is chosen per diagram.** Choosing a call of a block does not choose the matching calls of the blocks inside it, which start from their first call.
- **A value on a very short wire can sit partly under the block it feeds.**
- **Python module resolution is unsettled.** Generated Python composites assume a block's folder is on the path and its children are packages beneath it. Nothing runs Python yet, so nothing depends on the answer.
- **The animations are checked for happening, not for how they look.** The self-check confirms that moves, arrivals, pauses and wire values happen; whether they feel right needs a person.
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
- **How the canvas moves.** Double-click into blocks and use the breadcrumbs to come back out, and watch blocks arrive while an agent works. Things to judge: whether the zoom reads as going inside a block, and whether arrivals help or distract.
- **Watching and pausing a run.** In the Job Relevance Ranker example, run `rank-jobs` from the test bench, then set a breakpoint on Score Posting and run it again. Things to judge: whether the pace is right, whether the values on the wires are readable, whether Continue and Step do what you expect, and whether the flow on the held wires helps or distracts.
- **Reading the inspector.** Select a leaf block and read down the panel. Things to judge: whether it is obvious what sits under what, whether the code colours are right for this panel, and how wide the inspector wants to be.

## Current checkpoint

- `main`, with the two modes, the canvas animation and watching runs merged from `modes-and-debugger`, and the inspector rebuilt on top. The tag `checkpoint/pre-modes` marks `main` as it was before the modes work, and `checkpoint/pre-inspector-ui` as it was before the inspector work.
- One test has been failing since before this work: `check.test.ts` > "puts back a composite that someone edited" compares generated code against a file this checkout has in CRLF. It is a line-ending artifact of the working copy, not a fault in the code.

## Next major steps

1. Run both modes with a real agent, and tighten `FRAGMENTOR.md` wherever the agent goes wrong.
2. Show everything `fragmentor check` finds in the application, code problems included.
3. Decide how Python blocks are laid out as modules, so they can be run and watched.

## Status-file rule

Keep this file as a concise snapshot of current truth.

Do not use it as a chronological development diary. Git already stores history.

Remove or replace stale information instead of endlessly appending updates.
