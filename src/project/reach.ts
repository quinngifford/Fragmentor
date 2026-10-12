import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { FileReach, ReachReader, Target, Uses } from "../lang/index.js";
import { packFor } from "./code.js";
import type { BlockCode } from "./code.js";
// Windows and macOS find a file whatever the case it is written in, so a
// pointer written differently still covers it.
import { fold, under } from "./history.js";
import { LARGEST_SHOWN, resolveAccess } from "./project.js";
import type { Project, ProjectDiagnostic } from "./project.js";
import { isArchitecture } from "../model/roles.js";
import { WAYS_LISTED_OVER, holding } from "./analytics.js";

/**
 * Which blocks each block's code reaches, read from the code itself.
 *
 * This is what lets Fragmentor say when the diagram leaves out a connection
 * the code really makes. It is direct reach only: one block's code using a
 * name that another block's pointer covers. What a package does, what goes
 * over the network, and imports made while the program runs are not seen, and
 * wherever something could not be followed the block is told so rather than
 * reaching nothing in silence.
 *
 * On the reaching side, a block pointing at a function is that function and
 * the helpers in its file that it calls. Everything else in a file belongs to
 * the block whose pointer covers the whole file, or else the deepest folder
 * that holds it, unless the functions blocks point at there are some other
 * part's: top-level statements, imports that only run a file, and functions
 * no block points at. So three blocks sharing one file each reach only what
 * their own function does.
 *
 * On the reached side, a name belongs to the block pointing at it, then to
 * the block pointing at its whole file, then to the deepest folder. Code that
 * belongs to nobody, or to the reaching block or something around it, is glue:
 * it is followed, name by name, to whatever it in turn reaches. A file is
 * counted whole only where no single name can be followed — a module handed
 * on whole, an import that only runs it, a name that could not be found — and
 * so is a value built from several things, which may be used one at a time.
 * An edge found that way is marked approximate, and the block told why.
 */

export interface ReachEdge {
  /** The block whose code reaches, and the block it reaches. */
  from: string;
  to: string;
  /** What it uses there, in words that stay the same between readings: `dispatch from src/client/state.ts`. */
  evidence: string;
  /** True when some file on the way had to be counted whole. */
  approximate: boolean;
}

/** One function the measurements name: over the listed limit, or a block's largest. */
export interface NamedFunction {
  name: string;
  file: string;
  line: number;
  paths: number;
  statements: number;
}

/** The functions credited to one block, or to none under the key "". */
export interface BlockFunctions {
  /** How many ways through each function, one number per function, so a distribution can be drawn without naming them all. */
  paths: number[];
  /** How many statements in each function, one number per function. */
  sizes: number[];
  statements: number;
  /** The files these functions are in, each once. */
  files: string[];
  /** The functions over the listed limit, and the one with the most ways through. */
  named: NamedFunction[];
}

export interface ProjectReach {
  /** Sorted, with each (from, to, evidence) once. */
  edges: ReachEdge[];
  /** Every function read, credited to the block whose code it is, or to "" for code under no block. */
  functions: Record<string, BlockFunctions>;
  /** By block path: what that block's code does that could not be followed. */
  notChecked: Record<string, string[]>;
  /** Files whose code reaches something but lies under no block's pointer, so nothing accounts for it. */
  unpointed: string[];
  /** By system: whether its language's reach can be read at all. */
  systemsRead: Record<string, boolean>;
}

/** A block's pointer, as the owner of the code it covers. */
interface Owner {
  path: string;
  /** Relative to the project, with forward slashes; `.` is the whole project. */
  file: string;
  symbol: string | null;
}

/** Every file in the project a reader could read, leaving out installed packages, hidden folders and Fragmentor's own `blocks/`. */
function listFiles(projectDir: string, readers: ReachReader[]): string[] {
  const files: string[] = [];
  const visit = (relative: string) => {
    for (const entry of readdirSync(path.join(projectDir, relative), { withFileTypes: true })) {
      const file = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".") || (relative === "" && entry.name === "blocks")) continue;
        visit(file);
      } else if (entry.isFile() && readers.some((reader) => reader.fileKind(file) !== null)) {
        files.push(file);
      }
    }
  };
  visit("");
  return files;
}

export async function readProjectReach(project: Project, code: Map<string, BlockCode>): Promise<ProjectReach> {
  const readerOf = (blockPath: string): ReachReader | undefined => packFor(project, blockPath)?.reach;
  const systemsRead: Record<string, boolean> = {};
  for (const system of project.systems) systemsRead[system.rootBlock] = readerOf(system.rootBlock) !== undefined;
  const readers = [...new Set(project.systems.map((system) => readerOf(system.rootBlock)).filter((reader) => reader !== undefined))];

  const edges = new Map<string, ReachEdge>();
  const notChecked = new Map<string, Set<string>>();
  const note = (blockPath: string, line: string) => notChecked.set(blockPath, (notChecked.get(blockPath) ?? new Set()).add(line));
  const functions: Record<string, BlockFunctions> = {};
  const result = (unpointed: string[]): ProjectReach => ({
    edges: [...edges.values()].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.evidence.localeCompare(b.evidence)),
    functions,
    notChecked: Object.fromEntries([...notChecked].sort(([a], [b]) => a.localeCompare(b)).map(([blockPath, lines]) => [blockPath, [...lines].sort()])),
    unpointed: unpointed.sort(),
    systemsRead,
  });
  if (readers.length === 0) return result([]);

  /* Who owns what. */

  const bySymbol = new Map<string, Owner>();
  // Every block pointing at each whole file or folder, since several may.
  const pointedAt = new Map<string, Owner[]>();
  const folderKeys = new Set<string>();
  for (const [blockPath, found] of [...code].sort(([a], [b]) => a.localeCompare(b))) {
    const location = found.location;
    if (location === null) continue;
    const owner = { path: blockPath, file: location.file, symbol: location.symbol };
    if (location.symbol !== null) {
      if (!bySymbol.has(`${fold(location.file)}#${location.symbol}`)) bySymbol.set(`${fold(location.file)}#${location.symbol}`, owner);
      continue;
    }
    const key = fold(location.file);
    pointedAt.set(key, [...(pointedAt.get(key) ?? []), owner]);
    if (location.text === null && statSync(path.join(project.dir, location.file), { throwIfNoEntry: false })?.isDirectory()) folderKeys.add(key);
  }

  // A file several blocks point at whole, such as one router holding the
  // routes of three services, cannot be split between them, so its code is
  // counted as the block that holds them all, and each of them says so.
  const byFile = new Map<string, Owner>();
  const folders: Owner[] = [];
  for (const [key, owners] of pointedAt) {
    // Sorted by path, so a block pointing at the same code as one of its parts comes first and keeps it.
    const separate = owners.filter((owner, i) => !owners.slice(0, i).some((before) => under(before.path, owner.path)));
    let owner = separate[0]!;
    if (separate.length > 1) {
      const common = holding(separate.map((each) => each.path));
      if (common !== "") {
        owner = { path: common, file: owner.file, symbol: null };
        for (const each of separate) {
          const others = separate.filter((other) => other !== each).map((other) => other.path);
          note(each.path, `${each.file} is also the code of ${others.join(" and ")}, so what it reaches is counted as ${owner.path}'s`);
        }
      }
    }
    if (folderKeys.has(key)) folders.push(owner);
    else byFile.set(key, owner);
  }
  // The deepest first, so the folder that holds a file most closely is the one that owns it.
  folders.sort((a, b) => (b.file === "." ? 0 : b.file.length) - (a.file === "." ? 0 : a.file.length));

  const pointedInto = new Map<string, string[]>();
  for (const owner of bySymbol.values()) pointedInto.set(fold(owner.file), [...(pointedInto.get(fold(owner.file)) ?? []), owner.path]);

  /** Who a file's code belongs to, apart from the names blocks point at. */
  const restOwner = (file: string): Owner | undefined => {
    const whole = byFile.get(fold(file));
    if (whole !== undefined) return whole;
    const folder = folders.find((each) => each.file === "." || fold(file).startsWith(`${fold(each.file)}/`));
    const functions = pointedInto.get(fold(file)) ?? [];
    if (folder === undefined || functions.every((each) => under(folder.path, each))) return folder;
    // A file the folder only takes in along with the rest, whose functions are
    // some other part's, such as a command's file inside a server's folder, is
    // that part's: its top-level code is what runs those functions.
    const around = holding(functions.map((each) => each.split("/").slice(0, -1).join("/")));
    return around === "" ? folder : { path: around, file, symbol: null };
  };
  const ownerOf = (file: string, name: string | null): Owner | undefined =>
    (name === null ? undefined : bySymbol.get(`${fold(file)}#${name}`)) ?? restOwner(file);

  /* Reading, once per file for each reading of the project. */

  const readings = new Map<ReachReader, (file: string, text: string) => FileReach>();
  const readingOf = (reader: ReachReader) => {
    if (!readings.has(reader)) readings.set(reader, reader.reading(project.dir));
    return readings.get(reader)!;
  };

  // Finding each block's code read the files pointed at already, and reading
  // a file is most of what a reading of the project costs.
  const alreadyRead = new Map<string, string>();
  for (const found of code.values()) {
    if (found.location?.text != null) alreadyRead.set(fold(found.location.file), found.location.text);
  }

  /** What a file reaches; a sentence when it could not be read; null for code that is Fragmentor's own. */
  const sources = new Map<string, FileReach | string | null>();
  const source = (file: string, reader: ReachReader): FileReach | string | null => {
    const key = fold(file);
    if (!sources.has(key)) sources.set(key, readSource(file, reader));
    return sources.get(key)!;
  };
  const readSource = (file: string, reader: ReachReader): FileReach | string | null => {
    if (fold(file).startsWith("blocks/")) return null;
    if (reader.fileKind(file) === null) return `${file} is not code Fragmentor can read for what it reaches`;
    let text = alreadyRead.get(fold(file));
    try {
      text ??= readFileSync(path.join(project.dir, ...file.split("/")), "utf8");
    } catch {
      return `${file} could not be read`;
    }
    if (text.length > LARGEST_SHOWN) return `${file} is too large to read`;
    try {
      return readingOf(reader)(file, text);
    } catch {
      return `${file} could not be read as code`;
    }
  };

  /**
   * Where a name used from a file is really declared, through any files that
   * only pass it on, which are added to `through` nearest first. Null when it
   * is nowhere to be found.
   */
  const definition = (target: Target, reader: ReachReader, through: string[], seen = new Set<string>()): Target | "outside" | null => {
    if (target.name === null || target.name === "*") return target;
    const found = source(target.file, reader);
    if (found === null) return "outside";
    if (typeof found === "string" || found.declarations.has(target.name)) return target;
    const key = `${fold(target.file)}#${target.name}`;
    if (seen.has(key)) return null;
    seen.add(key);
    const passed = found.exports.get(target.name);
    if (passed === null) return "outside";
    let declared: Target | "outside" | null = null;
    if (passed !== undefined) {
      if ("local" in passed) return found.declarations.has(passed.local) ? { file: target.file, name: passed.local } : null;
      declared = definition(passed, reader, through, seen);
    } else {
      // A file that is not read, such as a generated client, would seem to
      // declare every name, so it is taken only as the one place left.
      const unread = found.exportsAll.filter((file): file is string => {
        const read = file === null ? undefined : source(file, reader);
        return read === null || typeof read === "string";
      });
      for (const file of found.exportsAll) {
        if (file !== null && !unread.includes(file)) declared = definition({ file, name: target.name }, reader, through, seen);
        if (declared !== null) break;
      }
      const somePackage = found.exportsAll.includes(null);
      if (declared === null && unread.length === 1 && !somePackage) declared = definition({ file: unread[0]!, name: target.name }, reader, through, seen);
      // A name no file of the project passes on may be a package's, passed on whole.
      else if (declared === null && unread.length === 0 && somePackage) return "outside";
    }
    if (declared !== null && declared !== "outside") through.unshift(target.file);
    return declared;
  };

  /** How many edges have been found so far, to tell whether following something found any. */
  let added = 0;
  const addEdge = (from: string, to: string, evidence: string, approximate: boolean) => {
    const key = `${from}\n${to}\n${evidence}`;
    if (!edges.has(key)) added += 1;
    if (!approximate || !edges.has(key)) edges.set(key, { from, to, evidence, approximate });
  };

  /** Every name any block's code was followed into, to tell what nothing accounts for. */
  const followed = new Set<string>();
  /** The helpers a function block's code followed in its own file, by `file#name`, which are that block's. */
  const helpers = new Map<string, string>();

  /** Follows everything one block's code uses, recording what it reaches; `ownFile` is a function block's file. */
  const reaching = (reacher: string, reader: ReachReader, ownFile?: string) => {
    const visited = new Set<string>();

    const walk = (file: string, uses: Uses, approximate: boolean): void => {
      for (const target of uses.targets) follow(target, approximate);
      for (const name of uses.local) follow({ file, name }, approximate);
      for (const line of uses.notChecked) note(reacher, line);
    };
    const walkWhole = (file: string, found: FileReach): void => {
      walk(file, found.rest, true);
      for (const name of found.declarations.keys()) follow({ file, name }, true);
    };

    const follow = (target: Target, approximate: boolean): void => {
      const through: string[] = [];
      const found = definition(target, reader, through);
      if (found === "outside") return;
      if (found === null) note(reacher, `"${target.name}" in ${target.file} could not be found, so all of ${target.file} is counted`);
      const at = found ?? { file: target.file, name: "*" };
      const rough = approximate || found === null;

      const key = `${fold(at.file)}#${at.name}`;
      if (visited.has(`${rough}:${key}`)) return;
      visited.add(`${rough}:${key}`);
      followed.add(key);

      const read = source(at.file, reader);
      if (read === null) return;
      // A function block's helpers in its own file are its own, whoever holds the rest of the file.
      const helper = ownFile !== undefined && at.name !== null && at.name !== "*" && fold(at.file) === fold(ownFile) && !bySymbol.has(key);
      if (helper && !helpers.has(key)) helpers.set(key, reacher);
      let owner = helper ? undefined : ownerOf(at.file, at.name === "*" ? null : at.name);
      if (!helper && (owner === undefined || under(owner.path, reacher))) {
        // A name declared where no other block's pointer reaches, but passed on
        // by a file that is some block's, such as the index a block points at,
        // is that block's: it is what the code imported from.
        owner = through.map((file) => restOwner(file)).find((each) => each !== undefined && !under(each.path, reacher)) ?? owner;
      }
      if (owner !== undefined && !under(owner.path, reacher)) {
        // Its own parts reach what they reach themselves.
        if (!under(reacher, owner.path)) {
          const evidence =
            at.name === null ? `an import that runs ${at.file}` : at.name === "*" ? `all of ${at.file}` : `${at.name} from ${at.file}`;
          addEdge(reacher, owner.path, evidence, rough);
          // A module handed on whole may have any of its functions called, so
          // the blocks pointing at them are reached too, though perhaps not.
          if (at.name === "*") {
            for (const each of bySymbol.values()) {
              if (fold(each.file) === fold(at.file) && !under(each.path, reacher) && !under(reacher, each.path)) addEdge(reacher, each.path, evidence, true);
            }
          }
        }
        return;
      }

      // Glue: nobody's, or the reacher's own, or part of something it sits in.
      if (typeof read === "string") {
        note(reacher, read);
        return;
      }
      const uses = at.name === null || at.name === "*" ? undefined : read.declarations.get(at.name);
      // A value built from several things, such as an object bundling a
      // database and a mailer, may be used one of them at a time, so unless
      // it is the reacher's own code, all of it is only perhaps reached.
      const bundle =
        uses !== undefined && owner?.path !== reacher && read.values.has(at.name!) && new Set([...uses.targets.map((each) => each.file), ...uses.local]).size > 1;
      const before = added;
      if (uses === undefined) walkWhole(at.file, read);
      else walk(at.file, uses, rough || bundle);
      // What was found only by counting all of something is not judged, so the block is told why.
      if (!rough && added > before && (uses === undefined || bundle)) {
        note(
          reacher,
          uses === undefined
            ? `${at.file} is ${at.name === null ? "imported only to run it" : "used whole"}, so all of it is counted`
            : `${at.name} in ${at.file} is a value that may hold several things, so all of it is counted`,
        );
      }
    };

    return { visited, walk, walkWhole, follow };
  };

  /**
   * Runs one block's share of the reading. Anything that goes wrong on the
   * way is said on that block, because a project whose reach could not be
   * read must still open.
   */
  const guarded = (blockPath: string, file: string, work: () => void) => {
    try {
      work();
    } catch {
      note(blockPath, `what the code in ${file} reaches could not be followed to the end`);
    }
  };

  /* Function blocks: their own function. */

  for (const owner of bySymbol.values()) {
    const reader = readerOf(owner.path);
    if (reader === undefined) continue;
    guarded(owner.path, owner.file, () => {
      const read = source(owner.file, reader);
      if (read === null) return;
      if (typeof read === "string") {
        note(owner.path, read);
        return;
      }
      const from = reaching(owner.path, reader, owner.file);
      const key = `${fold(owner.file)}#${owner.symbol}`;
      from.visited.add(`false:${key}`);
      followed.add(key);
      const uses = read.declarations.get(owner.symbol!);
      if (uses !== undefined) {
        from.walk(owner.file, uses, false);
      } else {
        // A method such as `Cart.total`, which is found by name but not read on its own.
        note(owner.path, `"${owner.symbol}" in ${owner.file} could not be found by reading the code, so all of ${owner.file} is counted`);
        from.walkWhole(owner.file, read);
      }
    });
  }

  /* Everything else in a file: its whole-file or folder owner's. */

  let files: string[];
  try {
    files = listFiles(project.dir, readers);
  } catch {
    files = [];
  }
  const listed = new Set(files.map(fold));
  for (const owner of byFile.values()) if (!listed.has(fold(owner.file))) files.push(owner.file);

  const walkers = new Map<string, ReturnType<typeof reaching>>();
  const nobodys: string[] = [];
  for (const file of files.sort()) {
    const owner = restOwner(file);
    if (owner === undefined) {
      nobodys.push(file);
      continue;
    }
    const reader = readerOf(owner.path);
    // Tests are never counted: they reach everything they test.
    if (reader === undefined || reader.fileKind(file) !== "code") continue;
    guarded(owner.path, file, () => {
      const read = source(file, reader);
      if (read === null) return;
      if (typeof read === "string") {
        note(owner.path, read);
        return;
      }
      const from = walkers.get(owner.path) ?? reaching(owner.path, reader);
      walkers.set(owner.path, from);
      from.walk(file, read.rest, false);
      for (const name of read.declarations.keys()) {
        if (!bySymbol.has(`${fold(file)}#${name}`)) from.follow({ file, name }, false);
      }
    });
  }

  /* Every function, credited once: by the name a pointer names, then as a helper its block followed, then by the file's owner. */

  for (const file of files) {
    const reader = readers.find((each) => each.fileKind(file) === "code");
    if (reader === undefined) continue;
    let read: FileReach | string | null = null;
    try {
      read = source(file, reader);
    } catch {
      continue;
    }
    if (read === null || typeof read === "string" || read.functions === undefined) continue;
    for (const shape of read.functions) {
      const key = `${fold(file)}#${shape.name}`;
      const owner =
        bySymbol.get(key)?.path ??
        (shape.top === null ? undefined : bySymbol.get(`${fold(file)}#${shape.top}`)?.path) ??
        helpers.get(key) ??
        restOwner(file)?.path ??
        "";
      const credited = (functions[owner] ??= { paths: [], sizes: [], statements: 0, files: [], named: [] });
      credited.paths.push(shape.paths);
      credited.sizes.push(shape.statements);
      credited.statements += shape.statements;
      if (!credited.files.includes(file)) credited.files.push(file);
      credited.named.push({ name: shape.name, file, line: shape.line, paths: shape.paths, statements: shape.statements });
    }
  }
  // A distribution needs every count, but the page holds no code, so only
  // the functions worth naming are named: those over the limit, the one with
  // the most ways through, and the one with the most in it.
  for (const credited of Object.values(functions)) {
    credited.paths.sort((a, b) => a - b);
    credited.sizes.sort((a, b) => a - b);
    credited.files.sort();
    const byPaths = (a: NamedFunction, b: NamedFunction) => b.paths - a.paths || a.file.localeCompare(b.file) || a.line - b.line;
    const longest = [...credited.named].sort(byPaths)[0];
    const biggest = [...credited.named].sort((a, b) => b.statements - a.statements || a.file.localeCompare(b.file) || a.line - b.line)[0];
    credited.named = credited.named.filter((each) => each.paths > WAYS_LISTED_OVER || each === longest || each === biggest).sort(byPaths);
  }

  /* Code under no pointer that reaches something, and that no block's code led into. */

  const unpointed = nobodys.filter((file) => {
    const reader = readers.find((each) => each.fileKind(file) === "code");
    let read: FileReach | string | null = null;
    try {
      if (reader !== undefined) read = source(file, reader);
    } catch {
      return false;
    }
    if (read === null || typeof read === "string") return false;
    const reachesSomething = (uses: Uses) => uses.targets.length > 0 || uses.notChecked.length > 0;
    return (
      reachesSomething(read.rest) ||
      [...read.declarations].some(([name, uses]) => !followed.has(`${fold(file)}#${name}`) && reachesSomething(uses))
    );
  });

  return result(unpointed);
}

/**
 * Where the code reaches into a service, client, database, queue or any other
 * such part from outside it, and nothing on the diagram says so.
 *
 * Crossing into one of those is what the diagram's access is for, so a
 * crossing no access declares is the diagram leaving out a connection the
 * code really makes. A component is only a grouping, so crossing into one
 * needs nothing, and calls inside one part need nothing either.
 *
 * It is lenient about where the access is: on the reaching block, on one of
 * its parts, or on something around it, naming the part crossed into,
 * something inside it, or something around it that does not also hold the
 * reaching block. Only which part is reached is judged, not how.
 *
 * Only reach read exactly is judged. Where some file had to be counted whole,
 * the block already says so as something not checked, and a guess is not
 * worth a warning.
 *
 * One warning for each reaching block and each part it crosses into, with its
 * evidence sorted and no line numbers, so the text stays the same while the
 * code does and a warning flagged for the agent is recognised again.
 */
export function undeclaredReach(project: Project, reach: ProjectReach): ProjectDiagnostic[] {
  // What each block's access leads to, found once.
  const leadsTo: [string, string[]][] = [...project.byPath].map(([blockPath, node]) => [
    blockPath,
    node.block.access.flatMap((entry) => resolveAccess(project, blockPath, entry.resource)?.path ?? []),
  ]);
  const declared = (from: string, into: string) =>
    leadsTo.some(
      ([holder, targets]) =>
        (under(holder, from) || under(from, holder)) &&
        targets.some((target) => !under(target, from) && (under(target, into) || under(into, target))),
    );

  const crossings = new Map<string, { from: string; into: string; evidence: Set<string> }>();
  for (const edge of reach.edges) {
    if (edge.approximate) continue;
    const segments = edge.to.split("/");
    let into: string | undefined;
    if (segments[0] !== edge.from.split("/")[0]) {
      into = segments[0];
    } else {
      // The outermost part crossed into that nothing declares.
      for (let depth = 1; depth <= segments.length && into === undefined; depth += 1) {
        const around = segments.slice(0, depth).join("/");
        const role = project.byPath.get(around)!.block.role;
        if (isArchitecture(role) && role !== "component" && !under(around, edge.from) && !declared(edge.from, around)) into = around;
      }
    }
    if (into === undefined) continue;
    const key = `${edge.from}\n${into}`;
    if (!crossings.has(key)) crossings.set(key, { from: edge.from, into, evidence: new Set() });
    crossings.get(key)!.evidence.add(edge.evidence);
  }

  return [...crossings.values()]
    .sort((a, b) => a.from.localeCompare(b.from) || a.into.localeCompare(b.into))
    .map(({ from, into, evidence }) => {
      const name = (blockPath: string) => project.byPath.get(blockPath)!.block.name;
      const uses = [...evidence].sort().join("; ");
      if (into.split("/")[0] !== from.split("/")[0]) {
        return {
          severity: "warning",
          blockPath: from,
          message: `"${name(from)}"'s code reaches into the system "${name(into)}" (${into}): ${uses}. Systems in one project are separate programs that never reach each other, so the diagram cannot say this: stop reaching it, or make the two one system.`,
        };
      }
      const naming = accessNaming(project, from, into);
      return {
        severity: "warning",
        blockPath: from,
        message: `"${name(from)}"'s code reaches "${name(into)}" (${into}), but no access on it, inside it or above it names that: ${uses}. ${
          naming === null ? "Add an access to it" : `Add an access naming "${naming}"`
        } to the block that makes the call, or stop reaching it.`,
      };
    });
}

/** The shortest resource an access on `from` would name `target` by, or null when none leads there. */
function accessNaming(project: Project, from: string, target: string): string | null {
  const segments = from.split("/");
  for (let depth = segments.length; depth > 0; depth -= 1) {
    const around = segments.slice(0, depth).join("/");
    if (!under(around, target) || around === target) continue;
    const naming = target.slice(around.length + 1);
    return resolveAccess(project, from, naming)?.path === target ? naming : null;
  }
  return null;
}
