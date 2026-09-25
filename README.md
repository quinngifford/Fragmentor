# Fragmentor

Fragmentor shows software as a hierarchy of blocks: the parts a system is made of, each drawn inside the part that owns it — functions, groups of them, and the databases, queues, services and clients they talk to. It checks that the code matches the diagram, and shows what actually happens when something sets the system going.

It does not contain an AI. A coding agent such as Claude Code or Codex builds the software in the project folder, following the rules Fragmentor writes there. Fragmentor draws the system as it grows, points out what is wrong, and runs the tests.

## Setup

```bash
npm install
npm link
```

`npm link` is needed once. It puts the `fragmentor` command on your PATH, which is how coding agents check their work.

## Use

1. Start Fragmentor with `npm run app`.
2. Choose **New project…**, on the start screen or under **File**, and answer its questions: where you are starting from, whether to plan the architecture before building it, and how finely to divide the work. Then pick a folder: an empty one, or one that already holds code.
3. Open your coding agent in that folder and send it the first command Fragmentor shows you: `fragmentor rebuild` to draw code you already have, `fragmentor plan <what you want to build>` to plan first, or `fragmentor make <what you want to build>` to build straight away. Everything else you can ask it is under **Commands**, at the top right.

The agent reads `FRAGMENTOR.md`, defines the blocks, writes the code wherever it belongs in the codebase, points each block at it, and runs `fragmentor check` and `fragmentor test` until both pass. Nothing requires the code to sit anywhere in particular: a block's folder says where the block is in the architecture, not where its code is on disk.

Fragmentor writes each block's types, as a contract in the block's own folder, wherever it can. Code that imports its contract is checked against it, can be run from the window with values you type, and has tests; code that does not — code that was there before Fragmentor, or is written in a language it has no pack for — is drawn and read instead. `fragmentor check` says which blocks are which and why, so nothing is quietly unchecked.

A diagram is not only functions. A block can stand for a group of parts, a database, a queue, a store, a service of yours, someone else's API, or the browser that starts a request. Those carry what they offer rather than ports — a database shows its tables and their columns — and the blocks that read or write them are joined to them, so the diagram says where data is kept and who can reach it. Colour says which world each thing belongs to. Fragmentor generates, checks and runs nothing for these blocks; the functions inside a service are ordinary blocks and are checked and tested as usual. `examples/tickets` is a whole application drawn this way, and it runs.

The whole system is one drawing: every block under the block it is part of, joined by plain lines that mean only that. Click a block for its details, or open its code in a window of its own; fold a block to put its parts away.

The agent also writes down what happens: for each thing that sets the system going — a button, a request, a scheduled job — an execution under `executions/`, with every step it takes through the architecture, what each step is, and the function that makes it. Pick one above the diagram and step through it a single arrow at a time, or switch to Flow to see the whole run laid out from beginning to end. `examples/messenger` is a chat application described this way.

If you asked to plan first, the agent draws the whole architecture before building any of it. Blocks that are only planned appear greyed out, with nothing generated, checked or run for them; they turn into ordinary blocks as the agent builds them.

The diagram updates as the agent works.

`PROJECT.md` describes what Fragmentor is for. `STATUS.md` describes where development stands.
