---
name: develop-module
description: Develop and prove one substantial capability in isolation before integrating it into the larger application.
---

# Develop Module

Use for substantial capabilities that can be developed and verified separately from the full product.

The goal is development isolation, not abstraction for its own sake.

## Process

1. Define the smallest useful behavior the module must prove.
2. Inspect existing code that genuinely affects the module.
3. Keep unrelated systems out of scope.
4. Build the simplest standalone or locally testable version first when practical.
5. Avoid production infrastructure unless the capability cannot be meaningfully proven without it.
6. Verify the module's behavior with `verify-feature`.
7. Use `human-verification` when direct user observation adds meaningful confidence.
8. Once the module is stable, create or recommend a checkpoint before broad integration or the next major module.

A module should not be considered stable merely because code was written.

A useful progression is:

- in development
- implemented
- AI verified
- human verified when appropriate
- stable / checkpointed

Only integrate a module into larger application architecture after its underlying behavior is sufficiently understood and verified.

Do not create unnecessary interfaces, plugin systems, or generalized frameworks merely to call the work "modular."
