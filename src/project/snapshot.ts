import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AccessVerb } from "../model/block.js";
import { formatAccess } from "../model/block.js";
import { isArchitecture, roleLabel } from "../model/roles.js";
import type { Role } from "../model/roles.js";
import { describeType } from "../model/types.js";
import type { PortType } from "../model/types.js";
import { answeringRoute, loadProject, locateCode, resolveAccess, systemOf, validateProject } from "./project.js";
import { packFor, readAllCode } from "./code.js";
import type { BlockCode } from "./code.js";
import { EXECUTIONS_DIR, architectureOf, checkExecution, loadExecutions } from "./executions.js";
import type { TriggerKind } from "./executions.js";
import { formatAddress } from "../model/trace.js";
import type { Trace } from "../model/trace.js";
import type { Expectations } from "../run/expect.js";
import { answeringBlock } from "../run/record.js";
import type { CodeLocation, Granularity, LoadedBlock, Project, ProjectDiagnostic, Start } from "./project.js";
import { getPack, isKnownLanguage } from "../lang/index.js";
import { boundStores, describeBound, storeEntries } from "./stores.js";
import { NOTES_DIR, loadNotes, waitingOn } from "./notes.js";
import { readProjectReach, undeclaredReach } from "./reach.js";
import type { ProjectReach } from "./reach.js";
import { RULES_FILE, evaluateRules, loadRules } from "./rules.js";
import type { SnapshotRule } from "./rules.js";
import type { Note, NoteAuthor } from "./notes.js";
import { readCases, storeKeyProblems } from "../run/cases.js";
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
  /** The child block that answers this operation, by id. Null when none does. */
  block: string | null;
  /**
   * What happens when this entry is used, block by block, starting with the
   * entry itself: an operation leads into the block answering it, and an entry
   * that calls another block's entry leads on to that one. It ends at a
   * function, which is the code that runs, or wherever the diagram stops saying.
   */
  route: { path: string; entry: string | null }[];
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
  /** Which of the reaching block's own entries does it, or null for the block as a whole. */
  from: string | null;
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

/**
 * A capability port that is a way into something drawn on the diagram, with
 * that thing already found.
 *
 * The test bench needs this to offer somewhere to put the rows a run will
 * read: without it a block whose whole job is reading a table could only ever
 * be run against an empty one.
 */
export interface SnapshotStore {
  /** The capability port, as the block's code refers to it. */
  port: string;
  /** `Store` or `Queue`. */
  capability: string;
  /** Written as the port's type: `Store<{ id: string }>`. */
  type: string;
  /** The name a run keeps this store's contents under: `app/orders-db.orders`. */
  target: string;
  /** Where it is in the project, for showing the person what they are filling in. */
  resourcePath: string;
  resourceName: string;
  entry: string;
  /** What one row looks like, written out. Null when the entry is described in words. */
  shape: string | null;
  shapeIr: PortType | null;
  /** Whether rows can be put there before a run, or only watched as the run puts them there. */
  seedable: boolean;
}

export interface SnapshotSystem {
  rootBlock: string;
  /** Language pack id, e.g. `typescript`, or whatever the code is written in. */
  language: string;
  displayName: string;
  /** False when Fragmentor has no language pack for it, so it generates and runs nothing. */
  known: boolean;
  /** Whether what its code reaches is read, so reach the diagram leaves out is found. */
  reachRead: boolean;
}

/** The code a block points at, as much of it as the inspector shows. */
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
  /**
   * A fingerprint of the whole file, line endings aside, so a change anywhere
   * in it is noticed between two snapshots. Null where the file was not read:
   * a folder, or a file too large to show.
   */
  hash: string | null;
}

export interface SnapshotBlock {
  path: string;
  id: string;
  name: string;
  responsibility: string;
  /** What kind of thing the block stands for: a function, or a piece of the architecture. */
  role: Role;
  /** What it is exactly within that role: `Dictionary`, `REST API`. */
  subtype: string | null;
  /** Shown on the block: `DATABASE`, or `DATA STRUCTURE: Dictionary`. */
  roleLabel: string;
  /** True for every role but `function`: something that is not called, so has no code of its own. */
  architecture: boolean;
  /**
   * Part of the plan rather than of the program: drawn and explained, with
   * nothing generated, checked or run for it.
   */
  planned: boolean;
  functionName: string;
  inputs: SnapshotPort[];
  outputs: SnapshotPort[];
  /** Architecture blocks only: the tables, channels or operations it offers. */
  exposes: SnapshotExposed[];
  /** What this block reaches, with each resource already found. */
  access: SnapshotAccess[];
  capabilities: SnapshotCapability[];
  /** The capability ports of this block that are ways into something on the diagram. */
  stores: SnapshotStore[];
  /** The paths of the blocks it is made of, in the order their folders sort. */
  children: string[];
  /**
   * The text of the code Fragmentor holds to a contract, which is the code it
   * offers to edit, and of the contract itself. Null for code it only draws:
   * that is read on demand instead, so the snapshot does not carry a copy of
   * the codebase.
   */
  sources: { code: string | null; contract: string | null };
  /** Which system this block belongs to, and therefore which language. */
  language: string;
  /** Where this block's code and contract are, relative to the project. Empty for neither. */
  files: { code: string; contract: string };
  /**
   * Whether the code this block points at is there. False means either nobody
   * has written it yet or it has moved, which Fragmentor cannot tell apart.
   */
  implemented: boolean;
  /**
   * Whether Fragmentor can run this block: its code is held to its contract,
   * in a language it can run.
   */
  runnable: boolean;
  /**
   * Why Fragmentor draws this block's code rather than checking and running
   * it, or null when it does. Only ever set for a function that is not planned.
   */
  drawnBecause: string | null;
  /** Tests saved alongside this block. Empty for a block Fragmentor cannot run. */
  cases: TestCase[];
  /** The code this block stands for, and where it is. */
  code: SnapshotCode | null;
  /**
   * What this block's code does that could not be followed in reading what it
   * reaches, such as an import made while the program runs. Empty when all of
   * it was, or when it was not read at all.
   */
  reachNotChecked: string[];
}

/**
 * One thing that can set the system going, and what follows from it.
 *
 * A trace is plain data already — addresses and events — so it travels to the
 * window as it is, and the window draws it at whatever resolution is on screen.
 */
export interface SnapshotExecution {
  id: string;
  name: string;
  description: string | null;
  trigger: { at: string; kind: TriggerKind; description?: string; code?: string; payload?: unknown };
  /** The trace an agent wrote down, when there is one. Always `declared`. */
  declared: Trace | null;
  /** Whether it says what must happen, which is what makes it a test. */
  expects: boolean;
  /** What each store holds before it starts, by target and then by key. */
  given: Record<string, Record<string, unknown>>;
  /** What it says must happen, when it says. A recording of it is held to this. */
  expect: Expectations | null;
  /** The function block a recording of it runs: the one answering its trigger. Null when there is none Fragmentor can run. */
  records: string | null;
  /** Why it cannot be recorded, when it cannot. */
  unrecordable: string | null;
}

/** A note, with whose turn it is worked out here rather than again by the window. */
export type SnapshotNote = Note & { waiting: NoteAuthor | null };

export interface ProjectSnapshot {
  dir: string;
  name: string;
  goal: string;
  /** Whether the folder already held code when the project was started. */
  existingCode: boolean;
  /** Whether the agent draws the architecture as a plan before building it. */
  start: Start;
  /** The language the person chose for the whole project, if they did. */
  language: string | null;
  granularity: Granularity;
  systems: SnapshotSystem[];
  blocks: Record<string, SnapshotBlock>;
  executions: SnapshotExecution[];
  /** Every note left on a block, resolved ones too, oldest first. */
  notes: SnapshotNote[];
  /** The person's rules over the architecture, each already held to the diagram and the code. */
  rules: SnapshotRule[];
  diagnostics: ProjectDiagnostic[];
  /** Files whose code reaches something but lies under no block's pointer, so nothing accounts for it. */
  reachUnpointed: string[];
}

async function readIfPresent(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

/** Lines shown from a block's code in the inspector: enough to recognise it, not the whole file. */
const EXCERPT_LINES = 60;

function excerptOf(pointer: string, location: CodeLocation): SnapshotCode {
  if (location.text === null) return { pointer, file: location.file, line: location.line, excerpt: null, excerptStart: 1, hash: null };
  const lines = location.text.split("\n");
  const start = Math.max(1, (location.line ?? 1) - 2);
  return {
    pointer,
    file: location.file,
    line: location.line,
    excerpt: lines.slice(start - 1, start - 1 + EXCERPT_LINES).join("\n"),
    excerptStart: start,
    // The text was read with its line endings made LF, so a checkout that
    // converts them changes nothing here.
    hash: createHash("sha1").update(location.text, "utf8").digest("hex"),
  };
}

/**
 * The project's executions, with what is wrong with them reported beside the
 * diagram's own problems, against the file each came from. A trace naming a
 * block that has since moved is exactly the drift worth being told about.
 */
async function executionsOf(project: Project, code: Map<string, BlockCode>, problems: ProjectDiagnostic[]): Promise<SnapshotExecution[]> {
  let loaded: Awaited<ReturnType<typeof loadExecutions>>;
  try {
    loaded = await loadExecutions(project.dir);
  } catch (error) {
    // A broken project still opens: this is one more thing wrong with it.
    const reason = error instanceof Error ? error.message : String(error);
    problems.push({ severity: "error", blockPath: EXECUTIONS_DIR, message: `The executions could not be read: ${reason}` });
    return [];
  }
  for (const unread of loaded.problems) {
    for (const message of unread.problems) problems.push({ severity: "error", blockPath: unread.file, message });
  }

  const architecture = architectureOf(project);
  // A pointer read once is a pointer read: several steps of one execution
  // usually run the same function.
  const pointers = new Map<string, string | null>();

  const snapshots: SnapshotExecution[] = [];
  for (const execution of loaded.executions) {
    const file = `${EXECUTIONS_DIR}/${execution.id}.json`;
    for (const message of checkExecution(execution, architecture)) {
      problems.push({ severity: "error", blockPath: file, message });
    }

    // Each step says which function makes it, and a pointer that leads
    // nowhere is exactly the drift worth being told about.
    for (const event of execution.declared?.events ?? []) {
      const pointer = event.type === "return" ? undefined : event.code;
      if (pointer === undefined) continue;
      if (!pointers.has(pointer)) {
        const found = await locateCode(project.dir, pointer);
        pointers.set(pointer, found.ok ? null : found.problem);
      }
      const problem = pointers.get(pointer);
      if (problem) problems.push({ severity: "error", blockPath: file, message: `trace step ${event.id}, code: ${problem}` });
    }

    const answering = answeringBlock(project, code, execution.trigger.at);
    // The person reads why in plain words; the technical reason stays with
    // the agent, in `fragmentor test`. The kernel's sentence is kept for
    // every other case, which is already said in words.
    const why = "why" in answering ? answering.why : null;
    const unrecordable =
      why !== null && why.includes("does not import its contract")
        ? why.replace(/, but cannot be recorded: .*$/, ", but its code is not held to its contract yet, so it cannot be recorded.")
        : why;
    snapshots.push({
        id: execution.id,
        name: execution.name,
        description: execution.description,
        trigger: {
          at: formatAddress(execution.trigger.at),
          kind: execution.trigger.kind,
          ...(execution.trigger.description === undefined ? {} : { description: execution.trigger.description }),
          ...(execution.trigger.code === undefined ? {} : { code: execution.trigger.code }),
          ...(execution.trigger.payload === undefined ? {} : { payload: execution.trigger.payload }),
        },
        declared: execution.declared,
        expects: execution.expect !== null,
        given: execution.given,
        expect: execution.expect,
        records: "block" in answering ? answering.block : null,
        unrecordable,
    });
  }
  return snapshots;
}

/**
 * The notes left on the project's blocks. A note that cannot be read, or is
 * on a block that is no longer there, is a warning rather than an error: it
 * says nothing about whether the program is right, and a block that moved is
 * the agent's to point its notes at again.
 */
async function notesOf(project: Project, problems: ProjectDiagnostic[]): Promise<SnapshotNote[]> {
  let loaded: Awaited<ReturnType<typeof loadNotes>>;
  try {
    loaded = await loadNotes(project.dir);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    problems.push({ severity: "warning", blockPath: NOTES_DIR, message: `The notes could not be read: ${reason}` });
    return [];
  }
  for (const unread of loaded.problems) {
    problems.push({ severity: "warning", blockPath: unread.file, message: `This note cannot be read: ${unread.problem}` });
  }
  for (const note of loaded.notes) {
    if (note.status === "open" && !project.byPath.has(note.block)) {
      problems.push({
        severity: "warning",
        blockPath: `${NOTES_DIR}/${note.id}.json`,
        message: `This note is on ${note.block}, which is no longer a block. If the block moved, change "block" in the note to where it went; if it is gone, resolve the note or delete it.`,
      });
    }
  }
  return loaded.notes.map((note) => ({ ...note, waiting: waitingOn(note) }));
}

/**
 * `atCommit` is for the project as it was at a commit, read back into a folder
 * holding only its blocks, its executions and the code they point at. It is
 * where whatever needs the rest of the project's folder is skipped: its notes,
 * which are not part of what it was, and what its code reaches, which needs
 * the files no block points at and the project's tsconfig to be read right.
 */
export async function projectSnapshot(projectDir: string, { atCommit = false }: { atCommit?: boolean } = {}): Promise<ProjectSnapshot> {
  const project = await loadProject(projectDir);
  const code = await readAllCode(project);
  // What the code reaches only ever gives warnings, so a project whose reach
  // could not be read still opens, and says so instead.
  let reach: ProjectReach | null = null;
  let reachProblems: ProjectDiagnostic[] = [];
  if (!atCommit) {
    try {
      reach = await readProjectReach(project, code);
      reachProblems = undeclaredReach(project, reach);
    } catch (error) {
      reach = null;
      reachProblems = project.systems.map((system): ProjectDiagnostic => ({
        severity: "warning",
        blockPath: system.rootBlock,
        message: `What the code reaches could not be read, so reach the diagram leaves out is not found: ${error instanceof Error ? error.message : String(error)}`,
      }));
    }
  }
  const blocks: Record<string, SnapshotBlock> = {};

  // Problems found reading the files beside the diagram are reported with the
  // diagram's own, rather than a block silently appearing to have no tests or
  // no code.
  const fileProblems: ProjectDiagnostic[] = [];
  const entries = storeEntries(project);
  const casesFor = async (blockPath: string, node: LoadedBlock) => {
    const saved = await readCases(projectDir, blockPath);
    if (saved.problem) fileProblems.push({ severity: "error", blockPath, message: saved.problem });
    for (const message of storeKeyProblems(saved.cases, entries, boundStores(project, node))) {
      fileProblems.push({ severity: "error", blockPath, message });
    }
    return saved.cases;
  };

  for (const [blockPath, node] of project.byPath) {
    const block = node.block;
    const language = systemOf(project, blockPath)?.language ?? "";
    const found = code.get(blockPath)!;
    const pack = packFor(project, blockPath);

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
      block: entry.block ?? null,
      route: answeringRoute(project, blockPath, name),
      description: entry.description ?? null,
      fields: fieldsOf(entry.returns ?? entry.accepts),
    }));

    const accesses: SnapshotAccess[] = block.access.map((entry) => {
      const found = resolveAccess(project, blockPath, entry.resource);
      return {
        text: formatAccess(entry),
        from: entry.from,
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

    const where = found.location === null || found.pointer === null ? null : excerptOf(found.pointer, found.location);
    if (found.problem !== null) {
      // Not written yet, or moved and left behind: the same fact either way,
      // and only whoever is working on it knows which.
      fileProblems.push({
        severity: "warning",
        blockPath,
        message: `"${block.name}" points at code that is not there: ${found.problem} Write it, or point the block at where the code went.`,
      });
    }

    blocks[blockPath] = {
      path: blockPath,
      id: block.id,
      name: block.name,
      responsibility: block.responsibility,
      role: block.role,
      subtype: block.subtype ?? null,
      roleLabel: roleLabel(block.role, block.subtype),
      architecture: isArchitecture(block.role),
      planned: block.planned,
      functionName: found.functionName ?? "",
      inputs: ports(block.inputs),
      outputs: ports(block.outputs),
      exposes,
      access: accesses,
      capabilities: Object.entries(block.capabilities).map(([name, cap]) => ({
        name,
        capability: cap.capability,
        description: cap.description ?? null,
      })),
      stores: boundStores(project, node).map((store) => ({
        port: store.port,
        capability: store.capability,
        type: describeBound(store),
        target: store.target,
        resourcePath: store.target.slice(0, store.target.length - store.entry.length - 1),
        resourceName: store.resourceName,
        entry: store.entry,
        shape: store.shape === null ? null : describeType(store.shape),
        shapeIr: store.shape,
        seedable: store.seedable,
      })),
      children: node.children.map((child) => child.path),
      sources: {
        code: found.bound ? (found.location?.text ?? null) : null,
        contract:
          found.contract === null
            ? null
            : await readIfPresent(path.join(projectDir, ...found.contract.split("/"))),
      },
      language,
      files: { code: found.location?.file ?? found.pointer ?? "", contract: found.contract ?? "" },
      implemented: found.location !== null,
      runnable: found.bound && (pack?.canRun ?? false),
      drawnBecause: found.drawnBecause,
      cases: found.bound && (pack?.canRun ?? false) ? await casesFor(blockPath, node) : [],
      code: where,
      reachNotChecked: reach?.notChecked[blockPath] ?? [],
    };
  }

  // Read before the snapshot is put together, because its problems go into the list below.
  const executions = await executionsOf(project, code, fileProblems);
  const notes = atCommit ? [] : await notesOf(project, fileProblems);

  // The person's rules, held to the same reading of reach the warnings above
  // came from. A file that cannot be read is an error, because rules that
  // silently stopped being checked would be worse than none.
  let rules: SnapshotRule[] = [];
  if (!atCommit) {
    const loaded = await loadRules(projectDir);
    if (loaded.problem !== null) {
      fileProblems.push({
        severity: "error",
        blockPath: RULES_FILE,
        message: `This file holds the person's rules, and none of them are checked until it is put right: ${loaded.problem}`,
      });
    }
    const held = evaluateRules(project, reach, loaded.rules);
    rules = held.rules;
    fileProblems.push(...held.diagnostics);
  }

  return {
    dir: project.dir,
    name: project.manifest.name,
    goal: project.manifest.goal,
    existingCode: project.manifest.existingCode,
    start: project.manifest.start,
    language: project.manifest.language ?? null,
    granularity: project.manifest.granularity,
    systems: project.systems.map((system) => {
      const known = isKnownLanguage(system.language);
      return {
        rootBlock: system.rootBlock,
        language: system.language,
        displayName: known ? getPack(system.language).displayName : system.language,
        known,
        reachRead: reach?.systemsRead[system.rootBlock] ?? false,
      };
    }),
    blocks,
    executions,
    notes,
    rules,
    diagnostics: [...validateProject(project), ...fileProblems, ...reachProblems],
    reachUnpointed: reach?.unpointed ?? [],
  };
}
