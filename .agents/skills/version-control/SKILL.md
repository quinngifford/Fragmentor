---
name: version-control
description: Keep substantial development safely checkpointed, recoverable, and suitable for independent experiments when needed.
---

# Version Control

Use version control to keep substantial development recoverable.

Before risky or significant changes:

- inspect the current repository state
- avoid overwriting unrelated user work
- identify the current known-good state
- create or recommend a clear checkpoint when appropriate

After meaningful stable milestones, create or recommend another checkpoint.

Use clear commit/checkpoint descriptions that state what became stable.

When several substantially different approaches to the same problem deserve real evaluation:

- preserve a shared known-good checkpoint
- develop the alternatives independently when practical
- avoid letting experimental paths interfere with each other
- compare behavior, complexity, reliability, and other relevant tradeoffs before choosing
- do not merge an experimental approach into the main development path merely because it was implemented

Before destructive Git operations, explain exactly what would be lost and get user approval.

If development becomes stuck, identify the safest known checkpoint and explain how returning to it would affect current work.
