import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v4";
import { ignoreAllButShared } from "./history.js";
import { blockDir } from "./project.js";

/**
 * Notes left on blocks, by the person and by the agent, for each other.
 *
 * A note is a short conversation about one block: "refuse a booking of zero
 * seats", then "done: book-seats now turns it away", then resolved. It is
 * the one way the person can ask for work in Fragmentor itself, beside the
 * part it is about, rather than describing the part to the agent in words.
 * Fragmentor never calls a model, so nothing here does the work: the person
 * tells their agent to review the notes, and the agent reads and answers
 * them with the `fragmentor` command.
 *
 * Whose turn it is follows from who wrote last. An open note whose last
 * message is the person's is waiting for the agent; one whose last message
 * is the agent's is waiting for the person, who resolves it once satisfied
 * or replies if not. Only the person resolves, because the agent saying it
 * is done and the person agreeing are two different things.
 *
 * Each note is a file of its own under `.fragmentor/notes/`, named by its id,
 * so the person and the agent writing at the same moment never write the
 * same file, and two branches that each add a note merge without a conflict.
 * The block it is on is written inside it rather than in its path, so a
 * block that moves takes its notes along by changing one line in each. They
 * are committed with the project, as saved versions are, and are never part
 * of a block's versions: a block swapped back to last week keeps this
 * week's notes.
 */

export const NOTES_DIR = ".fragmentor/notes";

export type NoteAuthor = "person" | "agent";

/**
 * What a run that went wrong was given, and what went wrong with it, kept
 * with the note flagging it so the agent can run it again without asking.
 */
export interface FlaggedRun {
  /** The saved test's name, or null for a run tried once from the bench. */
  test: string | null;
  input: unknown;
  /** What each store held before the run, by target and then by key. */
  stores?: Record<string, Record<string, unknown>>;
  /** What the test expected, when it said. */
  expected?: unknown;
  /** What came back, when anything did. */
  output?: unknown;
  /** What went wrong, as Fragmentor reported it. */
  problems: string[];
  logs: string[];
}

export interface NoteMessage {
  from: NoteAuthor;
  /** When it was written, as an ISO date. */
  at: string;
  text: string;
  run?: FlaggedRun;
}

export interface Note {
  id: string;
  /** The block it is on, by path. */
  block: string;
  status: "open" | "resolved";
  /** Oldest first, and never empty. */
  messages: NoteMessage[];
}

/** A time and the note's first few words, so the folder reads in order and says what each is about. */
export const noteIdPattern = /^\d{13}-[a-z0-9-]{0,32}$/;

/** Longer than this, a message is an essay rather than a note. */
export const MOST_NOTE_TEXT = 4000;

/** Past this, a value kept with a flagged run is cut short rather than kept whole. */
const MOST_KEPT_VALUE = 20_000;

const runSchema = z
  .object({
    test: z.string().min(1).nullable(),
    input: z.unknown(),
    stores: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
    expected: z.unknown().optional(),
    output: z.unknown().optional(),
    problems: z.array(z.string()),
    logs: z.array(z.string()),
  })
  .strict();

const noteFileSchema = z
  .object({
    block: z.string().min(1),
    status: z.enum(["open", "resolved"]),
    messages: z
      .array(
        z
          .object({
            from: z.enum(["person", "agent"]),
            at: z.string().min(1),
            text: z.string().min(1),
            run: runSchema.optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

type NoteFile = Omit<Note, "id">;

/** Who has to do something next, or null once the note is resolved. */
export function waitingOn(note: Note): NoteAuthor | null {
  if (note.status === "resolved") return null;
  return note.messages.at(-1)!.from === "person" ? "agent" : "person";
}

/** Whether a path, relative to the project with either kind of slash, is a note's file. */
export function isNotePath(file: string): boolean {
  return file.replace(/\\/g, "/").startsWith(`${NOTES_DIR}/`);
}

/** Whether a note is on this block or on one of its parts. */
export function isNoteWithin(note: Note, blockPath: string): boolean {
  return note.block === blockPath || note.block.startsWith(`${blockPath}/`);
}

function notePath(projectDir: string, id: string): string {
  if (!noteIdPattern.test(id)) throw new Error(`"${id}" is not a note. A note's id looks like 1727190000000-refuse-zero-seats.`);
  return path.join(projectDir, NOTES_DIR, `${id}.json`);
}

function textOf(text: string): string {
  const written = text.trim();
  if (written === "") throw new Error("A note needs something written in it.");
  if (written.length > MOST_NOTE_TEXT) throw new Error(`A note can be at most ${MOST_NOTE_TEXT} characters.`);
  return written;
}

/** A value kept whole where it is small, and cut short, saying so, where it is not. */
function kept(value: unknown): unknown {
  if (value === undefined) return undefined;
  const written = JSON.stringify(value);
  if (written === undefined || written.length <= MOST_KEPT_VALUE) return value;
  return `(too large to keep whole; it began) ${written.slice(0, MOST_KEPT_VALUE)}…`;
}

/**
 * A flagged run as it is kept: held to the shape, with anything huge cut
 * short. Stores are rows by key, which a cut could only turn into something
 * that is not, so ones too large are left out, saying so, rather than cut.
 */
function keptRun(run: FlaggedRun): FlaggedRun {
  const parsed = runSchema.safeParse(run);
  if (!parsed.success) throw new Error("What was flagged is not a run Fragmentor can keep with a note.");
  const given = parsed.data as FlaggedRun;
  // A store the run was given no rows for says nothing about it.
  const filled = Object.entries(given.stores ?? {}).filter(([, rows]) => Object.keys(rows).length > 0);
  const stores = filled.length === 0 ? undefined : Object.fromEntries(filled);
  const storesFit = stores === undefined || kept(stores) === stores;
  return {
    test: given.test === null ? null : given.test.slice(0, MOST_NOTE_TEXT),
    input: kept(given.input),
    ...(stores !== undefined && storesFit ? { stores } : {}),
    ...(given.expected === undefined ? {} : { expected: kept(given.expected) }),
    ...(given.output === undefined ? {} : { output: kept(given.output) }),
    problems: [
      ...given.problems.slice(0, 50).map((each) => each.slice(0, MOST_NOTE_TEXT)),
      ...(storesFit ? [] : ["The rows the stores held before the run were too many to keep with this note, so they are left out."]),
    ],
    logs: given.logs.slice(0, 50).map((each) => each.slice(0, MOST_NOTE_TEXT)),
  };
}

function message(from: NoteAuthor, text: string, run: FlaggedRun | undefined): NoteMessage {
  return { from, at: new Date().toISOString(), text: textOf(text), ...(run === undefined ? {} : { run: keptRun(run) }) };
}

function parseNote(text: string): NoteFile | string {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return `it is not valid JSON: ${error instanceof Error ? error.message : String(error)}`;
  }
  const parsed = noteFileSchema.safeParse(raw);
  if (parsed.success) return parsed.data as NoteFile;
  return parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
}

/**
 * Every note in a project, oldest first, and what was wrong with the files
 * that could not be read. A missing folder just means there are none yet.
 * A file that cannot be read is reported rather than dropped, so a note
 * never silently disappears.
 */
export async function loadNotes(projectDir: string): Promise<{ notes: Note[]; problems: { file: string; problem: string }[] }> {
  let names: string[];
  try {
    names = (await readdir(path.join(projectDir, NOTES_DIR))).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { notes: [], problems: [] };
    throw error;
  }

  const notes: Note[] = [];
  const problems: { file: string; problem: string }[] = [];
  for (const name of names) {
    const file = `${NOTES_DIR}/${name}`;
    const id = name.slice(0, -".json".length);
    if (!noteIdPattern.test(id)) {
      problems.push({ file, problem: "its name is not a note's id, so Fragmentor does not read it as one." });
      continue;
    }
    const text = await readFile(path.join(projectDir, NOTES_DIR, name), "utf8").catch(() => null);
    const parsed = text === null ? "it could not be read." : parseNote(text);
    if (typeof parsed === "string") problems.push({ file, problem: parsed });
    else notes.push({ id, ...parsed });
  }
  return { notes, problems };
}

/** One note, read for changing. */
async function readNote(projectDir: string, id: string): Promise<{ file: string; text: string; note: Note }> {
  const file = notePath(projectDir, id);
  const text = await readFile(file, "utf8").catch(() => null);
  if (text === null) throw new Error(`There is no note ${id}. It may have been deleted.`);
  const parsed = parseNote(text);
  if (typeof parsed === "string") throw new Error(`Note ${id} cannot be read, so it cannot be changed: ${parsed}`);
  return { file, text, note: { id, ...parsed } };
}

/** Refuses to write a note that could not be read back, which would lose it to everyone. */
function readable(note: NoteFile): void {
  const parsed = noteFileSchema.safeParse(note);
  if (!parsed.success) throw new Error(`Fragmentor could not keep this note: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
}

/**
 * Writes a note back over itself. The line endings a checkout gave the file
 * are kept, so a commit changing it shows only what changed.
 */
async function rewrite(file: string, before: string, note: Note): Promise<void> {
  const { id: _id, ...written } = note;
  readable(written);
  const end = before.includes("\r\n") ? "\r\n" : "\n";
  await writeFile(file, `${JSON.stringify(written, null, 2)}\n`.replace(/\n/g, end), "utf8");
}

/**
 * Leaves a new note on a block. It is refused for a block that is not there,
 * because a note on nothing could never be found again.
 */
export async function addNote(projectDir: string, blockPath: string, from: NoteAuthor, text: string, run?: FlaggedRun): Promise<Note> {
  const first = message(from, text, run);
  const blockFile = path.join(blockDir(projectDir, blockPath), "block.json");
  if (!(await access(blockFile).then(() => true, () => false))) throw new Error(`There is no block at ${blockPath}.`);

  await ignoreAllButShared(projectDir);
  await mkdir(path.join(projectDir, NOTES_DIR), { recursive: true });
  const written: NoteFile = { block: blockPath, status: "open", messages: [first] };
  readable(written);
  // The first few words, as many whole ones as fit.
  let slug = "";
  for (const word of first.text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    const longer = slug === "" ? word : `${slug}-${word}`;
    if (longer.length > 32) break;
    slug = longer;
  }
  if (slug === "") slug = first.text.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 32);

  // Never over another note: two written in the same millisecond with the same
  // first words take the next free moment.
  for (let time = Date.parse(first.at), tries = 0; ; time += 1, tries += 1) {
    const id = `${time}-${slug}`;
    try {
      await writeFile(notePath(projectDir, id), `${JSON.stringify(written, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      return { id, ...written };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || tries >= 100) throw error;
    }
  }
}

/**
 * Adds to a note's conversation, which hands it to whoever did not write
 * this. Replying to a resolved note opens it again, because a reply is
 * something more to do.
 */
export async function replyToNote(projectDir: string, id: string, from: NoteAuthor, text: string, run?: FlaggedRun): Promise<Note> {
  const added = message(from, text, run);
  const { file, text: before, note } = await readNote(projectDir, id);
  const next: Note = { ...note, status: "open", messages: [...note.messages, added] };
  await rewrite(file, before, next);
  return next;
}

/** Marks a note done. Resolving one that already is changes nothing. */
export async function resolveNote(projectDir: string, id: string): Promise<Note> {
  const { file, text: before, note } = await readNote(projectDir, id);
  if (note.status === "resolved") return note;
  const next: Note = { ...note, status: "resolved" };
  await rewrite(file, before, next);
  return next;
}

/** Deletes a note. It goes for everyone once the project is next committed. */
export async function deleteNote(projectDir: string, id: string): Promise<void> {
  const file = notePath(projectDir, id);
  if (!(await access(file).then(() => true, () => false))) throw new Error("That note is not there any more.");
  await rm(file);
}

/** A value as one line of JSON, cut short past what a person would read. */
function shown(value: unknown): string {
  const written = JSON.stringify(value) ?? "undefined";
  return written.length > 600 ? `${written.slice(0, 600)}…` : written;
}

/** A flagged run in words, a line each, as the agent reads it. */
export function describeRun(run: FlaggedRun): string[] {
  const lines = [run.test === null ? "a run tried from the bench went wrong" : `the saved test "${run.test}" failed`];
  lines.push(`input     ${shown(run.input)}`);
  if (run.stores !== undefined) lines.push(`stores    ${shown(run.stores)}`);
  if (run.expected !== undefined) lines.push(`expected  ${shown(run.expected)}`);
  if (run.output !== undefined) lines.push(`got       ${shown(run.output)}`);
  lines.push(...run.problems);
  if (run.logs.length > 0) lines.push(`logged    ${run.logs.join(" | ")}`);
  return lines;
}
