import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v4";
import { blockIdPattern, blockToFileShape, formatAccess, parseBlockFile } from "../model/block.js";
import type { Access, Block, Exposed, Port } from "../model/block.js";
import { normaliseLanguage } from "../lang/index.js";
import { describeType, typesEqual } from "../model/types.js";
import type { PortType } from "../model/types.js";
import { CAPABILITIES, capabilitiesReaching, reachesResource } from "../model/capabilities.js";
import { ROLES, isArchitecture } from "../model/roles.js";
import { resolveInside } from "./safePath.js";

/**
 * A Fragmentor project is a directory whose folder structure is the block
 * hierarchy. A block's identity is its path from the root, so nothing has to
 * be annotated or cross-referenced to know where a block sits: moving a
 * folder moves the block. A block's parts are the block folders inside its
 * own, and that is all being inside means: ownership, not order.
 *
 * A project holds one or more systems. A system is a block hierarchy with its
 * own target language, and systems are not connected to each other — they are
 * separate programs that happen to be worked on together.
 *
 *   <project>/
 *     fragmentor.json
 *     blocks/
 *       rank-jobs/          <- one system
 *         block.json
 *         score-posting/
 *           block.json
 *       train-model/        <- another, possibly in another language
 *         block.json
 *
 * A block's folder says where the block sits in the architecture. It says
 * nothing about where the block's code lives: that is the codebase's own
 * business, and each function block points at it with `code`.
 *
 * The person chooses the granularity and optionally the language when the
 * project is created, and Fragmentor writes them into fragmentor.json. The
 * agent fills in the rest, so a project with no systems yet is simply waiting
 * for it.
 */

export interface Granularity {
  /**
   * How finely the agent divides the work. 1 leaves large blocks alone;
   * 5 breaks work down to small single-purpose pieces.
   */
  level: 1 | 2 | 3 | 4 | 5;
  /** How many levels deep the hierarchy may go, counting a system's root as the first. */
  maxDepth: number;
}

export interface SystemDeclaration {
  /** The block id at the root of this system, which is also its folder. */
  rootBlock: string;
  /** The language this system's code is written in, when the project does not set one for every system. */
  language?: string;
}

/**
 * Whether the agent lays the architecture out as a plan before building it.
 *
 * With `plan`, it draws the whole shape first as planned blocks and waits for
 * the person to agree before writing anything. With `build`, it defines and
 * implements as it goes. Either way planned blocks stay available: this only
 * says where the work starts.
 */
export type Start = "plan" | "build";

export interface Manifest {
  name: string;
  /** What the software being built is supposed to do, in the user's words. */
  goal: string;
  /**
   * Whether the folder already held code when the project was started. It
   * decides whether the agent is describing code or writing it from nothing,
   * which is the difference the guide has to state plainly.
   */
  existingCode: boolean;
  start: Start;
  /** The language the person chose for every system, if they chose one. */
  language?: string;
  granularity: Granularity;
  systems: SystemDeclaration[];
}

const systemSchema = z
  .object({
    rootBlock: z.string().regex(blockIdPattern, "must be kebab-case, because it names the system's folder"),
    language: z.string().min(1).optional(),
  })
  .strict();

export const manifestSchema = z
  .object({
    name: z.string().min(1),
    goal: z.string().default(""),
    // Both were added after the first projects were, so a manifest without
    // them reads as one started from nothing and built straight away.
    existingCode: z.boolean().default(false),
    start: z.enum(["plan", "build"], {
      error: `must be "plan" (lay the architecture out as planned blocks first) or "build" (build it as you go)`,
    }).default("build"),
    language: z.string().min(1).optional(),
    granularity: z
      .object(
        {
          level: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)], {
            error: "must be a whole number from 1 to 5",
          }),
          maxDepth: z.number().int().min(1).max(8).default(4),
        },
        { error: `must say how finely to divide the work, for example { "level": 3 }` },
      )
      .strict(),
    systems: z.array(systemSchema).default([]),
  })
  .strict()
  .refine((m) => new Set(m.systems.map((s) => s.rootBlock)).size === m.systems.length, {
    message: "two systems cannot share a root block",
    path: ["systems"],
  }) as unknown as z.ZodType<Manifest>;

export interface LoadedBlock {
  block: Block;
  /** Slash-joined block ids from the system root, e.g. `rank-jobs/score-posting`. */
  path: string;
  /** Absolute path to the block's own folder. */
  dir: string;
  children: LoadedBlock[];
}

export interface LoadedSystem {
  rootBlock: string;
  /** The system's own language, or the project's. Empty when neither names one. */
  language: string;
  root: LoadedBlock;
}

export interface Project {
  dir: string;
  manifest: Manifest;
  systems: LoadedSystem[];
  byPath: Map<string, LoadedBlock>;
}

export interface Diagnostic {
  severity: "error" | "warning";
  /** Plain language. These are shown to the user in the canvas, not just logged. */
  message: string;
}

export interface ProjectDiagnostic extends Diagnostic {
  blockPath: string;
}

const BLOCKS_DIR = "blocks";
const MANIFEST_FILE = "fragmentor.json";
const BLOCK_FILE = "block.json";

export function blocksRoot(projectDir: string): string {
  return path.join(projectDir, BLOCKS_DIR);
}

/** A folder is a Fragmentor project when it holds this file. */
export function manifestPath(projectDir: string): string {
  return path.join(projectDir, MANIFEST_FILE);
}

/** Walks up to the folder holding fragmentor.json, the way git finds a repository. */
export async function findProject(start: string): Promise<string | null> {
  let dir = path.resolve(start);
  for (;;) {
    try {
      await access(manifestPath(dir));
      return dir;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }
}

/**
 * Where a block's folder lives, given its path from the blocks root. A path is
 * block ids joined by `/`, and anything else — `..` above all, arriving from
 * the window — is refused rather than followed out of the project.
 */
export function blockDir(projectDir: string, blockPath: string): string {
  const segments = blockPath.split("/");
  if (!segments.every((segment) => blockIdPattern.test(segment))) {
    throw new Error(`"${blockPath}" is not a block path: it should be block ids joined by "/".`);
  }
  return path.join(blocksRoot(projectDir), ...segments);
}

/** The system a block belongs to, identified by the first segment of its path. */
export function systemOf(project: Project, blockPath: string): LoadedSystem | undefined {
  const rootId = blockPath.split("/")[0];
  return project.systems.find((system) => system.rootBlock === rootId);
}

/** The language a block's code is written in. */
export function languageOf(project: Project, blockPath: string): string | undefined {
  return systemOf(project, blockPath)?.language;
}

/** Reads fragmentor.json alone, which is enough to know how the project is set up. */
export async function readManifest(projectDir: string): Promise<Manifest> {
  const file = manifestPath(projectDir);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (cause) {
    throw new Error(`The project file at ${file} could not be read: ${cause instanceof Error ? cause.message : String(cause)}.`, {
      cause,
    });
  }

  if (raw && typeof raw === "object" && "mode" in raw) {
    throw new Error(
      `The project at ${projectDir} sets "mode". There are no modes any more: every function block says where its code is with "code", and Fragmentor writes a contract for, checks and runs whichever blocks it can. Remove "mode" from fragmentor.json.`,
    );
  }

  if (raw && typeof raw === "object" && "rootBlock" in raw && !("systems" in raw)) {
    throw new Error(
      `The project at ${projectDir} uses the old single-system manifest. Replace "rootBlock" with a "systems" list, for example: "systems": [{ "rootBlock": "${String((raw as { rootBlock: unknown }).rootBlock)}", "language": "typescript" }].`,
    );
  }

  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new Error(`The project file at ${file} is not valid:\n${detail}`);
  }

  // "TypeScript" means the TypeScript pack. Anything no pack answers to stays
  // as it was written, and is drawn rather than checked.
  const manifest = parsed.data;
  return {
    ...manifest,
    ...(manifest.language === undefined ? {} : { language: normaliseLanguage(manifest.language) }),
    systems: manifest.systems.map((system) => ({
      ...system,
      ...(system.language === undefined ? {} : { language: normaliseLanguage(system.language) }),
    })),
  };
}

export async function loadProject(projectDir: string): Promise<Project> {
  const manifest = await readManifest(projectDir);
  const systems: LoadedSystem[] = [];
  const byPath = new Map<string, LoadedBlock>();

  const index = (node: LoadedBlock) => {
    byPath.set(node.path, node);
    node.children.forEach(index);
  };

  for (const declaration of manifest.systems) {
    const language = declaration.language ?? manifest.language;
    const root = await loadBlockTree(blockDir(projectDir, declaration.rootBlock), declaration.rootBlock, false);
    systems.push({ rootBlock: declaration.rootBlock, language: language ?? "", root });
    index(root);
  }

  return { dir: projectDir, manifest, systems, byPath };
}

async function loadBlockTree(dir: string, blockPath: string, plannedAbove: boolean): Promise<LoadedBlock> {
  const id = blockPath.split("/").at(-1)!;
  const file = path.join(dir, BLOCK_FILE);

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (cause) {
    // Say why, because whoever wrote the file needs to know what to fix.
    const reason =
      (cause as NodeJS.ErrnoException).code === "ENOENT"
        ? "the file does not exist"
        : cause instanceof Error
          ? cause.message
          : String(cause);
    throw new Error(`Could not read the block definition at ${file}: ${reason}.`, { cause });
  }

  const parsed = parseBlockFile(raw, id, plannedAbove);
  if (!parsed.ok) {
    throw new Error(`The block definition at ${file} is not valid:\n  ${parsed.problems.join("\n  ")}`);
  }

  // Planning spreads downward: a block inside one that does not exist yet
  // does not exist either. parseBlockFile has already applied that, both to
  // the block and to how its ports were read, so everything that reads a
  // loaded block sees the truth without walking back up the tree to find it.
  const planned = parsed.block.planned;

  // A block's folder can sit alongside things that are not blocks: __pycache__,
  // node_modules, a virtual environment. Only a directory that is named like a
  // block and actually contains one is treated as a child.
  const entries = await readdir(dir, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isDirectory() && blockIdPattern.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  const children: LoadedBlock[] = [];
  for (const childId of candidates) {
    const childDir = path.join(dir, childId);
    try {
      await access(path.join(childDir, BLOCK_FILE));
    } catch {
      continue;
    }
    children.push(await loadBlockTree(childDir, `${blockPath}/${childId}`, planned));
  }

  return { block: parsed.block, path: blockPath, dir, children };
}

/**
 * Checks what the diagram says against itself: what each block reaches,
 * what answers each operation, and what each capability port is a way into.
 */
export function validateProject(project: Project): ProjectDiagnostic[] {
  const diagnostics: ProjectDiagnostic[] = [];
  const { maxDepth } = project.manifest.granularity;
  const { language } = project.manifest;

  // A language on the project is the person's answer for every system in it,
  // so a system contradicting it is a mistake rather than a second opinion.
  if (language !== undefined) {
    for (const declaration of project.manifest.systems) {
      if (declaration.language !== undefined && declaration.language !== language) {
        diagnostics.push({
          severity: "error",
          blockPath: declaration.rootBlock,
          message: `The system "${declaration.rootBlock}" is written in ${declaration.language}, but this project is set to ${language}, so every system in it uses ${language}.`,
        });
      }
    }
  }

  for (const node of project.byPath.values()) {
    // A function block is one function in the codebase, so it says which. The
    // code's layout is the codebase's own — Fragmentor never moves code, and
    // nothing is implied by where a block's folder happens to sit — so without
    // this there is nothing to read, check or run.
    if (!node.block.planned && !isArchitecture(node.block.role) && node.block.code === undefined) {
      diagnostics.push({
        severity: "error",
        blockPath: node.path,
        message: `"${node.block.name}" does not say where its code is. Add "code", such as "src/pricing.ts#reportTotals". Give it a "role" if it is not a function, or "planned": true if it does not exist yet.`,
      });
    }

    if (node.block.pinnedAsLeaf && node.children.length > 0) {
      diagnostics.push({
        severity: "error",
        blockPath: node.path,
        message: `"${node.block.name}" is pinned as a leaf, but it has been given parts inside it. Make it a leaf again, or set "pinnedAsLeaf" to false if the person agrees.`,
      });
    }

    // An operation that says which block answers it is checked here: the
    // block it names is one of its parts, which only the project has in hand.
    for (const [name, entry] of Object.entries(node.block.exposes)) {
      if (entry.block === undefined) continue;
      const answering = node.children.find((child) => child.block.id === entry.block);
      const severity = node.block.planned ? "warning" : "error";

      if (!answering) {
        diagnostics.push({
          severity,
          blockPath: node.path,
          message: `"${node.block.name}" says its "${name}" is answered by "${entry.block}", but there is no such block inside it.`,
        });
      } else if (isArchitecture(answering.block.role)) {
        diagnostics.push({
          severity,
          blockPath: node.path,
          message: `"${node.block.name}" says its "${name}" is answered by "${entry.block}", which is ${ROLES[answering.block.role].label.toLowerCase()} rather than code. An operation is answered by a function block.`,
        });
      } else {
        for (const problem of answeringShapeProblems(node.block.name, name, entry, answering.block)) {
          diagnostics.push({ severity, blockPath: node.path, message: problem });
        }
      }
    }

    // Access is declared by the block that does the reaching, and only the
    // project knows what lies around a block, so it is checked here.
    // A planned block is a drawing of something nobody has built, so what it
    // says it reaches is a plan too, and reported as a warning.
    const loose = node.block.planned;
    for (const access of node.block.access) {
      diagnostics.push(...accessDiagnostics(project, node, access, loose));
    }
    diagnostics.push(...storePortDiagnostics(node, loose));

    // Two blocks pointing at one function would be one function standing for
    // two things, and a watched run would wrap it twice and report a call that
    // never happened.
    if (!node.block.planned && !isArchitecture(node.block.role) && node.block.code !== undefined) {
      const same = [...project.byPath.values()].filter(
        (other) =>
          other.path !== node.path &&
          !other.block.planned &&
          !isArchitecture(other.block.role) &&
          other.block.code === node.block.code,
      );
      if (same.length > 0) {
        diagnostics.push({
          severity: "error",
          blockPath: node.path,
          message: `"${node.block.name}" points at the same code as ${same
            .map((other) => `"${other.block.name}"`)
            .join(", ")}: ${node.block.code}. Two blocks cannot be the same function, so give each its own, naming it after the \`#\` if they share a file.`,
        });
      }
    }

    const depth = node.path.split("/").length;
    if (depth > maxDepth) {
      diagnostics.push({
        severity: "warning",
        blockPath: node.path,
        message: `"${node.block.name}" is ${depth} levels deep, but the project allows at most ${maxDepth} (granularity.maxDepth in fragmentor.json).`,
      });
    }
  }

  return diagnostics;
}

/**
 * The block an access names, found by looking outward from the one that
 * declared it: its own parts first, then its parent's, then its parent's
 * parent's, up to the top of the system.
 *
 * That is what lets a handler buried inside a service reach a database the
 * service keeps beside it, without every level in between having to repeat
 * it, and a block reach something it owns. A path such as
 * `infrastructure/db` is found the same way by its first part, then followed
 * down. A block of the right id is returned whatever it turns out to be, so
 * that naming a function by mistake is reported as the mistake it is rather
 * than as a missing block.
 */
export function resolveAccess(project: Project, blockPath: string, resource: string): LoadedBlock | undefined {
  const [first, ...rest] = resource.split("/");
  const segments = blockPath.split("/");
  for (let depth = segments.length; depth > 0; depth -= 1) {
    const ancestor = project.byPath.get(segments.slice(0, depth).join("/"));
    const found = ancestor?.children.find((child) => child.block.id === first);
    if (found) return rest.length === 0 ? found : project.byPath.get([found.path, ...rest].join("/"));
  }
  return undefined;
}

/** Long enough for any real chain, short enough that a loop in the diagram cannot hang whoever follows it. */
const MOST_ROUTE_STEPS = 12;

/**
 * What actually runs when one entry happens, as every step of the way there.
 *
 * A button on a client calls an operation on a service; that operation says
 * which block answers it; and that block is code, with a contract and a test
 * bench. Following those two links end to end turns "this button" into "this
 * function", which is the whole reason for saying which entry does the
 * reaching rather than only that two blocks are connected.
 *
 * The route starts where it is asked from and ends at a function block, or
 * wherever the links run out. Empty when there is no block at `blockPath`.
 */
export function answeringRoute(project: Project, blockPath: string, entry: string | null): { path: string; entry: string | null }[] {
  const route: { path: string; entry: string | null }[] = [];
  let at = project.byPath.get(blockPath);
  let atEntry = entry;

  while (at && route.length < MOST_ROUTE_STEPS) {
    route.push({ path: at.path, entry: atEntry });
    const here = at;
    const hereEntry = atEntry;
    at = undefined;

    // A function block is where it ends: that is the code that runs.
    if (!isArchitecture(here.block.role) || hereEntry === null) break;

    // An operation that names the block answering it leads straight into code.
    const answering = here.block.exposes[hereEntry]?.block;
    if (answering) {
      at = project.byPath.get(`${here.path}/${answering}`);
      atEntry = null;
      if (at) continue;
    }

    // Otherwise this entry may call another block's entry, and on it goes.
    for (const each of here.block.access) {
      const next = each.from === hereEntry ? resolveAccess(project, here.path, each.resource) : undefined;
      if (next) {
        at = next;
        atEntry = each.entry;
        break;
      }
    }
  }

  return route;
}

/**
 * Whether an operation and the block answering it are the same shape.
 *
 * They have to be, because nothing stands between them: the block is handed
 * what the operation accepts, and what it returns is the response. The
 * alternative was a mapping written on the operation saying which field
 * became which, which would put a piece of the program somewhere no reader
 * looks. Where the outside world's shape really does differ, the answering
 * block's code converts it. A block that needs nothing from the request may
 * take no inputs at all.
 *
 * A shape written in words is not checked, at either end: a port standing for
 * something the type language cannot say, or something a planned block has not
 * decided yet, is nobody's to enforce, and comparing a parsed operation
 * against it would report a mismatch on every diagram that has one.
 */
function answeringShapeProblems(name: string, entryName: string, entry: Exposed, answering: Block): string[] {
  const asPorts = (ports: Record<string, Port>): PortType => ({
    kind: "object",
    fields: Object.fromEntries(Object.entries(ports).map(([port, spec]) => [port, { type: spec.type }])),
  });

  const compare = (
    declared: PortType | null,
    ports: Record<string, Port>,
    direction: "accepts" | "returns",
    noun: string,
  ): string[] => {
    if (Object.values(ports).some((port) => port.type.kind === "text")) return [];

    const expected = asPorts(ports);
    const empty = Object.keys(ports).length === 0;

    // A block that takes nothing can answer a request that carries
    // something: it simply does not need it, which is allowed of any code.
    if (empty && direction === "accepts") return [];

    if (declared === null) {
      return empty ? [] : [`"${name}" says its "${entryName}" ${direction} nothing, but "${answering.id}" has ${noun}: ${describeType(expected)}.`];
    }
    if (declared.kind === "text") return [];
    if (empty) {
      return [`"${name}" says its "${entryName}" ${direction} ${describeType(declared)}, but "${answering.id}" has no ${noun}.`];
    }
    if (typesEqual(declared, expected)) return [];

    return [
      `"${name}" says its "${entryName}" ${direction} ${describeType(declared)}, but "${answering.id}", which answers it, has ${noun} ${describeType(expected)}. The block is handed what the operation accepts, and what it returns is the response, so give the two the same shape.`,
    ];
  };

  return [
    ...compare(entry.accepts, answering.inputs, "accepts", "inputs"),
    ...compare(entry.returns, answering.outputs, "returns", "outputs"),
  ];
}

/**
 * What a block's capability ports say, seen from the ports rather than from
 * the accesses.
 *
 * A `Store` or `Queue` is a way into one particular thing on the diagram, and
 * the access naming the port is what says which. A port nobody named has no
 * substitute to be given when the block runs, so it is reported here rather
 * than failing later with nothing to point at.
 */
function storePortDiagnostics(node: LoadedBlock, declaredLoosely: boolean): ProjectDiagnostic[] {
  if (isArchitecture(node.block.role)) return [];

  return Object.entries(node.block.capabilities).flatMap(([name, port]) => {
    if (!reachesResource(port.capability)) return [];

    const bound = node.block.access.filter((each) => each.from === name);
    const roles = CAPABILITIES[port.capability]!.reaches!.map((role) => ROLES[role].label.toLowerCase());
    const at = (message: string): ProjectDiagnostic => ({
      severity: declaredLoosely ? "warning" : "error",
      blockPath: node.path,
      message,
    });

    if (bound.length === 0) {
      return [
        at(
          `"${node.block.name}" asks for a ${port.capability} called "${name}", but nothing says what it is a way into. Add an access such as "${name} reads <${roles[0]!.replace(/ /g, "-")}>.<entry>" beside it.`,
        ),
      ];
    }

    // Two accesses from one port are two different things for the code to
    // reach through one object, and nothing would decide which it got.
    const targets = [...new Set(bound.map((each) => `${each.resource}.${each.entry ?? ""}`))];
    if (targets.length > 1) {
      return [
        at(
          `"${node.block.name}" says its ${port.capability} port "${name}" is a way into ${targets.length} different things: ${bound
            .map((each) => `"${formatAccess(each)}"`)
            .join(", ")}. One port reaches one of them; ask for a port each.`,
        ),
      ];
    }

    return [];
  });
}

/** What an access says about a block, once the block it names has been found. */
function accessDiagnostics(project: Project, node: LoadedBlock, access: Access, declaredLoosely: boolean): ProjectDiagnostic[] {
  const written = `declares "${formatAccess(access)}"`;
  const found = resolveAccess(project, node.path, access.resource);

  // A planned resource is the thing being decided, so a handler written
  // against one is early rather than wrong. Nothing about a plan is an error,
  // whichever end of the access it sits at.
  const loose = declaredLoosely || (found?.block.planned ?? false);
  const at = (severity: "error" | "warning", message: string): ProjectDiagnostic => ({
    severity: loose ? "warning" : severity,
    blockPath: node.path,
    message,
  });

  // What does the reaching, when the block names it. On an architecture
  // block that is one of its entries; on a function block it is the
  // capability port whose substitute this access is a way into.
  if (access.from !== null && isArchitecture(node.block.role) && !(access.from in node.block.exposes)) {
    const names = Object.keys(node.block.exposes);
    return [
      at(
        "error",
        `"${node.block.name}" ${written}, but it exposes nothing called "${access.from}"${
          names.length > 0 ? `. It exposes: ${names.join(", ")}.` : ", and exposes nothing at all."
        }`,
      ),
    ];
  }

  const port = access.from !== null && !isArchitecture(node.block.role) ? node.block.capabilities[access.from] : undefined;
  if (access.from !== null && !isArchitecture(node.block.role) && !port) {
    const names = Object.keys(node.block.capabilities);
    return [
      at(
        "error",
        `"${node.block.name}" ${written}, but it has no capability port called "${access.from}"${
          names.length > 0 ? `. Its ports are: ${names.join(", ")}.` : ", and asks for no capabilities at all."
        }`,
      ),
    ];
  }

  if (!found) {
    return [
      at(
        "error",
        `"${node.block.name}" ${written}, but there is no block called "${access.resource}" among its own parts, beside it, or anywhere above it in this system.`,
      ),
    ];
  }

  // Looking outward passes through the block itself and then everything it
  // sits inside, so both are reachable by name and neither means anything.
  if (found.path === node.path) {
    return [at("error", `"${node.block.name}" ${written}, but that is the block itself.`)];
  }
  if (node.path.startsWith(`${found.path}/`)) {
    return [
      at("error", `"${node.block.name}" ${written}, but "${access.resource}" is the block it sits inside. A block cannot reach what it is part of.`),
    ];
  }

  if (!isArchitecture(found.block.role)) {
    return [
      at(
        "error",
        `"${node.block.name}" ${written}, but "${access.resource}" is an ordinary function block. Access joins a block to a database, queue, service or other piece of the architecture; to use a function, import it and call it from code.`,
      ),
    ];
  }

  const role = ROLES[found.block.role];

  // A bound capability port is a way into one particular entry, so it has to
  // name one: a Store that knew only which database it belonged to would not
  // know which table it read.
  if (port && access.entry === null) {
    return [
      at(
        "error",
        `"${node.block.name}" ${written}, but "${access.from}" is a ${port.capability} port, which is a way into one ${role.entryNoun} rather than into "${found.block.name}" as a whole. Say which, as "${access.from} ${access.verb} ${access.resource}.<${role.entryNoun}>".`,
      ),
    ];
  }

  if (port && !CAPABILITIES[port.capability]?.reaches?.includes(found.block.role)) {
    const instead = capabilitiesReaching(found.block.role);
    return [
      at(
        "error",
        `"${node.block.name}" ${written}, but "${access.from}" is a ${port.capability} port and "${found.block.name}" is ${role.label.toLowerCase()}. ${
          instead.length > 0
            ? `A block of that kind is reached through ${instead.join(" or ")}.`
            : `Nothing reaches a block of that kind through a capability; ${role.label.toLowerCase()} is called, not read.`
        }`,
      ),
    ];
  }

  if (access.entry === null) return [];

  const entry = found.block.exposes[access.entry];
  if (!entry) {
    const names = Object.keys(found.block.exposes);
    return [
      at(
        "error",
        `"${node.block.name}" ${written}, but "${found.block.name}" exposes no ${role.entryNoun} called "${access.entry}"${
          names.length > 0 ? `. It exposes: ${names.join(", ")}.` : `, and exposes nothing at all yet.`
        }`,
      ),
    ];
  }

  // The entry itself says which directions it has. Reading something that
  // gives nothing back, or writing to something that takes nothing, is a
  // contradiction worth pointing out but not worth refusing a diagram over.
  if (access.verb === "reads" && entry.returns === null) {
    return [at("warning", `"${node.block.name}" reads "${access.resource}.${access.entry}", which says nothing comes back from it.`)];
  }
  if (access.verb === "writes" && entry.accepts === null) {
    return [at("warning", `"${node.block.name}" writes to "${access.resource}.${access.entry}", which says it takes nothing.`)];
  }
  return [];
}
export async function writeBlock(dir: string, block: Block): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, BLOCK_FILE), `${JSON.stringify(blockToFileShape(block), null, 2)}\n`, "utf8");
}

export async function writeManifest(projectDir: string, manifest: Manifest): Promise<void> {
  await mkdir(projectDir, { recursive: true });
  await writeFile(manifestPath(projectDir), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

/** Creates a project directory containing one root block per system. */
export async function createProject(
  projectDir: string,
  manifest: Manifest,
  rootBlocks: Block[],
): Promise<void> {
  await writeManifest(projectDir, manifest);
  for (const root of rootBlocks) {
    await writeBlock(blockDir(projectDir, root.id), root);
  }
}

/* -------------------------------------------------------------------------- */
/* Where a block's code is                                                     */
/* -------------------------------------------------------------------------- */

export interface CodeLocation {
  /** The file or folder, relative to the project, with forward slashes. */
  file: string;
  symbol: string | null;
  /** The line the symbol was found on, counting from 1. */
  line: number | null;
  /** The file's text, when the pointer names a file small enough to show. */
  text: string | null;
}

/** Past this, a file is not read to find a name in it or to show it. */
export const LARGEST_SHOWN = 2_000_000;

/**
 * Finds what a block's `code` points at: `src/pricing.ts`, `src/pricing/` or
 * `src/pricing.ts#priceOrder`. A pointer that leads nowhere is reported,
 * because a diagram pointing at code that has moved is exactly the drift a
 * diagram of code has to show.
 */
export async function locateCode(
  projectDir: string,
  pointer: string,
): Promise<{ ok: true; location: CodeLocation } | { ok: false; problem: string }> {
  const hash = pointer.indexOf("#");
  const filePart = (hash === -1 ? pointer : pointer.slice(0, hash)).trim().replace(/\\/g, "/");
  const symbol = hash === -1 ? null : pointer.slice(hash + 1).trim() || null;

  let target: string;
  try {
    target = resolveInside(projectDir, filePart);
  } catch {
    return { ok: false, problem: `"${pointer}" points outside the project folder.` };
  }

  const info = await stat(target).catch(() => null);
  if (!info) return { ok: false, problem: `"${filePart}" does not exist.` };
  const file = path.relative(projectDir, target).split(path.sep).join("/") || ".";

  if (info.isDirectory()) {
    if (symbol) return { ok: false, problem: `"${filePart}" is a folder, so it cannot point at "${symbol}". Name the file it is in.` };
    return { ok: true, location: { file, symbol: null, line: null, text: null } };
  }
  if (info.size > LARGEST_SHOWN) return { ok: true, location: { file, symbol, line: null, text: null } };

  const text = (await readFile(target, "utf8")).replace(/\r\n/g, "\n");
  if (!symbol) return { ok: true, location: { file, symbol: null, line: null, text } };

  const line = findSymbol(text, symbol);
  if (line === null) return { ok: false, problem: `"${filePart}" has nothing called "${symbol}".` };
  return { ok: true, location: { file, symbol, line, text } };
}

const escapeForPattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Words that introduce a declaration, in the languages a project is likely to be written in. */
const DECLARING = "function|def|class|fn|func|interface|type|const|let|var|struct|enum|trait|module|object|val|sub";

/** How a name looks where it is declared, near enough for any language. */
function declarationPatterns(name: string): RegExp[] {
  return [
    new RegExp(`\\b(${DECLARING})\\s+\\*?\\s*${name}($|[^A-Za-z0-9_$])`),
    new RegExp(`^\\s*((async|static|public|private|protected|export|default|override|readonly)\\s+)*\\*?${name}\\s*[(=:<]`),
  ];
}

/**
 * Whether a file really declares this name, rather than only mentioning it.
 *
 * Finding a name is deliberately forgiving, because a pointer into a language
 * Fragmentor cannot parse should still open the code somewhere useful. Calling
 * one is not: a block whose file only mentions the name — in the path of an
 * import, say — is a block the runner would refuse, so nothing offers to run it.
 *
 * A dotted name such as `Service.find` is a method: the class has to be
 * declared, and the method declared on a line after it. Where the class ends
 * is not worked out, which no language-blind reading could do.
 */
export function declaresSymbol(text: string, symbol: string): boolean {
  const lines = text.split("\n");
  let from = 0;
  for (const part of symbol.split(".").filter(Boolean)) {
    const patterns = declarationPatterns(escapeForPattern(part));
    const at = lines.findIndex((line, i) => i >= from && patterns.some((pattern) => pattern.test(line)));
    if (at === -1) return false;
    from = at + 1;
  }
  return from > 0;
}

/**
 * The line a name is declared on, near enough for any language: `function
 * priceOrder` or `priceOrder(order) {` beats a line that merely calls it. A
 * dotted name such as `Cart.total` is found part by part, each after the last.
 */
function findSymbol(text: string, symbol: string): number | null {
  const lines = text.split("\n");
  let found = -1;

  for (const part of symbol.split(".").filter(Boolean)) {
    const name = escapeForPattern(part);
    const word = new RegExp(`(^|[^A-Za-z0-9_$])${name}($|[^A-Za-z0-9_$])`);
    const patterns = declarationPatterns(name);

    const candidates: number[] = [];
    lines.forEach((line, i) => {
      if (i >= Math.max(found, 0) && word.test(line)) candidates.push(i);
    });
    if (candidates.length === 0) return null;
    found = candidates.find((i) => patterns.some((pattern) => pattern.test(lines[i]!))) ?? candidates[0]!;
  }

  return found === -1 ? null : found + 1;
}
