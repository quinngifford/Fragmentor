# Product

Fragmentor is a modular, block-based environment for AI-assisted software development.

Software is shown as a hierarchy of blocks — systems and subsystems — with precisely defined contracts and connections between them. An AI coding agent does the work in the project folder; Fragmentor gives that work its structure, makes it visible, and verifies it. The user inspects, tests, and steers the structure through a visual canvas.

The reference point is MATLAB Simulink, applied to general software development rather than signal processing.

## Why

Large AI-generated codebases become opaque. Neither the human nor the AI can hold them in mind, and every change begins with rediscovering how the system fits together.

Fragmentor makes the structure the primary artifact. A user should be able to look at a system, see its parts, see exactly what flows between them, open any part, and test it in isolation without understanding the rest.

## Two modes

When a project is created the person is asked a short series of questions, each following from the last: whether they are starting from nothing or from code they already have, what Fragmentor's role should be over that code, whether to plan the architecture before building it, how finely to divide the work, and optionally the language. These are the person's decisions rather than the agent's, so Fragmentor asks for them and writes them into `fragmentor.json` before any agent starts. The answers are what the agent's guide is written from, so the guide states what applies to this one project instead of listing the cases it might be in.

- **Structured.** The diagram is the specification. The agent builds the program as blocks, or rebuilds existing code that way; Fragmentor generates the code between blocks, checks the rest against the diagram, and runs the tests. Everything below about contracts, generated code and verification is structured mode.
- **Visual.** The diagram is a picture of code that exists anyway. The agent maps the codebase into blocks, each pointing at the file or function it stands for, and keeps the diagram current as the code changes. Fragmentor never generates, runs or changes the code. Types are free text as the code writes them, and testing is unavailable. What is checked is that the diagram holds together and that every block points at code that exists.

Rebuilding an existing codebase in structured mode is destructive by design, so the application asks for confirmation and the agent is told to make sure the code is committed first.

## What a block is

A block has:

- a role, saying what kind of thing it stands for: a function by default, or a piece of the architecture such as a database or a queue
- typed input ports
- typed output ports
- capability ports — declared effects the block needs, such as a database, HTTP access, the clock, or a model API
- a stated responsibility
- an implementation, which is either a leaf or a composite

A leaf block's implementation is code. A composite block's implementation is a set of child blocks and the connections between them.

Capability ports matter more than they first appear. Real software touches networks, disks, and databases, and a block model that only permits pure functions collapses immediately. Declaring effects as ports that flow down the hierarchy means any block can be run in isolation with substitutes supplied for its capabilities. This is what makes every block independently testable.

Capabilities are described in the same port type language as everything else, so each target language renders them its own way rather than the model favouring one.

### Every function block is a function

In structured mode every block whose role is `function` corresponds to a real, callable function in the code.

The user must be able to open any block, enter input values, run it, and see the outputs. That requirement forces callability, so there is no separate, cheaper representation for small blocks.

A conceptual step too small to justify its own function is not a block; it is a line inside a leaf block. Granularity control, not a second block representation, is what keeps the codebase from filling with trivial one-line functions.

## The rest of the system

A program is functions. An application is functions plus the things they talk to, and a diagram of the functions alone shows values arriving from nowhere and leaving for nowhere: where the data actually lives is not on it.

So a block carries a **role**. `function` is the block described above, and is what a block is unless it says otherwise. The rest — `service`, `external`, `database`, `storage`, `queue`, `client` — are **architecture**: parts of the system that are not Fragmentor's to write.

A role is the general kind. What a block is exactly — a dictionary, a REST API, PostgreSQL — is its own **subtype**, written in whatever words fit rather than chosen from a list, because no such list would ever be finished. It changes nothing but the label: blocks of one role are drawn alike however their subtypes differ.

An architecture block is not called, so it has no ports and no capabilities. It declares what it offers as **exposed entries**: a database's tables with their schemas, a queue's channels with the message on them, a service's operations with what they accept and return. A table drawn with its columns is the point — it is what makes the store worth looking at rather than merely naming.

Any block declares what it reaches as **access**: `reads app-db.users`, `writes app-db.orders`, `calls billing.charge`. This is declared by the block doing the reaching, the way a capability is, rather than by its parent the way a wire is: reaching a database is something the block itself does, and stays true wherever the block is moved. The block named is found by looking outward — the block's parent, then its parent, to the top of the system — so a handler deep inside a service reaches a database the service keeps beside it.

A wire and an access mean different things and are drawn differently. A wire is a value handed from one call into the next, and generated code depends on that meaning exactly. An access is a relationship with something the system talks to. Nothing is wired to a database.

Access is drawn per direction rather than per pair, because direction is the most important thing about it: a database that is read and written gets a line each way, not one line saying the two are connected. Everything leaves a block on its right and arrives on its left, the way its ports are drawn.

## How a diagram is arranged and coloured

The arrangement says something, so it has to be true. A diagram reads left to right from whoever sets the system going, through what they call, to what that calls in turn. Stores and queues are not steps in that: a service reads and writes a database in the same breath, and putting it further along would say it came after. They sit underneath instead, and the connection loops clockwise around the block — out of its right, down, and back up into its left. A queue written and never read is an endpoint but not the destination, because the system's answer goes back to whoever asked for it; it belongs under the flow rather than at the end of it.

Colour says which world a thing belongs to, and runs from what is most yours to what is least: your code, the data it holds, the data it keeps, your own separate programs, the people you serve, and the services you do not control. Which exact colours those are is the person's, not the project's: a kind's colour is changed from the legend and a single block's from the inspector, and both stay in that person's browser rather than in the files everyone shares. Green stays the signal colour it always was, so anything green is data moving inside the program and anything else is not. Red is spent on none of them: on this panel it means something is wrong.

A dashed line means one thing and only one thing: not built yet. Everything planned is grey and dashed, blocks and connections alike, whatever colour it would otherwise have taken.

A store is drawn on the diagram it belongs to and nowhere else, so where a store sits in the hierarchy is a decision that shows, and the diagrams under it are left to their own functions.

An arrangement is a default, not a rule. A person can move any block, and where they left it is remembered. So is a colour: which colour a kind or a single block takes is the person's, and stays in their browser rather than in the files everyone shares.

Nothing is generated, checked or run for an architecture block, or for a block holding one anywhere beneath it — the same rule as a plan, for the same reason: there is no chain of calls to write when one of the links is a database. The code that opens the real connections and calls into these is the framework's, and lives outside `blocks/`. The function blocks **inside** a service are ordinary blocks, generated, checked, run and tested as usual, which is what lets a project hold an honest end-to-end architecture at the top and a fully verified block hierarchy underneath each service.

Access says where data comes from and where it goes. It is not how the code gets there: block code still reaches the outside world only through its capabilities, and there is no database capability today. So an access belongs on whichever block really talks to the store — a service, whose code is outside `blocks/`, or a block with a capability that reaches it.

The roles are a vocabulary for reading, not a taxonomy to be enforced. Adding one is adding a description; everything that treats architecture differently asks only whether a role is code.

## Planned architecture

A block may be declared **planned**: part of the architecture rather than of the program. It appears on the diagram greyed out, carrying its responsibility and whatever connections have been worked out so far, and Fragmentor generates, checks and runs nothing for it. Its port types are prose as readily as types, because what flows between planned blocks is usually the thing still being decided.

Planning spreads downward — a block inside one that does not exist yet does not exist either. Upward it stops code rather than spreading: a block holding a planned block anywhere beneath it keeps its own contract but has no code to generate, because that code would call a function nobody has written. It is drawn as the real block it is, and the checks say plainly what it is waiting for.

This is what lets an architecture be argued with before it is built. A project created with plan-first begins entirely as planned blocks; the person reads the shape on the canvas, and the agent takes the flag off one block at a time as it builds them. A project built as it goes can still plan a part of itself this way.

## Relationship between the diagram and the code

The diagram is the specification. The agent writes the leaves; Fragmentor writes the composites.

A composite does nothing but call its children, so its code is generated from its wires rather than written by anyone. Connections appear as ordinary named variables passed between child function calls: a wire from block A's output to block B's input is a variable assigned from a call to A and passed into a call to B. Reading the diagram and reading the code should feel like reading the same thing twice, and because the code is generated, it cannot drift from the diagram. Code someone wrote inside a composite is reported rather than overwritten.

Leaves can still disagree with the diagram, so conformance is checked rather than assumed:

- each block is one exported function at a path determined by its position in the hierarchy, so block identity is structural rather than annotated
- a block's contract is expressed as runtime schemas for its inputs and outputs, which also drive the test bench forms
- leaf code is typechecked against its contract, and its imports are checked so that it can run on its own

There is no branching on the diagram. Conditions, loops and error handling live inside leaves until an example proves that insufficient.

## Where the AI fits

Fragmentor does not contain an AI and never calls a model. The AI is an external coding agent — Claude Code, Codex, or anything like them — working in the same project folder. The agent does the work; Fragmentor supplies the structure, the visibility, and the verification.

The workflow in structured mode is:

1. The user starts a project and gives the agent a goal.
2. The agent defines the architecture as blocks, following Fragmentor's rules.
3. Fragmentor reads that structure from disk and draws it, redrawing whenever the agent changes a file.
4. The agent writes the leaves and the tests; Fragmentor generates the rest.
5. Fragmentor validates the diagram, checks the code against it, and runs the tests.
6. The agent fixes whatever is reported, and the loop repeats.

A project keeps two things apart:

- **The architecture**, which is specific to the project and machine-readable: `fragmentor.json` and a `block.json` for each block. It is the single source of truth for the diagram.
- **The rules for working on it**: `FRAGMENTOR.md`, which Fragmentor writes into the project and keeps current. It is written for that one project — its mode, its language and its granularity — so it says only what applies there, and it is kept short, because an agent follows a short guide better than a complete one. `AGENTS.md` and `CLAUDE.md` point agents at it, and are otherwise the user's, for instructions specific to the project.

The agent checks its work with the `fragmentor` command, which runs the same checks the application relies on and reports them as text and an exit status.

Decomposition is still a review loop rather than a single shot. The user defines as much of the block hierarchy as they want, at any level, and the agent fills in the rest. The agent settles the structure first and lets the user review it on the canvas; code is written only after the structure is agreed, working bottom-up.

Decomposition depth is user-controlled. The granularity chosen when the project is created applies to the whole project, and any block may be pinned as a leaf. Granularity is expressed as a stop condition the agent evaluates — a block is a leaf when it has one clear responsibility with no further useful internal structure — with a hard depth limit as a safety net.

## Verification

Every block has tests, written by the agent alongside its code. This is not optional and is not limited to leaf blocks.

Beyond automated tests, each block has an interactive test bench. The block's input schema generates an input form, capability ports are filled with substitutes, and the user runs the block and compares actual outputs against expected ones, with data visualization where the output shape supports it.

Running a composite block records the value carried on every internal wire. The user can watch the values move through the diagram while a block runs, stop the run at a breakpoint before any block, and select a wire afterwards to see what flowed through it. This is the equivalent of a Simulink scope, and it is the main reason the diagram is worth looking at while debugging.

Each block carries a state: specified, implemented, tests passing, or stale. A block becomes stale when a contract it depends on changes. Stale propagation is what keeps a large hierarchy honest as it evolves.

## Developer interface

The interface is a visual canvas — dark, high-contrast, structural — where the user navigates the hierarchy, opens blocks, reads code, runs tests, inspects wires, and watches the agent's work take shape. Moving into a block and back out of it is animated as a zoom, and blocks appear on the diagram as the agent creates them, so the structure reads as a place rather than a series of pages. The user directs the agent in the agent's own tool; Fragmentor is where they see and check what it built.

**The user interacts through the UI.** Understanding the structure should come from looking at it, and every action the user takes should be a clear, clickable control. The user is never expected to learn or type commands to operate Fragmentor. The `fragmentor` command exists for the coding agent, and for developing and verifying Fragmentor itself; it is not a user-facing surface.

**Fragmentor is a desktop application.** There is no web version. The work is local: a project is a directory of files, the tools it drives are local, and nothing needs a server. The kernel is a library that the application and the agent's command both consume, never a tool the user drives directly.

If projects are ever shared, that happens through an ordinary repository holding the blocks and their code, rather than by moving the application online. Nothing in the file format should assume otherwise.

## Systems and languages

A project holds one or more systems. A system is a block hierarchy with a single target language. Systems in the same project are never connected to each other — they are separate programs, shown together because they are worked on together.

The target language is a choice, not an assumption. The block model, the validator and the project format know nothing about any language; that knowledge lives in a language pack, which owns naming conventions, file names, how a port type is written, the source of the generated contract, and the generated code of a composite. Adding a language means adding a pack, not editing the kernel. A visual project needs no pack: its code can be in any language.

Port contracts are defined with runtime schemas so a single definition yields both static types and the schema the test bench needs. Which library provides that is the pack's business — zod in TypeScript, pydantic in Python.

A block may use packages installed in the project, because real code does. What it may not do is reach the outside world except through its capabilities: importing a language's built-in file, network or process modules is refused, and for packages that do the same it is a rule the agent is told rather than one Fragmentor can enforce.

Two properties of the design limit which languages fit cleanly, and should be checked before adding a pack:

- **Capabilities are passed whole.** A block needing one capability receives the parent's entire capability object, which works because TypeScript and Python are structurally typed. A nominally typed language such as Go or Java would need each call site to construct the child's capabilities explicitly, which changes the shape of generated glue.
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
