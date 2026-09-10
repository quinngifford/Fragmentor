---
name: simplify
description: Reduce unnecessary code and architectural complexity while preserving useful behavior and correctness.
---

# Simplify

Use when a subsystem may have accumulated unnecessary complexity, especially after experimentation, repeated patches, or changing requirements.

Inspect the working implementation before changing it.

Look for:

- unnecessary files
- unnecessary abstractions
- duplicate logic
- obsolete code
- abandoned experimental paths
- compatibility layers that are no longer needed
- wrappers that add no meaningful value
- dependencies that can be removed
- functionality that is no longer required
- overly general solutions to narrow current problems

Prefer deletion, consolidation, and direct code over rewriting everything.

Do not reduce correctness, useful functionality, readability, or testability merely to reduce line count.

Do not perform broad cleanup unrelated to the requested scope unless it is required to safely remove the complexity being addressed.

After simplification, verify that important behavior still works.

Report simply:

- what was removed or simplified
- why it was unnecessary
- whether behavior changed
- how the remaining behavior was verified
