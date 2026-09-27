import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runBlock, runCases, startRun } from "./run.js";
import type { RunEvent } from "./run.js";
import type { TestCase } from "./cases.js";

type Call = Extract<RunEvent, { type: "call" }>;
const callsIn = (events: RunEvent[]) => events.filter((event): event is Call => event.type === "call");
const blockOf = (events: RunEvent[], id: number) => callsIn(events).find((call) => call.id === id)?.block ?? null;

/**
 * These run real code in a real subprocess. They are the only tests that
 * prove a block can actually be executed rather than only generated.
 *
 * The project is written here rather than taken from an example, so it can
 * hold exactly what the harness has to be tested against: a block reading
 * files, one calling another for several items at once, one calling a block
 * beside it, one returning nothing, and a system in a language that cannot
 * run yet.
 *
 * Its code happens to sit in the blocks' own folders, which is allowed and is
 * not required: what makes each block runnable is its code importing the
 * contract Fragmentor wrote for it.
 */

let projectDir: string;

const files: Record<string, unknown> = {
  "fragmentor.json": {
    name: "Files",
    goal: "",
    existingCode: false,
    start: "build",
    granularity: { level: 3, maxDepth: 4 },
    systems: [
      { rootBlock: "files", language: "typescript" },
      { rootBlock: "py", language: "python" },
    ],
  },
  "blocks/files/block.json": { role: "component", responsibility: "Reads and counts the lines of files." },
  "blocks/files/count-lines/block.json": {
    responsibility: "Count the lines of several files at once.",
    code: "blocks/files/count-lines/impl.ts#countLines",
    inputs: { paths: "string[]" },
    outputs: { counts: "number[]" },
    capabilities: { files: "FileSystem" },
  },
  "blocks/files/count-lines/impl.ts": `import type { CountLinesCaps } from "./contract.js";
import { readLines } from "../read-lines/impl.js";

export async function countLines(input: { paths: string[] }, caps: any) {
  const read = await Promise.all(input.paths.map((path) => readLines({ path }, caps)));
  return { counts: read.map((each) => each.lines.length) };
}
`,
  "blocks/files/read-lines/block.json": {
    responsibility: "Read a file's lines, leaving out the blank ones.",
    code: "blocks/files/read-lines/impl.ts#readLines",
    inputs: { path: "string" },
    outputs: { lines: "string[]" },
    capabilities: { files: "FileSystem" },
  },
  "blocks/files/read-lines/impl.ts": `import type { ReadLinesCaps } from "./contract.js";
import { withoutBlanks } from "../without-blanks/impl.js";

export async function readLines(input: { path: string }, caps: any) {
  const text = await caps.files.readFile(input.path);
  return withoutBlanks({ lines: text.split("\\n") }, caps);
}
`,
  "blocks/files/without-blanks/block.json": {
    responsibility: "Leave out lines with nothing on them.",
    code: "blocks/files/without-blanks/impl.ts#withoutBlanks",
    inputs: { lines: "string[]" },
    outputs: { lines: "string[]" },
  },
  "blocks/files/without-blanks/impl.ts": `import type { WithoutBlanksCaps } from "./contract.js";

export async function withoutBlanks(input: { lines: string[] }, caps: unknown) {
  return { lines: input.lines.filter((line) => line.trim() !== "") };
}
`,
  "blocks/files/write-note/block.json": {
    responsibility: "Write a note to a file. It returns nothing.",
    code: "blocks/files/write-note/impl.ts#writeNote",
    inputs: { path: "string", text: "string" },
    capabilities: { files: "FileSystem" },
  },
  "blocks/files/write-note/impl.ts": `import type { WriteNoteCaps } from "./contract.js";

export async function writeNote(input: { path: string; text: string }, caps: any) {
  await caps.files.writeFile(input.path, input.text);
}
`,
  "blocks/py/block.json": { role: "component", responsibility: "Python, which cannot run yet." },
  "blocks/py/shout/block.json": {
    responsibility: "Shout.",
    code: "blocks/py/shout/impl.py#shout",
    inputs: { text: "string" },
    outputs: { text: "string" },
  },
  "blocks/py/shout/impl.py": `async def shout(value, caps):
    return {"text": value.text.upper()}
`,
  "a.txt": "one\ntwo\n\nthree\n",
  "b.txt": "x\n",
  "c.txt": "",
};

beforeAll(async () => {
  projectDir = await mkdtemp(path.join(tmpdir(), "fragmentor-run-"));
  for (const [file, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(projectDir, file)), { recursive: true });
    await writeFile(
      path.join(projectDir, file),
      typeof contents === "string" ? contents : JSON.stringify(contents, null, 2),
      "utf8",
    );
  }
});

afterAll(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

describe("running a block", () => {
  it("returns what the block computed, reading through its capability", async () => {
    const result = await runBlock({ projectDir, blockPath: "files/read-lines", input: { path: "a.txt" } });

    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ lines: ["one", "two", "three"] });
    expect(result.outputProblems).toEqual([]);
  });

  it("runs a block that returns nothing, and holds it to no result", async () => {
    const result = await runBlock({ projectDir, blockPath: "files/write-note", input: { path: "note.txt", text: "hello" } });

    expect(result.ok).toBe(true);
    expect(result.output).toBeUndefined();
    expect(result.outputProblems).toEqual([]);
    expect(await readFile(path.join(projectDir, "note.txt"), "utf8")).toBe("hello");
  });

  it("refuses to read outside the project", async () => {
    const result = await runBlock({ projectDir, blockPath: "files/read-lines", input: { path: "../../package.json" } });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("outside the project");
  });

  it("reports what a block threw, rather than swallowing it", async () => {
    const result = await runBlock({ projectDir, blockPath: "files/read-lines", input: { path: "does-not-exist.txt" } });

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe("checking the contract on both sides", () => {
  it("refuses input that does not match, without running anything", async () => {
    const result = await runBlock({ projectDir, blockPath: "files/read-lines", input: { path: 3 } });

    expect(result.ok).toBe(false);
    expect(result.inputProblems).toEqual([expect.stringContaining("input.path should be")]);
    expect(result.durationMs).toBe(0);
  });

  it("names a missing input", async () => {
    const result = await runBlock({ projectDir, blockPath: "files/read-lines", input: {} });
    expect(result.inputProblems).toEqual(["input.path is missing."]);
  });
});

describe("running a list of tests", () => {
  const reads: TestCase = { name: "reads a file of the project", input: { path: "a.txt" }, expected: { lines: ["one", "two", "three"] } };

  it("runs exactly the tests it is given, whatever is saved", async () => {
    await writeFile(
      path.join(projectDir, "blocks", "files", "read-lines", "cases.json"),
      JSON.stringify([{ name: "saved, and not asked for", input: { path: "b.txt" } }]),
      "utf8",
    );
    try {
      const given: TestCase[] = [reads, { name: "does not fit", input: { file: "a.txt" } }];
      const results = await runCases(projectDir, "files/read-lines", { cases: given });

      expect(results.map((result) => [result.name, result.status])).toEqual([
        ["reads a file of the project", "passed"],
        ["does not fit", "error"],
      ]);
      expect(results[1]!.inputProblems).toEqual(["input.path is missing.", "input.file is not part of this type."]);
    } finally {
      await rm(path.join(projectDir, "blocks", "files", "read-lines", "cases.json"));
    }
  }, 30_000);

  it("reads the files of the project a copy stands in for", async () => {
    // A copy holding the blocks and their code, but none of the files they read.
    const copy = await mkdtemp(path.join(tmpdir(), "fragmentor run copy "));
    try {
      await cp(path.join(projectDir, "fragmentor.json"), path.join(copy, "fragmentor.json"));
      await cp(path.join(projectDir, "blocks"), path.join(copy, "blocks"), { recursive: true });

      const [asCopy] = await runCases(copy, "files/read-lines", { cases: [reads], copyOf: projectDir });
      expect(asCopy).toMatchObject({ status: "passed" });

      const [alone] = await runCases(copy, "files/read-lines", { cases: [reads] });
      expect(alone).toMatchObject({ status: "error" });
    } finally {
      await rm(copy, { recursive: true, force: true });
    }
  }, 30_000);

  it("keeps what a copy's tests write in the copy, and reads it back from there", async () => {
    const copy = await mkdtemp(path.join(tmpdir(), "fragmentor run copy "));
    try {
      await cp(path.join(projectDir, "fragmentor.json"), path.join(copy, "fragmentor.json"));
      await cp(path.join(projectDir, "blocks"), path.join(copy, "blocks"), { recursive: true });

      const writes = [
        { name: "over a file of the project", input: { path: "a.txt", text: "only\nin the copy\n" } },
        { name: "into a folder nothing has yet", input: { path: "notes/today.txt", text: "hello" } },
      ];
      const wrote = await runCases(copy, "files/write-note", { cases: writes, copyOf: projectDir });
      expect(wrote.map((result) => result.status)).toEqual(["unchecked", "unchecked"]);
      expect(await readFile(path.join(copy, "notes", "today.txt"), "utf8")).toBe("hello");
      expect(await readFile(path.join(projectDir, "a.txt"), "utf8")).toBe("one\ntwo\n\nthree\n");
      expect(await readFile(path.join(projectDir, "notes", "today.txt"), "utf8").catch((error) => error.code)).toBe("ENOENT");

      const [read] = await runCases(copy, "files/read-lines", {
        cases: [{ name: "reads what the copy wrote", input: { path: "a.txt" }, expected: { lines: ["only", "in the copy"] } }],
        copyOf: projectDir,
      });
      expect(read).toMatchObject({ status: "passed" });
    } finally {
      await rm(copy, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("a language that cannot run yet", () => {
  it("says so plainly instead of failing oddly", async () => {
    const result = await runBlock({ projectDir, blockPath: "py/shout", input: { text: "x" } });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("cannot run Python blocks yet");
  });
});

describe("watching a run", () => {
  const input = { paths: ["a.txt", "b.txt", "c.txt"] };

  it("reports every call the run makes, each with the call it came from, wherever the block sits", async () => {
    const events: RunEvent[] = [];
    const result = await runBlock({ projectDir, blockPath: "files/count-lines", input, onEvent: (event) => events.push(event) });
    expect(result.output).toEqual({ counts: [3, 1, 0] });

    const of = (block: string) => callsIn(events).filter((call) => call.block === block);
    const root = of("files/count-lines")[0]!;
    expect(root).toMatchObject({ parent: null, input });

    // Neither block is inside the one that calls it: each sits beside it.
    const readers = of("files/read-lines");
    expect(readers.map((call) => call.input)).toEqual([{ path: "a.txt" }, { path: "b.txt" }, { path: "c.txt" }]);
    expect(readers.every((call) => call.parent === root.id)).toBe(true);
    const readerIds = new Set(readers.map((call) => call.id));
    expect(of("files/without-blanks").map((call) => readerIds.has(call.parent!))).toEqual([true, true, true]);
  }, 30_000);

  it("records nothing, and pauses nowhere, when nobody is watching", async () => {
    const result = await runBlock({ projectDir, blockPath: "files/count-lines", input, breakpoints: ["files/read-lines"] });
    expect(result.ok).toBe(true);
  }, 30_000);

  it("holds a run at a breakpoint until it is told to go on", async () => {
    const events: RunEvent[] = [];
    let returnedWhileHeld: boolean | null = null;
    const { control, outcome } = startRun({
      projectDir,
      blockPath: "files/count-lines",
      input: { paths: ["a.txt"] },
      breakpoints: ["files/without-blanks"],
      onEvent: (event) => {
        events.push(event);
        if (event.type !== "paused") return;
        returnedWhileHeld = events.some((each) => each.type === "return" && each.id === event.id);
        setTimeout(() => control.resume("continue"), 50);
      },
    });

    expect((await outcome).ok).toBe(true);
    const held = events.filter((event) => event.type === "paused").map((event) => blockOf(events, event.id));
    expect(held).toEqual(["files/without-blanks"]);
    expect(returnedWhileHeld).toBe(false);
  }, 30_000);

  it("steps from a block to the next one that starts", async () => {
    const events: RunEvent[] = [];
    const heldAt: (string | null)[] = [];
    const { control, outcome } = startRun({
      projectDir,
      blockPath: "files/count-lines",
      input: { paths: ["a.txt"] },
      breakpoints: ["files/count-lines"],
      onEvent: (event) => {
        events.push(event);
        if (event.type !== "paused") return;
        heldAt.push(blockOf(events, event.id));
        control.resume(heldAt.length === 1 ? "step" : "continue");
      },
    });

    expect((await outcome).ok).toBe(true);
    expect(heldAt).toEqual(["files/count-lines", "files/read-lines"]);
  }, 30_000);

  it("holds every call of a block called for several things at once, one at a time", async () => {
    const events: RunEvent[] = [];
    const { control, outcome } = startRun({
      projectDir,
      blockPath: "files/count-lines",
      input,
      breakpoints: ["files/read-lines"],
      onEvent: (event) => {
        events.push(event);
        if (event.type === "paused") setTimeout(() => control.resume("continue"), 10);
      },
    });

    expect((await outcome).ok).toBe(true);
    const held = events.filter((event) => event.type === "paused").map((event) => event.id);
    expect(held).toHaveLength(3);
    expect(new Set(held).size).toBe(3);
  }, 30_000);

  it("stops a held run, and says it was stopped", async () => {
    const { control, outcome } = startRun({
      projectDir,
      blockPath: "files/count-lines",
      input,
      breakpoints: ["files/read-lines"],
      onEvent: (event) => {
        if (event.type === "paused") control.stop();
      },
    });

    expect(await outcome).toMatchObject({ ok: false, stopped: true });
  }, 30_000);

  it("does not count time held at a breakpoint against the time limit", async () => {
    const { control, outcome } = startRun({
      projectDir,
      blockPath: "files/read-lines",
      input: { path: "a.txt" },
      timeoutMs: 3000,
      breakpoints: ["files/read-lines"],
      onEvent: (event) => {
        if (event.type === "paused") setTimeout(() => control.resume("continue"), 3500);
      },
    });

    const result = await outcome;
    expect(result.ok).toBe(true);
    // Nor is it part of how long the run took.
    expect(result.durationMs).toBeLessThan(3000);
  }, 30_000);

  it("lets calls go on once their breakpoint is taken away", async () => {
    const events: RunEvent[] = [];
    const { control, outcome } = startRun({
      projectDir,
      blockPath: "files/count-lines",
      input,
      breakpoints: ["files/read-lines"],
      onEvent: (event) => {
        events.push(event);
        if (event.type !== "paused") return;
        // All three files are waiting at the breakpoint by now.
        control.setBreakpoints([]);
        control.resume("continue");
      },
    });

    expect((await outcome).ok).toBe(true);
    expect(events.filter((event) => event.type === "paused")).toHaveLength(1);
  }, 30_000);

  it("steps into the call it lets go, ahead of the calls still waiting", async () => {
    const events: RunEvent[] = [];
    const heldAt: (string | null)[] = [];
    let stepped = false;
    const { control, outcome } = startRun({
      projectDir,
      blockPath: "files/count-lines",
      input,
      breakpoints: ["files/read-lines"],
      onEvent: (event) => {
        events.push(event);
        if (event.type !== "paused") return;
        const block = blockOf(events, event.id);
        heldAt.push(block);
        if (!stepped) {
          stepped = true;
          control.resume("step");
        } else if (block === "files/without-blanks") {
          control.setBreakpoints([]);
          control.resume("continue");
        }
      },
    });

    expect((await outcome).ok).toBe(true);
    expect(heldAt.at(-1)).toBe("files/without-blanks");

    // It went into the file that was let go, not another one still waiting.
    const firstReader = callsIn(events).find((call) => call.block === "files/read-lines")!;
    const heldTidier = callsIn(events).find((call) => call.block === "files/without-blanks")!;
    expect(heldTidier.parent).toBe(firstReader.id);
  }, 30_000);
});

describe("watching a run that uses stores", () => {
  const tickets = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "examples", "tickets");
  let dir: string;
  const request = () => ({
    projectDir: dir,
    blockPath: "tickets/booking-api/book-seats",
    input: { eventId: "gig", seats: 5, email: "ada@example.com" },
    stores: { "tickets/tickets-db.events": { gig: { id: "gig", name: "Night Gig", seatsLeft: 10, price: 25 } } },
  });

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "fragmentor-run-stores-"));
    await cp(tickets, dir, { recursive: true });
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reports every read, write and send as the call that made it", async () => {
    const events: RunEvent[] = [];
    const result = await runBlock({ ...request(), onEvent: (event) => events.push(event) });
    expect(result.ok).toBe(true);

    const reserve = callsIn(events).find((call) => call.block === "tickets/booking-api/book-seats/reserve")!;
    const finder = callsIn(events).find((call) => call.block === "tickets/booking-api/find-event")!;
    const stores = events.flatMap((event) => (event.type === "store" ? [[event.parent, event.op, event.target, event.key ?? null]] : []));
    expect(stores).toEqual([
      [finder.id, "read", "tickets/tickets-db.events", "gig"],
      [reserve.id, "write", "tickets/tickets-db.events", "gig"],
      [reserve.id, "write", "tickets/tickets-db.bookings", "gig-10"],
      [reserve.id, "send", "tickets/outbox.confirmations", null],
    ]);
    // Calls and store uses share one count, so every event has an id of its own.
    const ids = events.flatMap((event) => (event.type === "call" || event.type === "store" ? [event.id] : []));
    expect(new Set(ids).size).toBe(ids.length);
    expect(result.truncated).toBeUndefined();
  }, 30_000);

  it("adds nothing to a run nobody is watching", async () => {
    const result = await runBlock(request());
    expect(result.ok).toBe(true);
    expect(Object.keys(result).sort()).toEqual(["durationMs", "inputProblems", "logs", "ok", "output", "outputProblems", "stores"]);
  }, 30_000);
});

describe("a run too long to record whole", () => {
  it("carries on past the most calls recorded, and says it was cut short", async () => {
    // Each file is read and tidied, two calls apiece, so this is well past 2000.
    const paths = Array<string>(1100).fill("a.txt");
    const events: RunEvent[] = [];
    const result = await runBlock({ projectDir, blockPath: "files/count-lines", input: { paths }, onEvent: (event) => events.push(event) });

    expect(result.ok).toBe(true);
    expect((result.output as { counts: number[] }).counts).toHaveLength(1100);
    expect(result.truncated).toBe(true);
    expect(callsIn(events).length).toBe(2000);
  }, 60_000);
});
