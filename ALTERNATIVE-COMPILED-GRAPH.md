# Alternative design: the graph compiles to code

**Not important for now. Do not implement this. Nothing in this file describes current behavior.**

This file records a materially different version of Fragmentor that was considered and set aside. It exists so the idea can be picked up deliberately later instead of being rediscovered from scratch.

The current direction is recorded in `PROJECT.md`: the diagram is a specification, the AI writes all code including composite glue, and a conformance check verifies the code matches the diagram.

## The alternative in one sentence

The diagram is the source of truth, and the body of every composite block is generated mechanically from its wiring rather than written by the AI.

## How it would work

A leaf block is still AI-written code behind a fixed signature. Nothing changes there.

A composite block has no authored body at all. Its code is produced by a compiler that reads the block's child list and wires and emits the calls: children sorted into dependency order, each wire becoming a variable binding, independent branches awaited concurrently, and the composite's outputs assembled from the declared sources.

The generated file is not editable. Changing a composite means changing the diagram and recompiling.

Because pure dataflow cannot express everything, the graph vocabulary needs a small set of control primitives, which is where most of the design cost lands:

- `Branch` — a predicate selects one of several sub-paths
- `Map` — a child block runs once per element of a collection
- possibly `Reduce` and a bounded `While`

Anything the vocabulary cannot express must either be pushed down into a leaf block or force an escape hatch, and escape hatches reintroduce exactly the drift this design exists to eliminate.

## Why it is attractive

- **Drift becomes impossible for composites.** There is no authored code that can disagree with the diagram, so no conformance checker is needed and no block can silently rot.
- **Wire inspection is free.** The compiler already knows every wire, so instrumenting each one to record its value is a code generation detail rather than a static analysis problem.
- **Composite tests get stronger.** The runtime knows the structure, so it can substitute a fake for any child block without touching source.
- **The AI writes less code**, so there is less surface for it to be wrong on. Its judgment is confined to leaves and to structure.
- **Refactoring is mechanical.** Reordering, extracting, or regrouping blocks is a graph edit that recompiles correctly by construction.

## Why it was not chosen

- **The generated glue is not code a person would write.** The stated goal is that reading the diagram and reading the code feel like reading the same thing twice. Compiler output tends to read like compiler output, and the user specifically wanted to see plain function calls with named variables passing between blocks.
- **The graph vocabulary becomes the hard part of the project.** Every construct real software needs — error handling, early return, retries, resource lifetimes, transactions, cancellation — has to be given a diagram representation before the tool can express ordinary programs. That work is large, it must be largely right up front, and it is difficult to shrink later.
- **Expressiveness ceilings arrive early and are frustrating.** The failure mode is a user who knows exactly what code they want and cannot draw it.
- **It is a bigger bet before anything is proven.** The current design can be walked back toward this one after the block model has been exercised on real programs; going the other direction means discarding a compiler.

## What would justify revisiting it

- Conformance checking of AI-written glue turns out to be unreliable or expensive in practice, and blocks drift from their diagrams often enough to erode trust.
- The restricted glue dialect ends up so restricted that it is effectively a compiler input already, at which point generating it is simpler than checking it.
- Wire-level inspection proves too fragile to implement over authored code.
- Real usage shows the block vocabulary needed is much smaller than feared, because most complexity concentrates inside leaves.

## If it is ever built

Keep leaf blocks, contracts, capability ports, granularity control, block states, and the test bench exactly as they are. Only the composite body changes: authored plus checked becomes generated. Preserve a known-good checkpoint before starting, build it on a branch, and compare the two on the same example project rather than reasoning about them abstractly.
