import { readFile } from "node:fs/promises";
import path from "node:path";
import { formatWire } from "../model/block.js";
import { describeType } from "../model/types.js";
import type { PortType } from "../model/types.js";
import { executionOrder, wireCarriedType } from "../model/validate.js";
import { loadLayout } from "./layout.js";
import type { Layout } from "./layout.js";
import { loadProject, systemOf, validateProject } from "./project.js";
import type { Granularity, ProjectDiagnostic } from "./project.js";
import { getPack, isKnownLanguage } from "../lang/index.js";
import { readCases } from "../run/cases.js";
import type { TestCase } from "../run/cases.js";

/**
 * Everything the interface needs about a project, in one serialisable value.
 *
 * The canvas never reaches into the kernel: it is handed this, and hands back
 * edits. That keeps the drawing code free of file paths and the kernel free of
 * anything to do with drawing.
 */

export interface SnapshotPort {
  name: string;
  /** The type as written, e.g. `{ title: string }[]`. */
  type: string;
  /** The same type as structure, which the test bench walks to build a form. */
  typeIr: PortType;
  description: string | null;
}

export interface SnapshotCapability {
  name: string;
  capability: string;
  description: string | null;
}

export interface SnapshotChild {
  block: string;
  mode: "once" | "each";
  eachOver: string | null;
  path: string;
  kind: "leaf" | "composite";
  name: string;
  functionName: string;
}

export interface SnapshotWire {
  text: string;
  source: { from: "input"; port: string } | { from: "block"; block: string; port: string };
  target: { to: "output"; port: string } | { to: "block"; block: string; port: string };
  type: string | null;
  isArray: boolean;
}

export interface SnapshotSystem {
  rootBlock: string;
  /** Language pack id, e.g. `typescript`. */
  language: string;
  displayName: string;
  /** False when the project asks for a language Fragmentor has no pack for. */
  known: boolean;
}

export interface SnapshotBlock {
  path: string;
  id: string;
  name: string;
  responsibility: string;
  kind: "leaf" | "composite";
  functionName: string;
  inputs: SnapshotPort[];
  outputs: SnapshotPort[];
  capabilities: SnapshotCapability[];
  children: SnapshotChild[];
  order: string[];
  wires: SnapshotWire[];
  sources: { impl: string | null; contract: string | null };
  /** Which system this block belongs to, and therefore which language. */
  language: string;
  /** File names for this block, which differ by language. */
  files: { impl: string; contract: string };
  /** Whether the implementation is still the untouched scaffold. */
  implemented: boolean;
  /** Tests saved alongside this block. */
  cases: TestCase[];
}

export interface ProjectSnapshot {
  dir: string;
  name: string;
  goal: string;
  granularity: Granularity;
  systems: SnapshotSystem[];
  blocks: Record<string, SnapshotBlock>;
  layout: Layout;
  diagnostics: ProjectDiagnostic[];
}

async function readIfPresent(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

export async function projectSnapshot(projectDir: string): Promise<ProjectSnapshot> {
  const project = await loadProject(projectDir);
  const blocks: Record<string, SnapshotBlock> = {};

  // A tests file that cannot be read is reported with the diagram's problems,
  // rather than the block silently appearing to have no tests.
  const caseProblems: ProjectDiagnostic[] = [];
  const casesFor = async (blockPath: string) => {
    const saved = await readCases(projectDir, blockPath);
    if (saved.problem) caseProblems.push({ severity: "error", blockPath, message: saved.problem });
    return saved.cases;
  };

  for (const [blockPath, node] of project.byPath) {
    const block = node.block;
    const childBlocks = new Map(node.children.map((c) => [c.block.id, c.block]));

    // Naming and file names are language conventions, so they come from the
    // pack for whichever system this block belongs to.
    const language = systemOf(project, blockPath)?.language ?? "typescript";
    const pack = isKnownLanguage(language) ? getPack(language) : getPack("typescript");

    const ports = (record: typeof block.inputs): SnapshotPort[] =>
      Object.entries(record).map(([name, port]) => ({
        name,
        type: describeType(port.type),
        typeIr: port.type,
        description: port.description ?? null,
      }));

    blocks[blockPath] = {
      path: blockPath,
      id: block.id,
      name: block.name,
      responsibility: block.responsibility,
      kind: block.kind,
      functionName: pack.functionName(block.id),
      inputs: ports(block.inputs),
      outputs: ports(block.outputs),
      capabilities: Object.entries(block.capabilities).map(([name, cap]) => ({
        name,
        capability: cap.capability,
        description: cap.description ?? null,
      })),
      children: block.children.map((child) => ({
        block: child.block,
        mode: child.mode,
        eachOver: child.eachOver ?? null,
        path: `${blockPath}/${child.block}`,
        kind: childBlocks.get(child.block)?.kind ?? "leaf",
        name: childBlocks.get(child.block)?.name ?? child.block,
        functionName: pack.functionName(child.block),
      })),
      order: executionOrder(block.children, block.wires),
      wires: block.wires.map((wire) => {
        const carried = wireCarriedType(block, childBlocks, wire);
        return {
          text: formatWire(wire),
          source: wire.source,
          target: wire.target,
          type: carried ? describeType(carried) : null,
          isArray: carried?.kind === "array",
        };
      }),
      sources: {
        impl: await readIfPresent(path.join(node.dir, pack.implFile)),
        contract: await readIfPresent(path.join(node.dir, pack.contractFile)),
      },
      language,
      files: { impl: pack.implFile, contract: pack.contractFile },
      implemented: false,
      cases: await casesFor(blockPath),
    };

    const impl = blocks[blockPath].sources.impl;
    blocks[blockPath].implemented = impl !== null && !pack.isUnimplemented(impl);
  }

  return {
    dir: project.dir,
    name: project.manifest.name,
    goal: project.manifest.goal,
    granularity: project.manifest.granularity,
    systems: project.systems.map((system) => ({
      rootBlock: system.rootBlock,
      language: system.language,
      displayName: isKnownLanguage(system.language) ? getPack(system.language).displayName : system.language,
      known: isKnownLanguage(system.language),
    })),
    blocks,
    layout: await loadLayout(projectDir),
    diagnostics: [...validateProject(project), ...caseProblems],
  };
}
