import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Mode } from "../model/block.js";
import { formatWire } from "../model/block.js";
import { describeType } from "../model/types.js";
import type { PortType } from "../model/types.js";
import { executionOrder, wireCarriedType } from "../model/validate.js";
import { loadLayout } from "./layout.js";
import type { Layout } from "./layout.js";
import { loadProject, locateCode, systemOf, validateProject } from "./project.js";
import type { CodeLocation, Granularity, ProjectDiagnostic } from "./project.js";
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
  /** Language pack id, e.g. `typescript`, or in a visual project whatever the code is written in. */
  language: string;
  displayName: string;
  /** False when a structured project asks for a language Fragmentor has no pack for. */
  known: boolean;
}

/** The code a visual block points at, as much of it as the inspector shows. */
export interface SnapshotCode {
  /** As written in block.json, e.g. `src/pricing.ts#priceOrder`. */
  pointer: string;
  /** The file or folder, relative to the project. */
  file: string;
  /** The line the named function or class was found on. */
  line: number | null;
  /** The code from just before that line, or from the top of the file. */
  excerpt: string | null;
  /** The line number the excerpt starts at. */
  excerptStart: number;
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
  /** File names for this block, which differ by language. Empty in a visual project. */
  files: { impl: string; contract: string };
  /**
   * Whether the block's code exists: an implementation that is more than the
   * untouched scaffold, or in a visual project, a pointer that leads to code.
   */
  implemented: boolean;
  /** Tests saved alongside this block. Always empty in a visual project. */
  cases: TestCase[];
  /** Visual projects only: the code this block stands for. */
  code: SnapshotCode | null;
}

export interface ProjectSnapshot {
  dir: string;
  name: string;
  goal: string;
  mode: Mode;
  /** The language the person chose for the whole project, if they did. */
  language: string | null;
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

/** Lines shown from a visual block's code: enough to recognise it, not the whole file. */
const EXCERPT_LINES = 60;

function excerptOf(pointer: string, location: CodeLocation): SnapshotCode {
  if (location.text === null) return { pointer, file: location.file, line: location.line, excerpt: null, excerptStart: 1 };
  const lines = location.text.split("\n");
  const start = Math.max(1, (location.line ?? 1) - 2);
  return {
    pointer,
    file: location.file,
    line: location.line,
    excerpt: lines.slice(start - 1, start - 1 + EXCERPT_LINES).join("\n"),
    excerptStart: start,
  };
}

export async function projectSnapshot(projectDir: string): Promise<ProjectSnapshot> {
  const project = await loadProject(projectDir);
  const { mode } = project.manifest;
  const blocks: Record<string, SnapshotBlock> = {};

  // Problems found reading the files beside the diagram are reported with the
  // diagram's own, rather than a block silently appearing to have no tests or
  // no code.
  const fileProblems: ProjectDiagnostic[] = [];
  const casesFor = async (blockPath: string) => {
    const saved = await readCases(projectDir, blockPath);
    if (saved.problem) fileProblems.push({ severity: "error", blockPath, message: saved.problem });
    return saved.cases;
  };

  for (const [blockPath, node] of project.byPath) {
    const block = node.block;
    const childBlocks = new Map(node.children.map((c) => [c.block.id, c.block]));
    const language = systemOf(project, blockPath)?.language ?? "";

    // Naming and file names are language conventions, so they come from the
    // pack for whichever system this block belongs to. A visual project has
    // no generated code, so it has no pack either.
    const pack = mode === "structured" ? getPack(isKnownLanguage(language) ? language : "typescript") : null;

    const ports = (record: typeof block.inputs): SnapshotPort[] =>
      Object.entries(record).map(([name, port]) => ({
        name,
        type: describeType(port.type),
        typeIr: port.type,
        description: port.description ?? null,
      }));

    let code: SnapshotCode | null = null;
    if (mode === "visual" && block.code !== undefined) {
      const found = await locateCode(projectDir, block.code);
      if (found.ok) code = excerptOf(block.code, found.location);
      else fileProblems.push({ severity: "error", blockPath, message: `"${block.name}" points at code that is not there: ${found.problem}` });
    }

    const impl = pack ? await readIfPresent(path.join(node.dir, pack.implFile)) : null;

    blocks[blockPath] = {
      path: blockPath,
      id: block.id,
      name: block.name,
      responsibility: block.responsibility,
      kind: block.kind,
      functionName: pack?.functionName(block.id) ?? "",
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
        functionName: pack?.functionName(child.block) ?? "",
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
        impl,
        contract: pack ? await readIfPresent(path.join(node.dir, pack.contractFile)) : null,
      },
      language,
      files: { impl: pack?.implFile ?? "", contract: pack?.contractFile ?? "" },
      implemented: pack ? impl !== null && !pack.isUnimplemented(impl) : code !== null,
      cases: pack ? await casesFor(blockPath) : [],
      code,
    };
  }

  return {
    dir: project.dir,
    name: project.manifest.name,
    goal: project.manifest.goal,
    mode,
    language: project.manifest.language ?? null,
    granularity: project.manifest.granularity,
    systems: project.systems.map((system) => {
      const known = isKnownLanguage(system.language);
      return {
        rootBlock: system.rootBlock,
        language: system.language,
        displayName: mode === "structured" && known ? getPack(system.language).displayName : system.language,
        known: mode === "visual" || known,
      };
    }),
    blocks,
    layout: await loadLayout(projectDir),
    diagnostics: [...validateProject(project), ...fileProblems],
  };
}
