# Current Development Status

## Current focus

**Separating architecture from execution.** The block tree now means containment only: what a system is made of, and what owns what. Runtime behaviour is moving into executions: a trigger, the conditions it happens under, and the trace of everything that followed across the whole architecture. `PROJECT.md` describes the model. The work happens on the `execution-model` branch, in phases, each ending with the tests and the self-check passing.

1. **Done: the trace kernel, on its own.** `src/model/trace.ts` holds addresses, the three kinds of event (interaction, return, effect), entered and activated, and `project(trace, view)`, which draws one trace at any combination of expanded blocks. It also has stepping that passes over what a collapsed block hides. `src/project/executions.ts` reads `executions/<name>.json`: a trigger, starting store contents, an optional trace an agent wrote (always kept as `declared`), and optional expectations. `src/run/expect.ts` evaluates expectations against any trace.
2. **Done: the wired model is gone.** There are no wires, no `each`, no list of children and no generated composite code. A block's parts are the folders inside it. Every function's code is the agent's, and calls whichever other functions it needs directly. Contracts are optional. A `component` role covers groups of parts that are not called. The five old examples are replaced by `examples/tickets`.
3. **Done: executions on the canvas**, from traces an agent wrote, over `examples/messenger`. Waiting for a person to look at it before phase 4.
4. **Next: record traces by running the code**, so a structured project's executions are observed rather than written down, and the watched run becomes one of them.
5. Tests and breakpoints over traces.
6. Documentation and a simplification pass.

## Working

- **Architecture as containment.** A block's parts are the block folders inside its own; a `children` or `wires` field is refused with a message saying why. A block has a `role`: `function` is code that is called; `component` is a group of parts that is not (a module, a package, the infrastructure); `service`, `external`, `database`, `storage`, `structure`, `queue` and `client` are the things the code talks to. A `subtype` says what it is exactly, in free text. A non-function block has no ports, no capabilities and no code; it offers `exposes` entries — a table with its schema, a channel with its message, an operation with what it accepts and returns — and an operation may say which function inside answers it.
- **Dependencies.** Any block says what it reaches with `access` — `"reads app-db.users"`, `"shorten calls api.createLink"` — found among the block's own parts first, then beside it and above it, or by a path such as `infrastructure/app-db.users`. On the canvas an access is a line whose arrow points the way the data moves and which meets each entry it names at that entry's own row; what a service's functions reach is gathered onto the service one level up, and what reaches outside the block in focus lands on the tile holding it. **Dependencies: shown / hidden** below the diagram puts them all away; they fade while an execution is drawn.
- **Executions on the canvas.** `executions/<name>.json` files are read into the project, and their problems listed like any other. The bar above the diagram picks one; it stays picked wherever the person goes, and is drawn at whatever depth is on screen, each end of each step at the deepest block drawn that holds it. Steps between the same two blocks are one line with a count (`×3`); a line that carried something flows, one that only set something off lights up; what happened out of sight inside a block is counted on it (`4 inside`); what the run left behind is a chip over the block responsible; untouched blocks are dimmed. **Restart**, **Step** (to the next thing that changes on this diagram), **Step into** (to the very next event, zooming into the block it happened in), **Play** and **Show all** move through it, with the current step in words underneath and **Show where** to open the diagram that shows it at its real blocks. A trace an agent wrote is labelled `declared`.
- **The rest of the architecture around the focus.** Every other part of the system is a small tile beside the diagram, on the side it stands on one level up, grouped by what it is part of. A tile opens in place (the arrow on it) to show its own parts, independently of the focus and of every other tile; double-clicking one goes to it. The block in focus is drawn as a dashed frame: a service's operations, a function's own contract, and what the block itself reaches. A block the focus is inside is drawn as a frame tile only while the picked execution reaches it.
- **Functions.** A function may take inputs and return outputs, or neither: one that returns nothing is typed `void` and is held to no result. Its code calls other functions by importing them from wherever they sit in the system, passing a value and its own `caps`; the typechecker holds the call to the callee's contract and capabilities. `fragmentor check` refuses imports of anything else but types and installed packages, and Node's built-in modules.
- **Reaching a store, and running from the top.** A `Store` port is a way into one table, file or structure and a `Queue` port into one channel; the access naming the port says which. The port is typed by what the entry holds. The bench offers somewhere to put rows before a run and shows what the run left — rows written, messages sent — and a saved test carries its rows. An operation and the function answering it have the same shape, except that a function needing nothing from the request may take no inputs. A client's action whose route ends at code has a bench of its own, so pressing the button runs what answers it.
- **`examples/messenger`**, a visual-mode chat application: a client with its UI and state, an API with a router and `auth` and `messaging` components, workers, and infrastructure holding a PostgreSQL database and a queue, pointing at real TypeScript under `src/`. Five executions are written down (sending a message, logging in, logging out, delivering a notification off the queue, and a scheduled clean-up), each with expectations its own trace meets.
- **`examples/tickets`.** A box office, a REST API, a PostgreSQL database, an outbox queue and a planned reminders job. Inside the API, `book-seats` and `cancel-booking` both use `find-event`, which therefore sits beside them; a `pricing` component holds `price-seat` and `refund-for`; `reserve` is used only by `book-seats` and sits inside it. Booking turns a request away early when it cannot be met, prices each seat at once, writes two tables and sends a confirmation. Thirteen tests pass.
- **A mark in every block's corner** saying what kind of thing it is, in the block's own colour: angle brackets for a function, a frame holding boxes for a component, a cylinder for a database, a person for a client.
- **Colour and arrangement.** Hue says which world a thing belongs to, from most yours to least; dashed means not built yet and nothing else. **By block**, the default, gives every block a colour of its own; **by kind** uses the vocabulary, with a legend that lists every kind, marks the ones on screen, and folds away. A kind's colour is changed from the legend and one block's from the inspector, remembered in the browser profile. A diagram reads left to right from whoever sets the system going, with stores and queues underneath what reaches them.
- **A question tree when a project is created**, asking where you are starting from, Fragmentor's role over the code, whether to plan first, how finely to divide the work and optionally the language, and writing the answers into `fragmentor.json`. `fragmentor init` does the same for an agent.
- **Planned architecture.** A block with `"planned": true` is drawn greyed out with a dashed edge and a `PLANNED` label, its types may be words, nothing about it is an error, and nothing is generated, checked or run for it. Planning spreads downward only. Code Fragmentor wrote for a block that is now planned is taken away; code someone else wrote is reported, never deleted.
- **Visual mode.** Each block points at the file or function it stands for, and its types are free text. `fragmentor check` reports pointers that lead nowhere. The inspector shows the code; the bench, tests, generation and breakpoints are hidden. Fragmentor never changes or runs the code.
- **Agent guide.** `FRAGMENTOR.md` is written for the one project it sits in, and now teaches containment: put a block inside another only when it is part of it, and a shared one inside the lowest block holding everything that uses it. Its worked example is a component holding three functions, one calling the other two, held by test to check and pass exactly as shown.
- **Language packs.** TypeScript is generated, typechecked and run. Python gets contracts only; it is not checked or run, and how one Python block imports another is unsettled.
- **Running, watching and pausing.** A function runs in a separate process against given values, with substitutes for its capabilities, checked against its contract. Every call the run makes, anywhere in the system, is recorded with the call that made it, and played back on whatever diagram is on screen: a block lights up when it, or anything inside it, is running, and says how its own calls went or, for a group of parts, how many ran inside it. A breakpoint pauses a run before a function; **Continue**, **Step**, **Continue all** and **Stop** steer it. Tests live in `cases.json` beside each function.
- **Desktop application.** Draws the diagram and redraws it as the agent works, keeping the view and selection; lists problems against their blocks; shows a banner over the last good diagram when a file is half written; warns about unsaved edits when the file changes underneath. A function's code can be edited; contracts are read-only. Opening a block zooms into it; blocks the agent adds are brought in one after another.
- **The trace kernel**, described under "Current focus", with its tests. The canvas draws with it; recorded runs do not produce traces yet.
- **The application checks itself.** `npm run check:app` plays an agent against a throwaway copy of `examples/tickets`: the new-project form, the system arriving, code saved from the window, a run paused on a function called five times at once, stepped, let through and finished, the API diagram afterwards showing what ran inside each part and leaving the untouched handler dark, a run stopped, blocks renamed and added and planned, a half-written file, an edit conflict, a problem listed, a switch to visual mode, a database added, the whole application's arrangement and colours, a button followed to the function that answers it, a store seeded from the bench, seats booked from the box office so the database is written and a confirmation queued, and in `examples/messenger` an execution picked, drawn over the whole application, stepped, stepped into the API, and a tile opened around it. Anything the window logs as an error fails the check.

## Not built yet

- Recording executions by running the code, and tests and breakpoints over them (phases 4 and 5). `fragmentor test` does not evaluate an execution's expectations yet.
- A queue delivering what was put on it to whatever consumes it.
- Showing code problems in the application. Only `fragmentor check` reports them.
- Running or checking Python code.
- Stale-state propagation, and per-block granularity overrides.

## Known problems or uncertainties

- **Neither mode has been run with a real agent**, and the guide has just changed a great deal.
- **A watched run is not an execution yet.** It lights up the blocks it reaches without drawing lines between them, on its own bar, until phase 4 records runs as traces.
- **Tiles make a fitted diagram smaller**, and at that size the labels on a busy execution crowd together. Zooming in reads them; nothing yet lays lines out around one another.
- **A dependency line can run through a block.** At the top of `examples/tickets` the database's read line to the API passes behind the outbox. It can be hidden, and fades under an execution.
- **A declared trace is only as true as the agent's reading of the code.** Nothing checks it against the code until traces can be recorded.
- **A function passing capabilities on declares them.** `book-seats` binds the stores `reserve` writes, because it hands `reserve` its own `caps`, so its access list reads as though it wrote them itself.
- **A callee uses its caller's store.** A port bound to one store in the caller and to another under the same name in a function it calls would reach the caller's. Nothing checks for that.
- **A role is the agent's to write**, as `planned` is. There is no control in the application for either.
- **A store's substitute is a dictionary, not a database**: `read`, `list`, `write`, `remove`, and no queries, ordering, transactions or constraints. A `Queue` only sends.
- **An exposed type that will not parse is kept as words**, so a typo in a schema is shown rather than reported.
- **Running an entry runs the code, not the hop to it.** The route from a client to a service is shown on the panel, not animated.
- **A block nobody has laid out lands in the automatic grid**, which can be nowhere near blocks placed by hand. **Re-layout** puts them together again.
- **Rebuilding existing code is up to the agent.** Fragmentor warns and asks for a commit but cannot enforce either.
- **Packages can reach the outside world** without a capability. Only Node's built-in modules are refused.
- **Visual pointers are found by name, not by parsing.**
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

- **Executions on the canvas (the phase 3 check).** Open **Messenger**, pick **Send a message** above the diagram, and read it at the top, inside **api**, inside **messaging**, and with tiles opened. Step through it with **Step** and **Step into**. Judge whether one line per pair of blocks with a count reads well, whether data flowing and triggers lighting up are told apart, whether the tiles make leaving the block in focus clear, and whether stepping goes where you expect.
- **Starting a project, and answering its questions.** Run `npm run app`, choose **New project…**, walk the questions both ways, then ask an agent for something small. Judge whether the questions are clear and whether the agent follows the new guide: parts inside what owns them, shared parts beside what uses them.
- **Booking seats from the box office.** Open **Tickets**, select **box-office**, fill in `gig`, `2` and an email under "Try bookSeats", put `{"gig": {"id":"gig","name":"Night Gig","seatsLeft":10,"price":25}}` in the events box, and press **Run bookSeats**. It should say two seats were booked, show the event with 8 left, a booking row, and one message sent. Judge whether what the run left is as useful as what it returned.
- **Watching and pausing a run.** Set a breakpoint on **price-seat** inside **booking-api / pricing**, then book five seats from **book-seats**. Judge whether the pace is right, whether Continue, Step and Continue all do what you expect, and whether blocks lighting up for what ran inside them reads well.
- **A whole application on the canvas.** Open **Tickets** and read the top diagram, then double-click into **booking-api** and **pricing**. Judge whether what is inside what makes sense, and whether a function's "takes / gives back" reads as a contract rather than a connection.
- **Planning an architecture before building it**, **how the canvas moves**, and **reading the inspector**, as before.

## Current checkpoint

- `execution-model`: the redesign, with phases 1 to 3 done.
- `main`: the last state of the wired model.
- Tags, newest first: `checkpoint/pre-execution-model` (where the redesign branched off), `checkpoint/pre-store-capability`, `checkpoint/pre-triggers`, `checkpoint/pre-subtypes`, `checkpoint/pre-connection-colours`, `checkpoint/pre-architecture-blocks`, `checkpoint/pre-planned-blocks`, `checkpoint/pre-inspector-ui` and `checkpoint/pre-modes`.
- Every test passes, as does `npm run check:app`. The line-ending failure that stood for a long time went with the generated composite code it checked.
- **The colour palettes in `app/renderer/state.ts` are the person's own**, edited by hand: `DEFAULT_ROLE_COLOURS` and `BLOCK_PALETTE`. Do not tidy or re-pick them. The one entry added since, `component`, was chosen to sit beside the function green and is the person's to change.

## Next major steps

1. **Phases 3 to 6 of the redesign**, listed under "Current focus".
2. **Run both modes with a real agent**, plan-first included, and tighten `FRAGMENTOR.md` wherever the agent goes wrong.
3. Show everything `fragmentor check` finds in the application, code problems included.
4. Decide how Python blocks import one another, so they can be run and watched.

## Status-file rule

Keep this file as a concise snapshot of current truth.

Do not use it as a chronological development diary. Git already stores history.

Remove or replace stale information instead of endlessly appending updates.
