# Current Development Status

## Current focus

**Separating architecture from execution.** The block tree now means containment only: what a system is made of, and what owns what. Runtime behaviour is moving into executions: a trigger, the conditions it happens under, and the trace of everything that followed across the whole architecture. `PROJECT.md` describes the model. The work happens on the `execution-model` branch, in phases, each ending with the tests and the self-check passing.

1. **Done: the trace kernel, on its own.** `src/model/trace.ts` holds addresses, the three kinds of event (interaction, return, effect), entered and activated, `place`/`placeEvent`, which say where an event is drawn given how much of the architecture is showing, and stepping that passes over what a folded block hides. `src/project/executions.ts` reads `executions/<name>.json`: a trigger, starting store contents, an optional trace an agent wrote (always kept as `declared`), and optional expectations. `src/run/expect.ts` evaluates expectations against any trace.
2. **Done: the wired model is gone.** There are no wires, no `each`, no list of children and no generated composite code. A block's parts are the folders inside it. Every function's code is the agent's, and calls whichever other functions it needs directly. Contracts are optional. A `component` role covers groups of parts that are not called. The five old examples are replaced by `examples/tickets`.
3. **Done: executions on the canvas**, from traces an agent wrote, over `examples/messenger`.
4. **Done: the canvas rebuilt around the tree**, and looked at. After a first look the person asked for the architecture to be one top-down tree with the whole system on it, blocks small with their details in windows, an execution stepped through one arrow at a time, and a separate drawing of each execution from beginning to end. All of that is built, reviewed and seen; the person called it "absolutely fantastic".
5. **Done: what the agent is told.** There are no modes, every function block says where its code is, and one guide replaces two. Described under "One model" below.
6. **Next: record traces by running the code**, so the executions of a project Fragmentor runs are observed rather than written down, and the watched run becomes one of them.
7. Then: tests and breakpoints over traces.
8. Documentation and a simplification pass.

## One model, and where the code lives

Asked right after the rebuilt canvas was approved — what has to change in what the agent is told, do structured and visual both need to exist, is generated code still worth keeping — with a preference for instructions as short and plain as they can be while leaving the agent in no doubt. The person decided: **no modes, and no requirement that the filesystem mirror the diagram.** What was built:

- **Every function block says where its code is** with `code`: a file relative to the project and the name of the function in it, such as `"src/api/book-seats.ts#bookSeats"`. A block without one is reported against that block, and the diagram still draws. Fragmentor writes no code at all — the starting files it used to create are gone — and everything it generates stays inside `blocks/`.
- **What Fragmentor does with a block's code is a fact about that block.** It writes the contract of a function block whose ports are written as types, in a language there is a pack for, into the block's own folder. **Code that imports that contract is typechecked against it, run, benched and tested; code that does not is drawn and read.** The import is the binding, because nothing else could hold a function to a shape it never mentions. `src/project/code.ts` is where that is worked out, once, for everything that asks.
- **`fragmentor check` says which blocks are drawn rather than checked, and why** — words, no pack, or an import that is not there — because a block it is quietly not checking would be worse than one it says it cannot.
- **`mode` is gone from `fragmentor.json`**, and a manifest still carrying it is told what became of it. The new-project questions lose the one about Fragmentor's role over the code. A language written the way a person writes it ("TypeScript") is read as the pack it means.
- **One guide.** `src/codegen/guide.md` with `guide.ts` replaces `guide-structured.md` and `guide-visual.md`. Contracts, running and testing are one section that says when they apply; executions are taught in every project rather than only where the diagram described existing code. It runs to about 260 lines for a TypeScript project and about 215 where nothing can be generated, against 213 and 197 for the two it replaced. `guide.test.ts` still writes the worked example into a temporary project and runs the check and the tests over it, so the guide cannot teach something that fails.
- **`examples/tickets` keeps its code under `src/booking/`**, which is what the new rule is for, and `examples/messenger` needed no change but its manifest: its blocks already pointed at code, and none of that code imports a contract, so all of it is drawn.

What is still open, for whoever picks this up:

- A block written in words gets no contract, which is right, but an agent that writes `Order[]` in a project it is meant to be building gets only a line in the check's report. Whether that deserves more is unsettled.
- A block Fragmentor runs can only call other blocks it runs: the compiled copy holds those files and nothing else. That is honest but narrow, and it is what stops a half-converted codebase being run.

## Working

- **Where the code is.** Every function block that is not planned says where its implementation lives with `code`, a file relative to the project and optionally `#` and the name of the function in it. Nothing about where a block's folder sits says anything about where its code sits. `fragmentor check` reports a pointer that leads nowhere as a warning, because it cannot tell code nobody has written yet from code that moved, and whoever is working on it can.
- **What Fragmentor holds to a contract.** A function block whose ports are types, in a language there is a pack for, gets a contract in its own folder; code that imports that contract is typechecked against it, run and tested; anything else is drawn. Per block, so one codebase can be part described and part built. The check lists what it is drawing rather than checking, and why.
- **Architecture as containment.** A block's parts are the block folders inside its own; a `children` or `wires` field is refused with a message saying why. A block has a `role`: `function` is code that is called; `component` is a group of parts that is not (a module, a package, the infrastructure); `service`, `external`, `database`, `storage`, `structure`, `queue` and `client` are the things the code talks to. A `subtype` says what it is exactly, in free text. A non-function block has no ports, no capabilities and no code; it offers `exposes` entries — a table with its schema, a channel with its message, an operation with what it accepts and returns — and an operation may say which function inside answers it.
- **Dependencies.** Any block says what it reaches with `access` — `"reads app-db.users"`, `"shorten calls api.createLink"` — found among the block's own parts first, then beside it and above it, or by a path such as `infrastructure/app-db.users`. On the canvas an access is a line whose arrow points the way the data moves and which meets each entry it names at that entry's own row; on the tree it is an arrow between the two blocks, gathered onto whatever is showing when one of them is folded away. **Dependencies: shown / hidden** below the drawing is how they are asked for; they start hidden, because the tree's own lines mean containment and an arrow is a different question.
- **The architecture as one tree.** Every block of every system is on screen at once, each under the block it is part of, joined by plain right-angled lines with no arrowheads: containment, and nothing else. Parts with no parts of their own are listed down the side of what they belong to, which is what keeps a system readable on one screen. A block with parts folds them away and brings them back, and folding is the only thing that takes a block off the drawing. There are no levels, and nothing is laid out by hand: `layout.json`, dragging and **Re-layout** are gone.
- **A block's windows.** A block on the tree is a small box — its name, its kind, its colour. Two buttons on it open the rest: **what it holds** (a contract, a database's tables, a service's operations, and what it reaches) and **its code** (the whole file, coloured, with the function it stands for marked). The same two buttons are in the inspector. The inspector offers to edit the code Fragmentor holds to a contract, beside the contract holding it, and shows anything else read-only with the reason underneath.
- **Executions on the tree.** `executions/<name>.json` files are read into the project, and their problems listed like any other. The bar above the drawing picks one and steps through it: **Restart**, **Step**, **Step into** and **Play**, with the step in words underneath. One arrow at a time is drawn, between the two blocks that step really joins; a step that carried something flows, one that only set something off lights up; what a run left behind is a chip at the block responsible. A step inside a folded block is passed over by **Step**, and **Step into** unfolds what hides it. A trace an agent wrote is labelled `declared`.
- **An execution as its own drawing.** **Flow** lays one execution out from beginning to end: step after step, left to right, wrapping onto the next row, with a block drawn again each time the run comes back to it, so nothing ever loops backwards. The step showing is marked on both drawings, and clicking any step in either opens its page.
- **A step's own page.** In the inspector: what the step is in the agent's words, the blocks it joins, what it carried, and the function that makes it, which opens in the code window.
- **Functions.** A function may take inputs and return outputs, or neither: one that returns nothing is typed `void` and is held to no result. Its code calls other functions by importing them from wherever they sit in the system, passing a value and its own `caps`; the typechecker holds the call to the callee's contract and capabilities. `fragmentor check` refuses imports of anything else but types and installed packages, and Node's built-in modules.
- **Reaching a store, and running from the top.** A `Store` port is a way into one table, file or structure and a `Queue` port into one channel; the access naming the port says which. The port is typed by what the entry holds. The bench offers somewhere to put rows before a run and shows what the run left — rows written, messages sent — and a saved test carries its rows. An operation and the function answering it have the same shape, except that a function needing nothing from the request may take no inputs. A client's action whose route ends at code has a bench of its own, so pressing the button runs what answers it.
- **`examples/messenger`**, a chat application described as it stands, none of whose code imports a contract, so all of it is drawn: a client with its UI and state, an API with a router and `auth` and `messaging` components, workers, and infrastructure holding a PostgreSQL database and a queue, pointing at real TypeScript under `src/`. Five executions are written down (sending a message, logging in, logging out, delivering a notification off the queue, and a scheduled clean-up), each step saying what it is and which function makes it, each with expectations its own trace meets.
- **`examples/tickets`.** A box office, a REST API, a PostgreSQL database, an outbox queue and a planned reminders job, with its code under `src/booking/` and each block pointing at it. Inside the API, `book-seats` and `cancel-booking` both use `find-event`, which therefore sits beside them; a `pricing` component holds `price-seat` and `refund-for`; `reserve` is used only by `book-seats` and sits inside it. Booking turns a request away early when it cannot be met, prices each seat at once, writes two tables and sends a confirmation. Thirteen tests pass.
- **A mark in every block's corner** saying what kind of thing it is, in the block's own colour: angle brackets for a function, a frame holding boxes for a component, a cylinder for a database, a person for a client.
- **Colour and arrangement.** Hue says which world a thing belongs to, from most yours to least; dashed means not built yet and nothing else. **By block**, the default, gives every block a colour of its own; **by kind** uses the vocabulary, with a legend that lists every kind, marks the ones on screen, and folds away. A kind's colour is changed from the legend and one block's from the inspector, remembered in the browser profile. A diagram reads left to right from whoever sets the system going, with stores and queues underneath what reaches them.
- **A question tree when a project is created**, asking where you are starting from, whether to plan first, how finely to divide the work and optionally the language, and writing the answers into `fragmentor.json`. `fragmentor init` does the same for an agent.
- **Planned architecture.** A block with `"planned": true` is drawn greyed out with a dashed edge and a `PLANNED` label, its types may be words, nothing about it is an error, and nothing is generated, checked or run for it. Planning spreads downward only. A contract Fragmentor wrote for a block that is now planned is taken away; no code is ever touched, because none of it is Fragmentor's.
- **Agent guide.** One `FRAGMENTOR.md`, written for the one project it sits in. It teaches containment (put a block inside another only when it is part of it, and a shared one inside the lowest block holding everything that uses it), where a block's code goes, contracts and testing where they apply, and executions. Its worked example is a component holding three functions, one calling the other two, with their code under `src/pricing/`, held by test to check and pass exactly as shown.
- **Language packs.** TypeScript is generated, typechecked and run. Python gets contracts only; it is not checked or run, and how one Python block imports another is unsettled.
- **Running, watching and pausing.** A function runs in a separate process against given values, with substitutes for its capabilities, checked against its contract. Every call the run makes, anywhere in the system, is recorded with the call that made it, and played back on whatever diagram is on screen: a block lights up when it, or anything inside it, is running, and says how its own calls went or, for a group of parts, how many ran inside it. A breakpoint pauses a run before a function; **Continue**, **Step**, **Continue all** and **Stop** steer it. Tests live in `cases.json` beside each function.
- **Desktop application.** Draws the diagram and redraws it as the agent works, keeping the view and selection; lists problems against their blocks; shows a banner over the last good diagram when a file is half written; warns about unsaved edits when the file changes underneath. The code of a block held to a contract can be edited, in the file the block points at; contracts and code Fragmentor only draws are read-only. Opening a block zooms into it; blocks the agent adds are brought in one after another.
- **The trace kernel**, described under "Current focus", with its tests. The canvas draws with it; recorded runs do not produce traces yet.
- **The application checks itself.** `npm run check:app` plays an agent against a throwaway copy of `examples/tickets`: the new-project form, the system arriving, code saved from the window, a run paused on a function called five times at once, stepped, let through and finished, the tree afterwards showing what ran inside each block and leaving the untouched handler dark, a run stopped, blocks renamed and added and planned, a half-written file, an edit conflict, a problem listed, one block's contract import taken away and put back, a database added and read in its own window, the whole application drawn as one tree with what it reaches asked for and a block folded, a button followed to the function that answers it, a store seeded from the bench, seats booked from the box office so the database is written and a confirmation queued, and in `examples/messenger` an execution picked, stepped through on the tree, followed into a folded block, and read end to end as a flow. Anything the window logs as an error fails the check.

## Not built yet

- Recording executions by running the code, and tests and breakpoints over them (phases 6 and 7). `fragmentor test` does not evaluate an execution's expectations yet.
- A queue delivering what was put on it to whatever consumes it.
- Showing code problems in the application. Only `fragmentor check` reports them.
- Running or checking Python code.
- Stale-state propagation, and per-block granularity overrides.

## Known problems or uncertainties

- **The guide has not been run with a real agent** since it became one guide, and it changed a great deal.
- **A watched run is not an execution yet.** It lights up the blocks it reaches without drawing lines between them, on its own bar, until phase 6 records runs as traces.
- **A wide system is a small drawing when it is fitted.** The tree is as wide as its widest row, so with both side panels open a large system fits at around two thirds size. Folding, hiding the rail and zooming are the answers; nothing rearranges a row to fit.
- **The flow view wraps every five steps**, whatever the width of the window.
- **A dependency arrow can pass behind a block.** Arrows are arcs between two boxes and nothing routes them around whatever stands between; they can be hidden altogether.
- **A declared trace is only as true as the agent's reading of the code.** Nothing checks it against the code until traces can be recorded.
- **A function passing capabilities on declares them.** `book-seats` binds the stores `reserve` writes, because it hands `reserve` its own `caps`, so its access list reads as though it wrote them itself.
- **A callee uses its caller's store.** A port bound to one store in the caller and to another under the same name in a function it calls would reach the caller's. Nothing checks for that.
- **A role is the agent's to write**, as `planned` is. There is no control in the application for either.
- **A store's substitute is a dictionary, not a database**: `read`, `list`, `write`, `remove`, and no queries, ordering, transactions or constraints. A `Queue` only sends.
- **An exposed type that will not parse is kept as words**, so a typo in a schema is shown rather than reported.
- **Running an entry runs the code, not the hop to it.** The route from a client to a service is shown on the panel, not animated.
- **Packages can reach the outside world** without a capability. Only Node's built-in modules are refused.
- **A block's code is found by name, not by parsing.** Whether its code imports its contract, and whether the file really declares the function rather than only mentioning it, are decided by scanning the text. A file that imports its contract and never uses the types it imported counts as held to it, and only the run-time check on its inputs and outputs then holds it to anything.
- **A block Fragmentor runs can only call other blocks it runs**, because the compiled copy holds those files and nothing else.
- **Watching has limits.** A run records its first 2000 calls, and a value larger than about 200 KB is described rather than shown. Breakpoints are not saved with the project.
- **Held calls take turns.** Several calls held at once are let go one at a time by Continue, all together by Continue all. Step goes into the call it lets go.
- **Declared traces guess what caused each step** when the agent does not say. After a callback into the caller the list is genuinely ambiguous; the guess is documented, and a step can name its cause.
- **Code colouring is scanned, not parsed.** Nothing depends on the colours being right.
- **The animations are checked for happening, not for how they look.**
- **The `fragmentor` command needs `npm link` once.** The guide tells the agent to ask for it.
- **A redraw takes the cursor out of the code editor**, keeping the unsaved text.
- **An edit conflict is warned about, not prevented.**
- **Reading the clock or randomness directly is not detected.**
- **The port type language has no recursion**, and an optional port also permits null in Python.
- **A block cannot appear twice in one parent**, because a block is its folder.

## Human verification needed

- **Done: the tree, the windows and the two ways of reading an execution.** Looked at and approved. Two things were changed without being asked and left that way, so they are the person's to reverse: the hierarchy rail starts hidden, and dependency arrows start hidden.
- **Starting a project, and answering its questions.** Run `npm run app`, choose **New project…**, walk the questions both ways, then ask an agent for something small. Judge whether the questions are clear now that nothing is asked about Fragmentor's role over the code, and whether the agent follows the new guide: parts inside what owns them, shared parts beside what uses them, and every function block pointing at the code it wrote.
- **Reading one guide.** Open a project's `FRAGMENTOR.md` and read it start to finish. Judge whether it leaves an agent in no doubt about where code goes, what a contract is for, and what importing one buys.
- **Booking seats from the box office.** Open **Tickets**, select **box-office**, fill in `gig`, `2` and an email under "Try bookSeats", put `{"gig": {"id":"gig","name":"Night Gig","seatsLeft":10,"price":25}}` in the events box, and press **Run bookSeats**. It should say two seats were booked, show the event with 8 left, a booking row, and one message sent. Judge whether what the run left is as useful as what it returned.
- **Watching and pausing a run.** Set a breakpoint on **price-seat** inside **booking-api / pricing**, then book five seats from **book-seats**. Judge whether the pace is right, whether Continue, Step and Continue all do what you expect, and whether blocks lighting up for what ran inside them reads well.
- **A whole application on the canvas.** Open **Tickets** and read the top diagram, then double-click into **booking-api** and **pricing**. Judge whether what is inside what makes sense, and whether a function's "takes / gives back" reads as a contract rather than a connection.
- **Planning an architecture before building it**, **how the canvas moves**, and **reading the inspector**, as before.

## Current checkpoint

- `execution-model`: the redesign, with phases 1 to 5 done. `checkpoint/pre-one-mode` is the state before modes went; `checkpoint/pre-tree-view` is the state before the canvas was rebuilt around the tree.
- `main`: the last state of the wired model.
- Tags, newest first: `checkpoint/pre-one-mode`, `checkpoint/pre-execution-model` (where the redesign branched off), `checkpoint/pre-store-capability`, `checkpoint/pre-triggers`, `checkpoint/pre-subtypes`, `checkpoint/pre-connection-colours`, `checkpoint/pre-architecture-blocks`, `checkpoint/pre-planned-blocks`, `checkpoint/pre-inspector-ui` and `checkpoint/pre-modes`.
- Every test passes, as does `npm run check:app`. The line-ending failure that stood for a long time went with the generated composite code it checked.
- **The colour palettes in `app/renderer/state.ts` are the person's own**, edited by hand: `DEFAULT_ROLE_COLOURS` and `BLOCK_PALETTE`. Do not tidy or re-pick them. The one entry added since, `component`, was chosen to sit beside the function green and is the person's to change.

## Next major steps

1. **Phases 3 to 6 of the redesign**, listed under "Current focus".
2. **Run the guide with a real agent**, plan-first included, in an empty folder and over a codebase that already exists, and tighten `FRAGMENTOR.md` wherever the agent goes wrong.
3. Show everything `fragmentor check` finds in the application, code problems included.
4. Decide how Python blocks import one another, so they can be run and watched.

## Status-file rule

Keep this file as a concise snapshot of current truth.

Do not use it as a chronological development diary. Git already stores history.

Remove or replace stale information instead of endlessly appending updates.
