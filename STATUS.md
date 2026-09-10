# Current Development Status

## Current focus

Blocks run, and tests can be saved against them. The job-ranker system is fully implemented and ships with saved tests. Next is the conformance check that holds written code to the diagram.

## Working

- **Block model.** Typed ports, capability ports that flow down by name, and a control vocabulary of straight-line plus per-item iteration.
- **Type expressions.** Port types are written and stored as `{ title: string; salary?: number }[]` and parsed into the structure the test bench will walk. Round-tripping is held exact by test.
- **Project format.** A project's folder structure is its block hierarchy. Blocks load, validate, and write back unchanged.
- **Validator.** Checks wiring, arity across iterated children, capability supply, and cycles, in plain language meant to be shown in the UI.
- **AI decomposition.** A proposal is turned into real blocks, run through the ordinary validator, and any problems are handed back to the model to correct. Tested against a scripted client including retry and give-up behaviour.
- **Worked example.** `examples/job-ranker` is produced by the real pipeline and exercised end to end by test: seed block, two rounds of decomposition, written to disk, read back, validated.
- **Language packs.** TypeScript (zod) and Python (pydantic). The kernel holds no language knowledge; naming, file names, type rendering and generated source all come from the pack. A project holds several systems, each with its own language, unconnected to each other.
- **Contract generation.** Every block gets a generated contract file: a zod schema and derived type per side, plus an interface for the effects it needs. Schemas are tested by behaviour, not spelling, and the generated code typechecks under strict mode (`npm run check:examples`). `impl.ts` is scaffolded once and never overwritten.
- **Self-hosted example.** `examples/contract-generator` is Fragmentor describing its own contract generator as blocks. `examples/job-ranker` holds two systems: the ranker in TypeScript and an embedding system in Python. Generated TypeScript typechecks (`npm run check:examples`) and generated Python parses (`npm run check:examples:py`).
- **Desktop application** (Electron). Opens a project from disk, draws its diagram, and writes changes back. Pan and zoom, draggable blocks whose positions are saved into the project's `layout.json`, bus-grouped connections, ctrl-click multi-select, per-bus colours, and a code panel that saves `impl.ts` to disk. Generated `contract.ts` is shown read-only, because it is derived from the diagram.
- **Running blocks.** A block runs in a separate process against values typed into the test bench, with substitutes for its capabilities. The input is checked against the contract before anything runs and the output is checked afterwards, so a wrong value is a message rather than a crash and a block that returns the wrong shape is caught. Implementations are compiled into a throwaway copy, so nothing is written into the project.
- **Saved tests.** A block's tests live in `cases.json` in its own folder, so they travel with it. A case is an input and, optionally, an expected output; running them reports passed, failed with the exact differences, or unchecked when there is no expectation yet. The system is compiled once for the whole run.
- **A worked system that actually works.** Every block of `examples/job-ranker`'s TypeScript system is implemented, including the composite glue. Running `rank-jobs` reads a postings file through its FileSystem capability, scores four postings and ranks them.
- **The application checks itself.** `npm run check:app` starts the real window, opens an example, edits a block's code, saves it, restores it, and reports what was drawn — then captures a screenshot to `dist/self-check.png`. It fails the command if the interface did not draw.

## Not built yet

- Leaf implementations and composite glue. Only the contract layer is generated; every `impl.ts` still throws.
- The conformance check that holds written code to the diagram.
- Generated tests. Tests can be written and saved by hand, but the AI does not yet propose them.
- Decomposition from inside the application. The AI loop exists but is only reachable from tests.
- Running Python blocks, and running the `embed-postings` system at all.

## Known problems or uncertainties

- **Decomposition has never run against a live model.** No API key is configured, so every decomposition so far came from a scripted client replaying an authored proposal. The pipeline is proven; the model's reliability at this task is not.
- **Wires carry whole port values.** There is no way to take one field out of an object on a wire, worked around by having a block accept the whole object.
- **The port type language has no recursion**, so it cannot describe its own types. The self-hosted example passes port types across block boundaries as expression strings and does the recursion inside a leaf. That works, and may be the right answer, but it is a real ceiling.
- **A block that imports a library will not run.** Implementations are compiled into a throwaway directory with no `node_modules`, so a block that imports an npm package at runtime cannot resolve it. Blocks that use only the language and their capabilities run fine, which is every block written so far.
- **Python module resolution is unsettled.** Generated Python imports `capabilities` and `contract` by bare name, which assumes something puts them on the path. Block folders are kebab-case and so are not importable as packages. This has to be decided before Python blocks can run.
- **An optional port is not quite the same in both packs.** TypeScript renders it as an absent property; Python renders it as a field with a `None` default, which also permits an explicit null.
- **A block cannot appear twice in one parent**, because children are identified by folder. Rendering two schemas needed one block doing both rather than the same block used twice.
- **The restricted glue dialect is unspecified.** Conformance checking depends on it, and if it ends up so restricted that it is effectively compiler input, the compiled-graph alternative becomes the simpler design.
- No conditional or error-handling vocabulary exists on the diagram. Branching lives inside leaves until an example proves that insufficient.

## Human verification needed

- The application in ordinary use: `npm run app`. Running a block from the test bench, whether the bus grouping reads better than per-signal wires, and whether dragging, zooming and the code panel feel right.

## Current checkpoint

- `main`. Every commit is a working tree with a passing suite.

## Next major steps

1. Build the conformance check and find out whether it holds. This is the decision point for the whole "graph is a spec" design.
2. Generate tests for each block, and run them from the same place blocks run.
3. Implement the `contract-generator` leaves, closing the self-hosting loop.
4. Bring decomposition into the application, once there is an API key to run it against.

## Status-file rule

Keep this file as a concise snapshot of current truth.

Do not use it as a chronological development diary. Git already stores history.

Remove or replace stale information instead of endlessly appending updates.
