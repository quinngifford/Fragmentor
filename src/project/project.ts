import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v4";
import { blockIdPattern, blockToFileShape, formatAccess, parseBlockFile } from "../model/block.js";
import type { Access, Block, Mode } from "../model/block.js";
import { ROLES, isArchitecture } from "../model/roles.js";
import { validateComposite } from "../model/validate.js";
import type { Diagnostic } from "../model/validate.js";
import { resolveInside } from "./safePath.js";

/**
 * A Fragmentor project is a directory whose folder structure is the block
 * hierarchy. A block's identity is its path from the root, so nothing has to
 * be annotated or cross-referenced to know where a block sits: moving a
 * folder moves the block.
 *
 * A project holds one or more systems. A system is a block hierarchy with its
 * own target language, and systems are not connected to each other — they are
 * separate programs that happen to be worked on together.
 *
 *   <project>/
 *     fragmentor.json
 *     layout.json
 *     blocks/
 *       rank-jobs/          <- one system
 *         block.json
 *         score-posting/
 *           block.json
 *       train-model/        <- another, possibly in another language
 *         block.json
 *
 * The person chooses the mode, the granularity and optionally the language
 * when the project is created, and Fragmentor writes them into fragmentor.json.
 * The agent fills in the rest, so a project with no systems yet is simply
 * waiting for it.
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
  mode: Mode;
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
    mode: z.enum(["structured", "visual"], {
      error: `must be "structured" (Fragmentor generates, checks and runs the code) or "visual" (Fragmentor only draws it)`,
    }),
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
  /** The system's own language, or the project's. Empty in a visual project that names none. */
  language: string;
  root: LoadedBlock;
}

export interface Project {
  dir: string;
  manifest: Manifest;
  systems: LoadedSystem[];
  byPath: Map<string, LoadedBlock>;
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
  return parsed.data;
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
    // Structured code is generated and checked in a language, so it has to be
    // known. A visual project only shows it, and can manage without.
    if (language === undefined && manifest.mode === "structured") {
      throw new Error(
        `fragmentor.json does not say what language the system "${declaration.rootBlock}" is written in. Add "language" to the system, or to the whole project.`,
      );
    }

    const root = await loadBlockTree(blockDir(projectDir, declaration.rootBlock), declaration.rootBlock, manifest.mode, false);
    systems.push({ rootBlock: declaration.rootBlock, language: language ?? "", root });
    index(root);
  }

  return { dir: projectDir, manifest, systems, byPath };
}

async function loadBlockTree(dir: string, blockPath: string, mode: Mode, plannedAbove: boolean): Promise<LoadedBlock> {
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

  const parsed = parseBlockFile(raw, id, mode, plannedAbove);
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
    children.push(await loadBlockTree(childDir, `${blockPath}/${childId}`, mode, planned));
  }

  return { block: parsed.block, path: blockPath, dir, children };
}

/**
 * Checks every composite against its children, and checks that the folders on
 * disk agree with what the diagram claims.
 */
export function validateProject(project: Project): ProjectDiagnostic[] {
  const diagnostics: ProjectDiagnostic[] = [];
  const { maxDepth } = project.manifest.granularity;
  const { mode, language } = project.manifest;

  // In a visual project the language only describes existing code, which may
  // well mix several; in a structured one the person's choice binds.
  if (mode === "structured" && language !== undefined) {
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
    const onDisk = new Map(node.children.map((child) => [child.block.id, child.block]));

    for (const diagnostic of validateComposite(node.block, onDisk, mode)) {
      diagnostics.push({ ...diagnostic, blockPath: node.path });
    }

    const declared = new Set(node.block.children.map((child) => child.block));
    for (const child of node.children) {
      if (!declared.has(child.block.id)) {
        diagnostics.push({
          severity: "error",
          blockPath: node.path,
          message: `There is a folder for "${child.block.id}" inside "${node.block.name}", but the diagram does not list it as a child.`,
        });
      }
    }

    // Access is declared by the block that does the reaching, so it is
    // checked here rather than in the composite: only the project knows what
    // lies above a block.
    const loose = mode === "visual" || node.block.planned;
    for (const access of node.block.access) {
      diagnostics.push(...accessDiagnostics(project, node, access, loose));
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
 * declared it: its parent's children first, then its parent's, up to the top
 * of the system.
 *
 * That is what lets a handler buried inside a service reach a database the
 * service keeps beside it, without every level in between having to repeat
 * it. A block of the right id is returned whatever it turns out to be, so
 * that naming a function by mistake is reported as the mistake it is rather
 * than as a missing block.
 */
export function resolveAccess(project: Project, blockPath: string, resource: string): LoadedBlock | undefined {
  const segments = blockPath.split("/");
  for (let depth = segments.length - 1; depth > 0; depth -= 1) {
    const ancestor = project.byPath.get(segments.slice(0, depth).join("/"));
    const found = ancestor?.children.find((child) => child.block.id === resource);
    if (found) return found;
  }
  return undefined;
}

/**
 * Whether this block is a piece of the architecture, or holds one anywhere
 * beneath it.
 *
 * A composite's code is nothing but a call to each of its children, and a
 * database is not something you call. So a block with architecture below it
 * has no code of its own to generate, exactly as one with a plan below it
 * does not — the real code that reaches into it is the framework's, and lives
 * outside `blocks/`. Its function children are ordinary blocks and are
 * generated, checked and run as usual.
 */
export function holdsArchitecture(node: LoadedBlock): boolean {
  return isArchitecture(node.block.role) || node.children.some(holdsArchitecture);
}

/** What an access says about a block, once the block it names has been found. */
function accessDiagnostics(project: Project, node: LoadedBlock, access: Access, loose: boolean): ProjectDiagnostic[] {
  const at = (severity: "error" | "warning", message: string): ProjectDiagnostic => ({
    severity: loose ? "warning" : severity,
    blockPath: node.path,
    message,
  });
  const written = `"${formatAccess(access)}"`;
  const found = resolveAccess(project, node.path, access.resource);

  if (!found) {
    return [
      at(
        "error",
        `"${node.block.name}" ${written}, but there is no block called "${access.resource}" beside it or anywhere above it in this system.`,
      ),
    ];
  }
  if (!isArchitecture(found.block.role)) {
    return [
      at(
        "error",
        `"${node.block.name}" ${written}, but "${access.resource}" is an ordinary function block. Access joins a block to a database, queue, service or other piece of the architecture; wire a function to it instead.`,
      ),
    ];
  }

  const role = ROLES[found.block.role];
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

/**
 * Whether this block is planned, or holds a planned block anywhere beneath it.
 *
 * A composite's code is nothing but a call to each of its children, so a
 * block with a planned block somewhere below it has no code to generate
 * either: the call would name a function nobody has written.
 */
export function holdsPlan(node: LoadedBlock): boolean {
  return node.block.planned || node.children.some(holdsPlan);
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
/* Where a visual block's code is                                              */
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
const LARGEST_SHOWN = 2_000_000;

/**
 * Finds what a visual block's `code` points at: `src/pricing.ts`, `src/pricing/`
 * or `src/pricing.ts#priceOrder`. A pointer that leads nowhere is reported,
 * because a diagram pointing at code that has moved is exactly the drift a
 * visual project has to show.
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

/** Words that introduce a declaration, in the languages a visual project is likely to be written in. */
const DECLARING = "function|def|class|fn|func|interface|type|const|let|var|struct|enum|trait|module|object|val|sub";

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
    const declared = new RegExp(`\\b(${DECLARING})\\s+\\*?\\s*${name}($|[^A-Za-z0-9_$])`);
    const defined = new RegExp(`^\\s*((async|static|public|private|protected|export|default|override|readonly)\\s+)*\\*?${name}\\s*[(=:<]`);

    const candidates: number[] = [];
    lines.forEach((line, i) => {
      if (i >= Math.max(found, 0) && word.test(line)) candidates.push(i);
    });
    if (candidates.length === 0) return null;
    found = candidates.find((i) => declared.test(lines[i]!) || defined.test(lines[i]!)) ?? candidates[0]!;
  }

  return found === -1 ? null : found + 1;
}
