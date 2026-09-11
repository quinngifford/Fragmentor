# Current Development Status

## Current focus

Fragmentor has been restructured around external coding agents. It no longer contains an AI. Claude Code or Codex works in the project folder; Fragmentor supplies the rules, redraws the system as it changes, and checks it. Next is running that loop with a real agent, and the conformance check that holds composite code to the diagram.

## Working

- **Block model.** Typed ports, capability ports that flow down by name, and a control vocabulary of straight-line plus per-item iteration.
- **Type expressions.** Port types are written and stored as `{ title: string; salary?: number }[]` and parsed into the structure the test bench walks. Round-tripping is held exact by test.
- **Project format.** A project's folder structure is its block hierarchy. Blocks load, validate, and write back unchanged.
- **Validator.** Checks wiring, arity across iterated children, capability supply, cycles, reserved child ids, pinned leaves and hierarchy depth, in plain language meant to be shown in the UI.
- **Agent guide.** Every project gets `FRAGMENTOR.md`: the general rules for an agent working in it, kept apart from the project's own architecture in `fragmentor.json` and `block.json`. It is kept current whenever code is generated, and its capability list, language files and signatures come from the same code the checks use. **New project** and `fragmentor init` also create `AGENTS.md` (Codex) and `CLAUDE.md` (Claude Code), which point at it. They are never rewritten, and if a folder already had its own that never mention the guide, Fragmentor says so. The guide's worked example is held by test to validate, check and pass its tests exactly as written.
- **The `fragmentor` command**, for the agent. `init` prepares a folder; `check` validates the diagram, regenerates contracts and checks the code, then lists blocks with no implementation or no tests; `test` runs saved tests. Errors exit with status 1. Checking the code means typechecking it against its contracts, and making sure each block imports only types and its own children's code, which is all the test runner can run. The typecheck works on projects outside the repository by lending them Fragmentor's own zod. The launcher runs the TypeScript source directly, so there is nothing to rebuild.
- **Language packs.** TypeScript (zod) and Python (pydantic). The kernel holds no language knowledge; naming, file names, type rendering and generated source all come from the pack. A project holds several systems, each with its own language, unconnected to each other.
- **Contract generation.** Every block gets a generated contract file: a zod schema and derived type per side, plus an interface for the effects it needs. `impl.ts` is scaffolded once and never overwritten. A file is only written when its contents change, so a check that changes nothing leaves the project untouched.
- **Examples.** `examples/job-ranker` holds two systems: a TypeScript ranker that is fully implemented with saved tests, and a Python embedder that is specified only. `examples/contract-generator` is Fragmentor describing its own contract generator, specified only. Both pass `fragmentor check`. They carry `FRAGMENTOR.md` but deliberately not `AGENTS.md` or `CLAUDE.md`, so an agent working on Fragmentor itself is not handed the guide as instructions.
- **Desktop application** (Electron). Opens a project from disk, draws its diagram, and writes changes back: draggable blocks saved to `layout.json`, bus-grouped connections, a code panel that saves `impl.ts`, a test bench, and saved tests.
- **Following the agent.** The open project is watched. The diagram, hierarchy and inspector redraw by themselves when files change, keeping the view and selection; a change that leaves the project as it was does not redraw. **New project…** prepares a folder for an agent and waits for it. A half-written file shows a banner over the last good diagram until it is whole. Validation problems are listed in the inspector, each leading to its block. Unsaved code edits warn when the file changes underneath them.
- **Running blocks.** A block runs in a separate process against given values, with substitutes for its capabilities. Input and output are checked against the contract, so a wrong value is a message rather than a crash.
- **Saved tests.** A block's tests live in `cases.json` in its own folder. A case is an input and, optionally, an expected output. A `cases.json` that cannot be read is reported as a problem, rather than silently counting as no tests.
- **The application checks itself.** `npm run check:app` plays an agent against a throwaway project. It covers the waiting screen, the project appearing, a rename on disk, a half-written file and its recovery, an edit conflict, and a wiring problem listed in the inspector. It also covers the older checks: editing, running, testing, dragging and navigation. It saves screenshots to `dist/self-check*.png`, and the command fails if any step fails.

## Not built yet

- The conformance check that holds composite code to the restricted glue style. Typechecking and the import rule catch a composite handing a child the wrong type of value, or importing code it cannot run. They do not catch a composite that calls the wrong children or adds logic of its own.
- Showing code problems in the application. Only `fragmentor check` reports them.
- Running or checking Python code, and so running the `embed-postings` system at all.
- Recording the values on wires, stale-state propagation, and per-block granularity overrides.

## Known problems or uncertainties

- **The agent workflow has not been run with a real agent.** Everything an agent does has been exercised by tests and the self-check. Whether an agent follows `FRAGMENTOR.md` well is untested, especially the restricted composite style and pausing for the person to review the structure.
- **The `fragmentor` command needs `npm link` once.** Without it an agent cannot find the command. The guide tells the agent to ask for it.
- **A redraw takes the cursor out of the code editor.** If the agent changes the project while the person is typing in a block's code, the inspector is rebuilt. The unsaved text is kept, but the focus and cursor position are not.
- **An edit conflict is warned about, not prevented.** Saving over a file the agent has since changed replaces the agent's change.
- **Reading the clock or randomness directly is not detected.** The guide tells agents to use the `Clock` and `Random` capabilities, but `Date.now()` and `Math.random()` still typecheck.
- **Wires carry whole port values.** There is no way to take one field out of an object on a wire, worked around by having a block accept the whole object.
- **The port type language has no recursion**, so it cannot describe its own types. The self-hosted example passes port types across block boundaries as expression strings and does the recursion inside a leaf. That works, and may be the right answer, but it is a real ceiling.
- **A block cannot use a library.** Implementations are compiled into a throwaway directory with no `node_modules`, and the import rule reports any attempt. Blocks that use only the language and their capabilities work, which is every block written so far.
- **Python module resolution is unsettled.** Generated Python imports `capabilities` and `contract` by bare name, which assumes something puts them on the path. Block folders are kebab-case and so are not importable as packages. This has to be decided before Python blocks can run.
- **An optional port is not quite the same in both packs.** TypeScript renders it as an absent property; Python renders it as a field with a `None` default, which also permits an explicit null.
- **A block cannot appear twice in one parent**, because children are identified by folder.
- **The restricted glue dialect is written down but only partly checked.** `FRAGMENTOR.md` states it as rules. If it ends up so restricted that it is effectively compiler input, the compiled-graph alternative becomes the simpler design.
- No conditional or error-handling vocabulary exists on the diagram. Branching lives inside leaves until an example proves that insufficient.

## Human verification needed

- **The agent workflow, end to end.** Run `npm link` once, then `npm run app`. Choose **New project…** and pick an empty folder, then open Claude Code or Codex in that folder and ask for a small program. Things to judge: whether the diagram keeps up, whether the agent follows the rules and checks its work, and whether problems are easy to see.
- **The application in ordinary use.** Running a block from the test bench; whether dragging, zooming and the code panel feel right.

## Current checkpoint

- Branch `agent-workflow`, off `main`. `main` is the last checkpoint before the restructure. Every commit is a working tree with a passing suite.

## Next major steps

1. Run the loop with a real agent on a small program, and tighten `FRAGMENTOR.md` wherever the agent goes wrong.
2. Build the conformance check and add it to `fragmentor check`. This is still the decision point for the whole "graph is a spec" design.
3. Show everything `fragmentor check` finds in the application, code problems included, against the blocks they belong to.
4. Implement the `contract-generator` leaves.

## Status-file rule

Keep this file as a concise snapshot of current truth.

Do not use it as a chronological development diary. Git already stores history.

Remove or replace stale information instead of endlessly appending updates.
