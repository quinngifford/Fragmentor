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
2. Choose **New project…** and answer its questions: where you are starting from, what Fragmentor should do with the code, whether to plan the architecture before building it, and how finely to divide the work. Then pick a folder: an empty one, or one that already holds code.
3. Open your coding agent in that folder and tell it what you want.

In **structured** mode the agent reads `FRAGMENTOR.md`, defines the blocks, writes the code and the tests, and runs `fragmentor check` and `fragmentor test` until both pass. Fragmentor writes each function's types and checks the code against them; a function calls the others it needs directly. In a folder that already holds code, the agent rebuilds that code as blocks.

In **visual** mode the agent maps the code already in the folder into a diagram, and never changes it.

A diagram is not only functions. A block can stand for a group of parts, a database, a queue, a store, a service of yours, someone else's API, or the browser that starts a request. Those carry what they offer rather than ports — a database shows its tables and their columns — and the blocks that read or write them are joined to them, so the diagram says where data is kept and who can reach it. Colour says which world each thing belongs to. Fragmentor generates, checks and runs nothing for these blocks; the functions inside a service are ordinary blocks and are checked and tested as usual. `examples/tickets` is a whole application drawn this way, and it runs.

If you asked to plan first, the agent draws the whole architecture before building any of it. Blocks that are only planned appear greyed out, with nothing generated, checked or run for them; they turn into ordinary blocks as the agent builds them.

The diagram updates as the agent works.

`PROJECT.md` describes what Fragmentor is for. `STATUS.md` describes where development stands.
