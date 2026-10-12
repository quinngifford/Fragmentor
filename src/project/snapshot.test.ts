import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blockDir, createProject, writeBlock, loadProject } from "./project.js";
import type { Manifest } from "./project.js";
import { NOTES_DIR, addNote, replyToNote, resolveNote } from "./notes.js";
import { projectSnapshot } from "./snapshot.js";
import { emitProject } from "../codegen/emit.js";
import { makeBlock, t } from "../model/testing.js";

let dir: string;

const manifest: Manifest = {
  name: "Doubler",
  goal: "Double a number.",
  existingCode: false,
  start: "build",
  granularity: { level: 3, maxDepth: 3 },
  systems: [{ rootBlock: "double-it", language: "typescript" }],
};

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "fragmentor-snap-"));

  const root = makeBlock({
    id: "double-it",
    name: "Double It",
    code: "src/double-it.ts#doubleIt",
    inputs: { value: { type: t.number, description: "The number to double." } },
    outputs: { doubled: { type: t.number } },
  });

  const child = makeBlock({
    id: "add-to-self",
    name: "Add To Self",
    code: "src/add-to-self.ts#addToSelf",
    inputs: { value: { type: t.number } },
    outputs: { sum: { type: t.number } },
  });

  await createProject(dir, manifest, [root]);
  await writeBlock(blockDir(dir, "double-it/add-to-self"), child);
  await mkdir(path.join(dir, "src"), { recursive: true });
  await writeFile(
    path.join(dir, "src", "double-it.ts"),
    [
      'import type { DoubleItInput, DoubleItOutput, DoubleItCaps } from "../blocks/double-it/contract.js";',
      "",
      "export async function doubleIt(input: DoubleItInput, caps: DoubleItCaps): Promise<DoubleItOutput> {",
      "  return { doubled: input.value * 2 };",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("projectSnapshot", () => {
  it("describes every block, with types both as text and as structure", async () => {
    const snapshot = await projectSnapshot(dir);

    expect(snapshot.name).toBe("Doubler");
    expect(Object.keys(snapshot.blocks).sort()).toEqual(["double-it", "double-it/add-to-self"]);

    const root = snapshot.blocks["double-it"]!;
    expect(root.inputs[0]).toMatchObject({
      name: "value",
      type: "number",
      typeIr: { kind: "number" },
      description: "The number to double.",
    });
    expect(root.code).toMatchObject({ pointer: "src/double-it.ts#doubleIt", file: "src/double-it.ts", line: 3 });
    // Its code imports the contract, so Fragmentor holds it to it and can run it.
    expect(root.runnable).toBe(true);
    expect(root.drawnBecause).toBeNull();

    // The block beside it points at code nobody has written yet.
    const child = snapshot.blocks["double-it/add-to-self"]!;
    expect(child.code).toBeNull();
    expect(child.implemented).toBe(false);
    expect(child.runnable).toBe(false);
    expect(snapshot.diagnostics).toContainEqual({
      severity: "warning",
      blockPath: "double-it/add-to-self",
      message: expect.stringContaining("points at code that is not there"),
    });
  });

  it("lists the blocks each block is made of, and nothing about what calls what", async () => {
    const snapshot = await projectSnapshot(dir);

    expect(snapshot.blocks["double-it"]!.children).toEqual(["double-it/add-to-self"]);
    expect(snapshot.blocks["double-it/add-to-self"]!.children).toEqual([]);
  });

  it("calls a bound Python block runnable, with its contract in the importable mirror", async () => {
    await writeFile(
      path.join(dir, "fragmentor.json"),
      JSON.stringify({ ...manifest, systems: [{ rootBlock: "double-it", language: "python" }] }),
      "utf8",
    );
    await writeBlock(
      blockDir(dir, "double-it"),
      makeBlock({
        id: "double-it",
        name: "Double It",
        code: "src/double_it.py#double_it",
        inputs: { value: { type: t.number } },
        outputs: { doubled: { type: t.number } },
      }),
    );
    await writeFile(
      path.join(dir, "src", "double_it.py"),
      [
        "from typing import TYPE_CHECKING",
        "",
        "if TYPE_CHECKING:",
        "    from blocks._contracts.double_it.contract import DoubleItCaps, DoubleItInput, DoubleItOutput",
        "",
        "",
        "async def double_it(input, caps):",
        '    return {"doubled": input["value"] * 2}',
        "",
      ].join("\n"),
      "utf8",
    );

    const block = (await projectSnapshot(dir)).blocks["double-it"]!;
    // Bound Python is checked and runnable, its contract in the mirror.
    expect(block.drawnBecause).toBeNull();
    expect(block.runnable).toBe(true);
    expect(block.cases).toEqual([]);
    expect(block.files.contract).toBe("blocks/_contracts/double_it/contract.py");
  });

  it("carries the code it holds to a contract, and the contract once it is written", async () => {
    const before = (await projectSnapshot(dir)).blocks["double-it"]!;
    expect(before.sources.code).toContain("export async function doubleIt");
    expect(before.sources.contract).toBeNull();

    await emitProject(await loadProject(dir));

    const after = (await projectSnapshot(dir)).blocks["double-it"]!;
    expect(after.sources.contract).toContain("export type DoubleItInput");
    expect(after.implemented).toBe(true);
    expect(after.files).toEqual({ code: "src/double-it.ts", contract: "blocks/double-it/contract.d.ts" });
  });

  it("reports diagnostics rather than throwing, so a broken project still opens", async () => {
    await writeBlock(
      blockDir(dir, "double-it/add-to-self"),
      makeBlock({
        id: "add-to-self",
        name: "Add To Self",
        access: [{ from: null, verb: "reads", resource: "nowhere", entry: null }],
      }),
    );

    const snapshot = await projectSnapshot(dir);
    expect(snapshot.diagnostics.map((d) => d.message)).toContainEqual(expect.stringContaining('no block called "nowhere"'));
    expect(Object.keys(snapshot.blocks)).toHaveLength(2);
  });
});

describe("executions in a snapshot", () => {
  it("carries each execution with its trace, and reports one that names nothing", async () => {
    await mkdir(path.join(dir, "executions"));
    await writeFile(
      path.join(dir, "executions", "double.json"),
      JSON.stringify({
        trigger: { at: "double-it", kind: "request", payload: { value: 2 } },
        trace: [{ from: "double-it", to: "double-it/add-to-self", kind: "call", payload: { value: 2 }, response: { sum: 4 } }],
        expect: { entered: ["double-it/add-to-self"] },
      }),
      "utf8",
    );
    await writeFile(
      path.join(dir, "executions", "lost.json"),
      JSON.stringify({ trigger: { at: "double-it/halve", kind: "action" } }),
      "utf8",
    );

    const snapshot = await projectSnapshot(dir);
    expect(snapshot.executions.map((each) => [each.id, each.trigger.at, each.declared?.source ?? null, each.expects])).toEqual([
      ["double", "double-it", "declared", true],
      ["lost", "double-it/halve", null, false],
    ]);
    expect(snapshot.executions[0]!.declared!.events.map((event) => event.type)).toEqual(["interaction", "interaction", "return"]);
    expect(snapshot.diagnostics).toContainEqual({
      severity: "error",
      blockPath: "executions/lost.json",
      message: 'trigger.at: there is no block at "double-it/halve".',
    });
  });

  it("says which code a recording of each execution runs, or why none can be, and where each entry leads", async () => {
    const examples = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "examples");
    const tickets = await projectSnapshot(path.join(examples, "tickets"));
    const bookSeats = tickets.executions.find((each) => each.id === "book-seats")!;
    expect([bookSeats.records, bookSeats.unrecordable]).toEqual(["tickets/booking-api/book-seats", null]);
    // What it starts from and must do travel with it, so a recording can be held to them in the window.
    expect(Object.keys(bookSeats.given)).toContain("tickets/tickets-db.events");
    expect(bookSeats.expect?.effects.length).toBeGreaterThan(0);
    expect(tickets.blocks["tickets/box-office"]!.exposes.find((each) => each.name === "bookSeats")!.route).toEqual([
      { path: "tickets/box-office", entry: "bookSeats" },
      { path: "tickets/booking-api", entry: "bookSeats" },
      { path: "tickets/booking-api/book-seats", entry: null },
    ]);

    const messenger = await projectSnapshot(path.join(examples, "messenger"));
    const send = messenger.executions.find((each) => each.id === "send-a-message")!;
    expect(send.records).toBeNull();
    // The window says why in plain words; the technical reason is the agent's, in `fragmentor test`.
    expect(send.unrecordable).toBe('"Send Button" answers app/client/ui/send-button, but its code is not held to its contract yet, so it cannot be recorded.');
  });

  it("still opens a project whose executions cannot be read, and says why", async () => {
    // A file where the folder should be, which reading the folder refuses.
    await writeFile(path.join(dir, "executions"), "not a folder", "utf8");

    const snapshot = await projectSnapshot(dir);
    expect(snapshot.executions).toEqual([]);
    expect(snapshot.diagnostics.filter((each) => each.blockPath === "executions")).toHaveLength(1);
  });
});

describe("notes in a snapshot", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("carries every note, resolved ones too, with whose turn it is", async () => {
    // A minute apart, so which is oldest does not depend on how fast this runs.
    vi.useFakeTimers({ toFake: ["Date"] });
    const at = (minute: number) => vi.setSystemTime(new Date(Date.UTC(2026, 8, 24, 10, minute)));
    at(0);
    const asked = await addNote(dir, "double-it/add-to-self", "person", "Write this one.");
    at(1);
    const answered = await addNote(dir, "double-it", "person", "Explain the doubling.");
    await replyToNote(dir, answered.id, "agent", "It adds the number to itself.");
    at(2);
    const done = await addNote(dir, "double-it", "agent", "I renamed the input.");
    await resolveNote(dir, done.id);
    vi.useRealTimers();

    const snapshot = await projectSnapshot(dir);
    expect(snapshot.notes.map((note) => [note.id, note.block, note.status, note.waiting])).toEqual([
      [asked.id, "double-it/add-to-self", "open", "agent"],
      [answered.id, "double-it", "open", "person"],
      [done.id, "double-it", "resolved", null],
    ]);
    expect(snapshot.notes[1]!.messages.map((message) => message.text)).toEqual(["Explain the doubling.", "It adds the number to itself."]);
    // A note says what someone wants done, not that anything is wrong.
    expect(snapshot.diagnostics.filter((each) => each.blockPath.startsWith(NOTES_DIR))).toEqual([]);
  });

  it("warns about an open note on a block that is gone, and a note that cannot be read", async () => {
    const message = { from: "person", at: "2026-09-24T10:00:00.000Z", text: "Where did this go?" };
    await mkdir(path.join(dir, NOTES_DIR), { recursive: true });
    await writeFile(
      path.join(dir, NOTES_DIR, "1790000000001-moved.json"),
      JSON.stringify({ block: "double-it/halve", status: "open", messages: [message] }),
      "utf8",
    );
    // Once resolved, it is nobody's business where its block went.
    await writeFile(
      path.join(dir, NOTES_DIR, "1790000000002-long-gone.json"),
      JSON.stringify({ block: "double-it/triple", status: "resolved", messages: [message] }),
      "utf8",
    );
    await writeFile(path.join(dir, NOTES_DIR, "1790000000003-broken.json"), "<<<<<<< HEAD", "utf8");

    const snapshot = await projectSnapshot(dir);
    expect(snapshot.notes.map((note) => note.id)).toEqual(["1790000000001-moved", "1790000000002-long-gone"]);
    const noted = snapshot.diagnostics.filter((each) => each.blockPath.startsWith(NOTES_DIR));
    expect(noted).toEqual([
      {
        severity: "warning",
        blockPath: `${NOTES_DIR}/1790000000003-broken.json`,
        message: expect.stringMatching(/^This note cannot be read: it is not valid JSON/),
      },
      {
        severity: "warning",
        blockPath: `${NOTES_DIR}/1790000000001-moved.json`,
        message: expect.stringContaining("This note is on double-it/halve, which is no longer a block."),
      },
    ]);
  });
});

describe("a snapshot of code Fragmentor only draws", () => {
  it("carries the code each block points at, and reports a pointer that leads nowhere", async () => {
    const other = await mkdtemp(path.join(tmpdir(), "fragmentor-snap-"));
    try {
      await writeFile(
        path.join(other, "fragmentor.json"),
        JSON.stringify({ name: "Seen", language: "Go", granularity: { level: 2 }, systems: [{ rootBlock: "serve" }] }),
        "utf8",
      );
      await mkdir(path.join(other, "blocks", "serve", "handle"), { recursive: true });
      await writeFile(
        path.join(other, "blocks", "serve", "block.json"),
        JSON.stringify({ responsibility: "Serves requests.", code: "main.go#main" }),
        "utf8",
      );
      await writeFile(
        path.join(other, "blocks", "serve", "handle", "block.json"),
        JSON.stringify({ responsibility: "Handles one request.", code: "handler.go#Handle", inputs: { request: "*http.Request" } }),
        "utf8",
      );
      await writeFile(path.join(other, "main.go"), "package main\n\nfunc main() {\n\tserve()\n}\n", "utf8");

      const snapshot = await projectSnapshot(other);
      expect(snapshot.language).toBe("Go");
      // Nothing is generated or run in a language there is no pack for.
      expect(snapshot.systems).toEqual([{ rootBlock: "serve", language: "Go", displayName: "Go", known: false, reachRead: false, reachNotReadBecause: "Go code is not read yet" }]);

      const serve = snapshot.blocks.serve!;
      expect(serve.code).toMatchObject({ pointer: "main.go#main", file: "main.go", line: 3, excerptStart: 1 });
      expect(serve.code!.excerpt).toContain("func main()");
      expect(serve.implemented).toBe(true);
      expect(serve.runnable).toBe(false);
      expect(serve.drawnBecause).toContain("no language pack for Go");
      expect(serve.sources).toEqual({ code: null, contract: null });

      const handle = snapshot.blocks["serve/handle"]!;
      expect(handle.inputs[0]!.type).toBe("*http.Request");
      expect(handle.code).toBeNull();
      expect(snapshot.diagnostics).toContainEqual({
        severity: "warning",
        blockPath: "serve/handle",
        message: expect.stringContaining('"Handle" points at code that is not there: "handler.go" does not exist.'),
      });
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });
});

describe("what the code reaches, in a snapshot", () => {
  it("warns on the block whose code reaches a part the diagram does not say it reaches, in the same words each time", async () => {
    const copy = await mkdtemp(path.join(tmpdir(), "fragmentor-snap-"));
    try {
      await cp(fileURLToPath(new URL("../../examples/messenger", import.meta.url)), copy, { recursive: true });
      const blockFile = path.join(blockDir(copy, "app/workers/deliver-notification"), "block.json");
      const block = JSON.parse(await readFile(blockFile, "utf8")) as { access: string[] };
      await writeFile(blockFile, JSON.stringify({ ...block, access: block.access.filter((each) => each !== "writes client") }), "utf8");

      const snapshot = await projectSnapshot(copy);
      expect(snapshot.systems.map((system) => system.reachRead)).toEqual([true]);
      expect(snapshot.diagnostics).toEqual([
        {
          severity: "warning",
          blockPath: "app/workers/deliver-notification",
          message: expect.stringContaining('"Deliver Notification"\'s code reaches "Client" (app/client)'),
        },
      ]);
      expect((await projectSnapshot(copy)).diagnostics).toEqual(snapshot.diagnostics);
      expect(Object.values(snapshot.blocks).filter((each) => each.reachNotChecked.length > 0)).toEqual([]);
      expect(snapshot.reachUnpointed).toEqual([]);
      // Everything known about who reaches whom is on the snapshot, each way said.
      expect(snapshot.systems.map((system) => system.reachNotReadBecause)).toEqual([null]);
      expect(snapshot.reachSeen.filter((each) => each.on === "code")).toHaveLength(18);
      expect(snapshot.reachSeen.filter((each) => each.on === "diagram")).toHaveLength(14);
      expect(snapshot.reachSeen.find((each) => each.on === "diagram" && each.from === "app/api/auth/log-in")).toMatchObject({
        to: "app/infrastructure/database",
        verb: "reads",
        entry: "users",
        exact: true,
        planned: false,
      });

      // Every function read is credited to a block, with the few worth naming.
      expect(snapshot.functions["app/client/state"]).toMatchObject({ paths: [7], statements: 14 });
      expect(snapshot.functions["app/client/state"]!.named.map((each) => each.name)).toEqual(["dispatch"]);

      // Read as it was at a commit, the code's reach is left alone.
      const then = await projectSnapshot(copy, { atCommit: true });
      expect(then.diagnostics).toEqual([]);
      expect(then.reachSeen).toEqual([]);
      expect(then.functions).toEqual({});
      expect(then.systems.map((system) => system.reachNotReadBecause)).toEqual(["the code is not read as it was at a commit"]);
    } finally {
      await rm(copy, { recursive: true, force: true });
    }
  }, 30_000);
});
