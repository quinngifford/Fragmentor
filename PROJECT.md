# Product

Fragmentor is a modular, block-based environment for AI-assisted software development.

Software is designed as a hierarchy of blocks — systems and subsystems — with precisely defined contracts and connections between them. The AI decomposes a design into blocks, writes the code for each block, writes verification tests for every block, and wires the blocks together. The user inspects, tests, and steers the structure through a visual canvas.

The reference point is MATLAB Simulink, applied to general software development rather than signal processing.

## Why

Large AI-generated codebases become opaque. Neither the human nor the AI can hold them in mind, and every change begins with rediscovering how the system fits together.

Fragmentor makes the structure the primary artifact. A user should be able to look at a system, see its parts, see exactly what flows between them, open any part, and test it in isolation without understanding the rest.

## What a block is

A block has:

- typed input ports
- typed output ports
- capability ports — declared effects the block needs, such as a database, HTTP access, the clock, or a model API
- a stated responsibility
- an implementation, which is either a leaf or a composite

A leaf block's implementation is code. A composite block's implementation is a set of child blocks and the connections between them.

Capability ports matter more than they first appear. Real software touches networks, disks, and databases, and a block model that only permits pure functions collapses immediately. Declaring effects as ports that flow down the hierarchy means any block can be run in isolation with substitutes supplied for its capabilities. This is what makes every block independently testable.

### Every block is a function

Every block corresponds to a real, callable function in the generated code.

The user must be able to open any block, enter input values, run it, and see the outputs. That requirement forces callability, so there is no separate, cheaper representation for small blocks.

A conceptual step too small to justify its own function is not a block; it is a line inside a leaf block. Granularity control, not a second block representation, is what keeps the codebase from filling with trivial one-line functions.

## Relationship between the diagram and the code

The diagram is the specification. The AI writes all of the code, including the glue inside composite blocks.

Inside a composite block, connections appear in the code as ordinary named variables passed between child function calls. A wire from block A's output to block B's input is a variable assigned from a call to A and passed into a call to B. Reading the diagram and reading the code should feel like reading the same thing twice.

Generated code can drift from the diagram it claims to implement, so conformance is checked rather than assumed:

- each block is one exported function at a path determined by its position in the hierarchy, so block identity is structural rather than annotated
- a block's contract is expressed as runtime schemas for its inputs and outputs, which also drive the test bench forms
- composite glue is written in a deliberately restricted style — straight-line bindings and calls — so a static check can confirm the code calls exactly the declared children with arguments from the declared sources

Drift is therefore a visible, reported state on a block rather than silent rot.

An alternative design in which the diagram compiles directly into composite code is recorded in `ALTERNATIVE-COMPILED-GRAPH.md`. It is not the current direction.

## AI decomposition

The user defines as much of the block hierarchy as they want, at any level. The AI fills in the rest.

Decomposition is a review loop, not a single shot. For an undefined block, the AI proposes child blocks, their contracts, and the wiring between them. The user accepts, edits, regenerates, or pins the block as a leaf. Code is written only after the structure is agreed, working bottom-up.

Decomposition depth is user-controlled. A default granularity applies to the whole project, individual blocks may override it, and any block may be pinned as a leaf. Granularity is expressed as a stop condition the AI evaluates — a block is a leaf when it has one clear responsibility with no further useful internal structure — with a hard depth limit as a safety net.

## Verification

Every block has generated tests. This is not optional and is not limited to leaf blocks.

Beyond automated tests, each block has an interactive test bench. The block's input schema generates an input form, capability ports are filled with substitutes, and the user runs the block and compares actual outputs against expected ones, with data visualization where the output shape supports it.

Running a composite block records the value carried on every internal wire. Selecting a wire shows what actually flowed through it. This is the equivalent of a Simulink scope, and it is the main reason the diagram is worth looking at while debugging.

Each block carries a state: specified, implemented, tests passing, or stale. A block becomes stale when a contract it depends on changes. Stale propagation is what keeps a large hierarchy honest as it evolves.

## Developer interface

The interface is a visual canvas — dark, high-contrast, structural — where the user navigates the hierarchy, opens blocks, reads code, runs tests, inspects wires, and directs the AI.

**The user interacts through the UI.** Understanding the structure should come from looking at it, and every action the user takes should be a clear, clickable control. The user is never expected to learn or type commands to operate Fragmentor. Any command-line tooling exists as internal scaffolding for development and verification of Fragmentor itself, and is not a user-facing surface.

**Fragmentor is a desktop application.** There is no web version. The work is local: a project is a directory of files, the tools it drives are local, and nothing needs a server. The kernel is a library the application consumes, never a tool the user drives directly.

If projects are ever shared, that happens through an ordinary repository holding the blocks and their code, rather than by moving the application online. Nothing in the file format should assume otherwise.

## Scope

Fragmentor generates TypeScript. Port contracts are defined with runtime schemas so a single definition yields both static types and the schema the test bench needs.

Not in scope now:

- generating code in languages other than TypeScript
- importing or reverse-engineering existing codebases into blocks
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
