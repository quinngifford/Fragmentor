import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod/v4";
import { blockIdPattern, parseBlockFile } from "../model/block.js";
import { isArchitecture } from "../model/roles.js";
import { blockDir, loadProject } from "./project.js";
import type { LoadedBlock, Project } from "./project.js";
import { resolveInside } from "./safePath.js";

/**
 * A block's earlier versions, and putting one back.
 *
 * A version is the whole of a block at one moment: its folder and its parts',
 * their saved tests and contracts, and the code files they point at, because
 * a block without its parts or its code is not the block as it was. A block
 * has two kinds. Its git history is the commits of whatever git repository
 * holds the project that changed any of that, from the commit that added its
 * block.json. Its saved versions are the few the person chose to keep, each
 * a file under `.fragmentor/versions/` that is committed with the project,
 * so everyone working on it has them. Git is what both stand on: it says
 * which files make up a block now.
 *
 * Putting a version back is the one time Fragmentor writes code files, and
 * only because the person asked. Everything a swap replaces is copied first
 * into `.fragmentor/swaps/`, which git is told to ignore, so the swap can be
 * undone exactly. That copy is not a third kind of version: it lists nothing,
 * and holds only what one swap replaced. A swap never writes or deletes
 * through a symbolic link or a junction: what one reaches is not what the
 * person asked to change.
 *
 * Git's messages are never parsed, because they can be translated. Decisions
 * use exit codes and the -z and --format output, and git's first line of
 * complaint is only ever quoted inside a sentence of ours. Every path is
 * relative to the project folder, so a project in a subfolder of its
 * repository needs nothing special.
 */

type GitResult = { code: number; out: Buffer; err: string } | { missing: true };

/**
 * Runs git in the project's folder.
 *
 * Paths are taken literally, so code at `src/[id].ts` is not read as a
 * pattern matching other files. The person's own settings that would add to
 * what `log` prints, or make it follow a file back past where it was added,
 * are turned off, so its output is only what was asked for. Optional locks
 * are off, so a listing or a status never takes the index from an agent
 * committing at the same moment (a diff takes it anyway, so it is given a
 * copy: see onIndexCopy), and git never stops to ask for a password nobody
 * can type.
 */
function git(dir: string, args: string[], env: Record<string, string> = {}, input?: Buffer | string): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = execFile(
      "git",
      ["-c", "log.showSignature=false", "-c", "log.follow=false", "-c", "color.ui=false", "-C", dir, ...args],
      {
        encoding: "buffer",
        maxBuffer: 256 << 20,
        windowsHide: true,
        env: { ...process.env, GIT_LITERAL_PATHSPECS: "1", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", ...env },
      },
      (error, stdout, stderr) => {
        if (error?.code === "ENOENT") return resolve({ missing: true });
        // Anything else that stopped git, such as more output than fits, is a
        // failure too, so it never reads as success.
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : -1;
        resolve({ code, out: stdout, err: stderr.toString("utf8") || (error?.message ?? "") });
      },
    );
    if (input !== undefined) child.stdin?.end(input);
  });
}

const NO_GIT = "Versions come from git, which is not installed on this computer. Install it, then come back to Fragmentor.";

/** Git's first line of complaint, only ever placed inside a sentence of ours. */
function firstLine(err: string): string {
  return (err.split(/\r?\n/).find((line) => line.trim() !== "") ?? "").replace(/^fatal: /, "").trim();
}

/** What git printed, or why it printed nothing useful. */
function outputOf(result: GitResult): Buffer {
  if ("missing" in result) throw new Error(NO_GIT);
  if (result.code !== 0) throw new Error(`Git could not read the project's history: ${firstLine(result.err)}`);
  return result.out;
}

/** Output written with -z: one path to each NUL. */
function pathsIn(out: Buffer): string[] {
  return out.toString("utf8").split("\0").filter(Boolean);
}

const unique = (paths: string[]) => [...new Set(paths)];

/**
 * The file or folder a block's `code` names, relative to the project with
 * forward slashes, or null when it names nothing a version can hold. A planned
 * block's pointer is not followed, as readBlockCode does not follow it, and one
 * that leads out of the project is never part of it.
 */
export function pointerPath(code: string | undefined, planned: boolean): string | null {
  if (code === undefined || planned) return null;
  const hash = code.indexOf("#");
  const file = path.posix
    .normalize((hash === -1 ? code : code.slice(0, hash)).trim().replace(/\\/g, "/"))
    .replace(/^\.\//, "")
    .replace(/\/$/, "");
  if (file === "" || file === "." || file === ".." || file.startsWith("../")) return null;
  if (file.startsWith("/") || /^[A-Za-z]:/.test(file)) return null;
  return file;
}

/**
 * Whether a path is clutter rather than part of the project: installed
 * packages, compiled Python, and anything hidden, such as an `.env` beside
 * the code. It is never part of a version and a swap never touches it. The
 * application's watcher ignores the same changes, and hears paths with the
 * system's own slashes, so either kind is taken.
 */
export function noise(file: string): boolean {
  return file.split(/[\\/]/).some((segment) => segment === "node_modules" || segment === "__pycache__" || segment.startsWith("."));
}

/** Whether a slash-joined path is `root` or inside it. */
export function under(root: string, file: string): boolean {
  return file === root || file.startsWith(`${root}/`);
}

/**
 * The paths, leaving out any that lie inside another of them. Git finds the
 * same files either way, and a system with hundreds of blocks would otherwise
 * make a command line longer than Windows allows.
 */
function outermost(paths: string[]): string[] {
  const all = unique(paths);
  return all.filter((each) => !all.some((other) => other !== each && under(other, each)));
}

/** A path and every folder on the way to it: `a`, `a/b`, `a/b/c.ts`. */
function steps(file: string): string[] {
  return file.split("/").map((_, i, parts) => parts.slice(0, i + 1).join("/"));
}

/**
 * The first of these paths in `root` that is a symbolic link or a junction,
 * which Node reports as one too, or null. What a link reaches is not what a
 * swap was asked to change, and removing one takes everything it reaches out
 * of the project, so a swap never goes through one.
 */
async function firstLink(root: string, paths: string[]): Promise<string | null> {
  for (const each of paths) {
    if ((await lstat(path.join(root, ...each.split("/"))).catch(() => null))?.isSymbolicLink()) return each;
  }
  return null;
}

/** "A", "A and B", or "A, B and C". */
function listNames(names: string[]): string {
  return names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

function isFile(file: string): Promise<boolean> {
  return stat(file).then(
    (info) => info.isFile(),
    () => false,
  );
}

/** Windows and macOS keep names' capitals but, by default, find a file whatever the capitals asked for. */
const IGNORES_CASE = process.platform === "win32" || process.platform === "darwin";

/**
 * Two names for one file on a disk that ignores case, or null.
 *
 * Git can hold `price.ts` and `Price.ts` as two paths, and after a rename that
 * changed only the capitals it can go on calling a file by the name it had
 * before, while the disk has one file under whichever name it was last given.
 * A swap there could take one name for the other and write, remove or keep a
 * copy of the wrong file, so it is refused rather than guessed at. Either the
 * paths themselves differ only in capitals, or the disk holds one of them, or
 * a folder on the way to it, under capitals of its own.
 */
async function caseClash(root: string, paths: string[]): Promise<{ file: string; other: string } | null> {
  if (IGNORES_CASE) {
    const seen = new Map<string, string>();
    for (const file of paths) {
      const other = seen.get(file.toLowerCase());
      if (other !== undefined) return { file, other };
      seen.set(file.toLowerCase(), file);
    }
  }

  const listed = new Map<string, string[]>();
  for (const file of unique(paths.flatMap(steps))) {
    const target = path.join(root, ...file.split("/"));
    if (!(await exists(target))) continue;
    const folder = path.dirname(target);
    if (!listed.has(folder)) listed.set(folder, await readdir(folder).catch(() => []));
    const names = listed.get(folder)!;
    const name = path.basename(target);
    if (names.includes(name)) continue;
    const onDisk = names.find((each) => each.toLowerCase() === name.toLowerCase()) ?? name;
    return { file, other: [...file.split("/").slice(0, -1), onDisk].join("/") };
  }
  return null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whether this folder or any above it holds a repository, whether or not git
 * can read it. Git refusing one it cannot trust looks, by its exit code, just
 * like there being none, and starting another inside it would hide the first.
 */
async function insideRepositoryFolder(dir: string): Promise<boolean> {
  for (let folder = path.resolve(dir); ; folder = path.dirname(folder)) {
    if (await exists(path.join(folder, ".git"))) return true;
    if (path.dirname(folder) === folder) return false;
  }
}

/**
 * Runs git against a copy of the repository's index.
 *
 * A diff brings the index up to date as it goes, whatever optional locks are
 * turned off, and to do that it takes the index's lock. The list of versions
 * is read again every time the agent writes a file, so on the real index it
 * would sooner or later take that lock from the agent committing, whose commit
 * would then fail. A copy of its own leaves the real one alone. Without one to
 * copy, as in a repository nothing has been added to, git is asked as it is.
 */
async function onIndexCopy<T>(dir: string, work: (env: Record<string, string>) => Promise<T>): Promise<T> {
  const found = await git(dir, ["rev-parse", "--git-path", "index"]);
  const index = "missing" in found || found.code !== 0 ? null : path.resolve(dir, found.out.toString("utf8").trim());
  const aside = await mkdtemp(path.join(tmpdir(), "fragmentor-index-"));
  try {
    const copy = path.join(aside, "index");
    if (index === null || !(await copyFile(index, copy).then(() => true, () => false))) return await work({});
    return await work({ GIT_INDEX_FILE: copy });
  } finally {
    await rm(aside, { recursive: true, force: true });
  }
}

/**
 * The files under these paths at one commit. Only ordinary files are part of
 * a version: a link or a nested repository is not something a swap can write.
 */
async function treeFiles(dir: string, commit: string, specs: string[]): Promise<string[]> {
  const listed = await git(dir, ["ls-tree", "-r", "-z", commit, "--", ...specs]);
  if ("missing" in listed) throw new Error(NO_GIT);
  if (listed.code !== 0) throw new Error("That commit is not in this project's history.");
  return pathsIn(listed.out).flatMap((entry) => {
    // "<mode> <type> <object>\t<path>"
    const tab = entry.indexOf("\t");
    const [mode, type] = entry.slice(0, tab).split(" ");
    const file = entry.slice(tab + 1);
    return type === "blob" && (mode === "100644" || mode === "100755") && !noise(file) ? [file] : [];
  });
}

/**
 * A file as it was at one commit, as a checkout would write it. The `./`
 * makes the path the project's rather than the repository's, which differ
 * when the project is a subfolder of it.
 */
async function readAt(dir: string, commit: string, file: string): Promise<Buffer> {
  return outputOf(await git(dir, ["cat-file", "--filters", `${commit}:./${file}`]));
}

/**
 * The files under these paths now: those git tracks, even if deleted, and
 * those it does not but is not told to ignore. A tracked link or nested
 * repository is left out, as treeFiles leaves it out of a commit, so it is
 * never planned, claimed or deleted. The untracked ones are also given on
 * their own, since no commit can hold them.
 */
async function nowFiles(dir: string, specs: string[]): Promise<{ all: string[]; untracked: string[] }> {
  const [tracked, others] = await Promise.all([
    git(dir, ["ls-files", "-z", "-s", "--cached", "--", ...specs]),
    git(dir, ["ls-files", "-z", "--others", "--exclude-standard", "--", ...specs]),
  ]);
  const files = pathsIn(outputOf(tracked)).flatMap((entry) => {
    // "<mode> <object> <stage>\t<path>", once for each stage of a conflict.
    const mode = entry.slice(0, entry.indexOf(" "));
    const file = entry.slice(entry.indexOf("\t") + 1);
    return (mode === "100644" || mode === "100755") && !noise(file) ? [file] : [];
  });
  const untracked = pathsIn(outputOf(others)).filter((file) => !noise(file));
  return { all: unique([...files, ...untracked]), untracked };
}

/**
 * Whether two files say the same thing but for their line endings. A checkout
 * converts those, so a file that differs only there is left as it is, as
 * writeIfChanged leaves a generated one.
 */
function sameText(a: Buffer, b: Buffer): boolean {
  return a.equals(b) || a.toString("latin1").replace(/\r\n/g, "\n") === b.toString("latin1").replace(/\r\n/g, "\n");
}

/** A file's bytes, line endings aside as sameText sets them aside, reduced to a hash: enough to tell later whether it changed. */
function fingerprint(bytes: Buffer): string {
  return createHash("sha1").update(bytes.toString("latin1").replace(/\r\n/g, "\n"), "latin1").digest("hex");
}

/** Runs `work` on every item, eight at a time: one git process per file, without starting hundreds at once. */
async function eightAtATime<T>(items: T[], work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await work(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(8, items.length) }, worker));
}

/** A commit of the project's git history, as a version of a block. */
export interface BlockVersion {
  commit: string;
  /** When it was committed, as ISO 8601. */
  date: string;
  author: string;
  subject: string;
}

/** A version the person saved, with a name, as it is listed. */
export interface SavedVersion {
  id: string;
  name: string;
  /** What the person wrote about it, or "". */
  description: string;
  /** When it was saved, as ISO 8601. */
  date: string;
  /** Who saved it, by the name git commits under on their computer, or "" when it has none. */
  author: string;
}

/** Which version to compare with or swap to: a commit, or a saved version by its id. */
export type VersionRef = { commit: string } | { saved: string };

/**
 * A saved version's id: when it was saved, in milliseconds, then its name as
 * any disk takes it in a file name. Anything else sent as one is refused
 * before a path is made from it.
 */
export const savedIdPattern = /^\d{13}-[a-z0-9-]{0,40}$/;

/** The version a swap put in place, saying which kind it is. */
export type SwappedVersion = ({ kind: "commit" } & BlockVersion) | ({ kind: "saved" } & SavedVersion);

export interface BlockVersions {
  /** Why there can be no versions, as a sentence, or null when there can. */
  unavailable: string | null;
  /** The commits of its git history, newest first, at most 100. */
  versions: BlockVersion[];
  /** More than 100 exist. */
  more: boolean;
  /** Whether the block as it is now differs from the newest commit, which it does when there is none. */
  changed: boolean;
  /** Why no version of it can be swapped in on its own, from what is on disk now, or null. */
  blocked: string | null;
  /**
   * The version put in place by the swap Undo swap would reverse, when that
   * is a swap of this block. Set even when git cannot be used, since undoing
   * needs only the copy the swap kept.
   */
  swapped: SwappedVersion | null;
  /**
   * Its saved versions, newest first. They are read from their files alone,
   * so they are listed even when git cannot be used, and nobody takes them
   * for lost.
   */
  saved: SavedVersion[];
  /**
   * Files among its saved versions, relative to the project, that cannot be
   * read as one, such as one a merge left half-written. Named so the person
   * knows, since a version dropped from the list without a word looks lost.
   */
  unreadable: string[];
  /** The rows the block is exactly as now: commits by hash, saved versions by id. */
  inUse: string[];
  /** When it is exactly as none of them, the row it was taken from and has changed since: the version swapped in, or else the latest commit. */
  changedFrom: string | null;
}

/**
 * How many paths were written or removed. A swap with nothing to change makes
 * no record of itself; an undo always does, so the same swap is never undone
 * twice.
 */
export interface SwapDone {
  changed: number;
}

/** Every path a swap to one version would touch, and what each held then. A path missing from `then` did not exist. */
export interface SwapPlan {
  project: Project;
  name: string;
  touched: string[];
  then: Map<string, Buffer>;
  /** The version, as a swap's record says what it put in place. */
  to: SwappedIn;
}

/** What a swap put in place, as its record says: a commit as `log` gives it, or a saved version as it is listed. */
type SwappedIn = BlockVersion | { saved: SavedVersion };

/** A commit as one line of `log` output, read by versionFrom. */
const FORMAT = "--format=%H%x1f%cI%x1f%an%x1f%s";

function versionFrom(line: string): BlockVersion {
  const [commit = "", date = "", author = "", subject = ""] = line.split("\x1f");
  return { commit, date, author, subject };
}

/** The live project, the block, and what its versions are made of now: its folder, and the code it and its parts point at. */
async function loadBlock(projectDir: string, blockPath: string): Promise<{ project: Project; node: LoadedBlock; specs: string[] }> {
  blockDir(projectDir, blockPath);
  const project = await loadProject(projectDir);
  const node = project.byPath.get(blockPath);
  if (!node) throw new Error(`There is no block at ${blockPath}.`);

  const pointers = [...project.byPath.values()]
    .filter((each) => under(blockPath, each.path))
    .map((each) => pointerPath(each.block.code, each.block.planned))
    .filter((pointer): pointer is string => pointer !== null);
  return { project, node, specs: outermost([`blocks/${blockPath}`, ...pointers]) };
}

/**
 * Whether git can give this project's versions: why not, as a sentence, or
 * whether it has any commits yet. One question settles it: 0 has commits, 1
 * has none yet, and anything else means there is no repository it can read.
 */
async function gitState(projectDir: string): Promise<{ unavailable: string } | { unavailable: null; hasCommits: boolean }> {
  const head = await git(projectDir, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  if ("missing" in head) return { unavailable: NO_GIT };
  if (head.code !== 0 && head.code !== 1) {
    return {
      unavailable: (await insideRepositoryFolder(projectDir))
        ? `Versions come from the project's git history, and git cannot read the repository holding this folder: ${firstLine(head.err)}`
        : "Versions come from the project's git history, and this folder is not in a git repository yet. Ask your agent to put it under git and commit.",
    };
  }
  return { unavailable: null, hasCommits: head.code === 0 };
}

/**
 * Whether a path in a saved version's file is one of the project's, as git
 * gives them: one that climbs out, or starts anywhere but the project, was
 * never written by Fragmentor, so the file is not read as a version.
 */
function projectPath(file: string): boolean {
  return !file.includes("\\") && !/^[A-Za-z]:/.test(file) && file.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/**
 * A saved version's file. Each file of the version is kept as its text, where
 * its bytes are text that reads back as the same bytes, so the version can be
 * read in a review of the commit that adds it; any other file as its bytes.
 */
const savedFileSchema = z.object({
  name: z.string(),
  description: z.string(),
  block: z.string(),
  saved: z.string(),
  by: z.string(),
  files: z.record(z.string().refine(projectPath), z.union([z.object({ text: z.string() }).strict(), z.object({ base64: z.string() }).strict()])),
});
type SavedFile = z.infer<typeof savedFileSchema>;

/** A saved version's file, or null when it does not read as one, such as one a merge left half-written. */
function parseSaved(text: string): SavedFile | null {
  try {
    const parsed = savedFileSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * The folder holding a block's saved versions, one file each, so two people
 * saving versions of one block never write the same file. Its parts' are
 * folders inside it.
 */
function savedFolder(projectDir: string, blockPath: string): string {
  blockDir(projectDir, blockPath);
  return path.join(projectDir, ".fragmentor", "versions", ...blockPath.split("/"));
}

const listedAs = (id: string, file: SavedFile): SavedVersion => ({
  id,
  name: file.name,
  description: file.description,
  date: file.saved,
  author: file.by,
});

/**
 * A block's saved versions, newest first, and the files among them that
 * cannot be read as one. What each holds is given beside them, by id, since
 * the list does not carry it.
 */
async function savedVersions(
  projectDir: string,
  blockPath: string,
): Promise<{ saved: SavedVersion[]; unreadable: string[]; held: Map<string, SavedFile["files"]> }> {
  const folder = savedFolder(projectDir, blockPath);
  const saved: SavedVersion[] = [];
  const unreadable: string[] = [];
  const held = new Map<string, SavedFile["files"]>();
  for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const id = entry.name.slice(0, -".json".length);
    const file = parseSaved(await readFile(path.join(folder, entry.name), "utf8").catch(() => ""));
    if (savedIdPattern.test(id) && file !== null) {
      saved.push(listedAs(id, file));
      held.set(id, file.files);
    } else {
      unreadable.push(path.relative(projectDir, path.join(folder, entry.name)).split(path.sep).join("/"));
    }
  }
  // An id starts with when it was saved, always in thirteen digits.
  return { saved: saved.sort((a, b) => (a.id < b.id ? 1 : -1)), unreadable: unreadable.sort(), held };
}

/**
 * Which of a block's versions it is exactly as now, so that swapping to it
 * would change nothing: the rows to mark as in use, commits by hash and saved
 * versions by id. `specs` are what the block is made of now, its folder and
 * the code it and its parts point at, and `files` those git lists under them,
 * as nowFiles gives them.
 *
 * The list is read every time the agent writes a file, so only three kinds
 * are checked, none of them with a git process of its own: the latest commit,
 * which the caller has already compared, as `latest`; the version the swap
 * standing put in place, from what its record says it left; and each saved
 * version, against the files themselves. Any older commit would cost a diff
 * of its own, so a block put back by hand to match one is not seen to.
 */
async function inUseNow(
  projectDir: string,
  specs: string[],
  files: string[],
  latest: string | null,
  swap: Extract<Kept, { kind: "swap" }> | null,
  held: Map<string, SavedFile["files"]>,
): Promise<string[]> {
  // Each file is read once, however many versions it is compared with. A
  // folder where a file was reads as no file, as changesFrom takes it.
  const disk = new Map<string, Promise<Buffer | null>>();
  const read = (file: string) => {
    let bytes = disk.get(file);
    if (bytes === undefined) {
      bytes = staysInside(projectDir, file) ? readFile(resolveInside(projectDir, file)).catch(() => null) : Promise.resolve(null);
      disk.set(file, bytes);
    }
    return bytes;
  };

  const rows = latest === null ? [] : [latest];
  // A swap that stopped part-way left the block as no version at all.
  if (swap !== null && swap.done && (await asSwapLeft(projectDir, swap.n, specs, files, read))) {
    rows.push("saved" in swap ? swap.saved.id : swap.commit);
  }

  // A block exactly as a saved version has that version's block.json files,
  // so it points at the same code, and what the version covers is what the
  // block is made of now: `files`. Swapping to it changes nothing when no
  // file there is one the version does not hold, and every file it holds is
  // there as it holds it, line endings aside, as changesFrom compares them.
  // What it holds is left out as fromSaved and planSwap leave it out.
  for (const [id, stored] of held) {
    const kept = new Map(Object.entries(stored).filter(([file]) => !noise(file) && staysInside(projectDir, file)));
    const same = async () => {
      for (const file of files) if (!kept.has(file) && (await read(file)) !== null) return false;
      for (const [file, content] of kept) {
        const bytes = await read(file);
        const then = "text" in content ? Buffer.from(content.text, "utf8") : Buffer.from(content.base64, "base64");
        if (bytes === null || !sameText(bytes, then)) return false;
      }
      return true;
    };
    if (await same()) rows.push(id);
  }
  return unique(rows);
}

/**
 * Whether the block is still as a swap left it: every path the swap touched
 * that is still part of the block holds what it held when the swap finished,
 * and no file the swap did not write has appeared among `files`, what the
 * block is made of now. A path the swap touched that the block no longer
 * points at is someone else's business: writing it again is not a change to
 * this block. A record
 * made before swaps said what they left says nothing, and is taken as
 * unchanged, as it was before there was any telling.
 */
async function asSwapLeft(
  projectDir: string,
  n: number,
  specs: string[],
  files: string[],
  read: (file: string) => Promise<Buffer | null>,
): Promise<boolean> {
  const text = await readFile(path.join(projectDir, ".fragmentor", "swaps", String(n), "done"), "utf8").catch(() => "");
  let said: unknown;
  try {
    said = JSON.parse(text);
  } catch {
    return true;
  }
  const parsed = leftSchema.safeParse(said);
  if (!parsed.success) return true;

  const left = new Map(Object.entries(parsed.data.files));
  for (const [file, hash] of left) {
    if (!specs.some((spec) => under(spec, file))) continue;
    const bytes = await read(file);
    if ((bytes === null ? null : fingerprint(bytes)) !== hash) return false;
  }
  for (const file of files) if (!left.has(file) && (await read(file)) !== null) return false;
  return true;
}

/** What a finished swap's `done` file says it left: each path it touched, by the fingerprint of what it held then, or null where it held nothing. */
const leftSchema = z.object({ files: z.record(z.string(), z.string().nullable()) });

/**
 * A block's versions, newest first, and what the panel needs to say about
 * them. Whether a commit can still be read is left until it is compared or
 * swapped: reading every one here would cost two processes a commit.
 */
export async function blockVersions(projectDir: string, blockPath: string): Promise<BlockVersions> {
  // Undoing needs only the copy the swap kept, and the saved versions only
  // their files, so both are given whatever state git is in.
  const found = await pendingSwap(projectDir);
  const pending = found !== null && found.block === blockPath ? found : null;
  const { saved, unreadable, held } = await savedVersions(projectDir, blockPath);
  // A saved version is called what it is called now, if it is still there,
  // rather than what it was called when it was swapped in.
  const swapped: SwappedVersion | null =
    pending === null
      ? null
      : "saved" in pending
        ? { kind: "saved", ...(saved.find((each) => each.id === pending.saved.id) ?? pending.saved) }
        : { kind: "commit", commit: pending.commit, date: pending.date, author: pending.author, subject: pending.subject };
  // Which version the block is on cannot be told without git's list of the
  // files it is made of, so nothing is said about it.
  const none = (unavailable: string): BlockVersions => ({
    unavailable,
    versions: [],
    more: false,
    changed: true,
    blocked: null,
    swapped,
    saved,
    unreadable,
    inUse: [],
    changedFrom: null,
  });

  const state = await gitState(projectDir);
  if (state.unavailable !== null) return none(state.unavailable);
  const { hasCommits } = state;

  const { project, specs } = await loadBlock(projectDir, blockPath);
  const now = await nowFiles(projectDir, specs);
  const blocked = claims(project, blockPath, now.all, "swapping");

  let versions: BlockVersion[] = [];
  let more = false;
  let changed = now.all.length > 0;
  if (hasCommits) {
    // A block's versions start where its block.json was added. Its code may be
    // far older than the block, and those commits are not versions of it.
    const file = `blocks/${blockPath}/block.json`;
    const lines = (result: GitResult) => outputOf(result).toString("utf8").split("\n").filter(Boolean);
    const [added] = lines(await git(projectDir, ["log", "-n", "1", "--diff-filter=A", FORMAT, "--", file]));
    if (added !== undefined) {
      // Only commits that descend from the add. On a branch merged in later,
      // the commits made beside it, before the block existed, are not
      // versions of it even though they changed its code.
      const log = lines(
        await git(projectDir, ["log", "-n", "100", "--ancestry-path", FORMAT, `${versionFrom(added).commit}..HEAD`, "--", ...specs]),
      );
      more = log.length === 100;
      versions = (more ? log : [...log, added]).map(versionFrom);
    } else {
      // Git shows no changes for a merge, so a block added while one was
      // resolved has no add to find. Every commit that changed what it is
      // made of is listed then, which can reach back before the block.
      const held = await git(projectDir, ["cat-file", "-e", `HEAD:./${file}`]);
      if (!("missing" in held) && held.code === 0) {
        const log = lines(await git(projectDir, ["log", "-n", "101", FORMAT, "HEAD", "--", ...specs]));
        more = log.length > 100;
        versions = log.slice(0, 100).map(versionFrom);
      }
    }

    // Not git status: that reports a file whose line endings alone were
    // rewritten, which is exactly what a swap does to a file an agent wrote.
    // A diff compares what git would store, so it is not fooled.
    const diff = await onIndexCopy(projectDir, (env) => git(projectDir, ["diff", "--quiet", "HEAD", "--", ...specs], env));
    changed = now.untracked.length > 0 || (!("missing" in diff) && diff.code === 1);
  }

  const latest = versions[0]?.commit ?? null;
  const inUse = await inUseNow(projectDir, specs, now.all, changed ? null : latest, pending, held);
  const changedFrom = inUse.length > 0 ? null : swapped === null ? latest : swapped.kind === "commit" ? swapped.commit : swapped.id;
  return { unavailable: null, versions, more, changed, blocked, swapped, saved, unreadable, inUse, changedFrom };
}

/**
 * Why a swap touching these paths cannot be made on its own, or null. Saving
 * the block as a version is refused for the same reason, since that version
 * could never be swapped back, so the sentence is for whichever was asked.
 *
 * A path inside another block's folder is that block's. A code file is also
 * claimed by any function outside the block that points at it, or at a folder
 * holding it: swapping would change that function too. Blocks that are not
 * functions have no code of their own, so a component pointing at the folder
 * around the block never stands in its way.
 *
 * On a disk that ignores case, as Windows and macOS do by default, a pointer
 * spelled differently from git's path still reaches the file, so paths are
 * compared ignoring case there. Refusing too often only asks for a larger
 * block to be swapped; missing a claimant would change its code unseen.
 */
function claims(project: Project, blockPath: string, paths: string[], doing: "swapping" | "saving"): string | null {
  const name = project.byPath.get(blockPath)!.block.name;
  const fold = IGNORES_CASE ? (file: string) => file.toLowerCase() : (file: string) => file;
  const inside = (root: string, file: string) => under(fold(root), fold(file));
  // What swapping would change that is not the block's, and the block holding
  // all of it, if one does, to take whole instead.
  const refuse = (change: string, instead: string | null) =>
    doing === "saving"
      ? `${name} cannot be saved as a version on its own, since swapping it back ${change}${instead === null ? "." : `. Save ${instead}, which holds them all, instead.`}`
      : `Swapping ${name} ${change}${instead === null ? ", so it cannot be compared or swapped on its own." : `. Compare or swap ${instead}, which holds them all, instead.`}`;

  const elsewhere = paths.find((file) => inside("blocks", file) && !inside(`blocks/${blockPath}`, file));
  if (elsewhere !== undefined) return refuse(`would change ${elsewhere}, which is inside another block's folder`, null);

  const claimants: LoadedBlock[] = [];
  const files = new Set<string>();
  for (const node of project.byPath.values()) {
    if (under(blockPath, node.path) || node.block.planned || isArchitecture(node.block.role)) continue;
    const pointer = pointerPath(node.block.code, node.block.planned);
    if (pointer === null) continue;
    const claimed = paths.filter((file) => inside(pointer, file));
    if (claimed.length === 0) continue;
    claimants.push(node);
    for (const file of claimed) files.add(file);
  }
  if (claimants.length === 0) return null;

  // The lowest block holding them all, which could be swapped whole instead.
  // None, when they sit in different systems.
  const lowest = claimants.reduce((shared, node) => {
    const a = shared.split("/");
    const b = node.path.split("/");
    let same = 0;
    while (same < a.length && same < b.length && a[same] === b[same]) same += 1;
    return a.slice(0, same).join("/");
  }, blockPath);

  return refuse(
    `would also change the code of ${listNames(claimants.map((node) => node.block.name))}, which ${
      claimants.length === 1 ? "is" : "are"
    } not part of it: ${[...files].sort().join(", ")}`,
    lowest === "" ? null : project.byPath.get(lowest)!.block.name,
  );
}

/**
 * Where the project sits in its repository, as git's paths from the top of it
 * begin: "" at the top, or the folder with a slash after it. The two commands
 * below read paths from the top whatever folder git is started in.
 */
async function prefixOf(dir: string): Promise<string> {
  return outputOf(await git(dir, ["rev-parse", "--show-prefix"])).toString("utf8").trim();
}

/**
 * Files as git would store them in a commit: with the line endings, and
 * anything else a checkout converts, undone. A version saved this way is
 * written on another computer as that computer's checkout would write it,
 * rather than with the line endings of the one it was saved on. Git keeps
 * the objects this makes for a while, as it keeps anything it was handed.
 */
async function asStored(dir: string, files: string[]): Promise<Map<string, Buffer>> {
  const stored = new Map<string, Buffer>();
  if (files.length === 0) return stored;
  const prefix = await prefixOf(dir);
  const ids = outputOf(await git(dir, ["hash-object", "-w", "--stdin-paths"], {}, files.map((file) => `${prefix}${file}\n`).join("")))
    .toString("utf8")
    .split("\n")
    .filter(Boolean);
  if (ids.length !== files.length) throw new Error("Git could not read the block's files to save them.");

  // "<object> blob <size>" on a line, then that many bytes, then a line end, for each.
  const batch = outputOf(await git(dir, ["cat-file", "--batch"], {}, ids.map((id) => `${id}\n`).join("")));
  let at = 0;
  for (const file of files) {
    const end = batch.indexOf(0x0a, at);
    const size = Number(batch.subarray(at, end).toString("latin1").split(" ")[2]);
    stored.set(file, batch.subarray(end + 1, end + 1 + size));
    at = end + 1 + size + 1;
  }
  return stored;
}

/** A file stored as git stores it, as this computer's checkout would write it. */
async function asCheckedOut(dir: string, prefix: string, file: string, bytes: Buffer): Promise<Buffer> {
  const id = outputOf(await git(dir, ["hash-object", "-w", "--no-filters", "--stdin"], {}, bytes)).toString("utf8").trim();
  return outputOf(await git(dir, ["cat-file", "--filters", `--path=${prefix}${file}`, id]));
}

/**
 * A version as a swap reads it: the files it holds under some paths, and one
 * file's bytes. Whether those come from a commit or a saved version's file,
 * everything made of them is the same.
 */
interface VersionSource {
  files(specs: string[]): Promise<string[]>;
  read(file: string): Promise<Buffer>;
  /** What a swap's record says it put in place. */
  about(): Promise<SwappedIn>;
}

function fromCommit(projectDir: string, commit: string): VersionSource {
  return {
    files: (specs) => treeFiles(projectDir, commit, specs),
    read: (file) => readAt(projectDir, commit, file),
    about: async () => versionFrom(outputOf(await git(projectDir, ["log", "-n", "1", FORMAT, commit, "--"])).toString("utf8").trim()),
  };
}

/**
 * A saved version, read from its file. Clutter is left out of it, as treeFiles
 * leaves it out of a commit, and each file is written as a checkout would
 * write it here, as a commit's is.
 */
async function fromSaved(projectDir: string, blockPath: string, id: string): Promise<VersionSource> {
  const file = path.join(savedFolder(projectDir, blockPath), `${id}.json`);
  const text = await readFile(file, "utf8").catch(() => null);
  if (text === null) throw new Error("That saved version is not there any more.");
  const saved = parseSaved(text);
  if (saved === null) {
    const where = path.relative(projectDir, file).split(path.sep).join("/");
    throw new Error(`This version cannot be compared or swapped: Fragmentor cannot read ${where} as a saved version.`);
  }

  const held = new Map(Object.entries(saved.files).filter(([each]) => !noise(each)));
  const prefix = await prefixOf(projectDir);
  return {
    files: async (specs) => [...held.keys()].filter((each) => specs.some((spec) => under(spec, each))),
    read: async (each) => {
      const content = held.get(each);
      if (content === undefined) throw new Error(`That saved version does not hold ${each}.`);
      return asCheckedOut(projectDir, prefix, each, "text" in content ? Buffer.from(content.text, "utf8") : Buffer.from(content.base64, "base64"));
    },
    about: async () => ({ saved: listedAs(id, saved) }),
  };
}

/** Whether a path, from git or a saved version, stays inside the project. None should lead out of it, and none is followed if one does. */
function staysInside(projectDir: string, file: string): boolean {
  try {
    resolveInside(projectDir, file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Everything a swap to one version would touch, and what each path held then.
 * Compare works from the same plan, so it is refused exactly when a swap
 * would be, and shows exactly what a swap would do.
 *
 * Every path the block is made of now or was made of then is made to match
 * the version: written as it was, or taken away if it was not there. A code
 * file the block points at now is looked for in the version too, so a helper
 * that lived at that path then is written back rather than deleted.
 */
export async function planSwap(projectDir: string, blockPath: string, version: VersionRef): Promise<SwapPlan> {
  // The panel names the version, so anything else, such as a value starting
  // with "-" that git would read as an option, or one that would make a path
  // leading elsewhere, is refused before git or the disk sees it.
  if ("commit" in version) {
    if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(version.commit)) throw new Error(`"${version.commit}" is not a commit.`);
  } else if (!savedIdPattern.test(version.saved)) {
    throw new Error(`"${version.saved}" is not a saved version.`);
  }

  const { project, node, specs: nowSpecs } = await loadBlock(projectDir, blockPath);
  const name = node.block.name;
  const root = `blocks/${blockPath}`;
  const source = "commit" in version ? fromCommit(projectDir, version.commit) : await fromSaved(projectDir, blockPath, version.saved);

  const folder = await source.files([root]);
  if (!folder.includes(`${root}/block.json`)) throw new Error(`${name} was not a block in this version.`);

  // Its block folders then, found as loadBlockTree finds them: a folder named
  // like a block, holding a block.json, inside another block's folder.
  const depth = (file: string) => file.split("/").length;
  const folders = [root];
  for (const each of folder
    .filter((file) => file.endsWith("/block.json"))
    .map((file) => file.slice(0, -"/block.json".length))
    .sort((a, b) => depth(a) - depth(b))) {
    const parent = each.slice(0, each.lastIndexOf("/"));
    if (each !== root && folders.includes(parent) && blockIdPattern.test(each.slice(parent.length + 1))) folders.push(each);
  }

  // Each is read as Fragmentor reads a block today, because a swap puts it
  // back into today's project. Planning spreads downward, from whatever holds
  // the block now.
  const parentPath = blockPath.includes("/") ? blockPath.slice(0, blockPath.lastIndexOf("/")) : null;
  const plannedAbove = new Map([[root, parentPath === null ? false : (project.byPath.get(parentPath)?.block.planned ?? false)]]);
  const versionPointers: string[] = [];
  for (const each of folders) {
    const file = `${each}/block.json`;
    const unreadable = (problems: string[]) =>
      new Error(`This version cannot be compared or swapped: Fragmentor no longer reads ${file} as it was written then. ${problems.join(" ")}`);

    const text = (await source.read(file)).toString("utf8");
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw unreadable(["It is not valid JSON."]);
    }
    const parsed = parseBlockFile(raw, each.slice(each.lastIndexOf("/") + 1), plannedAbove.get(each) ?? false);
    if (!parsed.ok) throw unreadable(parsed.problems);

    for (const child of folders) if (child.slice(0, child.lastIndexOf("/")) === each) plannedAbove.set(child, parsed.block.planned);
    const pointer = pointerPath(parsed.block.code, parsed.block.planned);
    if (pointer !== null) versionPointers.push(pointer);
  }

  const specs = outermost([...nowSpecs, ...versionPointers]);
  const [listedThen, now] = await Promise.all([source.files(specs), nowFiles(projectDir, specs)]);

  const inside = (file: string) => staysInside(projectDir, file);
  const thenFiles = listedThen.filter(inside);
  // A commit says what every path held at that moment. A saved version says
  // only what was under the block's folder and the code it pointed at when it
  // was saved, so a file under a pointer the block has gained since is one it
  // knows nothing about: it is left as it is rather than taken away.
  const knows = "commit" in version ? specs : outermost([root, ...versionPointers]);
  const touched = unique([...thenFiles, ...now.all.filter((file) => inside(file) && knows.some((spec) => under(spec, file)))]).sort();

  const link = await firstLink(projectDir, unique(touched.flatMap(steps)));
  if (link !== null) {
    throw new Error(`Swapping ${name} would go through a link at ${link}, and Fragmentor never writes through one, so it cannot be compared or swapped.`);
  }

  const clash = await caseClash(projectDir, touched);
  if (clash !== null) {
    throw new Error(
      `Swapping ${name} would change ${clash.file}, whose name differs only in capitals from ${clash.other}, and this computer does not tell those apart, so it cannot be compared or swapped.`,
    );
  }

  const refused = claims(project, blockPath, touched, "swapping");
  if (refused !== null) throw new Error(refused);

  const then = new Map<string, Buffer>();
  await eightAtATime(thenFiles, async (file) => {
    then.set(file, await source.read(file));
  });
  return { project, name, touched, then, to: await source.about() };
}

/**
 * Makes a folder hold what a plan says: each path its content, or nothing.
 *
 * Deletions go first, so a path that is a file on one side and a folder on
 * the other can change places. Writes are plain rather than written aside and
 * renamed: renaming over a file OneDrive or an editor holds fails the same
 * way, and what makes a swap recoverable is the copy kept before it starts.
 *
 * A path reached through a link is refused just before it would be changed,
 * as planSwap refuses it, since a link can appear after the plan is made.
 */
export async function applyPlan(root: string, plan: Map<string, Buffer | null>): Promise<void> {
  const top = path.resolve(root);
  const failed = (verb: string, file: string, why: string) => new Error(`Could not ${verb} ${file}: ${why}.`);
  const refuseLinks = async (verb: string, file: string) => {
    if ((await firstLink(root, steps(file))) !== null) throw failed(verb, file, "it is reached through a link, which a swap never follows");
  };

  for (const [file, content] of plan) {
    if (content !== null) continue;
    const target = resolveInside(root, file);
    await refuseLinks("remove", file);
    try {
      await rm(target, { force: true });
    } catch (error) {
      throw failed("remove", file, messageOf(error));
    }
    // A folder the swap left empty goes too, as it would in a checkout, but
    // never the folder being swapped into, and never a link.
    for (let folder = path.dirname(target); folder.startsWith(`${top}${path.sep}`); folder = path.dirname(folder)) {
      if ((await lstat(folder).catch(() => null))?.isSymbolicLink() !== false) break;
      if (!(await rmdir(folder).then(() => true, () => false))) break;
    }
  }

  for (const [file, content] of plan) {
    if (content === null) continue;
    const target = resolveInside(root, file);
    await refuseLinks("write", file);
    try {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    } catch (error) {
      throw failed("write", file, messageOf(error));
    }
  }
}

/** The part of a plan that changes anything: a path already as it should be, line endings aside, is left alone. */
async function changesFrom(projectDir: string, plan: Map<string, Buffer | null>): Promise<Map<string, Buffer | null>> {
  const changes = new Map<string, Buffer | null>();
  for (const [file, target] of plan) {
    const live = resolveInside(projectDir, file);
    const current = (await isFile(live)) ? await readFile(live).catch(() => null) : null;
    if (target === null ? current === null : current !== null && sameText(current, target)) continue;
    changes.set(file, target);
  }
  return changes;
}

/** Puts a block and its parts back as they were in one version, keeping what was there so it can be undone. */
export async function swapToVersion(projectDir: string, blockPath: string, version: VersionRef): Promise<SwapDone> {
  // A swap on top of one that stopped part-way would copy the half-swapped
  // files, and what the person had before would be out of reach.
  const last = await lastRecord(projectDir);
  if (last !== null && !last.done) {
    throw new Error(`The last swap of ${last.name} did not finish. Press Undo swap under Versions in its panel first, so what it replaced is put back.`);
  }

  const plan = await planSwap(projectDir, blockPath, version);
  const whole = new Map(plan.touched.map((file) => [file, plan.then.get(file) ?? null]));
  const changes = await changesFrom(projectDir, whole);
  if (changes.size === 0) return { changed: 0 };
  return replace(projectDir, whole, changes, { kind: "swap", block: blockPath, name: plan.name, ...plan.to });
}

/**
 * Puts back what the last swap of this block replaced. Only the project's
 * most recent swap can be undone, and only while nothing has been swapped or
 * undone since: that is the only copy that still describes the files as they
 * are. The undo keeps a copy of its own, like any swap, but what it puts back
 * always comes from the swap's copy, even when an earlier undo stopped part-way.
 */
export async function undoLastSwap(projectDir: string, blockPath: string): Promise<SwapDone> {
  const record = await pendingSwap(projectDir);
  if (record === null || record.block !== blockPath) {
    const { node } = await loadBlock(projectDir, blockPath);
    throw new Error(`There is no swap of ${node.block.name} to undo.`);
  }

  const kept = path.join(projectDir, ".fragmentor", "swaps", String(record.n), "files");
  const plan = new Map<string, Buffer | null>();
  for (const each of record.files) plan.set(each.path, each.existed ? await readFile(resolveInside(kept, each.path)) : null);
  return replace(projectDir, plan, await changesFrom(projectDir, plan), { kind: "undo", block: blockPath, name: record.name, undoes: record.n });
}

/**
 * What a record says was done. `name` is the block's, so a saved version's
 * own name is kept under `saved`, beside everything else listed about it.
 */
type SwapAbout =
  | ({ kind: "swap"; block: string; name: string } & SwappedIn)
  | { kind: "undo"; block: string; name: string; undoes: number };

type SwapRecord = SwapAbout & {
  at: string;
  files: { path: string; existed: boolean }[];
};

/** A record read back, with its number, and whether every change it was made for was made. */
type Kept = SwapRecord & { n: number; done: boolean };

/**
 * What `.fragmentor/.gitignore` says: ignore everything here, this file
 * included, but the saved versions and the notes left on blocks. A copy of
 * old code kept for Undo swap is never committed and never shows as a change,
 * while every saved version and every note shows up to be committed with the
 * project, so everyone working on it has them.
 */
const IGNORED = "*\n!versions/\n!versions/**\n!notes/\n!notes/**\n";

/**
 * Makes `.fragmentor/.gitignore` say exactly that, before anything is written
 * beside it. One written before there were saved versions or notes ignores
 * them too.
 */
export async function ignoreAllButShared(projectDir: string): Promise<void> {
  const file = path.join(projectDir, ".fragmentor", ".gitignore");
  await mkdir(path.dirname(file), { recursive: true });
  if ((await readFile(file, "utf8").catch(() => null)) !== IGNORED) await writeFile(file, IGNORED, "utf8");
}

/**
 * Applies the changes a plan makes to the project, having first copied
 * everything they replace.
 *
 * The record is complete on disk before anything live is touched, and its
 * swap.json is written last, so a record without one is a copy that never
 * finished and nothing was changed. Once every change is made, a file named
 * `done` is put beside it; swap.json itself is never written again, so a
 * stop in the middle of saying so cannot spoil the copy. A swap or an undo
 * that fails part-way, on a file something else holds open, leaves a record
 * that is not done: Undo swap still reverses the swap from the swap's own
 * copy, and no other swap is made until it has.
 *
 * `done` says what every path of the whole plan holds once it is done, by a
 * fingerprint of each file, so the list can tell whether the block is still
 * as the swap left it without asking git, and without a copy of any of it.
 */
async function replace(
  projectDir: string,
  plan: Map<string, Buffer | null>,
  changes: Map<string, Buffer | null>,
  about: SwapAbout,
): Promise<SwapDone> {
  await ignoreAllButShared(projectDir);
  const swaps = path.join(projectDir, ".fragmentor", "swaps");
  await mkdir(swaps, { recursive: true });

  const taken = (await readdir(swaps)).filter((entry) => /^\d+$/.test(entry)).map(Number);
  const n = Math.max(0, ...taken) + 1;
  const record = path.join(swaps, String(n));
  await mkdir(record);

  try {
    const files: SwapRecord["files"] = [];
    for (const file of changes.keys()) {
      const live = resolveInside(projectDir, file);
      // A folder where a file is going is not that file: what is inside it is
      // kept path by path, as the plan's own paths.
      const existed = await isFile(live);
      if (existed) {
        const copy = resolveInside(record, "files", file);
        await mkdir(path.dirname(copy), { recursive: true });
        await copyFile(live, copy);
      }
      files.push({ path: file, existed });
    }
    const written: SwapRecord = { ...about, at: new Date().toISOString(), files };
    await writeFile(path.join(record, "swap.json"), `${JSON.stringify(written, null, 2)}\n`, "utf8");
  } catch (error) {
    await rm(record, { recursive: true, force: true });
    throw error;
  }

  try {
    await applyPlan(projectDir, changes);
  } catch (error) {
    const advice =
      about.kind === "swap" ? "What was there before is kept: press Undo swap to put it back." : "Nothing is lost: press Undo swap again once the file is free.";
    throw new Error(`${messageOf(error)} ${advice}`);
  }
  // A path the plan leaves as it was holds what it should, line endings
  // aside, so its fingerprint is the one the plan gives it.
  const left = Object.fromEntries([...plan].map(([file, content]) => [file, content === null ? null : fingerprint(content)]));
  await writeFile(path.join(record, "done"), `${JSON.stringify({ files: left }, null, 2)}\n`, "utf8");
  return { changed: changes.size };
}

/** The project's most recent record that can be read, or null when nothing has been swapped. */
async function lastRecord(projectDir: string): Promise<Kept | null> {
  const numbers = (await readdir(path.join(projectDir, ".fragmentor", "swaps")).catch(() => [] as string[]))
    .filter((entry) => /^\d+$/.test(entry))
    .map(Number)
    .sort((a, b) => b - a);
  for (const n of numbers) {
    const record = await readRecord(projectDir, n);
    if (record !== null) return record;
  }
  return null;
}

/**
 * One record, or null when it has no swap.json, or one that does not parse
 * because the application was stopped while writing it. Either way it is
 * passed over, as a copy that never finished.
 */
async function readRecord(projectDir: string, n: number): Promise<Kept | null> {
  const record = path.join(projectDir, ".fragmentor", "swaps", String(n));
  const text = await readFile(path.join(record, "swap.json"), "utf8").catch(() => null);
  if (text === null) return null;
  let about: SwapRecord;
  try {
    about = JSON.parse(text) as SwapRecord;
  } catch {
    return null;
  }
  return { ...about, n, done: await exists(path.join(record, "done")) };
}

/**
 * The swap Undo swap reverses, or null. It is the newest record when that is
 * a swap, whether or not it finished. When the newest is an undo that stopped
 * part-way, the swap it was reversing still stands, so it is that one.
 */
async function pendingSwap(projectDir: string): Promise<Extract<Kept, { kind: "swap" }> | null> {
  const last = await lastRecord(projectDir);
  if (last === null || last.kind === "swap") return last;
  if (last.done) return null;
  const undoing = await readRecord(projectDir, last.undoes);
  return undoing?.kind === "swap" ? undoing : null;
}

/**
 * Saves a block as it is now as a version of it, with a name and a
 * description, and gives it back as it will be listed, with the rule that
 * keeps git from sharing it if one does.
 *
 * It holds exactly what a swap to it would replace: the block's folder, its
 * parts' folders and the code they point at, as git lists them now, read
 * from disk. So swapping to it straight away changes nothing, and a file
 * never committed is kept as surely as one that was. It is refused wherever
 * it could never be swapped back.
 */
export async function saveVersion(
  projectDir: string,
  blockPath: string,
  name: string,
  description: string,
): Promise<SavedVersion & { ignored: string | null }> {
  const called = name.trim();
  const about = description.trim();
  if (called === "") throw new Error("A saved version needs a name.");
  if (called.length > 80) throw new Error("A saved version's name can be at most 80 characters.");
  if (about.length > 2000) throw new Error("A saved version's description can be at most 2000 characters.");

  const state = await gitState(projectDir);
  if (state.unavailable !== null) throw new Error(state.unavailable);

  const { project, node, specs } = await loadBlock(projectDir, blockPath);
  const same = (await savedVersions(projectDir, blockPath)).saved.find((each) => each.name.toLowerCase() === called.toLowerCase());
  if (same !== undefined) throw new Error(`${node.block.name} already has a saved version named “${same.name}”. Give this one a name of its own.`);

  const now = await nowFiles(projectDir, specs);
  // A version without its block.json is no block, and planSwap refuses one.
  if (!now.all.includes(`blocks/${blockPath}/block.json`)) {
    throw new Error(`${node.block.name} cannot be saved as a version: git does not see its block.json, as when it is told to ignore it, so it could never be swapped back.`);
  }
  const refused = claims(project, blockPath, now.all, "saving");
  if (refused !== null) throw new Error(refused);
  // As planSwap refuses a link, which a swap back would have to go through.
  const link = await firstLink(projectDir, unique(now.all.flatMap(steps)));
  if (link !== null) {
    throw new Error(
      `${node.block.name} cannot be saved as a version: it goes through a link at ${link}, and Fragmentor never writes through one, so it could never be swapped back.`,
    );
  }

  const there: string[] = [];
  for (const file of now.all.filter((each) => staysInside(projectDir, each)).sort()) {
    // Git still lists a file deleted since it was committed, and it is not part of the block now.
    if (await isFile(resolveInside(projectDir, file))) there.push(file);
  }
  const files: [string, SavedFile["files"][string]][] = [];
  for (const [file, bytes] of await asStored(projectDir, there)) {
    const text = bytes.toString("utf8");
    files.push([file, Buffer.from(text, "utf8").equals(bytes) ? { text } : { base64: bytes.toString("base64") }]);
  }

  const user = await git(projectDir, ["config", "user.name"]);
  const saved = new Date();
  const slug = called.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, 40).replace(/-+$/, "");
  const id = `${saved.getTime()}-${slug}`;
  const written: SavedFile = {
    name: called,
    description: about,
    block: blockPath,
    saved: saved.toISOString(),
    by: "missing" in user || user.code !== 0 ? "" : user.out.toString("utf8").trim(),
    files: Object.fromEntries(files),
  };

  await ignoreAllButShared(projectDir);
  const folder = savedFolder(projectDir, blockPath);
  await mkdir(folder, { recursive: true });
  // Never over another version, however unlikely one is to have this id.
  const at = path.join(folder, `${id}.json`);
  await writeFile(at, `${JSON.stringify(written, null, 2)}\n`, { encoding: "utf8", flag: "wx" });

  // A saved version is shared by being committed, which it cannot be where
  // the repository is told to ignore it, as by a rule leaving out .fragmentor/.
  // Asked as status asks, since a folder left out hides everything in it
  // whatever the rules inside it say; then which rule that is, for the person.
  const relative = path.relative(projectDir, at).split(path.sep).join("/");
  const seen = await git(projectDir, ["ls-files", "-z", "--others", "--exclude-standard", "--", relative]);
  let ignored: string | null = null;
  if (!("missing" in seen) && seen.code === 0 && pathsIn(seen.out).length === 0) {
    // check-ignore takes no literal paths; these two hold nothing a pattern could mean.
    const rule = await git(projectDir, ["check-ignore", "-v", "--", ".fragmentor", relative], { GIT_LITERAL_PATHSPECS: "0" });
    ignored = !("missing" in rule) && rule.code === 0 ? rule.out.toString("utf8").split("\t")[0]!.trim() : "a rule of this repository";
  }
  return { ...listedAs(id, written), ignored };
}

/**
 * Gives one of a block's saved versions a new name and description, held to
 * what saving one is held to, and gives it back as it will be listed. Its id
 * stays as it is, since a swap's record and a comparison know it by that;
 * the name in its file name is only there for whoever reads the folder.
 *
 * Nothing else in its file changes, down to the line endings a checkout gave
 * it, so a review of the commit that changes it shows only what the person
 * changed. It needs no git: it is one file of the project.
 */
export async function editSavedVersion(projectDir: string, blockPath: string, id: string, name: string, description: string): Promise<SavedVersion> {
  if (!savedIdPattern.test(id)) throw new Error(`"${id}" is not a saved version.`);
  const called = name.trim();
  const about = description.trim();
  if (called === "") throw new Error("A saved version needs a name.");
  if (called.length > 80) throw new Error("A saved version's name can be at most 80 characters.");
  if (about.length > 2000) throw new Error("A saved version's description can be at most 2000 characters.");

  const file = path.join(savedFolder(projectDir, blockPath), `${id}.json`);
  const text = await readFile(file, "utf8").catch(() => null);
  if (text === null) throw new Error("That saved version is not there any more.");
  const saved = parseSaved(text);
  if (saved === null) {
    const where = path.relative(projectDir, file).split(path.sep).join("/");
    throw new Error(`This version cannot be changed: Fragmentor cannot read ${where} as a saved version.`);
  }

  const same = (await savedVersions(projectDir, blockPath)).saved.find(
    (each) => each.id !== id && each.name.toLowerCase() === called.toLowerCase(),
  );
  if (same !== undefined) {
    const { node } = await loadBlock(projectDir, blockPath);
    throw new Error(`${node.block.name} already has a saved version named “${same.name}”. Give this one a name of its own.`);
  }

  // Read again as it was written, rather than as the schema gives it back,
  // so every field keeps its place and anything unknown is kept too. JSON
  // writes no line break inside a string, so each one it writes is a line's end.
  const raw = JSON.parse(text) as Record<string, unknown>;
  const end = text.includes("\r\n") ? "\r\n" : "\n";
  await writeFile(file, `${JSON.stringify({ ...raw, name: called, description: about }, null, 2)}\n`.replace(/\n/g, end), "utf8");
  return listedAs(id, { ...saved, name: called, description: about });
}

/**
 * Deletes one of a block's saved versions, and the folders that leaves empty.
 * It goes for everyone once the project is next committed. Git's history
 * holds it only if it was ever committed.
 */
export async function deleteSavedVersion(projectDir: string, blockPath: string, id: string): Promise<void> {
  if (!savedIdPattern.test(id)) throw new Error(`"${id}" is not a saved version.`);
  const folder = savedFolder(projectDir, blockPath);
  const file = path.join(folder, `${id}.json`);
  if (!(await isFile(file))) throw new Error("That saved version is not there any more.");
  await rm(file);

  const top = path.join(projectDir, ".fragmentor", "versions");
  for (let each = folder; each.startsWith(`${top}${path.sep}`); each = path.dirname(each)) {
    if (!(await rmdir(each).then(() => true, () => false))) break;
  }
}

/**
 * Makes sure a new project has a history for its blocks' versions to come
 * from: a repository is started when the folder is in none. Nothing is
 * committed, because committing is the agent's job and a first commit could
 * fail on a machine with no name to commit under. This never throws; what it
 * found or did is a note the agent reads.
 */
export async function startHistory(dir: string): Promise<{ written: string[]; note: string }> {
  const noGit = {
    written: [],
    note: "Git is not installed, so no repository was started and its blocks will have no earlier versions. Install Git, then run git init here.",
  };
  const top = await git(dir, ["rev-parse", "--show-toplevel"]);
  if ("missing" in top) return noGit;
  if (top.code === 0) return { written: [], note: `Its history is kept in the git repository at ${top.out.toString("utf8").trim()}.` };
  if (await insideRepositoryFolder(dir)) {
    return { written: [], note: `Did not start a git repository: git cannot read the one holding this folder (${firstLine(top.err)}).` };
  }

  // No branch is named, so the person's own default is kept.
  const started = await git(dir, ["init", "--quiet"]);
  if ("missing" in started) return noGit;
  if (started.code !== 0) return { written: [], note: `Could not start a git repository here: ${firstLine(started.err)}` };

  // The same clutter the watcher ignores, so an agent's first `git add` does
  // not commit installed packages. Only where Fragmentor made the repository:
  // anyone else's ignore rules are their own.
  const written: string[] = [];
  const ignore = path.join(dir, ".gitignore");
  if (!(await exists(ignore))) {
    await writeFile(ignore, "node_modules/\n__pycache__/\n", "utf8");
    written.push(".gitignore");
  }
  return { written, note: "Started a git repository here. Each commit of a block is a version of it; nothing is committed yet." };
}
