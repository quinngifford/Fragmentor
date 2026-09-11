# Fragmentor

Fragmentor shows software as a hierarchy of blocks, each a function with typed inputs, typed outputs and declared effects, and checks that the code matches the diagram.

It does not contain an AI. A coding agent such as Claude Code or Codex builds the software in the project folder, following the rules Fragmentor writes there. Fragmentor draws the system as it grows, points out what is wrong, and runs the tests.

## Setup

```bash
npm install
npm link
```

`npm link` is needed once. It puts the `fragmentor` command on your PATH, which is how coding agents check their work.

## Use

1. Start Fragmentor with `npm run app`.
2. Choose **New project…** and pick an empty folder.
3. Open your coding agent in that folder and tell it what you want built.

The agent reads `FRAGMENTOR.md`, defines the blocks, writes the code and the tests, and runs `fragmentor check` and `fragmentor test` until both pass. The diagram updates as it works.

`PROJECT.md` describes what Fragmentor is for. `STATUS.md` describes where development stands.
