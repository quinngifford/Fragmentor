---
name: human-verification
description: Prepare simple manual testing steps so the user can personally verify important behavior.
---

# Human Verification

Use when seeing or interacting with the real behavior would provide meaningful confidence beyond automated verification.

Prepare any setup needed beforehand when possible.

Then give simple step-by-step instructions explaining:

- exactly where to go
- exactly what to click, type, upload, or run
- what should happen at each important step
- what success looks like
- what would indicate something is wrong

Assume the user does not know the internal implementation.

Keep the test focused on the feature being verified.

If commands are required, provide the exact command and briefly explain what it does.

If you create a testing tool, script, fixture, or developer UI for the user, make it easy to find and use and explain what it is for.

Do not require human verification when automated verification already establishes the behavior sufficiently and there is no meaningful benefit from manual inspection.
