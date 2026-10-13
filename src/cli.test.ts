import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitIn } from "./project/exampleHistory.js";
import { NOTES_DIR, addNote, replyToNote } from "./project/notes.js";
import type { Note } from "./project/notes.js";

/**
 * The command exactly as an agent runs it: the real launcher, in a separate
 * process, from a folder outside the repository.
 */

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const launcher = path.join(repo, "bin", "fragmentor.js");
const tickets = path.join(repo, "examples", "tickets");

/** Git, where the machine has it: the test recording a commit is skipped otherwise. */
const hasGit = spawnSync("git", ["--version"]).status === 0;

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
    expect(init.output).toContain("wrote  .claude/skills/fragmentor-notes/SKILL.md");
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
    expect(result.output).toContain("6 blocks that are not called, so Fragmentor only draws them:");
    expect(result.output).toContain("Result: no errors");
    expect(result.status).toBe(0);
  }, 30_000);

  it("counts one block that is not called as one", async () => {
    expect(fragmentor(["init", "--granularity=3", "--language=typescript"], dir).status).toBe(0);
    const manifest = JSON.parse(await readFile(path.join(dir, "fragmentor.json"), "utf8")) as { systems: unknown[] };
    manifest.systems.push({ rootBlock: "app" });
    await writeFile(path.join(dir, "fragmentor.json"), JSON.stringify(manifest), "utf8");
    await mkdir(path.join(dir, "blocks", "app"), { recursive: true });
    await writeFile(path.join(dir, "blocks", "app", "block.json"), JSON.stringify({ role: "service", responsibility: "The app.", code: "src" }), "utf8");
    await mkdir(path.join(dir, "src"));

    const result = fragmentor(["check"], dir);
    expect(result.output).toContain("1 block that is not called, so Fragmentor only draws it:");
    expect(result.status).toBe(0);
  }, 30_000);

  it("says a system whose code is not read for what it reaches is not checked for it", async () => {
    expect(fragmentor(["init", "--granularity=3", "--language=python"], dir).status).toBe(0);
    const manifest = JSON.parse(await readFile(path.join(dir, "fragmentor.json"), "utf8")) as { systems: unknown[] };
    manifest.systems.push({ rootBlock: "app" });
    await writeFile(path.join(dir, "fragmentor.json"), JSON.stringify(manifest), "utf8");
    await mkdir(path.join(dir, "blocks", "app"), { recursive: true });
    await writeFile(path.join(dir, "blocks", "app", "block.json"), JSON.stringify({ role: "service", responsibility: "The app.", code: "src" }), "utf8");
    await mkdir(path.join(dir, "src"));

    const result = fragmentor(["check"], dir);
    expect(result.output).toContain("Reach not checked\n  app: Python code is not read for what it reaches yet, so only its declared access is known\n");
    expect(result.status).toBe(0);
  }, 30_000);

  it("explains a phrase for the agent typed as a command, without failing", () => {
    const result = fragmentor(["rebuild"], dir);
    expect(result.status).toBe(0);
    expect(result.output).toContain('"fragmentor rebuild" is something you ask your coding agent to do, not a command to run here.');
    expect(result.output).toContain("/fragmentor-rebuild");
    expect(result.output).toContain("none of your code");
    expect(result.output).toContain("the Commands section of FRAGMENTOR.md");
    expect(result.output).not.toContain("Unknown command");

    // Anything else is still unknown.
    const unknown = fragmentor(["rebuilt"], dir);
    expect(unknown.status).toBe(1);
    expect(unknown.output).toContain('Unknown command "rebuilt"');
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

  it("warns of reach the diagram leaves out, and says what it could not follow, without failing", async () => {
    await cp(path.join(repo, "examples", "messenger"), dir, { recursive: true });
    const blockFile = path.join(dir, "blocks", "app", "workers", "deliver-notification", "block.json");
    const block = JSON.parse(await readFile(blockFile, "utf8")) as { access: string[] };
    block.access = block.access.filter((access) => access !== "writes client");
    await writeFile(blockFile, JSON.stringify(block, null, 2), "utf8");
    const cleanUp = path.join(dir, "src", "workers", "cleanUp.ts");
    await writeFile(cleanUp, `${await readFile(cleanUp, "utf8")}\nexport const later = () => import("./delivery.js");\n`, "utf8");

    const result = fragmentor(["check"], dir);
    expect(result.output).toContain(
      `WARN   app/workers/deliver-notification: "Deliver Notification"'s code reaches "Client" (app/client), but no access on it, inside it or above it names that: dispatch from src/client/state.ts.`,
    );
    expect(result.output).toContain(`Reach not checked\n  app/workers: a dynamic import of "./delivery.js" in src/workers/cleanUp.ts\n`);
    expect(result.output).toContain("Result: no errors, 1 warning.");
    expect(result.status).toBe(0);
  }, 30_000);

  it("runs the saved tests, and fails when one does", async () => {
    await cp(tickets, dir, { recursive: true });

    const passing = fragmentor(["test"], dir);
    expect(passing.output).toContain("PASS   turns someone away when there are not enough seats left");
    expect(passing.status).toBe(0);
    // A service may point at the module it is, so it is said to be drawn, not to have no code.
    expect(passing.output).toContain("Not run, because it is planned and not built yet: tickets/reminders\n");
    expect(passing.output).toContain("Not run, because they are not called, so Fragmentor only draws them: tickets, tickets/booking-api,");
    expect(passing.output).not.toContain("no code");

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

describe("executions, held to what their code does", () => {
  const bookSeats = () => path.join(dir, "executions", "book-seats.json");
  const change = async (edit: (execution: { trigger: { payload: Record<string, unknown> }; trace: Record<string, unknown>[] }) => void) => {
    const execution = JSON.parse(await readFile(bookSeats(), "utf8"));
    edit(execution);
    await writeFile(bookSeats(), JSON.stringify(execution), "utf8");
  };

  it("records each one it can run, and says how much of it the run could not see", async () => {
    await cp(tickets, dir, { recursive: true });

    const result = fragmentor(["test"], dir);
    expect(result.status).toBe(0);
    // The two hops before the block it runs and what the page shows, and the
    // one expectation about what the page shows, are out of the run's sight.
    for (const id of ["book-seats", "booking-turned-away", "cancel-booking", "cancel-without-the-event"]) {
      expect(result.output).toContain(`  MET    ${id}  (3 steps and 1 expectation could not be checked from this run)\n`);
    }
    expect(result.output).not.toContain("not recorded");
    // Each is named beneath, with why, the hand-off to the block that ran among them.
    const detail = " ".repeat(11);
    expect(result.output).toContain(
      `${detail}The step "The server that takes the request is not a block; all it does is hand it to the block that answers this operation." (#2) could not be checked: tickets/booking-api.bookSeats is not part of what ran.\n`,
    );
    expect(result.output).toContain(
      `${detail}"Nothing happens in tickets/outbox.reminders" could not be checked: tickets/outbox.reminders is not part of what ran.\n`,
    );
    // A `never` the run saw part of was checked there, so it is not said to be unchecked outright.
    expect(result.output).toContain(
      `${detail}"Nothing happens in tickets/outbox" could not be fully checked: Checked only for tickets/outbox.confirmations.\n`,
    );
  }, 60_000);

  it("fails on a step the run contradicts, and names it, even with no saved tests", async () => {
    await cp(tickets, dir, { recursive: true });
    const files = await readdir(path.join(dir, "blocks"), { recursive: true });
    await Promise.all(files.filter((file) => path.basename(file) === "cases.json").map((file) => rm(path.join(dir, "blocks", file))));
    await change((execution) => {
      const write = execution.trace.find((step) => step.to === "tickets/tickets-db.bookings")!;
      write.payload = { ...(write.payload as object), total: 125 };
    });

    const result = fragmentor(["test"], dir);
    expect(result.status).toBe(1);
    expect(result.output).toContain("No block has saved tests yet.");
    expect(result.output).toContain("  FAILED book-seats");
    expect(result.output).toContain(
      "(#9): A write from tickets/booking-api/book-seats/reserve to tickets/tickets-db.bookings happened, but not as expected: payload.total was 122.5, expected 125.",
    );
    expect(result.output).toContain("  MET    cancel-booking");
    // How long each recorded run took, under its verdict, from the harness's own clock.
    expect(result.output).toMatch(/  MET    cancel-booking[^\n]*\n {11}took (under 1 ms|\d+ ms); slowest: tickets\/booking-api\/[a-z-]+(\/[a-z-]+)?, (under 1 ms|\d+ ms)\n/);
    expect(result.output).toContain("1 of 4 executions failed.");
  }, 60_000);

  it("fails on one whose payload the code no longer accepts", async () => {
    await cp(tickets, dir, { recursive: true });
    await change((execution) => {
      delete execution.trigger.payload.email;
    });

    const result = fragmentor(["test"], dir);
    expect(result.status).toBe(1);
    expect(result.output).toMatch(/ {2}FAILED book-seats\n {11}could not record: .*input\.email is missing/);
  }, 60_000);

  it("never runs code only drawn, and says why each is held to its own file alone", async () => {
    await cp(path.join(repo, "examples", "messenger"), dir, { recursive: true });

    const result = fragmentor(["test"], dir);
    expect(result.status).toBe(0);
    expect(result.output).toContain("  MET    log-in\n");
    expect(result.output).toContain('not recorded: "Login Form" answers app/client/ui/login-form, but cannot be recorded:');
    expect(result.output).toContain("rather than checking or running it; held to its own expectations\n");
    expect(result.output).toContain("Those not recorded are held only to what their own file says must happen");
  }, 60_000);

  it("says an operation answered by an anonymous handler is not recorded, as expected rather than as a fault", async () => {
    await cp(tickets, dir, { recursive: true });
    const apiFile = path.join(dir, "blocks", "tickets", "booking-api", "block.json");
    const api = JSON.parse(await readFile(apiFile, "utf8")) as { exposes: Record<string, { block?: string }> };
    delete api.exposes.bookSeats!.block;
    await writeFile(apiFile, JSON.stringify(api), "utf8");
    // Only code that was already here has anonymous handlers; in a project
    // built from the diagram the missing block is a gap and is said as one.
    const built = fragmentor(["test"], dir);
    expect(built.output).toContain("Nothing on the diagram says which code answers tickets/box-office.bookSeats");
    const manifestFile = path.join(dir, "fragmentor.json");
    const manifest = JSON.parse(await readFile(manifestFile, "utf8")) as Record<string, unknown>;
    await writeFile(manifestFile, JSON.stringify({ ...manifest, existingCode: true }), "utf8");

    const result = fragmentor(["test"], dir);
    expect(result.output).toContain(
      "  MET    book-seats\n           not recorded: it leads to the operation tickets/booking-api.bookSeats, which names no block that answers it, as with an anonymous handler; held to its own expectations\n",
    );
    expect(result.output).not.toContain("Nothing on the diagram says");
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

    // It is the person's turn, so it is not the agent's to start on.
    const started = fragmentor(["working", idIn(left.output)], dir);
    expect(started.status).toBe(1);
    expect(started.output).toContain(`Note ${idIn(left.output)} is waiting for the person, not you: they answer it next.`);
  }, 30_000);

  it("lists a person's note with where its block, code and tests are, and hands it back once answered", async () => {
    const asked = await addNote(dir, priceSeat, "person", "Take a fifth off from the tenth seat.", {
      run: {
        test: "the tenth seat is a fifth off",
        input: { fullPrice: 25, seat: 10 },
        expected: { price: 20 },
        output: { price: 22.5 },
        problems: ["output.price was 22.5, expected 20."],
        logs: [],
      },
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
    // This copy is in no repository, so there is no commit to record, and an answer is still an answer.
    expect(answered.output).toContain("No commit was recorded with it, because git has no commit here to record");
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

    // --no-commit is taken only straight after the id; anywhere later it is words of the answer.
    await replyToNote(dir, id, "person", "And the other button?");
    expect(fragmentor(["reply", id, "--no-commit", "-"], dir, "It says Cancel.\n").status).toBe(0);
    await replyToNote(dir, id, "person", "Thanks.");
    expect(fragmentor(["reply", id, "Answer", "with", "--no-commit", "next", "time."], dir).status).toBe(0);
    expect((await readNote(id)).messages.map((message) => message.text).slice(-3)).toEqual([
      "It says Cancel.",
      "Thanks.",
      "Answer with --no-commit next time.",
    ]);
  }, 30_000);

  it.skipIf(!hasGit)("shows what a note is on and that it is being worked on, and records the commit holding the answer", async () => {
    const git = gitIn(dir);
    await git("init", "--quiet");
    await git("add", "--all", "--", ".");
    await git("commit", "--quiet", "-m", "The example as it ships");

    const asked = await addNote(dir, priceSeat, "person", "Why ten percent, and not a fifth?", {
      problem: "Price Seat has no test for the fifth seat.",
      on: { file: "src/booking/price-seat.ts", lines: [4, 5], text: "const DISCOUNT_FROM = 5;\nconst DISCOUNT = 0.1;" },
    });
    const onStep = await addNote(dir, "tickets/box-office", "person", "Say which seats were booked.", {
      on: { execution: "book-seats", step: "#1", description: "The page has nothing to show until the API says." },
    });

    const started = fragmentor(["working", asked.id], dir);
    expect(started.status).toBe(0);
    expect(started.output).toContain(`Marked note ${asked.id} on ${priceSeat} as being worked on.`);
    expect(started.output).toContain("The person now sees it being worked on in Fragmentor, until you reply to it.");

    const listed = fragmentor(["notes"], dir);
    expect(listed.output).toContain(
      ["  on     lines 4-5 of src/booking/price-seat.ts", "         const DISCOUNT_FROM = 5;", "         const DISCOUNT = 0.1;"].join("\n"),
    );
    expect(listed.output).toMatch(/\n {2}working since \d{4}-\d\d-\d\d \d\d:\d\d UTC\n/);
    expect(listed.output).toContain("      problem   Price Seat has no test for the fifth seat.");
    expect(listed.output).toContain('  on     the step "The page has nothing to show until the API says." (#1) of executions/book-seats.json');
    expect(listed.output).toContain("run `fragmentor working <id>`");

    // Nothing has been committed since the person wrote, so nothing is recorded.
    const unchanged = fragmentor(["reply", onStep.id, "The page already says so."], dir);
    expect(unchanged.output).toContain(
      "No commit was recorded with it, because none has been made since the person wrote. If you changed files for it, commit them before you reply.",
    );
    expect((await readNote(onStep.id)).messages[1]!.commit).toBeUndefined();

    // The person wrote a minute ago, and the work was committed since.
    const backdate = async (id: string) => {
      const kept = await readNote(id);
      kept.messages[0]!.at = new Date(Date.now() - 60_000).toISOString();
      await writeFile(path.join(dir, NOTES_DIR, `${id}.json`), JSON.stringify(kept, null, 2), "utf8");
    };
    const refundFor = "tickets/booking-api/pricing/refund-for";
    const elsewhere = await addNote(dir, refundFor, "person", "Refund in full up to a day ahead.");
    const question = await addNote(dir, priceSeat, "person", "Is ten percent what the venue asked for?");
    for (const id of [asked.id, elsewhere.id, question.id]) await backdate(id);
    await writeFile(path.join(dir, "src", "booking", "price-seat.ts"), "// A fifth, as asked.\n", { flag: "a" });
    await git("commit", "--quiet", "-am", "Say why the discount is what it is");
    const hash = (await git("rev-parse", "HEAD")).trim();

    const answered = fragmentor(["reply", asked.id, "It was a guess; it now says why."], dir);
    expect(answered.status).toBe(0);
    expect(answered.output).toContain(`Recorded commit ${hash.slice(0, 7)} "Say why the discount is what it is" with it`);
    const after = await readNote(asked.id);
    expect(after.messages[1]!.commit).toEqual({ hash, subject: "Say why the discount is what it is" });
    expect(after.working).toBeUndefined();

    // That commit is newer than the note on Refund For, and holds no work on it.
    const notItsBlock = fragmentor(["reply", elsewhere.id, "Done."], dir);
    expect(notItsBlock.status).toBe(0);
    expect(notItsBlock.output).toContain(
      `No commit was recorded with it, because the newest commit, ${hash.slice(0, 7)} "Say why the discount is what it is", did not change ${refundFor}.`,
    );
    expect((await readNote(elsewhere.id)).messages[1]!.commit).toBeUndefined();

    // A question is answered, not acted on, so no commit goes with it, even one that changed its block.
    const answer = fragmentor(["reply", question.id, "--no-commit", "Yes:", "it", "is", "in", "their", "contract."], dir);
    expect(answer.status).toBe(0);
    expect(answer.output).toContain("No commit was recorded with it, as --no-commit asked.");
    expect((await readNote(question.id)).messages[1]).toEqual({ from: "agent", at: expect.any(String), text: "Yes: it is in their contract." });

    await replyToNote(dir, asked.id, "person", "Thanks. And the tenth seat?");
    expect(fragmentor(["notes", priceSeat], dir).output).toContain(`      commit    ${hash.slice(0, 7)} Say why the discount is what it is`);

    // A merge is not itself a version of the block, so an answer after one records nothing, and says why.
    const merged = await addNote(dir, priceSeat, "person", "Start the discount at the fourth seat.");
    await backdate(merged.id);
    const trunk = (await git("rev-parse", "--abbrev-ref", "HEAD")).trim();
    await git("checkout", "--quiet", "-b", "fourth-seat");
    await writeFile(path.join(dir, "src", "booking", "price-seat.ts"), "// From the fourth seat.\n", { flag: "a" });
    await git("commit", "--quiet", "-am", "Start the discount at the fourth seat");
    await git("checkout", "--quiet", trunk);
    await git("merge", "--quiet", "--no-ff", "-m", "Merge the fourth seat", "fourth-seat");
    const afterMerge = fragmentor(["reply", merged.id, "Done on a branch, and merged."], dir);
    expect(afterMerge.status).toBe(0);
    expect(afterMerge.output).toContain("is a merge, which is not itself a version of the block");
    expect((await readNote(merged.id)).messages[1]!.commit).toBeUndefined();
  }, 60_000);

  it("says plainly when there is no such note or block", () => {
    const noNote = fragmentor(["reply", "1790000000000-nothing-here", "Done."], dir);
    expect(noNote.status).toBe(1);
    expect(noNote.output).toContain("There is no note 1790000000000-nothing-here.");

    const noNoteToStart = fragmentor(["working", "1790000000000-nothing-here"], dir);
    expect(noNoteToStart.status).toBe(1);
    expect(noNoteToStart.output).toContain("There is no note 1790000000000-nothing-here.");
    expect(fragmentor(["working"], dir).output).toContain("fragmentor working needs the id of the note you are starting on");

    const noBlock = fragmentor(["notes", "tickets/nowhere"], dir);
    expect(noBlock.status).toBe(1);
    expect(noBlock.output).toContain("There is no block at tickets/nowhere.");

    const noteOnNothing = fragmentor(["note", "tickets/nowhere", "Hello."], dir);
    expect(noteOnNothing.status).toBe(1);
    expect(noteOnNothing.output).toContain("There is no block at tickets/nowhere.");

    const flagFirst = fragmentor(["reply", "--no-commit", "1790000000000-nothing-here", "Done."], dir);
    expect(flagFirst.status).toBe(1);
    expect(flagFirst.output).toContain(`--no-commit goes straight after the note's id: fragmentor reply <note-id> --no-commit "<your answer>".`);
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
        `  2 waiting for you, on ${priceSeat} and tickets/box-office. Run \`fragmentor notes\` when the person asks you to work through them.`,
        "  1 waiting for the person, on tickets/box-office.",
      ].join("\n"),
    );
    expect(result.output).toContain("Result: no errors.");
  }, 30_000);
});

describe.skipIf(!hasGit)("what changed since the last commit", () => {
  const blockFile = () => path.join(dir, "blocks", "tickets", "booking-api", "pricing", "price-seat", "block.json");

  beforeEach(async () => {
    await cp(tickets, dir, { recursive: true });
  });

  async function committed(): Promise<void> {
    const git = gitIn(dir);
    await git("init", "--quiet");
    await git("add", "--all", "--", ".");
    await git("commit", "--quiet", "-m", "The example as it ships");
  }

  it("is nothing straight after a commit, and each block changed since, in words, after an edit", async () => {
    await committed();
    const unchanged = fragmentor(["diff"], dir);
    expect(unchanged.status).toBe(0);
    expect(unchanged.output).toMatch(/^No changes since the last commit, [0-9a-f]{7} "The example as it ships"\./);

    const block = JSON.parse(await readFile(blockFile(), "utf8")) as { responsibility: string };
    await writeFile(blockFile(), JSON.stringify({ ...block, responsibility: "Price one seat, less a tenth from the fifth." }, null, 2), "utf8");
    // From elsewhere, naming the project.
    const edited = fragmentor(["diff", "--project", dir], repo);
    expect(edited.status).toBe(0);
    expect(edited.output).toContain(
      [
        "Changed",
        "  tickets/booking-api/pricing/price-seat  Price Seat",
        "      responsibility changed: Price one seat, less a tenth from the fifth.",
      ].join("\n"),
    );
  }, 30_000);

  it("calls everything new before the first commit", async () => {
    await gitIn(dir)("init", "--quiet");
    const result = fragmentor(["diff"], dir);
    expect(result.status).toBe(0);
    expect(result.output).toContain("Changes since before the first commit:\n\nNew\n  tickets  Tickets");
  }, 30_000);

  it("says why it cannot say, without git or given anything to compare", async () => {
    const noGit = fragmentor(["diff"], dir);
    expect(noGit.status).toBe(1);
    expect(noGit.output).toMatch(/^Changes come from/);

    await committed();
    const given = fragmentor(["diff", "HEAD~1"], dir);
    expect(given.status).toBe(1);
    expect(given.output).toContain("fragmentor diff takes nothing but --project, and was given HEAD~1.");
  }, 30_000);
});

describe("fragmentor analytics", () => {
  it("lists Messenger's weak spot first with its evidence, then the measurements, each with what it is counted from", async () => {
    await cp(path.join(repo, "examples", "messenger"), dir, { recursive: true });
    const result = fragmentor(["analytics"], dir);
    expect(result.status).toBe(0);
    const lines = result.output.split("\n");
    expect(lines.indexOf("Weak spots")).toBeLessThan(lines.indexOf("Coupling"));
    expect(result.output).toContain("  Parts that use each other in a circle: 1\n    State and UI, on Client (app/client)\n");
    expect(result.output).toContain("in the code: State → UI, showMessage from src/client/ui/chatView.ts");
    expect(result.output).toContain("in the code: UI → State, dispatch from src/client/state.ts");
    expect(result.output).toContain("  Functions with more than 10 ways through: none");
    expect(result.output).toContain("  Ways through: most: dispatch, 7 · min 1, median 1, max 7 over 18 functions in the code");
    expect(result.output).toContain("  Used by: most: Database (6) · min 0, median 1, max 6 over 22 blocks");
    expect(result.output).toContain("    State (outward share 0.4) → Router (outward share 0.83)");
    expect(result.output).toContain("    UI: its 3 parts form 3 groups: Chat View · Login Form · Send Button");
    expect(result.output).toContain("\nRuntime performance\n  Recorded runs: not recorded by this command; `fragmentor test` records every execution and prints its time");
    expect(result.output).toContain("  Changes: Changes come from the project's git history, and this folder is not in a git repository yet. Ask your agent to put it under git and commit.");
    expect(result.output).toContain("  Changes often and is hard to follow: not measured: Changes come from the project's git history");
    expect(result.output).toContain("\nNot measured: none");
    // Every number's sentence is on the line after it.
    expect(result.output).toContain("  Used by: most: Database (6)");
    expect(result.output.split("Used by: most: Database (6)")[1]!.split("\n")[1]).toContain("Counted from");

    const check = fragmentor(["check"], dir);
    expect(check.output).toContain("\nWeak spots: 1, which is not a problem. `fragmentor analytics` lists them with their evidence; weigh them when the person asks for a review, and change nothing for them otherwise.\n");
    expect(check.output).toContain("Result: no errors.");
  }, 60_000);

  it("counts the commits that touched each block once the project is under git", async () => {
    await cp(tickets, dir, { recursive: true });
    const git = gitIn(dir);
    await git("init", "--quiet");
    await git("add", "-A");
    await git("commit", "--quiet", "-m", "Start");
    const output = fragmentor(["analytics", "tickets/booking-api/find-event"], dir).output;
    expect(output).toContain("  Changes: 1 commit in the last 12 months (100% of Tickets)");
    expect(output).toContain("Commits of the last 12 months that touched a block's code files");
  }, 60_000);

  it("finds no weak spot on Tickets, says what it looked for, and measures one block on its own", async () => {
    await cp(tickets, dir, { recursive: true });
    const whole = fragmentor(["analytics"], dir);
    expect(whole.status).toBe(0);
    expect(whole.output).toContain("  Parts that use each other in a circle: none\n");
    expect(whole.output).toContain("  No weak spots found. A weak spot is a finding worth asking your agent about, never a problem.");
    expect(whole.output).toContain("    Tickets Database (tickets/tickets-db): 5\n");
    expect(whole.output).toContain("    Pricing: its 2 parts form 2 groups: Price Seat · Refund For\n");
    expect(whole.output).toContain("  Held to a contract: 6 of 6 function blocks");
    expect(whole.output).toContain("  Ways through: most: bookSeats, 5 ·");
    expect(whole.output).toContain("  Size: 48 statements in 18 functions in the code · most: bookSeats, 12 (25%)");
    expect(whole.output).toContain("  Code under no block: 10 statements (21%) in src/server.ts");

    const one = fragmentor(["analytics", "tickets/tickets-db"], dir);
    expect(one.status).toBe(0);
    expect(one.output).toContain("Tickets Database (tickets/tickets-db)\n\nNo weak spot is on this block.");
    expect(one.output).toContain("  Used by: 5 — 1st of 2 stores\n");
    expect(one.output).toContain("    Reminders (tickets/reminders): on the diagram: reads bookings (planned)");
    expect(one.output).toContain("  Outward share: 0 (everything leans on it)");

    expect(fragmentor(["analytics", "tickets/nowhere"], dir).output).toContain("There is no block at tickets/nowhere.");
    expect(fragmentor(["analytics", "a", "b"], dir).output).toContain("fragmentor analytics takes one block path at most, and was given 2.");
    expect(fragmentor(["check"], dir).output).not.toContain("Weak spots");
  }, 60_000);
});
