import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NOTES_DIR, addNote } from "./project/notes.js";
import type { Note } from "./project/notes.js";

/**
 * The command exactly as an agent runs it: the real launcher, in a separate
 * process, from a folder outside the repository.
 */

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const launcher = path.join(repo, "bin", "fragmentor.js");
const tickets = path.join(repo, "examples", "tickets");

function fragmentor(args: string[], cwd: string, input?: string): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [launcher, ...args], { cwd, encoding: "utf8", input });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "fragmentor-cli-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("the fragmentor command", () => {
  it("starts a project with the settings a person chose, then says what it still needs", async () => {
    const refused = fragmentor(["init"], dir);
    expect(refused.status).toBe(1);
    expect(refused.output).toContain("--granularity");

    const init = fragmentor(["init", "--granularity", "3", "--language", "typescript"], dir);
    expect(init.status).toBe(0);
    expect(init.output).toContain("wrote  fragmentor.json");
    expect(init.output).toContain("wrote  FRAGMENTOR.md");
    expect(JSON.parse(await readFile(path.join(dir, "fragmentor.json"), "utf8"))).toMatchObject({
      language: "typescript",
      granularity: { level: 3 },
      systems: [],
    });

    const check = fragmentor(["check"], dir);
    expect(check.status).toBe(0);
    expect(check.output).toContain("No systems yet");
  }, 30_000);

  it("records where the project starts and whether it starts as a plan", async () => {
    expect(fragmentor(["init", "--granularity=3", "--language=typescript", "--start=plan"], dir).status).toBe(0);
    expect(JSON.parse(await readFile(path.join(dir, "fragmentor.json"), "utf8"))).toMatchObject({
      existingCode: false,
      start: "plan",
    });
    expect(await readFile(path.join(dir, "FRAGMENTOR.md"), "utf8")).toContain("**This project starts as a plan.**");
  }, 30_000);

  it("refuses to both rebuild existing code and plan it from nothing", () => {
    const refused = fragmentor(["init", "--granularity=3", "--existing-code", "--start=plan"], dir);
    expect(refused.status).toBe(1);
    expect(refused.output).toContain("cannot go together");
  }, 30_000);

  it("has nothing to test in a project with no blocks yet", () => {
    expect(fragmentor(["init", "--granularity=2"], dir).status).toBe(0);

    const result = fragmentor(["test"], dir);
    expect(result.status).toBe(0);
    expect(result.output).toContain("nothing to test yet");
  }, 30_000);

  it("finds the project from inside a block's folder, and passes the example", async () => {
    await cp(tickets, dir, { recursive: true });

    const result = fragmentor(["check"], path.join(dir, "blocks", "tickets", "booking-api", "pricing"));
    expect(result.output).toContain("tickets: typechecks against its contracts");
    expect(result.output).toContain("Result: no errors");
    expect(result.status).toBe(0);
  }, 30_000);

  it("fails on a problem with the diagram and says what it is", async () => {
    await cp(tickets, dir, { recursive: true });
    const blockFile = path.join(dir, "blocks", "tickets", "booking-api", "find-event", "block.json");
    const block = JSON.parse(await readFile(blockFile, "utf8")) as { access: string[] };
    block.access = ["events reads tickets-db.venues"];
    await writeFile(blockFile, JSON.stringify(block, null, 2), "utf8");

    const result = fragmentor(["check", "--project", dir], repo);
    expect(result.status).toBe(1);
    expect(result.output).toContain('ERROR  tickets/booking-api/find-event: "Find Event" declares "events reads tickets-db.venues"');
  }, 30_000);

  it("runs the saved tests, and fails when one does", async () => {
    await cp(tickets, dir, { recursive: true });

    const passing = fragmentor(["test"], dir);
    expect(passing.output).toContain("PASS   turns someone away when there are not enough seats left");
    expect(passing.status).toBe(0);

    await writeFile(
      path.join(dir, "blocks", "tickets", "booking-api", "pricing", "price-seat", "cases.json"),
      JSON.stringify([{ name: "wrong on purpose", input: { fullPrice: 25, seat: 1 }, expected: { price: 20 } }]),
      "utf8",
    );

    const failing = fragmentor(["test", "tickets/booking-api/pricing/price-seat"], dir);
    expect(failing.status).toBe(1);
    expect(failing.output).toContain("FAIL   wrong on purpose");
    expect(failing.output).toContain("output.price was 25, expected 20.");
  }, 60_000);
});

describe("notes, from the agent's side", () => {
  const priceSeat = "tickets/booking-api/pricing/price-seat";
  const readNote = async (id: string) => JSON.parse(await readFile(path.join(dir, NOTES_DIR, `${id}.json`), "utf8")) as Omit<Note, "id">;
  /** The id a command printed for the note it left or answered. */
  const idIn = (output: string) => /note (\d{13}-[a-z0-9-]*)/.exec(output)![1]!;

  beforeEach(async () => {
    await cp(tickets, dir, { recursive: true });
  });

  it("leaves a note for the person, which is then theirs and not the agent's to review", async () => {
    const left = fragmentor(["note", priceSeat, "The fifth-seat discount is applied twice when a booking is split."], dir);
    expect(left.status).toBe(0);
    expect(left.output).toContain(`on ${priceSeat}`);
    expect(left.output).toContain("The person will see it on the block in Fragmentor");
    expect(await readNote(idIn(left.output))).toMatchObject({
      block: priceSeat,
      status: "open",
      messages: [{ from: "agent", text: "The fifth-seat discount is applied twice when a booking is split." }],
    });

    const listed = fragmentor(["notes"], dir);
    expect(listed.status).toBe(0);
    expect(listed.output).toContain("No notes are waiting for you.");
    expect(listed.output).toContain(`1 note is waiting for the person rather than you, on ${priceSeat}.`);
    expect(listed.output).not.toContain("fragmentor reply");
  }, 30_000);

  it("lists a person's note with where its block, code and tests are, and hands it back once answered", async () => {
    const asked = await addNote(dir, priceSeat, "person", "Take a fifth off from the tenth seat.", {
      test: "the tenth seat is a fifth off",
      input: { fullPrice: 25, seat: 10 },
      expected: { price: 20 },
      output: { price: 22.5 },
      problems: ["output.price was 22.5, expected 20."],
      logs: [],
    });
    const source = await readFile(path.join(dir, "src", "booking", "price-seat.ts"), "utf8");
    const line = source.split(/\r?\n/).findIndex((each) => each.includes("function priceSeat")) + 1;

    const listed = fragmentor(["notes"], dir);
    expect(listed.status).toBe(0);
    expect(listed.output).toContain("1 note is waiting for you.");
    expect(listed.output).toContain(`${asked.id}  on ${priceSeat} (Price Seat)`);
    expect(listed.output).toContain(`  block  blocks/${priceSeat}/block.json`);
    expect(listed.output).toContain(`  code   src/booking/price-seat.ts:${line}  (priceSeat)`);
    expect(listed.output).toContain(`  tests  blocks/${priceSeat}/cases.json`);
    expect(listed.output).toMatch(/ {2}person, \d{4}-\d\d-\d\d \d\d:\d\d UTC\n {4}Take a fifth off from the tenth seat\./);
    expect(listed.output).toContain('      the saved test "the tenth seat is a fifth off" failed');
    expect(listed.output).toContain('      expected  {"price":20}');
    expect(listed.output).toContain('answer it with `fragmentor reply <id> "<what you did>"`');

    // Only the notes on a block and its parts, however its path was typed.
    expect(fragmentor(["notes", "tickets\\booking-api\\"], dir).output).toContain(asked.id);
    const elsewhere = fragmentor(["notes", "tickets/box-office"], dir);
    expect(elsewhere.status).toBe(0);
    expect(elsewhere.output).toContain("No notes on tickets/box-office or its parts are waiting for you.");
    expect(elsewhere.output).not.toContain(asked.id);

    const answered = fragmentor(["reply", asked.id, "Done: the tenth seat is a fifth off, and that run is a saved test."], dir);
    expect(answered.status).toBe(0);
    expect(answered.output).toContain(`Answered note ${asked.id} on ${priceSeat}.`);
    expect((await readNote(asked.id)).messages.map((message) => message.from)).toEqual(["person", "agent"]);

    const after = fragmentor(["notes"], dir);
    expect(after.output).toContain("No notes are waiting for you.");
    expect(after.output).toContain(`1 note is waiting for the person rather than you, on ${priceSeat}.`);
  }, 60_000);

  it("keeps words that look like options as text, and reads text from standard input when asked", async () => {
    const left = fragmentor(["note", "tickets/box-office", "Should", "this", "take", "--project", "or", "--language=fr?"], dir);
    expect(left.status).toBe(0);
    const id = idIn(left.output);
    expect((await readNote(id)).messages[0]!.text).toBe("Should this take --project or --language=fr?");

    const answered = fragmentor(["reply", id, "-"], dir, 'Neither: it says "Book".\r\nSee book-seats.\r\n');
    expect(answered.status).toBe(0);
    expect((await readNote(id)).messages[1]!.text).toBe('Neither: it says "Book".\nSee book-seats.');
  }, 30_000);

  it("says plainly when there is no such note or block", () => {
    const noNote = fragmentor(["reply", "1790000000000-nothing-here", "Done."], dir);
    expect(noNote.status).toBe(1);
    expect(noNote.output).toContain("There is no note 1790000000000-nothing-here.");

    const noBlock = fragmentor(["notes", "tickets/nowhere"], dir);
    expect(noBlock.status).toBe(1);
    expect(noBlock.output).toContain("There is no block at tickets/nowhere.");

    const noteOnNothing = fragmentor(["note", "tickets/nowhere", "Hello."], dir);
    expect(noteOnNothing.status).toBe(1);
    expect(noteOnNothing.output).toContain("There is no block at tickets/nowhere.");
  }, 30_000);

  it("has check say how many notes are waiting, without changing its result", async () => {
    // Their first words sort in the order they are written, in case both are written in one millisecond.
    await addNote(dir, priceSeat, "person", "Charge a fifth less from the tenth seat.");
    await addNote(dir, "tickets/box-office", "person", "Say how many seats are left.");
    await addNote(dir, "tickets/box-office", "agent", "The page never says when a booking failed.");

    const result = fragmentor(["check"], dir);
    expect(result.status).toBe(0);
    expect(result.output).toContain(
      [
        "Notes",
        `  2 waiting for you, on ${priceSeat} and tickets/box-office. Run \`fragmentor notes\` when the person asks you to review them.`,
        "  1 waiting for the person, on tickets/box-office.",
      ].join("\n"),
    );
    expect(result.output).toContain("Result: no errors.");
  }, 30_000);
});
