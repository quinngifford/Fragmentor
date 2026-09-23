import { execFile } from "node:child_process";
import { copyFile, lstat, mkdir, readFile, readdir, rm, rmdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { blockIdPattern, parseBlockFile } from "../model/block.js";
import { isArchitecture } from "../model/roles.js";
import { blockDir, loadProject } from "./project.js";
import type { LoadedBlock, Project } from "./project.js";
import { resolveInside } from "./safePath.js";

/**
 * A block's earlier versions, and putting one back.
 *
 * Fragmentor keeps no history of its own. A block's versions are the commits
 * of whatever git repository holds the project that changed the block, its
 * parts or the code they point at, from the commit that added its block.json.
 * A version is the whole of that at one commit: the folders, their saved
 * tests and contracts, and the code files, because a block without its parts
 * or its code is not the block as it was.
 *
 * Putting a version back is the one time Fragmentor writes code files, and
 * only because the person asked. Everything a swap replaces is copied first
 * into `.fragmentor/swaps/`, which git is told to ignore, so the swap can be
 * undone exactly. That copy is not a second history: it lists nothing as a
 * version, and holds only what one swap replaced. A swap never writes or
 * deletes through a symbolic link or a junction: what one reaches is not
 * what the person asked to change.
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
 * are off, so reading the history never takes the index from an agent
 * committing at the same moment, and git never stops to ask for a password
 * nobody can type.
 */
function git(dir: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["--literal-pathspecs", "-c", "log.showSignature=false", "-c", "log.follow=false", "-c", "color.ui=false", "-C", dir, ...args],
      {
        encoding: "buffer",
        maxBuffer: 256 << 20,
        windowsHide: true,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
      },
      (error, stdout, stderr) => {
        if (error?.code === "ENOENT") return resolve({ missing: true });
        // Anything else that stopped git, such as more output than fits, is a
        // failure too, so it never reads as success.
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : -1;
        resolve({ code, out: stdout, err: stderr.toString("utf8") || (error?.message ?? "") });
      },
    );
  });
}

const NO_GIT = "Versions come from git, which is not installed on this computer. Install it, then open this window again.";

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
function z(out: Buffer): string[] {
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
 * The files under these paths at one commit. Only ordinary files are part of
 * a version: a link or a nested repository is not something a swap can write.
 */
async function treeFiles(dir: string, commit: string, specs: string[]): Promise<string[]> {
  const listed = await git(dir, ["ls-tree", "-r", "-z", commit, "--", ...specs]);
  if ("missing" in listed) throw new Error(NO_GIT);
  if (listed.code !== 0) throw new Error("That commit is not in this project's history.");
  return z(listed.out).flatMap((entry) => {
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
 * their own, since no version can hold them.
 */
async function nowFiles(dir: string, specs: string[]): Promise<{ all: string[]; untracked: string[] }> {
  const [tracked, others] = await Promise.all([
    git(dir, ["ls-files", "-z", "-s", "--cached", "--", ...specs]),
    git(dir, ["ls-files", "-z", "--others", "--exclude-standard", "--", ...specs]),
  ]);
  const files = z(outputOf(tracked)).flatMap((entry) => {
    // "<mode> <object> <stage>\t<path>", once for each stage of a conflict.
    const mode = entry.slice(0, entry.indexOf(" "));
    const file = entry.slice(entry.indexOf("\t") + 1);
    return (mode === "100644" || mode === "100755") && !noise(file) ? [file] : [];
  });
  const untracked = z(outputOf(others)).filter((file) => !noise(file));
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

/** Runs `work` on every item, eight at a time: one git process per file, without starting hundreds at once. */
async function eightAtATime<T>(items: T[], work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await work(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(8, items.length) }, worker));
}

export interface BlockVersion {
  commit: string;
  /** When it was committed, as ISO 8601. */
  date: string;
  author: string;
  subject: string;
}

export interface BlockVersions {
  /** Why there can be no versions, as a sentence, or null when there can. */
  unavailable: string | null;
  /** Newest first, at most 100. */
  versions: BlockVersion[];
  /** More than 100 exist. */
  more: boolean;
  /** Whether the block as it is now differs from the newest version, which it does when there is none. */
  changed: boolean;
  /** Why no version of it can be swapped in on its own, from what is on disk now, or null. */
  blocked: string | null;
  /**
   * The version put in place by the swap Undo swap would reverse, when that
   * is a swap of this block. Set even when git cannot be used, since undoing
   * needs only the copy the swap kept.
   */
  swapped: BlockVersion | null;
}

/**
 * How many paths were written or removed. A swap with nothing to change makes
 * no record of itself; an undo always does, so the same swap is never undone
 * twice.
 */
export interface SwapDone {
  changed: number;
}

/** Every path a swap to one commit would touch, and what each held then. A path missing from `then` did not exist. */
export interface SwapPlan {
  project: Project;
  name: string;
  touched: string[];
  then: Map<string, Buffer>;
}

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
 * A block's versions, newest first, and what the window needs to say about
 * them. Whether a version can still be read is left until it is compared or
 * swapped: reading every one here would cost two processes a commit.
 */
export async function blockVersions(projectDir: string, blockPath: string): Promise<BlockVersions> {
  // Undoing needs only the copy the swap kept, so it is offered whatever
  // state git is in.
  const pending = await pendingSwap(projectDir);
  const swapped =
    pending?.block === blockPath ? { commit: pending.commit, date: pending.date, author: pending.author, subject: pending.subject } : null;
  const none = (unavailable: string): BlockVersions => ({
    unavailable,
    versions: [],
    more: false,
    changed: true,
    blocked: null,
    swapped,
  });

  // One question settles git's whole state: 0 has commits, 1 has none yet,
  // and anything else means there is no repository it can read.
  const head = await git(projectDir, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  if ("missing" in head) return none(NO_GIT);
  if (head.code !== 0 && head.code !== 1) {
    return none(
      (await insideRepositoryFolder(projectDir))
        ? `Versions come from the project's git history, and git cannot read the repository holding this folder: ${firstLine(head.err)}`
        : "Versions come from the project's git history, and this folder is not in a git repository yet. Ask your agent to put it under git and commit.",
    );
  }
  const hasCommits = head.code === 0;

  const { project, specs } = await loadBlock(projectDir, blockPath);
  const now = await nowFiles(projectDir, specs);
  const blocked = claims(project, blockPath, now.all);

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
    const diff = await git(projectDir, ["diff", "--quiet", "HEAD", "--", ...specs]);
    changed = now.untracked.length > 0 || (!("missing" in diff) && diff.code === 1);
  }

  return { unavailable: null, versions, more, changed, blocked, swapped };
}

/**
 * Why a swap touching these paths cannot be made on its own, or null.
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
function claims(project: Project, blockPath: string, paths: string[]): string | null {
  const name = project.byPath.get(blockPath)!.block.name;
  const fold = IGNORES_CASE ? (file: string) => file.toLowerCase() : (file: string) => file;
  const inside = (root: string, file: string) => under(fold(root), fold(file));

  const elsewhere = paths.find((file) => inside("blocks", file) && !inside(`blocks/${blockPath}`, file));
  if (elsewhere !== undefined) {
    return `Swapping ${name} would change ${elsewhere}, which is inside another block's folder, so it cannot be compared or swapped on its own.`;
  }

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

  const which = `Swapping ${name} would also change the code of ${listNames(claimants.map((node) => node.block.name))}, which ${
    claimants.length === 1 ? "is" : "are"
  } not part of it: ${[...files].sort().join(", ")}`;
  return lowest === ""
    ? `${which}, so it cannot be compared or swapped on its own.`
    : `${which}. Compare or swap ${project.byPath.get(lowest)!.block.name}, which holds them all, instead.`;
}

/**
 * Everything a swap to one commit would touch, and what each path held then.
 * Compare works from the same plan, so it is refused exactly when a swap
 * would be, and shows exactly what a swap would do.
 *
 * Every path the block is made of now or was made of then is made to match
 * the commit: written as it was, or taken away if it was not there. A code
 * file the block points at now is looked for at the commit too, so a helper
 * that lived at that path then is written back rather than deleted.
 */
export async function planSwap(projectDir: string, blockPath: string, commit: string): Promise<SwapPlan> {
  // The window names the commit, so anything else, such as a value starting
  // with "-" that git would read as an option, is refused before git sees it.
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(commit)) throw new Error(`"${commit}" is not a commit.`);

  const { project, node, specs: nowSpecs } = await loadBlock(projectDir, blockPath);
  const name = node.block.name;
  const root = `blocks/${blockPath}`;

  const folder = await treeFiles(projectDir, commit, [root]);
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

    const text = (await readAt(projectDir, commit, file)).toString("utf8");
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
  const [listedThen, now] = await Promise.all([treeFiles(projectDir, commit, specs), nowFiles(projectDir, specs)]);

  // Git's paths are the project's, so none should lead out of it. None is
  // followed if one does.
  const inside = (file: string) => {
    try {
      resolveInside(projectDir, file);
      return true;
    } catch {
      return false;
    }
  };
  const thenFiles = listedThen.filter(inside);
  const touched = unique([...thenFiles, ...now.all.filter(inside)]).sort();

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

  const refused = claims(project, blockPath, touched);
  if (refused !== null) throw new Error(refused);

  const then = new Map<string, Buffer>();
  await eightAtATime(thenFiles, async (file) => {
    then.set(file, await readAt(projectDir, commit, file));
  });
  return { project, name, touched, then };
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

/** Puts a block and its parts back as they were at one commit, keeping what was there so it can be undone. */
export async function swapToVersion(projectDir: string, blockPath: string, commit: string): Promise<SwapDone> {
  // A swap on top of one that stopped part-way would copy the half-swapped
  // files, and what the person had before would be out of reach.
  const last = await lastRecord(projectDir);
  if (last !== null && !last.done) {
    throw new Error(`The last swap of ${last.name} did not finish. Press Undo swap in its Versions window first, so what it replaced is put back.`);
  }

  const plan = await planSwap(projectDir, blockPath, commit);
  const changes = await changesFrom(projectDir, new Map(plan.touched.map((file) => [file, plan.then.get(file) ?? null])));
  if (changes.size === 0) return { changed: 0 };

  const version = versionFrom(outputOf(await git(projectDir, ["log", "-n", "1", FORMAT, commit, "--"])).toString("utf8").trim());
  return replace(projectDir, changes, { kind: "swap", block: blockPath, name: plan.name, ...version });
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
  return replace(projectDir, await changesFrom(projectDir, plan), { kind: "undo", block: blockPath, name: record.name, undoes: record.n });
}

type SwapAbout =
  | ({ kind: "swap"; block: string; name: string } & BlockVersion)
  | { kind: "undo"; block: string; name: string; undoes: number };

type SwapRecord = SwapAbout & {
  at: string;
  files: { path: string; existed: boolean }[];
};

/** A record read back, with its number, and whether every change it was made for was made. */
type Kept = SwapRecord & { n: number; done: boolean };

/**
 * Applies a plan to the project, having first copied everything it replaces.
 *
 * The record is complete on disk before anything live is touched, and its
 * swap.json is written last, so a record without one is a copy that never
 * finished and nothing was changed. Once every change is made, a file named
 * `done` is put beside it; swap.json itself is never written again, so a
 * stop in the middle of saying so cannot spoil the copy. A swap or an undo
 * that fails part-way, on a file something else holds open, leaves a record
 * that is not done: Undo swap still reverses the swap from the swap's own
 * copy, and no other swap is made until it has.
 */
async function replace(projectDir: string, plan: Map<string, Buffer | null>, about: SwapAbout): Promise<SwapDone> {
  const kept = path.join(projectDir, ".fragmentor");
  const swaps = path.join(kept, "swaps");
  await mkdir(swaps, { recursive: true });
  // Git is told to ignore all of it, this file included, so a copy of old
  // code is never committed and never shows as a change.
  if (!(await exists(path.join(kept, ".gitignore")))) await writeFile(path.join(kept, ".gitignore"), "*\n", "utf8");

  const taken = (await readdir(swaps)).filter((entry) => /^\d+$/.test(entry)).map(Number);
  const n = Math.max(0, ...taken) + 1;
  const record = path.join(swaps, String(n));
  await mkdir(record);

  try {
    const files: SwapRecord["files"] = [];
    for (const file of plan.keys()) {
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
    await applyPlan(projectDir, plan);
  } catch (error) {
    const advice =
      about.kind === "swap" ? "What was there before is kept: press Undo swap to put it back." : "Nothing is lost: press Undo swap again once the file is free.";
    throw new Error(`${messageOf(error)} ${advice}`);
  }
  await writeFile(path.join(record, "done"), "", "utf8");
  return { changed: plan.size };
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
