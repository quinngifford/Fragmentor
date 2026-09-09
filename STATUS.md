# Current Development Status

## Current focus

Design settled; nothing implemented yet. The next step is proving the kernel — whether an AI can decompose a real requirement into a coherent block hierarchy with precise contracts whose generated blocks compose into working software — headlessly, before any canvas is built.

## Working

- Nothing implemented yet. The repository currently contains project documentation only.

## Decided

- The diagram is a specification; the AI writes all code, including composite glue, and a conformance check verifies the code matches the diagram.
- Every block is a real callable function, because the interactive test bench requires callability. Steps too small to justify a function are lines inside a leaf, not blocks.
- Effects are declared as capability ports that flow down the hierarchy, so any block can run in isolation with substitutes supplied.
- Generated code is TypeScript only. Port contracts use runtime schemas that also drive test bench forms.
- The compiled-graph alternative is recorded in `ALTERNATIVE-COMPILED-GRAPH.md` and is deliberately not being built.

## In development

- Nothing yet.

## Known problems or uncertainties

- Whether AI decomposition produces hierarchies that are stable and sensible rather than arbitrary is the central unproven risk.
- Whether conformance checking of AI-written composite glue is reliable enough to keep the diagram trustworthy is unproven.
- The restricted glue dialect that makes conformance checkable has not been specified.
- The canvas technology is intentionally undecided until the kernel is proven.

## Human verification needed

- None yet.

## Current checkpoint

- Not recorded. The repository is not yet under version control; create the first checkpoint once a working baseline exists.

## Next major steps

1. Build the headless kernel: block model and on-disk project format, contract representation, AI decomposition loop, leaf and glue code generation, test generation, conformance check.
2. Prove it end to end by building one small real program with it.
3. AI-verify, then human-verify the result.
4. Checkpoint before starting the canvas.

## Status-file rule

Keep this file as a concise snapshot of current truth.

Do not use it as a chronological development diary. Git already stores history.

Remove or replace stale information instead of endlessly appending updates.
