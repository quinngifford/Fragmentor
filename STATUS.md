# Current Development Status

## Current focus

Building the headless kernel. The block model, project format, validator, and AI decomposition loop work and are tested. Code generation is the next piece.

## Working

- **Block model.** Typed ports, capability ports that flow down by name, and a control vocabulary of straight-line plus per-item iteration. 92 tests.
- **Type expressions.** Port types are written and stored as `{ title: string; salary?: number }[]` and parsed into the structure the test bench will walk. Round-tripping is held exact by test.
- **Project format.** A project's folder structure is its block hierarchy. Blocks load, validate, and write back unchanged.
- **Validator.** Checks wiring, arity across iterated children, capability supply, and cycles, in plain language meant to be shown in the UI.
- **AI decomposition.** A proposal is turned into real blocks, run through the ordinary validator, and any problems are handed back to the model to correct. Tested against a scripted client including retry and give-up behaviour.
- **Worked example.** `examples/job-ranker` is produced by the real pipeline and exercised end to end by test: seed block, two rounds of decomposition, written to disk, read back, validated.
- **Canvas prototype.** `prototypes/canvas.html` renders that example from exported project data. It is a design prototype, not connected to the kernel.

## Not built yet

- Code generation for leaf blocks and composite glue.
- The conformance check that holds generated code to the diagram.
- Test generation and a way to run a block.
- The real application. The canvas prototype is a drawing, not the product.

## Known problems or uncertainties

- **Decomposition has never run against a live model.** No API key is configured, so every decomposition so far came from a scripted client replaying an authored proposal. The pipeline is proven; the model's reliability at this task is not.
- **Wires carry whole port values.** There is no way to take one field out of an object on a wire, which was noticed while building the example and worked around by having a block accept the whole object. Whether field access belongs on the diagram is unresolved.
- **The restricted glue dialect is unspecified.** Conformance checking depends on it, and if it ends up so restricted that it is effectively compiler input, the compiled-graph alternative becomes the simpler design.
- No conditional or error-handling vocabulary exists on the diagram. Branching lives inside leaves until an example proves that insufficient.

## Human verification needed

- The canvas prototype: whether the visual language reads correctly and the interaction model is right, before it is built for real.

## Current checkpoint

- `cd40a35` and later on `main`. Every commit so far is a working tree with a passing suite.

## Next major steps

1. Generate leaf implementations and composite glue for the example project.
2. Build the conformance check and find out whether it holds.
3. Generate and run tests for each block.
4. Get the example running end to end, then decide what the real application is built with.

## Status-file rule

Keep this file as a concise snapshot of current truth.

Do not use it as a chronological development diary. Git already stores history.

Remove or replace stale information instead of endlessly appending updates.
