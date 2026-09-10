---
name: verify-feature
description: Verify that an implemented change actually works and report the evidence clearly.
---

# Verify Feature

Verify the requested behavior using the most relevant available methods, such as:

- focused automated tests
- integration tests
- type checking
- linting
- builds
- controlled local execution
- browser/UI testing
- inspection of outputs or persisted state

Choose verification proportional to the change. Do not create meaningless tests merely to increase test count.

Actively look for likely failure modes and important edge cases.

Fix problems caused by the change when appropriate, then re-run the relevant verification.

Use a fresh `tester` agent when independent verification would materially improve confidence or when verification produces large/noisy output that should stay outside the main context.

Clearly report in simple language:

## Verified automatically

What was actually tested and the evidence that passed.

## Problems found and fixed

Any failures discovered during verification and what changed.

## Not verified automatically

Anything the available environment could not establish.

## Remaining risk

Any meaningful uncertainty that still exists.

Never claim something was tested if it was only inspected.
