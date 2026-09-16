import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AccessVerb, Mode } from "../model/block.js";
import { formatAccess, formatWire } from "../model/block.js";
import { ROLES, isArchitecture } from "../model/roles.js";
import type { Role } from "../model/roles.js";
import { describeType } from "../model/types.js";
import type { PortType } from "../model/types.js";
import { executionOrder, wireCarriedType } from "../model/validate.js";
import { loadLayout } from "./layout.js";
import type { Layout } from "./layout.js";
import { holdsArchitecture, holdsPlan, loadProject, locateCode, resolveAccess, systemOf, validateProject } from "./project.js";
import type { CodeLocation, Granularity, ProjectDiagnostic, Start } from "./project.js";
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

/**
 * One of the things an architecture block offers, ready to draw: a database
 * table with its columns, a queue channel, a service operation.
 */
export interface SnapshotExposed {
  name: string;
  /** What goes in, as written. Null when nothing does. */
  accepts: string | null;
  /** What comes back, as written. Null when nothing does. */
  returns: string | null;
  description: string | null;
  /**
   * The named parts of the shape, when it has any: a table's columns. Taken
   * from what comes back, or what goes in when nothing does, because a store
   * gives back what it was given and an operation is recognised by its
   * result. Empty when the shape is a plain type or free text.
   */
  fields: { name: string; type: string; optional: boolean }[];
}

/** A block reaching a piece of the architecture, with the resource already found. */
export interface SnapshotAccess {
  /** As written, e.g. `reads app-db.users`. */
  text: string;
  verb: AccessVerb;
  resource: string;
  /** Where the resource is in the project, or null when nothing of that id is in scope. */
  resourcePath: string | null;
  resourceName: string;
  entry: string | null;
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
  /** What kind of thing the block stands for: a function, or a piece of the architecture. */
  role: Role;
  /** Shown on the block: FUNCTION, DATABASE, QUEUE. */
  roleLabel: string;
  /** True for every role but `function`: something the system talks to rather than code. */
  architecture: boolean;
  /** Whether architecture sits at or beneath this block, so no code is generated here. */
  holdsArchitecture: boolean;
  /**
   * Part of the plan rather than of the program: drawn, explained, wired as
   * loosely as the plan is, with nothing generated, checked or run for it.
   */
  planned: boolean;
  /** Whether a planned block sits somewhere beneath this one, so its own code waits. */
  holdsPlan: boolean;
  functionName: string;
  inputs: SnapshotPort[];
  outputs: SnapshotPort[];
  /** Architecture blocks only: the tables, channels or operations it offers. */
  exposes: SnapshotExposed[];
  /** What this block reaches, with each resource already found. */
  access: SnapshotAccess[];
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
  /** Whether the folder already held code when the project was started. */
  existingCode: boolean;
  /** Whether the agent draws the architecture as a plan before building it. */
  start: Start;
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

    /** A shape's named parts, so a table can be drawn as its columns. */
    const fieldsOf = (type: PortType | null) =>
      type?.kind === "object"
        ? Object.entries(type.fields).map(([name, field]) => ({
            name,
            type: describeType(field.type),
            optional: Boolean(field.optional),
          }))
        : [];

    const exposes: SnapshotExposed[] = Object.entries(block.exposes).map(([name, entry]) => ({
      name,
      accepts: entry.accepts === null ? null : describeType(entry.accepts),
      returns: entry.returns === null ? null : describeType(entry.returns),
      description: entry.description ?? null,
      fields: fieldsOf(entry.returns ?? entry.accepts),
    }));

    const accesses: SnapshotAccess[] = block.access.map((entry) => {
      const found = resolveAccess(project, blockPath, entry.resource);
      return {
        text: formatAccess(entry),
        verb: entry.verb,
        resource: entry.resource,
        resourcePath: found?.path ?? null,
        resourceName: found?.block.name ?? entry.resource,
        entry: entry.entry,
      };
    });

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

    // An architecture block has no implementation file to look for, and a
    // stray one in its folder has already been reported by the generator.
    const impl = pack && !isArchitecture(block.role) ? await readIfPresent(path.join(node.dir, pack.implFile)) : null;

    blocks[blockPath] = {
      path: blockPath,
      id: block.id,
      name: block.name,
      responsibility: block.responsibility,
      kind: block.kind,
      role: block.role,
      roleLabel: ROLES[block.role].label,
      architecture: isArchitecture(block.role),
      holdsArchitecture: holdsArchitecture(node),
      planned: block.planned,
      holdsPlan: holdsPlan(node),
      functionName: pack?.functionName(block.id) ?? "",
      inputs: ports(block.inputs),
      outputs: ports(block.outputs),
      exposes,
      access: accesses,
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
      cases: pack && !block.planned && !isArchitecture(block.role) ? await casesFor(blockPath) : [],
      code,
    };
  }

  return {
    dir: project.dir,
    name: project.manifest.name,
    goal: project.manifest.goal,
    mode,
    existingCode: project.manifest.existingCode,
    start: project.manifest.start,
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
