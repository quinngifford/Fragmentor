# Current Development Status

## Current focus

A diagram can now hold the whole system, not only its functions. A block carries a role, so a database, a queue, a service, someone else's API or the browser that starts a request is drawn as the thing it is, with its tables or operations on show, and the blocks that reach it are joined straight to it. Colour says which world a thing belongs to, dashed means not built yet and nothing else, and stores sit under what reaches them rather than further along it. Underneath, planned architecture, the two modes, the generated composite code, the zooming canvas, watched runs with breakpoints and the rebuilt inspector are all in place. Next: running both modes with a real agent.

## Working

- **The rest of the system.** A block has a `role`. `function` is what a block has always been; `service`, `external`, `database`, `storage`, `queue` and `client` are architecture — parts of the system Fragmentor does not write. An architecture block has no ports and no capabilities; it says what it offers with `exposes`, each entry a table with its schema, a channel with its message, or an operation with what it accepts and returns. Any block says what it reaches with `access`, as in `"reads app-db.users"`, declared on the block doing the reaching and resolved by looking outward to the top of the system, so a handler inside a service reaches a database the service keeps beside it. On the canvas a resource carries its entries down its middle, and an access is a line whose arrow points the way the data moves; access is gathered from everything inside a block, so the level above a service shows what its handlers depend on without the service repeating it, and a resource that lives further out is brought in and marked `elsewhere`. Nothing is generated, checked or run for architecture, nor for a block holding it, exactly as for a plan — the blocks inside a service stay ordinary blocks and are generated, checked and tested as before. `examples/link-shortener` is a whole application drawn this way.

- **One colour vocabulary, and an arrangement that means something.** Hue says which world a thing belongs to, from what is most yours to what is least: green for your code, violet for your own separate programs, blue for the data you keep, cyan for data in motion, amber for the people you serve, coral for the services you do not control. Buses are a family of greens, so anything green is data moving inside the program and anything else is not; red stays what it always was, the colour of something being wrong. Dashed means not built yet and nothing else, so everything planned is grey and dashed at both ends of the line. A diagram reads left to right from whoever sets the system going through what they call, while stores and queues sit underneath what reaches them, joined by a clockwise loop out of the right and back into the left. Access is drawn per direction, so a database that is read and written has a line each way.

- **Two ways of reading a diagram, to be compared.** The bar under the canvas carries them. **Colour** is by kind — the vocabulary above, with a legend naming only the kinds actually on screen — or by block, which gives every block a colour of its own and paints what leaves it to match; easier to follow along one wire, and it says nothing about what anything is. **Stores** decides which diagram a database or a queue is drawn on: *where kept*, on the level it belongs to, leaving the diagrams under it to their own functions; *every level*, brought into each of them so none hides where its data comes from; or *where used*, beside the block that truly touches it and nowhere else. Both settings stay in the browser profile, not in the project. *Where kept* and *by kind* are the defaults.

- **A question tree when a project is created.** **New project…** asks where you are starting from (an empty folder or code you already have), what Fragmentor's role should be over that code, whether to plan the architecture before building it, how finely to divide the work, and optionally the language. Each answer reveals the next, so a question that does not apply is never asked; plan-first is only offered where there is nothing there yet. The answers go into `fragmentor.json` as `mode`, `existingCode` and `start` before any agent starts. Starting a structured project over existing code asks for confirmation and says to commit first, and answers that disagree with the folder that was picked are pointed out rather than silently kept. `fragmentor init --mode … --granularity … [--language …] [--existing-code] [--start plan|build]` does the same for an agent.

- **Planned architecture.** A block with `"planned": true` is part of the plan rather than of the program: drawn greyed out with a dashed edge and a `PLANNED` label, its wires dimmed, its port types written as words such as `"the ranked postings"`, and its wiring as incomplete as the plan is. Nothing about one is an error, and Fragmentor generates, checks and runs nothing for it. Planning spreads downward; a block holding a plan beneath it keeps its contract but has its code held back, and `fragmentor check` counts both apart from unfinished work. Taking the flag off restores the contract, the starting file and the parent's generated code. Code Fragmentor wrote for a block that is now planned is taken away; code someone else wrote is reported, never deleted.
- **Structured mode.** Typed ports, capability ports that flow down by name, and straight-line plus per-item iteration. The code of a block with children is generated from its wires, so it cannot drift from the diagram; code someone wrote there is reported, never overwritten. The agent writes the leaves and the tests.
- **Visual mode.** The diagram describes existing code. Each block points at the file or function it stands for, such as `src/pricing.ts#priceOrder`, and its types are free text. `fragmentor check` reports pointers that lead nowhere, and treats gaps in the wiring as warnings. The inspector shows the code a block points at; the test bench, saved tests, code generation and breakpoints are hidden. Fragmentor never changes or runs the code.
- **Agent guide.** `FRAGMENTOR.md` is written for the one project it sits in: its mode, its language, its granularity, where it started and whether it starts as a plan. Instead of an `if this folder already had code` paragraph it states which case this project is in, and a plan-first project is told to draw every block planned and wait for agreement. It is about 150 lines for a structured project and 60 for a visual one, down from 375. Its worked examples are held by test to pass the checks exactly as shown. New projects also get `AGENTS.md` and `CLAUDE.md`, which point at it and are never rewritten.
- **Small block files.** The folder gives a block its id, having children is what makes it a composite, ports and capabilities can be written as just their type, and anything empty can be left out.
- **Packages.** A block may import packages installed in the project; checking and running find them in the project's `node_modules`. Node's built-in modules are refused, because effects go through capabilities.
- **Language packs.** TypeScript is generated, typechecked and run. Python gets contracts and composite code, but is not checked or run.
- **Running blocks and saved tests.** A block runs in a separate process against given values, with substitutes for its capabilities, checked against its contract on both sides. Tests live in `cases.json` beside each block.
- **Watching a run.** Every run from the test bench is played back on the diagram at a pace a person can follow: blocks light up as they run, data pulses along the wires into them, and each wire keeps the value it carried, with the full value in the inspector. A composite is watched from inside. A block run once per item shows how many of its calls are done, and the inspector steps between them. Clicking the dot beside a block's name, or ticking the box in the inspector, sets a breakpoint: the run stops before that block with what reached it on show, and **Continue**, **Step** and **Stop** steer it. A block run once per item is called for every item at once and every call is held, so **Continue all** lets the whole block through rather than one call at a time. Time spent paused counts neither against the time limit nor in the run's duration. While the run is held, the wires that are carrying a value go on flowing, so a paused diagram still shows where the data is. The canvas waits for the run to settle before it goes to where the run is held, because letting one held call go hands the breakpoint to the next in the queue for a moment. Saved tests can be watched too.
- **Desktop application.** Opens a project, draws its diagram and redraws it as the agent works, keeping the view and selection. Problems are listed against their blocks, a half-written file shows a banner over the last good diagram, and unsaved edits warn when the file changes underneath them. Leaf code can be edited; generated code is read-only. **Close project** puts it away and shows the start screen again.
- **The inspector.** It reads as a ladder: the block, the areas it is divided into — what it promises, its code, its tests — then the sections in each area, then the named parts of a section. Each rung is smaller and quieter than the one above it. Code is coloured, whether it is being read or typed in, by a scanner that knows TypeScript, Python and JSON. The edge between the diagram and the inspector can be dragged to make room for code, and how wide it was left is remembered.
- **Canvas motion.** Opening a block zooms into it until its own diagram takes over, and going back up zooms out of it into the diagram around it; unrelated jumps fade. Blocks and buses the agent adds are brought in one after another, and new blocks flash in the hierarchy. Opening a project animates nothing, and the system's reduced-motion setting turns it all off.
- **The application checks itself.** `npm run check:app` plays an agent against a throwaway project: the new-project form, the agent's first system arriving, a block added while the person watches, zooming into a block, a run paused at a breakpoint and stepped, let through a whole block and continued to the end, the inspector dragged wider, the project closed again, a switch to visual mode, a planned block drawn apart from the built ones, and the older checks. Anything the window logs as an error fails the check. It saves screenshots to `dist/self-check*.png`, and the command fails if any step fails.

## Not built yet

- No capability reaches a database, so in structured mode an `access` records where data comes from without being how the code gets it.
- Showing code problems in the application. Only `fragmentor check` reports them.
- Running or checking Python code.
- Stale-state propagation, and per-block granularity overrides.

## Known problems or uncertainties

- **Neither mode has been run with a real agent.** Everything an agent does has been exercised by tests and the self-check. Whether an agent follows the shorter guide well is untested, and so is whether it maps an existing codebase faithfully in visual mode or rebuilds one safely in structured mode.
- **A role is the agent's to write**, as `planned` is. There is no control in the application for making a block a database or taking the role off again.
- **`access` describes, it does not connect.** In structured mode a block's code still reaches the world only through its capabilities, and the catalogue has none for a database. So an access belongs on whichever block really talks to the store: a service, whose code lives outside `blocks/`, or a block with a capability that reaches it. Nothing enforces that.
- **An exposed type that will not parse is kept as words**, without a word said. That is deliberate — a database column is often a type the port language has never heard of — but it means a typo in a schema is shown rather than reported.
- **A composite holding architecture has its wiring checked more loosely.** With no code to generate, an input nothing is wired to is a warning rather than an error, and inside a service it is not remarked on at all, because the framework calls those blocks from outside. Two wires into one input is still reported wherever it happens. A genuine gap in that wiring is therefore quieter than elsewhere.
- **A folder nobody declared can relax its parent's checks.** A stray folder holding a block with a role counts towards "architecture sits beneath this", as a stray planned block already did. The undeclared folder is itself an error, so such a project fails anyway.
- **Access is drawn on the parent's diagram only.** A block's own diagram does not show what it reaches; the level above it does.

- **Planned blocks are the agent's to mark.** There is no control in the application for declaring a block planned or taking the flag off. The agent writes `"planned": true` into the block's file, as it writes everything else about a block.

- **A block nobody has laid out lands in the automatic grid**, which can be nowhere near blocks that were placed by hand, so a newly planned block may appear off to one side. **Re-layout** puts them all together again. This is not new, but it shows up most when the agent adds blocks to a diagram someone has arranged.

- **Rebuilding existing code is up to the agent.** Fragmentor warns the person and tells the agent to make sure the code is committed, but cannot enforce either.
- **Packages can reach the outside world** without a capability. Only Node's built-in modules are refused.
- **Visual pointers are found by name, not by parsing.** A pointer to a name that only appears in a comment still passes.
- **Watching has limits.** A run records its first 2000 block calls, and a value larger than about 200 KB is described rather than shown. Breakpoints last until the project is closed; they are not saved with it.
- **Held calls take turns.** When several calls are held at once, as with a block run once per item, Continue lets go of one at a time while the breakpoint stays set; Continue all lets go of every call of that block, and taking the breakpoint away lets the rest go too. Step goes into the call it lets go.
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

- **Starting a project, and answering its questions.** Run `npm run app`, choose **New project…**, and walk the questions both ways: from scratch and from a folder holding code. Then open Claude Code or Codex in the folder and ask for a small program (structured) or a diagram of the code (visual). Things to judge: whether each question is clear and lands in the right order, whether the recommended answer is the one you would want, and whether the agent follows the guide it is given.

- **A whole application on the canvas, read both ways.** Run `npm run app`, open `examples/link-shortener`, and look at the top diagram: a browser on the left, the HTTP service it calls, the geolocation service that is still only planned, and the database and queue underneath. Then press **Colour** and **Stores** under the canvas and go through them, double-clicking into **Link API** and again into **Follow Link** in each. Things to judge: which colouring you would keep, which of the three places a store should be drawn, whether the clockwise loop under a store reads as one thing going out and another coming back, and whether a resource marked `elsewhere` reads as belonging to the diagram above rather than to this one.

- **Planning an architecture before building it.** Start a project from scratch with **Plan the architecture**, then ask your agent for something small. Things to judge: whether it draws the whole shape as planned blocks before writing code, whether greyed-out blocks are unmistakably not built, and whether the plan is easy to argue with on the canvas.
- **How the canvas moves.** Double-click into blocks and use the breadcrumbs to come back out, and watch blocks arrive while an agent works. Things to judge: whether the zoom reads as going inside a block, and whether arrivals help or distract.
- **Watching and pausing a run.** In the Job Relevance Ranker example, run `rank-jobs` from the test bench, then set a breakpoint on Score Posting and run it again. Things to judge: whether the pace is right, whether the values on the wires are readable, whether Continue and Step do what you expect, and whether the flow on the held wires helps or distracts.
- **Reading the inspector.** Select a leaf block and read down the panel. Things to judge: whether it is obvious what sits under what, whether the code colours are right for this panel, and how wide the inspector wants to be.

## Current checkpoint

- `main`, with architectural block types on top of planned architecture, the new-project question tree, the two modes, the canvas animation, watched runs and the rebuilt inspector. The tag `checkpoint/pre-architecture-blocks` marks `main` as it was before this work, `checkpoint/pre-planned-blocks` before the planned-block work, `checkpoint/pre-inspector-ui` before the inspector work, and `checkpoint/pre-modes` before the modes work.
- One test has been failing since before this work: `check.test.ts` > "puts back a composite that someone edited" compares generated code against a file this checkout has in CRLF. It is a line-ending artifact of the working copy, not a fault in the code.

## Next major steps

1. Run both modes with a real agent, plan-first included, and tighten `FRAGMENTOR.md` wherever the agent goes wrong.
2. Show everything `fragmentor check` finds in the application, code problems included.
3. Decide how Python blocks are laid out as modules, so they can be run and watched.

## Status-file rule

Keep this file as a concise snapshot of current truth.

Do not use it as a chronological development diary. Git already stores history.

Remove or replace stale information instead of endlessly appending updates.
