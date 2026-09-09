import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
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
 *   <project>/
 *     fragmentor.json
 *     blocks/
 *       rank-jobs/
 *         block.json
 *         impl.ts
 *         score-posting/
 *           block.json
 *           impl.ts
 */

export interface Granularity {
  /**
   * How far the AI decomposes on its own. 1 leaves large blocks alone;
   * 5 breaks work down to small single-purpose pieces. This is the user's
   * tuning knob, exposed as a slider.
   */
  level: 1 | 2 | 3 | 4 | 5;
  /** A hard floor applied regardless of level, so decomposition always terminates. */
  maxDepth: number;
}

export interface Manifest {
  name: string;
  /** What the software being built is supposed to do, in the user's words. */
  goal: string;
  rootBlock: string;
  granularity: Granularity;
}

export const manifestSchema = z
  .object({
    name: z.string().min(1),
    goal: z.string().min(1),
    rootBlock: z.string().regex(blockIdPattern),
    granularity: z
      .object({
        level: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).default(3),
        maxDepth: z.number().int().min(1).max(8).default(4),
      })
      .strict()
      .default({ level: 3, maxDepth: 4 }),
  })
  .strict() as unknown as z.ZodType<Manifest>;

export interface LoadedBlock {
  block: Block;
  /** Slash-joined block ids from the root, e.g. `rank-jobs/score-posting`. */
  path: string;
  /** Absolute path to the block's own folder. */
  dir: string;
  children: LoadedBlock[];
}

export interface Project {
  dir: string;
  manifest: Manifest;
  root: LoadedBlock;
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

/** Where a block's folder lives, given its path from the root. */
export function blockDir(projectDir: string, blockPath: string): string {
  return path.join(blocksRoot(projectDir), ...blockPath.split("/"));
}

export async function loadProject(projectDir: string): Promise<Project> {
  const manifestText = await readFile(path.join(projectDir, MANIFEST_FILE), "utf8");
  const manifest = manifestSchema.parse(JSON.parse(manifestText));

  const root = await loadBlockTree(blockDir(projectDir, manifest.rootBlock), manifest.rootBlock);

  const byPath = new Map<string, LoadedBlock>();
  const index = (node: LoadedBlock) => {
    byPath.set(node.path, node);
    node.children.forEach(index);
  };
  index(root);

  return { dir: projectDir, manifest, root, byPath };
}

async function loadBlockTree(dir: string, blockPath: string): Promise<LoadedBlock> {
  const id = blockPath.split("/").at(-1)!;

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path.join(dir, BLOCK_FILE), "utf8"));
  } catch (cause) {
    throw new Error(`Could not read the block definition at ${path.join(dir, BLOCK_FILE)}`, { cause });
  }

  const parsed = blockSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new Error(`The block definition at ${path.join(dir, BLOCK_FILE)} is not valid:\n${detail}`);
  }

  const block = parsed.data;
  if (block.id !== id) {
    throw new Error(
      `The block in folder "${id}" calls itself "${block.id}". A block's id must match its folder name.`,
    );
  }

  const entries = await readdir(dir, { withFileTypes: true });
  const childDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();

  const children: LoadedBlock[] = [];
  for (const childId of childDirs) {
    children.push(await loadBlockTree(path.join(dir, childId), `${blockPath}/${childId}`));
  }

  return { block, path: blockPath, dir, children };
}

/**
 * Checks every composite in the project against its children, and checks that
 * the folders on disk agree with what the diagram claims.
 */
export function validateProject(project: Project): ProjectDiagnostic[] {
  const diagnostics: ProjectDiagnostic[] = [];

  for (const node of project.byPath.values()) {
    const onDisk = new Map(node.children.map((c) => [c.block.id, c.block]));

    for (const diagnostic of validateComposite(node.block, onDisk)) {
      diagnostics.push({ ...diagnostic, blockPath: node.path });
    }

    const declared = new Set(node.block.children.map((c) => c.block));
    for (const child of node.children) {
      if (!declared.has(child.block.id)) {
        diagnostics.push({
          severity: "error",
          blockPath: node.path,
          message: `There is a folder for "${child.block.id}" inside "${node.block.name}", but the diagram does not list it as a child.`,
        });
      }
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
  await writeFile(path.join(projectDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

/**
 * Records an accepted decomposition: the parent becomes a composite and each
 * child gets its own folder beneath it.
 */
export async function writeDecomposition(
  projectDir: string,
  parentPath: string,
  parent: Block,
  children: Block[],
): Promise<void> {
  await writeBlock(blockDir(projectDir, parentPath), parent);
  for (const child of children) {
    await writeBlock(blockDir(projectDir, `${parentPath}/${child.id}`), child);
  }
}

/** Creates a new project directory containing a single unimplemented root block. */
export async function createProject(
  projectDir: string,
  manifest: Manifest,
  rootBlock: Block,
): Promise<void> {
  await writeManifest(projectDir, manifest);
  await writeBlock(blockDir(projectDir, manifest.rootBlock), rootBlock);
}
