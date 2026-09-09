# Current Development Status

## Current focus

Building the headless kernel. Model, project format, validator, decomposition, and contract generation all work, under 113 tests. Next is the part that can actually run: leaf implementations, then the conformance check.

## Working

- **Block model.** Typed ports, capability ports that flow down by name, and a control vocabulary of straight-line plus per-item iteration.
- **Type expressions.** Port types are written and stored as `{ title: string; salary?: number }[]` and parsed into the structure the test bench will walk. Round-tripping is held exact by test.
- **Project format.** A project's folder structure is its block hierarchy. Blocks load, validate, and write back unchanged.
- **Validator.** Checks wiring, arity across iterated children, capability supply, and cycles, in plain language meant to be shown in the UI.
- **AI decomposition.** A proposal is turned into real blocks, run through the ordinary validator, and any problems are handed back to the model to correct. Tested against a scripted client including retry and give-up behaviour.
- **Worked example.** `examples/job-ranker` is produced by the real pipeline and exercised end to end by test: seed block, two rounds of decomposition, written to disk, read back, validated.
- **Contract generation.** Every block gets a generated `contract.ts`: a zod schema and derived type per side, plus an interface for the effects it needs. Schemas are tested by behaviour, not spelling, and the generated code typechecks under strict mode (`npm run check:examples`). `impl.ts` is scaffolded once and never overwritten.
- **Self-hosted example.** `examples/contract-generator` is Fragmentor describing its own contract generator as blocks, and Fragmentor generates that project's contracts. 13 blocks across the two examples, 28 generated files, all compiling.
- **Canvas prototype.** `prototypes/canvas.html` renders both projects from exported project data: pan and zoom, draggable blocks, bus-grouped connections, ctrl-click multi-select, a per-block code panel, and per-bus colours. Positions, colours and code edits are kept in the viewer's browser only. It is a design prototype, not connected to the kernel. The build parses the finished page's script and refuses to write one that would render nothing.

## Not built yet

- Leaf implementations and composite glue. Only the contract layer is generated; every `impl.ts` still throws.
- The conformance check that holds written code to the diagram.
- Test generation and a way to run a block.
- The real application. The canvas prototype is a drawing, not the product.

## Known problems or uncertainties

- **Decomposition has never run against a live model.** No API key is configured, so every decomposition so far came from a scripted client replaying an authored proposal. The pipeline is proven; the model's reliability at this task is not.
- **Wires carry whole port values.** There is no way to take one field out of an object on a wire, worked around by having a block accept the whole object.
- **The port type language has no recursion**, so it cannot describe its own types. The self-hosted example passes port types across block boundaries as expression strings and does the recursion inside a leaf. That works, and may be the right answer, but it is a real ceiling.
- **A block cannot appear twice in one parent**, because children are identified by folder. Rendering two schemas needed one block doing both rather than the same block used twice.
- **The restricted glue dialect is unspecified.** Conformance checking depends on it, and if it ends up so restricted that it is effectively compiler input, the compiled-graph alternative becomes the simpler design.
- No conditional or error-handling vocabulary exists on the diagram. Branching lives inside leaves until an example proves that insufficient.

## Human verification needed

- The canvas prototype: whether the bus grouping reads better than per-signal wires, and whether the interaction model is right, before any of it is built for real.
- Whether the prototype should become the real application rather than being rebuilt. It now carries enough behaviour that throwing it away has a cost.

## Current checkpoint

- `main`. Every commit is a working tree with a passing suite.

## Next major steps

1. Implement the four leaves of `examples/contract-generator` and wire the composite, so a Fragmentor project generates contracts and can be checked against the hand-written generator it mirrors.
2. Build the conformance check and find out whether it holds.
3. Generate and run tests for each block.
4. Decide what the real application is built with.

## Status-file rule

Keep this file as a concise snapshot of current truth.

Do not use it as a chronological development diary. Git already stores history.

Remove or replace stale information instead of endlessly appending updates.
