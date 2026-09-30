import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitIn } from "./exampleHistory.js";
import {
  MOST_NOTE_TEXT,
  NOTES_DIR,
  addNote,
  deleteNote,
  describeRun,
  flaggedRunOf,
  isNotePath,
  isNoteWithin,
  loadNotes,
  markWorking,
  noteById,
  noteIdPattern,
  replyToNote,
  resolveNote,
  waitingOn,
} from "./notes.js";
import type { FlaggedRun, Note } from "./notes.js";

/**
 * Notes on a copy of the tickets example, as the files they are: what is
 * written, what is refused, and what survives a checkout and a merge.
 */

const tickets = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "examples", "tickets");
const priceSeat = "tickets/booking-api/pricing/price-seat";

/** Git, where the machine has it: the one test that needs it is skipped otherwise. */
const hasGit = spawnSync("git", ["--version"]).status === 0;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "fragmentor-notes-"));
  await cp(tickets, dir, { recursive: true });
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

const noteFile = (id: string) => path.join(dir, NOTES_DIR, `${id}.json`);
const readNoteFile = async (id: string) => JSON.parse(await readFile(noteFile(id), "utf8")) as Omit<Note, "id">;

/** Writes a note's file by hand, as a checkout or a merge would leave it. */
async function putNote(name: string, contents: unknown): Promise<void> {
  await mkdir(path.join(dir, NOTES_DIR), { recursive: true });
  await writeFile(path.join(dir, NOTES_DIR, name), typeof contents === "string" ? contents : JSON.stringify(contents), "utf8");
}

const failedRun: FlaggedRun = {
  test: "the tenth seat is a fifth off",
  input: { fullPrice: 25, seat: 10 },
  expected: { price: 20 },
  output: { price: 22.5 },
  problems: ["output.price was 22.5, expected 20."],
  logs: ["priced seat 10"],
};

describe("leaving a note", () => {
  it("writes it to a file of its own, named by a time and its first words", async () => {
    const note = await addNote(dir, priceSeat, "person", "  Refuse a booking of zero seats.  ");

    expect(note.id).toMatch(noteIdPattern);
    expect(note.id).toMatch(/^\d{13}-refuse-a-booking-of-zero-seats$/);
    expect(await readdir(path.join(dir, NOTES_DIR))).toEqual([`${note.id}.json`]);

    const written = await readNoteFile(note.id);
    expect(written).toEqual({
      block: priceSeat,
      status: "open",
      messages: [{ from: "person", at: expect.any(String), text: "Refuse a booking of zero seats." }],
    });
    // The id is the moment it was written, so the folder reads in order.
    expect(Date.parse(written.messages[0]!.at)).toBe(Number(note.id.slice(0, 13)));
    expect(note).toEqual({ id: note.id, ...written });
  });

  it("refuses a block that is not there, a path that is not one, and text that is no note", async () => {
    await expect(addNote(dir, "tickets/nowhere", "person", "Hello.")).rejects.toThrow("There is no block at tickets/nowhere.");
    await expect(addNote(dir, "tickets/../outside", "person", "Hello.")).rejects.toThrow("is not a block path");
    await expect(addNote(dir, priceSeat, "person", "   \n ")).rejects.toThrow("A note needs something written in it.");
    await expect(addNote(dir, priceSeat, "person", "x".repeat(MOST_NOTE_TEXT + 1))).rejects.toThrow(
      `A note can be at most ${MOST_NOTE_TEXT} characters.`,
    );
    expect((await loadNotes(dir)).notes).toEqual([]);

    // Right at the limit is still a note.
    expect((await addNote(dir, priceSeat, "person", "x".repeat(MOST_NOTE_TEXT))).messages[0]!.text).toHaveLength(MOST_NOTE_TEXT);
  });

  it("makes sure notes are committed while everything else Fragmentor keeps is not", async () => {
    await addNote(dir, priceSeat, "person", "Hello.");
    expect(await readFile(path.join(dir, ".fragmentor", ".gitignore"), "utf8")).toBe("*\n!versions/\n!versions/**\n!notes/\n!notes/**\n!rules.json\n");
  });

  it("gives two notes written in the same millisecond with the same words different ids", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(1_790_000_000_000));

    const first = await addNote(dir, priceSeat, "person", "Same words.");
    const second = await addNote(dir, priceSeat, "agent", "Same words.");
    expect([first.id, second.id]).toEqual(["1790000000000-same-words", "1790000000001-same-words"]);
    expect((await readNoteFile(first.id)).messages[0]!.from).toBe("person");
    expect((await readNoteFile(second.id)).messages[0]!.from).toBe("agent");
  });

  it.skipIf(!hasGit)("shows up in git as something to commit, and nothing else Fragmentor keeps does", async () => {
    const git = gitIn(dir);
    await git("init", "--quiet");
    await git("add", "--all", "--", ".");
    await git("commit", "--quiet", "-m", "The example as it ships");

    const note = await addNote(dir, priceSeat, "person", "Refuse a booking of zero seats.");
    // A copy kept for Undo swap, which must never be committed.
    await mkdir(path.join(dir, ".fragmentor", "swaps", "1"), { recursive: true });
    await writeFile(path.join(dir, ".fragmentor", "swaps", "1", "record.json"), "{}", "utf8");

    expect((await git("status", "--porcelain", "--untracked-files=all")).trim()).toBe(`?? ${NOTES_DIR}/${note.id}.json`);
  }, 30_000);
});

describe("a note's conversation", () => {
  it("is waiting for whoever did not write last, until the person resolves it", async () => {
    const note = await addNote(dir, priceSeat, "person", "Take a fifth off from the tenth seat.");
    expect(waitingOn(note)).toBe("agent");

    const answered = await replyToNote(dir, note.id, "agent", "Done: the tenth seat is a fifth off.");
    expect(waitingOn(answered)).toBe("person");
    expect(answered.messages.map((message) => message.from)).toEqual(["person", "agent"]);

    const again = await replyToNote(dir, note.id, "person", "And the eleventh, please.");
    expect(waitingOn(again)).toBe("agent");

    // What is on disk says the same as what came back.
    const [loaded] = (await loadNotes(dir)).notes;
    expect(loaded).toEqual(again);
    expect(waitingOn(loaded!)).toBe("agent");
  });

  it("opens again when someone replies to it after it was resolved", async () => {
    const note = await addNote(dir, priceSeat, "person", "Explain the discount.");
    const resolved = await resolveNote(dir, note.id);
    expect(resolved.status).toBe("resolved");
    expect(waitingOn(resolved)).toBeNull();

    const reopened = await replyToNote(dir, note.id, "person", "One more thing.");
    expect(reopened.status).toBe("open");
    expect(waitingOn(reopened)).toBe("agent");
    expect((await readNoteFile(note.id)).status).toBe("open");
  });

  it("changes nothing when resolved twice", async () => {
    const note = await addNote(dir, priceSeat, "person", "Explain the discount.");
    const once = await resolveNote(dir, note.id);
    const bytes = await readFile(noteFile(note.id), "utf8");

    expect(await resolveNote(dir, note.id)).toEqual(once);
    expect(await readFile(noteFile(note.id), "utf8")).toBe(bytes);
  });

  it("is gone once deleted, and says so to whoever tries again", async () => {
    const note = await addNote(dir, priceSeat, "person", "Never mind.");
    await deleteNote(dir, note.id);

    expect((await loadNotes(dir)).notes).toEqual([]);
    await expect(deleteNote(dir, note.id)).rejects.toThrow("That note is not there any more.");
    await expect(replyToNote(dir, note.id, "agent", "Done.")).rejects.toThrow(`There is no note ${note.id}. It may have been deleted.`);
    await expect(resolveNote(dir, "not-a-note")).rejects.toThrow('"not-a-note" is not a note.');
  });

  it("keeps the line endings of a file checked out with Windows ones", async () => {
    const note = await addNote(dir, priceSeat, "person", "Refuse a booking of zero seats.");
    await writeFile(noteFile(note.id), (await readFile(noteFile(note.id), "utf8")).replace(/\n/g, "\r\n"), "utf8");

    await replyToNote(dir, note.id, "agent", "Done.");
    const text = await readFile(noteFile(note.id), "utf8");
    expect(text).toContain("\r\n");
    expect(text.replace(/\r\n/g, "")).not.toContain("\n");
    expect(JSON.parse(text).messages).toHaveLength(2);

    // And one written with plain ones keeps those.
    const other = await addNote(dir, priceSeat, "person", "Another.");
    await resolveNote(dir, other.id);
    expect(await readFile(noteFile(other.id), "utf8")).not.toContain("\r");
  });
});

describe("a flagged run", () => {
  it("is kept with the note it was flagged on, and described as the agent reads it", async () => {
    const note = await addNote(dir, priceSeat, "person", "This one is wrong.", { run: { ...failedRun, stores: {} } });

    const { run } = (await readNoteFile(note.id)).messages[0]!;
    // Stores that held nothing say nothing, so they are not kept.
    expect(run).toEqual(failedRun);
    expect(describeRun(run!)).toEqual([
      'the saved test "the tenth seat is a fifth off" failed',
      'input     {"fullPrice":25,"seat":10}',
      'expected  {"price":20}',
      'got       {"price":22.5}',
      "output.price was 22.5, expected 20.",
      "logged    priced seat 10",
    ]);
  });

  it("cuts a huge value short, saying which, and refuses what is not a run", async () => {
    const huge = { rows: "x".repeat(30_000) };
    const note = await addNote(dir, priceSeat, "person", "Too big.", {
      run: { test: null, input: huge, expected: { price: 20 }, output: huge, problems: [], logs: [] },
    });

    const { run } = (await readNoteFile(note.id)).messages[0]!;
    expect(typeof run!.input).toBe("string");
    expect(run!.input as string).toMatch(/^\(too large to keep whole; it began\) \{"rows":"xxx/);
    expect((run!.input as string).length).toBeLessThan(20_100);
    // What was small enough is kept whole, and not listed as cut.
    expect(run!.expected).toEqual({ price: 20 });
    expect(run!.cut).toEqual(["input", "output"]);
    const described = describeRun(run!);
    expect(described[0]).toBe("a run tried from the bench went wrong");
    expect(described.at(-1)).toBe(
      "Too large to keep whole with this note, so cut short or left out: the input and what came back. This is not all of the run, so it cannot be run again exactly as it went.",
    );

    // A run kept whole says nothing is cut.
    const whole = await addNote(dir, priceSeat, "person", "Small.", { run: failedRun });
    expect(whole.messages[0]!.run!.cut).toBeUndefined();

    await expect(
      addNote(dir, priceSeat, "person", "Not a run.", { run: { input: 1 } as unknown as FlaggedRun }),
    ).rejects.toThrow("What was flagged is not a run Fragmentor can keep with a note.");
  });

  it("still says what was cut when a run that was cut is flagged again", async () => {
    const note = await addNote(dir, priceSeat, "person", "Still wrong.", {
      run: { ...failedRun, input: "(too large to keep whole; it began) {…", cut: ["input"] },
    });
    expect(note.messages[0]!.run!.cut).toEqual(["input"]);
    expect((await loadNotes(dir)).problems).toEqual([]);
  });

  it("keeps only the stores the run was given rows for", async () => {
    const note = await addNote(dir, priceSeat, "person", "Empty stores.", {
      run: {
        test: null,
        input: {},
        stores: { "tickets/tickets-db.events": {}, "tickets/tickets-db.bookings": { b1: { id: "b1" } } },
        problems: [],
        logs: [],
      },
    });
    expect(note.messages[0]!.run!.stores).toEqual({ "tickets/tickets-db.bookings": { b1: { id: "b1" } } });

    const none = await addNote(dir, priceSeat, "person", "No rows at all.", {
      run: { test: null, input: {}, stores: { "tickets/tickets-db.events": {} }, problems: [], logs: [] },
    });
    expect(none.messages[0]!.run!.stores).toBeUndefined();
  });

  it("leaves out stores too large to keep, saying so, so the note can still be read and answered", async () => {
    const rows = Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`row-${i}`, { id: `row-${i}`, seats: i }]));
    const note = await addNote(dir, priceSeat, "person", "Too many rows.", {
      run: { test: null, input: { seats: 0 }, stores: { "tickets/tickets-db.events": rows }, problems: ["It threw."], logs: [] },
    });

    const { notes, problems } = await loadNotes(dir);
    expect(problems).toEqual([]);
    const run = notes.find((each) => each.id === note.id)!.messages[0]!.run!;
    expect(run.stores).toBeUndefined();
    expect(run.problems).toEqual(["It threw."]);
    expect(run.cut).toEqual(["stores"]);
    expect(describeRun(run).at(-1)).toMatch(/^Too large to keep whole with this note, so cut short or left out: the stores' rows\./);
    await expect(replyToNote(dir, note.id, "agent", "Fixed.")).resolves.toMatchObject({ messages: [{}, { text: "Fixed." }] });
  });
});

describe("what a note is on, and what comes with it", () => {
  const hash = "0123456789abcdef0123456789abcdef01234567";

  it("keeps some lines of code as they were, and past what a note holds as many whole lines as fit", async () => {
    const lines = { file: "src/booking/price-seat.ts", lines: [3, 5] as [number, number], text: "one\ntwo\nthree" };
    const note = await addNote(dir, priceSeat, "person", "Why a tenth?", { on: lines });
    expect((await readNoteFile(note.id)).on).toEqual(lines);

    // Right at the limit is kept whole.
    const atLimit = { ...lines, text: "x".repeat(MOST_NOTE_TEXT) };
    expect((await addNote(dir, priceSeat, "person", "Just fits.", { on: atLimit })).on).toEqual(atLimit);

    // Lines of 99 characters and a line break each: past the limit, only whole ones are kept.
    const line = (i: number) => `${String(i).padStart(3, "0")} ${"x".repeat(95)}`;
    const many = Array.from({ length: 60 }, (_, i) => line(i)).join("\n");
    const long = await addNote(dir, priceSeat, "person", "All of it.", { on: { ...lines, lines: [1, 60], text: many } });
    const kept = (long.on as { text: string }).text;
    expect(kept.length).toBeLessThanOrEqual(MOST_NOTE_TEXT);
    const keptLines = kept.split("\n");
    expect(keptLines.at(-1)).toBe("… (the rest of the lines picked out are not kept)");
    expect(keptLines.slice(0, -1)).toEqual(Array.from({ length: keptLines.length - 1 }, (_, i) => line(i)));
    // As many as fit: one more would not have.
    expect(kept.length + line(keptLines.length - 1).length + 1).toBeGreaterThan(MOST_NOTE_TEXT);
    expect(long.on).toMatchObject({ file: lines.file, lines: [1, 60] });
  });

  it("keeps a step of an execution, by the execution and the step's id", async () => {
    const step = { execution: "book-seats", step: "price", description: "Each seat is priced in turn." };
    const note = await addNote(dir, priceSeat, "person", "Price them all at once.", { on: step });
    expect((await readNoteFile(note.id)).on).toEqual(step);
    expect(await noteById(dir, note.id)).toEqual(note);
  });

  it("refuses lines that run backwards, rather than keep a note nobody could read back", async () => {
    await expect(
      addNote(dir, priceSeat, "person", "Backwards.", { on: { file: "src/booking/price-seat.ts", lines: [5, 2], text: "" } }),
    ).rejects.toThrow("The lines picked out run backwards, from 5 to 2: the first line comes before the last.");
    expect((await loadNotes(dir)).notes).toEqual([]);
  });

  it("keeps a problem the person flagged, and the commit the agent answered with", async () => {
    const note = await addNote(dir, priceSeat, "person", "Fix this, please.", { problem: "  Price Seat's code is not there.  " });
    expect((await readNoteFile(note.id)).messages[0]!.problem).toBe("Price Seat's code is not there.");

    await replyToNote(dir, note.id, "agent", "Done.", { commit: { hash, subject: "Write Price Seat" } });
    expect((await readNoteFile(note.id)).messages[1]!.commit).toEqual({ hash, subject: "Write Price Seat" });
  });

  it("refuses a commit that is not a whole hash, and leaves the note as it was", async () => {
    const note = await addNote(dir, priceSeat, "person", "Fix this, please.");
    const before = await readFile(noteFile(note.id), "utf8");
    await expect(replyToNote(dir, note.id, "agent", "Done.", { commit: { hash: "abc1234", subject: "Short" } })).rejects.toThrow(
      "Fragmentor could not keep this note",
    );
    expect(await readFile(noteFile(note.id), "utf8")).toBe(before);
  });

  it("gives the newest run flagged, which is the one to run again", async () => {
    const note = await addNote(dir, priceSeat, "person", "This one is wrong.", { run: failedRun });
    await replyToNote(dir, note.id, "agent", "Fixed.");
    const newer = { ...failedRun, input: { fullPrice: 25, seat: 11 } };
    const again = await replyToNote(dir, note.id, "person", "Still wrong for the eleventh.", { run: newer });

    expect(flaggedRunOf(again)).toEqual(newer);
    expect(flaggedRunOf(await addNote(dir, priceSeat, "person", "No run."))).toBeUndefined();
  });
});

describe("working on a note", () => {
  it("shows the agent has started on it, until anyone next writes to it", async () => {
    const note = await addNote(dir, priceSeat, "person", "Take a fifth off from the tenth seat.");
    const started = await markWorking(dir, note.id);
    expect(Date.parse(started.working!)).not.toBeNaN();
    expect((await readNoteFile(note.id)).working).toBe(started.working);
    // It is still waiting for the agent: saying it has started is not an answer.
    expect(waitingOn(started)).toBe("agent");

    const answered = await replyToNote(dir, note.id, "agent", "Done.");
    expect(answered.working).toBeUndefined();
    expect((await readNoteFile(note.id)).working).toBeUndefined();

    await replyToNote(dir, note.id, "person", "And the eleventh, please.");
    await markWorking(dir, note.id);
    expect((await resolveNote(dir, note.id)).working).toBeUndefined();
    expect((await readNoteFile(note.id)).working).toBeUndefined();
  });

  it("is refused for a note that is resolved", async () => {
    const note = await addNote(dir, priceSeat, "person", "Explain the discount.");
    await resolveNote(dir, note.id);
    await expect(markWorking(dir, note.id)).rejects.toThrow(`Note ${note.id} is resolved.`);
  });

  it("is refused for a note waiting for the person, and leaves it as it was", async () => {
    const answered = await addNote(dir, priceSeat, "person", "Explain the discount.");
    await replyToNote(dir, answered.id, "agent", "It is ten percent from the fifth seat.");
    const theirs = await addNote(dir, priceSeat, "agent", "The discount is never tested.");

    for (const note of [answered, theirs]) {
      const before = await readFile(noteFile(note.id), "utf8");
      await expect(markWorking(dir, note.id)).rejects.toThrow(`Note ${note.id} is waiting for the person, not you: they answer it next.`);
      expect(await readFile(noteFile(note.id), "utf8")).toBe(before);
    }
  });
});

describe("loadNotes", () => {
  it("finds none in a project that has never had one", async () => {
    expect(await loadNotes(dir)).toEqual({ notes: [], problems: [] });
  });

  it("returns notes oldest first, and names every file it cannot read rather than dropping it", async () => {
    const message = { from: "person", at: "2026-09-24T10:00:00.000Z", text: "Hello." };
    await putNote("1790000000002-newer.json", { block: priceSeat, status: "open", messages: [message] });
    await putNote("1790000000001-older.json", { block: "tickets/box-office", status: "resolved", messages: [message] });
    await putNote("1790000000003-broken.json", '{ "block": ');
    await putNote("1790000000004-empty.json", { block: priceSeat, status: "open", messages: [] });
    await putNote("My Notes.json", { block: priceSeat, status: "open", messages: [message] });
    await putNote("readme.txt", "Not a note, and not claiming to be one.");

    const { notes, problems } = await loadNotes(dir);
    expect(notes.map((note) => note.id)).toEqual(["1790000000001-older", "1790000000002-newer"]);
    expect(problems).toEqual([
      { file: `${NOTES_DIR}/1790000000003-broken.json`, problem: expect.stringMatching(/^it is not valid JSON/) },
      { file: `${NOTES_DIR}/1790000000004-empty.json`, problem: expect.stringContaining("messages") },
      { file: `${NOTES_DIR}/My Notes.json`, problem: "its name is not a note's id, so Fragmentor does not read it as one." },
    ]);
  });
});

describe("where a note is", () => {
  it("is on its own block and each block that holds it", () => {
    const note: Note = { id: "1790000000000-x", block: priceSeat, status: "open", messages: [] };
    expect(isNoteWithin(note, priceSeat)).toBe(true);
    expect(isNoteWithin(note, "tickets/booking-api")).toBe(true);
    expect(isNoteWithin(note, "tickets/booking")).toBe(false);
    expect(isNoteWithin(note, `${priceSeat}/deeper`)).toBe(false);
  });

  it("recognises a note's file by its path, whichever way the slashes lean", () => {
    expect(isNotePath(".fragmentor/notes/1790000000000-x.json")).toBe(true);
    expect(isNotePath(".fragmentor\\notes\\1790000000000-x.json")).toBe(true);
    expect(isNotePath(".fragmentor/versions/tickets/x.json")).toBe(false);
  });
});
