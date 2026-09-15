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
2. Choose **New project…**. Decide what Fragmentor should do with the code and how finely to divide it, then pick a folder: an empty one, or one that already holds code.
3. Open your coding agent in that folder and tell it what you want.

In **structured** mode the agent reads `FRAGMENTOR.md`, defines the blocks, writes the code and the tests, and runs `fragmentor check` and `fragmentor test` until both pass. Fragmentor writes the code that connects the blocks. In a folder that already holds code, the agent rebuilds that code as blocks.

In **visual** mode the agent maps the code already in the folder into a diagram, and never changes it.

The diagram updates as the agent works.

`PROJECT.md` describes what Fragmentor is for. `STATUS.md` describes where development stands.
