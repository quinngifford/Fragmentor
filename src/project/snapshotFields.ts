import type { Address, Effect, Interaction, Return, Trace } from "../model/trace.js";
import type { Granularity } from "./project.js";
import type {
  ProjectSnapshot,
  SnapshotAccess,
  SnapshotBlock,
  SnapshotCapability,
  SnapshotCode,
  SnapshotExecution,
  SnapshotExposed,
  SnapshotPort,
  SnapshotSystem,
} from "./snapshot.js";

/**
 * Every field of a snapshot, and what is done with it by whatever reads a
 * whole snapshot besides the window.
 *
 * Two things do: the list of what changed between two snapshots, and the page
 * a project is exported as. Each has to decide about every field: the one
 * whether a difference in it is a change, the other whether it leaves the
 * person's computer. Deciding both here, in tables typed over the snapshot's
 * own types, means a field added to the snapshot does not compile until both
 * are decided, rather than being quietly left out of the changes or quietly
 * shared.
 *
 * `change` is "compared" when a difference in it is a change, or tells which
 * block is which, and "ignored" when it follows from fields that are compared
 * or is not something the project says. `export` is "kept" when the exported
 * page carries it, and "dropped" when it does not: it is private, the page
 * cannot use it, or it is only true of the computer it was read on. What takes
 * a dropped field's place is the export's business.
 *
 * Pure, with only type imports, so the window can load it.
 */

export interface FieldUse {
  change: "compared" | "ignored";
  export: "kept" | "dropped";
}

/** One entry for each field of T, optional ones included, and no other. */
export type FieldTable<T> = { [K in keyof T]-?: FieldUse };

/**
 * The same, for a type inside one of the fields above: what is inside an
 * execution's trace, or a block's exposed entries. These decide only whether
 * each part leaves the computer. The diff reads such parts by hand, where it
 * reads them at all, so a part added to one of these types has to be looked
 * at in changes.ts as well; nothing here makes it.
 */
export type ExportTable<T> = { [K in keyof T]-?: { export: FieldUse["export"] } };

// Each entry keeps its literal type, so the exporter can tell at compile time
// which fields it has to put something in the place of.
const compared = { change: "compared", export: "kept" } as const satisfies FieldUse;
const ignored = { change: "ignored", export: "kept" } as const satisfies FieldUse;
/** Compared, but never on the exported page. */
const comparedPrivate = { change: "compared", export: "dropped" } as const satisfies FieldUse;
const ignoredPrivate = { change: "ignored", export: "dropped" } as const satisfies FieldUse;
const kept = { export: "kept" } as const;
const dropped = { export: "dropped" } as const;

export const projectFields = {
  // Where it is on this computer.
  dir: ignoredPrivate,
  // How the project was set up says nothing about what was built.
  name: ignored,
  goal: ignored,
  existingCode: ignored,
  start: ignored,
  language: ignored,
  granularity: ignored,
  // A system comes and goes with its root block.
  systems: ignored,
  blocks: compared,
  executions: compared,
  // A note is a conversation about the project, not part of it.
  notes: ignoredPrivate,
  // What changed in the rules is `.fragmentor/rules.json`'s own diff, and the
  // exported page carries problems only as a count.
  rules: ignoredPrivate,
  // Problems lead the panels already, compared with nothing.
  diagnostics: ignoredPrivate,
  // What the code reaches is not read at a commit, and the files are the codebase's.
  reachUnpointed: ignoredPrivate,
} satisfies FieldTable<ProjectSnapshot>;

export const blockFields = {
  path: compared,
  // The last part of its path.
  id: ignored,
  name: compared,
  responsibility: compared,
  role: compared,
  subtype: compared,
  // Both follow from its role.
  roleLabel: ignored,
  architecture: ignored,
  planned: compared,
  inputs: compared,
  outputs: compared,
  exposes: compared,
  access: compared,
  capabilities: compared,
  // Follows from its capabilities and access, and a run's stand-ins stay home.
  stores: ignoredPrivate,
  // Blocks are compared one by one, each where it is.
  children: ignored,
  // Its code's hash is compared instead, and code never leaves unasked.
  sources: ignoredPrivate,
  // Its system's.
  language: ignored,
  // What it points at, where its code is not there to say so. Its contract
  // is found from its code.
  files: compared,
  implemented: compared,
  runnable: compared,
  drawnBecause: compared,
  // Saved tests can hold real data.
  cases: comparedPrivate,
  code: compared,
  // Not read at a commit, and it names the codebase's files.
  reachNotChecked: ignoredPrivate,
} satisfies FieldTable<SnapshotBlock>;

export const codeFields = {
  pointer: compared,
  // The pointer's own file.
  file: ignored,
  // Where it is in the file moves with any edit above it; the hash says whether the file changed.
  line: ignored,
  excerptStart: ignored,
  // Code never leaves unasked, not even as a fingerprint of it.
  excerpt: ignoredPrivate,
  hash: comparedPrivate,
} satisfies FieldTable<SnapshotCode>;

export const portFields = {
  name: compared,
  // As written; its structure is compared, so the order of an object's fields is not a change.
  type: ignored,
  // A page that runs nothing needs only the type as written.
  typeIr: comparedPrivate,
  description: compared,
} satisfies FieldTable<SnapshotPort>;

export const accessFields = {
  text: compared,
  // All part of the text.
  from: ignored,
  verb: ignored,
  resource: ignored,
  entry: ignored,
  // What the text leads to, so rewording it to reach the same thing is told apart from reaching something else.
  resourcePath: compared,
  resourceName: ignored,
} satisfies FieldTable<SnapshotAccess>;

export const executionFields = {
  id: compared,
  name: compared,
  description: compared,
  trigger: compared,
  declared: compared,
  expects: compared,
  // Values, like what a step carries, are not what an execution does; and
  // starting rows can hold real data.
  given: ignoredPrivate,
  // Whether it says what must happen is compared as `expects`. What it says
  // is checked by holding a recording to it, not listed as a change, and the
  // rows it wants left behind can hold real data as starting rows can.
  expect: ignoredPrivate,
  // Both follow from its trigger and the diagram, and a page that runs
  // nothing records nothing.
  records: ignoredPrivate,
  unrecordable: ignoredPrivate,
} satisfies FieldTable<SnapshotExecution>;

/* -------------------------------------------------------------------------- */
/* Inside the fields above, for the exported page                             */
/* -------------------------------------------------------------------------- */

// Only whether each part leaves the computer is decided here; ExportTable says why.

export const systemFields = {
  rootBlock: kept,
  language: kept,
  displayName: kept,
  known: kept,
  reachRead: kept,
} satisfies ExportTable<SnapshotSystem>;

export const granularityFields = {
  level: kept,
  maxDepth: kept,
} satisfies ExportTable<Granularity>;

export const exposedFields = {
  name: kept,
  accepts: kept,
  returns: kept,
  block: kept,
  route: kept,
  description: kept,
  fields: kept,
} satisfies ExportTable<SnapshotExposed>;

export const routeStepFields = {
  path: kept,
  entry: kept,
} satisfies ExportTable<SnapshotExposed["route"][number]>;

export const exposedPartFields = {
  name: kept,
  type: kept,
  optional: kept,
} satisfies ExportTable<SnapshotExposed["fields"][number]>;

export const capabilityFields = {
  name: kept,
  capability: kept,
  description: kept,
} satisfies ExportTable<SnapshotCapability>;

export const blockFilesFields = {
  code: kept,
  contract: kept,
} satisfies ExportTable<SnapshotBlock["files"]>;

export const triggerFields = {
  at: kept,
  kind: kept,
  description: kept,
  code: kept,
  // What the agent wrote down as setting it going, as it wrote every step.
  payload: kept,
} satisfies ExportTable<SnapshotExecution["trigger"]>;

export const traceFields = {
  source: kept,
  execution: kept,
  events: kept,
  // What stores held at the end, which only a recording knows, and which is real data.
  state: dropped,
} satisfies ExportTable<Trace>;

export const addressFields = {
  path: kept,
  entry: kept,
} satisfies ExportTable<Address>;

export const interactionFields = {
  type: kept,
  id: kept,
  description: kept,
  code: kept,
  cause: kept,
  from: kept,
  to: kept,
  kind: kept,
  payload: kept,
} satisfies ExportTable<Interaction>;

export const returnFields = {
  type: kept,
  id: kept,
  of: kept,
  from: kept,
  to: kept,
  response: kept,
  error: kept,
} satisfies ExportTable<Return>;

export const effectFields = {
  type: kept,
  id: kept,
  description: kept,
  code: kept,
  cause: kept,
  at: kept,
  kind: kept,
  detail: kept,
} satisfies ExportTable<Effect>;
