import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v4";
import { blockIdPattern, blockSchema, blockToFileShape } from "../model/block.js";
import type { Block } from "../model/block.js";
import { validateComposite } from "../model/validate.js";
import type { Diagnostic } from "../model/validate.js";

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
  /** The id of the language pack this system's code is written in. */
  language: string;
}

export interface Manifest {
  name: string;
  /** What the software being built is supposed to do, in the user's words. */
  goal: string;
  systems: SystemDeclaration[];
  granularity: Granularity;
}

const systemSchema = z
  .object({
    rootBlock: z.string().regex(blockIdPattern),
    language: z.string().min(1),
  })
  .strict();

export const manifestSchema = z
  .object({
    name: z.string().min(1),
    goal: z.string().min(1),
    systems: z.array(systemSchema).min(1, "a project needs at least one system"),
    granularity: z
      .object({
        level: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).default(3),
        maxDepth: z.number().int().min(1).max(8).default(4),
      })
      .strict()
      .default({ level: 3, maxDepth: 4 }),
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

/** Where a block's folder lives, given its path from the blocks root. */
export function blockDir(projectDir: string, blockPath: string): string {
  return path.join(blocksRoot(projectDir), ...blockPath.split("/"));
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

export async function loadProject(projectDir: string): Promise<Project> {
  const manifestText = await readFile(manifestPath(projectDir), "utf8");
  const raw: unknown = JSON.parse(manifestText);

  if (raw && typeof raw === "object" && "rootBlock" in raw && !("systems" in raw)) {
    throw new Error(
      `The project at ${projectDir} uses the old single-system manifest. Replace "rootBlock" with a "systems" list, for example: "systems": [{ "rootBlock": "${String((raw as { rootBlock: unknown }).rootBlock)}", "language": "typescript" }].`,
    );
  }

  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new Error(`The project file at ${manifestPath(projectDir)} is not valid:\n${detail}`);
  }
  const manifest = parsed.data;

  const systems: LoadedSystem[] = [];
  const byPath = new Map<string, LoadedBlock>();

  const index = (node: LoadedBlock) => {
    byPath.set(node.path, node);
    node.children.forEach(index);
  };

  for (const declaration of manifest.systems) {
    const root = await loadBlockTree(blockDir(projectDir, declaration.rootBlock), declaration.rootBlock);
    systems.push({ rootBlock: declaration.rootBlock, language: declaration.language, root });
    index(root);
  }

  return { dir: projectDir, manifest, systems, byPath };
}

async function loadBlockTree(dir: string, blockPath: string): Promise<LoadedBlock> {
  const id = blockPath.split("/").at(-1)!;

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path.join(dir, BLOCK_FILE), "utf8"));
  } catch (cause) {
    // Say why, because whoever wrote the file needs to know what to fix.
    const reason =
      (cause as NodeJS.ErrnoException).code === "ENOENT"
        ? "the file does not exist"
        : cause instanceof Error
          ? cause.message
          : String(cause);
    throw new Error(`Could not read the block definition at ${path.join(dir, BLOCK_FILE)}: ${reason}.`, { cause });
  }

  const parsed = blockSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new Error(`The block definition at ${path.join(dir, BLOCK_FILE)} is not valid:\n${detail}`);
  }

  const block = parsed.data;
  if (block.id !== id) {
    throw new Error(`The block in folder "${id}" calls itself "${block.id}". A block's id must match its folder name.`);
  }

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
    children.push(await loadBlockTree(childDir, `${blockPath}/${childId}`));
  }

  return { block, path: blockPath, dir, children };
}

/**
 * Checks every composite against its children, and checks that the folders on
 * disk agree with what the diagram claims.
 */
export function validateProject(project: Project): ProjectDiagnostic[] {
  const diagnostics: ProjectDiagnostic[] = [];
  const { maxDepth } = project.manifest.granularity;

  for (const node of project.byPath.values()) {
    const onDisk = new Map(node.children.map((child) => [child.block.id, child.block]));

    for (const diagnostic of validateComposite(node.block, onDisk)) {
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
