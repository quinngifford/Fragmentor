# Product

Fragmentor is a modular, block-based environment for AI-assisted software development.

Software is shown as a hierarchy of blocks: the architecture, meaning what exists and what owns what. Separately, it shows what actually happens when something sets the system going, drawn over that architecture. An AI coding agent does the work in the project folder; Fragmentor gives that work its structure, makes it visible, and verifies it. The user inspects, tests, and steers the structure through a visual canvas.

## Why

Large AI-generated codebases become opaque. Neither the human nor the AI can hold them in mind, and every change begins with rediscovering how the system fits together.

Fragmentor makes the structure the primary artifact. A user should be able to look at a system, see its parts, see what actually happens between them when something sets it going, open any part, and test it without understanding the rest.

## Architecture and execution

Fragmentor keeps apart two things that are easily confused: what a system is, and what it does.

- **Architecture** is containment and ownership. A block's children are the parts it is made of, not the things it calls. A part used by several others sits beside them, at the lowest block that owns all of them, rather than under whichever happens to use it. The architecture is not the folder structure of the code, though a block may point at the code it stands for.
- **Dependencies** — which part is able to reach which — are static facts about the architecture, declared with `access`, and drawn only when asked for.
- **An execution** is one trigger under stated starting conditions: a click, a request, a scheduled job, a queue message, a webhook. It produces a **trace**: every interaction and effect that happened, in order, anywhere in the architecture. An interaction can go from any part to any other, in any direction, and one execution can branch.
- **An interaction** has a source, a target, a kind and a cause, and may or may not carry something. Carrying data or only triggering is a difference in what is drawn, not two kinds of connection.
- **An effect** is an observable consequence — a row changed, a message published, a response sent — shown at the part responsible. It is never a part of the architecture.
- **Contracts** exist only where they mean something. A part may take nothing, return nothing, or only be triggered.

## What is on screen

The architecture is one drawing: every block of every system, each under the block it is part of, joined by plain right-angled lines that mean containment and nothing else. There are no levels to move between — the whole system is there at once, and a block with parts can be folded to put them away. Granularity decides how finely the architecture is divided in the first place, not how much of it is shown.

A block on the tree is a small box: its name and what kind of thing it is. Everything else about it — its code, its contract, the tables or operations it offers, what it reaches — opens in a window of its own.

An execution is read in one of two ways, and neither of them is a web over the architecture:

- **Stepped through on the tree**, one arrow at a time, between the two blocks that step really joins. Nothing moves or opens as it goes; a step hidden inside a folded block is reached by stepping into it, which unfolds what hides it.
- **As its own drawing**, from beginning to end: step after step, left to right, wrapping onto the next row, with a block drawn again each time the run comes back to it, so nothing loops backwards.

A trace never depends on what is on screen. Each end of a step is drawn at the deepest block showing that contains its real end, so what happens inside a folded block is gathered onto the block standing for it. Nothing is lost by folding: the trace keeps every event.

Every step says what it is, in the words of whoever wrote the trace down, and names the function that makes it. Fragmentor checks that function exists, as it checks a block's own code. A step has a page of its own: what it is, the blocks it joins, what it carried, and the code behind it.

A trace is either **recorded**, meaning Fragmentor saw it happen by running the code, or **declared**, meaning an agent wrote it down after reading the code. A declared trace is documentation and is never presented as something observed.

Tests are assertions over a trace: that the run crossed into a part, that an interaction happened and carried what it should, that an effect happened, that the stores hold what they should at the end, and that a part was never touched. Breakpoints pause on entering a part, an interaction, an effect or a change of state. Both work for parts with no parameters and no result.

This replaces an earlier model borrowed from Simulink, in which every block was a function whose children were steps wired output to input, and whose code Fragmentor generated from the wires. That model is gone. Executions an agent writes down are drawn over the architecture; recording them by running the code, and tests and breakpoints over them, are being built now. `STATUS.md` says how far that has got.

## Where the code is, and what Fragmentor does with it

**Every function block says where its implementation is**, with a `code` pointer: a file relative to the project and the name of the function in it. Nothing requires the codebase to mirror the diagram. A block's folder says where the block sits in the architecture; where its code sits on disk is the codebase's own business, and a layout that echoes the architecture is a good idea rather than a rule. Fragmentor never writes code of its own and never moves any; the one time it writes code files is when the person swaps a block back to one of its versions.

**What Fragmentor does with a block's code is a fact about that block, not a setting on the project.** Where a function block's inputs and outputs are written in the type language and its system is in a language there is a pack for, Fragmentor writes its contract — into the block's own folder, because everything generated stays inside `blocks/`. The contract on its own changes nothing. What binds the two is **the code importing it**: code that imports its contract is typechecked against it, can be run and benched from the window, and can have saved tests; code that does not is drawn and read. The import is the only honest binding there is, because nothing else could hold a function to a shape it never mentions.

So one codebase can have a part described exactly as it stands and another built under Fragmentor's eye, and `fragmentor check` says which blocks are which and why. A block Fragmentor is quietly not checking would be worse than one it says it cannot.

This replaces two modes a project had to choose between — structured, where the diagram was the specification and Fragmentor generated and ran everything, and visual, where it only drew code it never touched. Both are what the one model does at either end of it.

When a project is created the person is asked a short series of questions, each following from the last: whether they are starting from nothing or from code they already have, whether to plan the architecture before building it, how finely to divide the work, and optionally the language. These are the person's decisions rather than the agent's, so Fragmentor asks for them and writes them into `fragmentor.json` before any agent starts. The answers are what the agent's guide is written from, so the guide states what applies to this one project instead of listing the cases it might be in.

## What a block is

A block has:

- a role, saying what kind of thing it stands for: a function by default, or something else such as a group of parts, a database or a queue
- a stated responsibility
- the blocks it is made of, which are the block folders inside its own
- for a function, a contract where one means something: typed inputs, typed outputs, or neither
- for a function, capability ports — declared effects it needs, such as a store, HTTP access or the clock

A function's implementation is code the agent writes. It calls whichever other functions it needs, wherever they sit in the architecture, when it needs them and as often as it needs them; none of that is on the diagram, because the diagram says what the system is made of, and what calls what is what an execution shows.

Capability ports matter more than they first appear. Real software touches networks, disks, and databases, and a block model that only permits pure functions collapses immediately. Declaring effects as ports means any function can be run in isolation with substitutes supplied for its capabilities. This is what makes every function independently testable, and it is also where a run's effects can be seen: a row written, a message sent.

Capabilities are described in the same port type language as everything else, so each target language renders them its own way rather than the model favouring one.

### Every function block is a function

Every block whose role is `function` corresponds to a real, callable function in the code, and says which one.

The user must be able to open any block whose code is held to a contract, enter input values, run it, and see the outputs. That requirement forces callability, so there is no separate, cheaper representation for small blocks.

A conceptual step too small to justify its own function is not a block; it is a line inside a function. Granularity control, not a second block representation, is what keeps the codebase from filling with trivial one-line functions.

## The rest of the system

A program is functions. An application is functions plus the things they talk to, and a diagram of the functions alone shows values arriving from nowhere and leaving for nowhere: where the data actually lives is not on it.

So a block carries a **role**. `function` is the block described above, and is what a block is unless it says otherwise. The rest — `component`, `service`, `external`, `database`, `storage`, `structure`, `queue`, `client` — are never called themselves, so they have no code of their own. A `component` is a group of parts that is none of the other kinds: a module, a package, the infrastructure. The rest are the things the code talks to.

A role is the general kind. What a block is exactly — a dictionary, a REST API, PostgreSQL — is its own **subtype**, written in whatever words fit rather than chosen from a list, because no such list would ever be finished. It changes nothing but the label: blocks of one role are drawn alike however their subtypes differ.

A block of any role but `function` is not called, so it has no ports and no capabilities. It declares what it offers as **exposed entries**: a database's tables with their schemas, a queue's channels with the message on them, a service's operations with what they accept and return. A table drawn with its columns is the point — it is what makes the store worth looking at rather than merely naming.

Any block declares what it reaches as **access**: `reads app-db.users`, `writes app-db.orders`, `calls billing.charge`. An access may name the entry it starts from as well as the one it ends at — `showOrders calls orders-api.listOrders` — and then it joins those two rather than the two blocks, which is what a client with several buttons needs. This is declared by the block doing the reaching: reaching a database is something the block itself does, and stays true wherever the block is moved. The block named is found among the block's own parts first, then by looking outward — beside it, then beside its parent, to the top of the system — so a handler deep inside a service reaches a database the service keeps beside it. One kept inside a group is named by its path from there: `reads infrastructure/app-db.users`.

An access is a dependency: a fact about the architecture, saying what is able to reach what. It is not a record of what happened, which is an execution's, and the two are never merged. A button's access, an operation saying which block answers it, and that block's contract together say where pressing the button leads, and the application can run it from there.

Access is drawn per direction rather than per pair, because direction is the most important thing about it: a database that is read and written gets a line each way, not one line saying the two are connected. Everything leaves a block on its right and arrives on its left, the way its ports are drawn.

## How a diagram is arranged and coloured

The arrangement says something, so it has to be true. A diagram reads left to right from whoever sets the system going, through what they call, to what that calls in turn. Stores and queues are not steps in that: a service reads and writes a database in the same breath, and putting it further along would say it came after. They sit underneath instead, and the connection loops clockwise around the block — out of its right, down, and back up into its left. A queue written and never read is an endpoint but not the destination, because the system's answer goes back to whoever asked for it; it belongs under the flow rather than at the end of it.

Colour says which world a thing belongs to, and runs from what is most yours to what is least: your code, the data it holds, the data it keeps, your own separate programs, the people you serve, and the services you do not control. Which exact colours those are is the person's, not the project's: a kind's colour is changed from the legend and a single block's from the inspector, and both stay in that person's browser rather than in the files everyone shares. Green is your own code. Red is spent on none of them: on this panel it means something is wrong.

A dashed line means one thing and only one thing: not built yet. Everything planned is grey and dashed, blocks and connections alike, whatever colour it would otherwise have taken.

A store is drawn on the diagram it belongs to and nowhere else, so where a store sits in the hierarchy is a decision that shows, and the diagrams under it are left to their own parts.

An arrangement is a default, not a rule. A person can move any block, and where they left it is remembered. So is a colour: which colour a kind or a single block takes is the person's, and stays in their browser rather than in the files everyone shares.

Nothing is generated, checked or run for a block that is not a function. The code that receives real requests and opens real connections is the framework's, and no block stands for it. The functions **inside** a service are ordinary blocks, checked, run and tested as usual, which is what lets a project hold an honest end-to-end architecture and a fully verified set of functions inside it.

Code reaches a store through a capability port, and the access naming that port says which entry it is a way into — so the line drawn and the path the code takes are the same line.

The roles are a vocabulary for reading, not a taxonomy to be enforced. Adding one is adding a description; everything that treats roles differently asks only whether a role is a function.

## Planned architecture

A block may be declared **planned**: part of the architecture rather than of the program. It appears on the diagram greyed out, carrying its responsibility and whatever connections have been worked out so far, and Fragmentor generates, checks and runs nothing for it. Its port types are prose as readily as types, because what a planned block takes and gives is usually the thing still being decided.

Planning spreads downward — a block inside one that does not exist yet does not exist either. Upward it stops: a block holding a planned part is as real as it was.

This is what lets an architecture be argued with before it is built. A project created with plan-first begins entirely as planned blocks; the person reads the shape on the canvas, and the agent takes the flag off one block at a time as it builds them. A project built as it goes can still plan a part of itself this way.

## Relationship between the diagram and the code

The diagram is the specification of what exists. The agent writes every function; Fragmentor writes each function's types from its contract. Code can still disagree with the diagram, so conformance is checked rather than assumed:

- each function block is one exported function, named by the block's `code` pointer, wherever in the codebase that is
- a function's contract is expressed as runtime schemas for its inputs and outputs, which also drive the test bench forms
- its code is typechecked against its contract, calls to other functions are typechecked against theirs, and its imports are checked so that it can run: types, other functions in its system, and packages installed in the project

Conditions, loops and error handling are the code's. The diagram does not describe control flow; an execution shows the path one run took.

## Versions

A version is a block with all its parts — their folders, saved tests and the code they point at — as they stood at one moment, because a block without its parts or its code is not the block as it was. What it uses beside it is not part of it: a version is put back into today's system, and runs against today's versions of whatever it calls.

A block has two kinds of version, because they answer different needs:

- **Saved versions** are the few the person chooses to keep: saved from the application with a name and a description, when the block works the way they want to be able to come back to. They are files in the project, so they travel with its repository and everyone working on it sees them.
- **Git history** is every commit of the repository holding the project that changed the block. It is complete and shared by whatever the team already uses, and far too fine-grained to be the only history, since an agent commits every small step.

Either kind can be compared with the block as it is, which runs the saved tests of both, and every other saved test in its system, against both; swapped in; and the swap undone. Nothing a swap replaces is lost. A swap is refused where it would change code belonging to a function outside the block, because one file can hold more than one block's code.

Starting a project starts a git repository when the folder is in none, and the agent commits each block as it finishes it, so every finished block is in the history. Git is what both kinds stand on: Fragmentor asks it which files make up a block, and does not keep a history of its own beside the one the person saves.

## Where the AI fits

Fragmentor does not contain an AI and never calls a model. The AI is an external coding agent — Claude Code, Codex, or anything like them — working in the same project folder. The agent does the work; Fragmentor supplies the structure, the visibility, and the verification.

The workflow is:

1. The user starts a project and gives the agent a goal.
2. The agent defines the architecture as blocks, following Fragmentor's rules, each function block saying where its code is or will be.
3. Fragmentor reads that structure from disk and draws it, redrawing whenever the agent changes a file.
4. The agent writes the code and the tests; Fragmentor writes the types of every block whose code imports them.
5. Fragmentor validates the diagram, checks that code against it, and runs the tests.
6. The agent fixes whatever is reported, and the loop repeats.

A project keeps two things apart:

- **The architecture**, which is specific to the project and machine-readable: `fragmentor.json` and a `block.json` for each block. It is the single source of truth for the diagram.
- **The rules for working on it**: `FRAGMENTOR.md`, which Fragmentor writes into the project and keeps current. There is one guide, because there is one way to work; it is written for the one project it sits in — where it starts from, its language and its granularity — so it says only what applies there, and it is kept short, because an agent follows a short guide better than a complete one. `AGENTS.md` and `CLAUDE.md` point agents at it, and are otherwise the user's, for instructions specific to the project.

The agent checks its work with the `fragmentor` command, which runs the same checks the application relies on and reports them as text and an exit status.

Decomposition is still a review loop rather than a single shot. The user defines as much of the block hierarchy as they want, at any level, and the agent fills in the rest. The agent settles the structure first and lets the user review it on the canvas; code is written only after the structure is agreed, working bottom-up.

Decomposition depth is user-controlled. The granularity chosen when the project is created applies to the whole project, and any block may be pinned as a leaf. Granularity is expressed as a stop condition the agent evaluates — a block needs no parts when it has one clear responsibility with no further useful internal structure — with a hard depth limit as a safety net.

## Verification

Every function has tests, written by the agent alongside its code. This is not optional.

Beyond automated tests, each function has an interactive test bench. Its input schema generates an input form, capability ports are filled with substitutes, stores can be given rows before the run, and the user runs the function and sees what it returned and what it left behind in the stores.

Running a function records every call it makes, anywhere in the system, with the call that made it. The user can watch the parts of the architecture light up as the run reaches them, stop the run at a breakpoint before any function, and step through it. This is the start of what executions complete: a trace of everything a trigger set off, stepped through on the tree or read end to end as its own drawing.

Each block carries a state: specified, implemented, tests passing, or stale. A block becomes stale when a contract it depends on changes. Stale propagation is what keeps a large hierarchy honest as it evolves.

## Developer interface

The interface is a visual canvas — dark, high-contrast, structural — where the user reads the hierarchy, opens blocks, reads code, runs tests, follows runs, and watches the agent's work take shape. The whole system is one drawing rather than a series of pages, and blocks appear on it as the agent creates them. The user directs the agent in the agent's own tool; Fragmentor is where they see and check what it built.

**The user interacts through the UI.** Understanding the structure should come from looking at it, and every action the user takes should be a clear, clickable control. The user is never expected to learn or type commands to operate Fragmentor. The `fragmentor` command exists for the coding agent, and for developing and verifying Fragmentor itself; it is not a user-facing surface.

**Fragmentor is a desktop application.** There is no web version. The work is local: a project is a directory of files, the tools it drives are local, and nothing needs a server. The kernel is a library that the application and the agent's command both consume, never a tool the user drives directly.

If projects are ever shared, that happens through an ordinary repository holding the blocks and their code, rather than by moving the application online. Nothing in the file format should assume otherwise.

## Systems and languages

A project holds one or more systems. A system is a block hierarchy with a single target language. Systems in the same project are never connected to each other — they are separate programs, shown together because they are worked on together.

The target language is a choice, not an assumption. The block model, the validator and the project format know nothing about any language; that knowledge lives in a language pack, which owns naming conventions, file names, how a port type is written, and the source of the generated contract. Adding a language means adding a pack, not editing the kernel. A system in a language there is no pack for is drawn and nothing more, which Fragmentor says plainly rather than refusing the project.

Port contracts are defined with runtime schemas so a single definition yields both static types and the schema the test bench needs. Which library provides that is the pack's business — zod in TypeScript, pydantic in Python.

A block may use packages installed in the project, because real code does. What it may not do is reach the outside world except through its capabilities: importing a language's built-in file, network or process modules is refused, and for packages that do the same it is a rule the agent is told rather than one Fragmentor can enforce.

Two properties of the design limit which languages fit cleanly, and should be checked before adding a pack:

- **Capabilities are passed whole.** A function calling another hands it its own entire capability object, which works because TypeScript and Python are structurally typed. A nominally typed language such as Go or Java would need each call to construct the callee's capabilities explicitly.
- **The port type language has unions.** Languages without sum types have no natural rendering for them, and a pack for such a language would need either a workaround or a restriction.

Not in scope now:

- Fragmentor calling AI models itself; the AI is always an agent working in the project folder
- connecting systems to each other, in the same language or across languages
- a browser version of the application, or any hosted service
- sharing projects between people, which would be a repository integration rather than a feature of the application
- deploying or operating the software Fragmentor builds

## Development strategy

### Modular development

Develop major capabilities separately, one at a time, until their core behavior works and can be verified.

Prefer isolated testable modules before broad integration.

Do not introduce scalable databases, paid hosting, 24/7 workers, production queues, or other production infrastructure merely to prove a feature that can be tested locally or cheaply.

Integrate proven modules into the developer application before building any broader system.

### Version control and experimentation

Create clear checkpoints around substantial development milestones and before risky experiments.

When several plausible approaches to the same problem deserve real evaluation, it is acceptable to branch from the same known-good checkpoint and develop and test the approaches independently before choosing one.

### Simplicity

Keep code and architecture as simple as possible without sacrificing correctness or quality.

Complexity has a real cost, because both humans and AI must repeatedly rediscover and reason about the codebase.

Prefer fewer concepts, fewer layers, less code, and fewer dependencies when they produce an equally good solution.

Do not prematurely optimize for hypothetical future scale.

### Verification

Do not move on from important module milestones merely because implementation exists.

Meaningful work should be verified using automated and AI verification appropriate to the feature.

Human verification should also be used when seeing or interacting with the real behavior provides meaningful additional confidence.

An important module can conceptually progress through:

1. Not started
2. In development
3. Implemented
4. AI verified
5. Human verified when appropriate
6. Stable / checkpointed

"Implemented" does not automatically mean "done."

## Engineering priorities

When priorities conflict, generally favor:

1. correctness
2. simplicity
3. verifiability
4. modularity and isolation
5. low development and infrastructure cost
6. speed where the product actually requires it
7. scalability when real requirements justify it

## Documentation rule

Document durable product intent, important constraints, and non-obvious decisions.

Do not document implementation details that are already obvious from the code.

Prefer documenting required outcomes over prematurely locking in methods.
