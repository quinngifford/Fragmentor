import type { ProjectSnapshot, SnapshotAccess, SnapshotBlock, SnapshotCode, SnapshotExecution, SnapshotPort } from "./snapshot.js";

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

const compared: FieldUse = { change: "compared", export: "kept" };
const ignored: FieldUse = { change: "ignored", export: "kept" };
/** Compared, but never on the exported page. */
const comparedPrivate: FieldUse = { change: "compared", export: "dropped" };
const ignoredPrivate: FieldUse = { change: "ignored", export: "dropped" };

export const projectFields: FieldTable<ProjectSnapshot> = {
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
};

export const blockFields: FieldTable<SnapshotBlock> = {
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
  // Follows from its code pointer, or its id.
  functionName: ignored,
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
};

export const codeFields: FieldTable<SnapshotCode> = {
  pointer: compared,
  // The pointer's own file.
  file: ignored,
  // Where it is in the file moves with any edit above it; the hash says whether the file changed.
  line: ignored,
  excerptStart: ignored,
  // Code never leaves unasked, not even as a fingerprint of it.
  excerpt: ignoredPrivate,
  hash: comparedPrivate,
};

export const portFields: FieldTable<SnapshotPort> = {
  name: compared,
  // As written; its structure is compared, so the order of an object's fields is not a change.
  type: ignored,
  // A page that runs nothing needs only the type as written.
  typeIr: comparedPrivate,
  description: compared,
};

export const accessFields: FieldTable<SnapshotAccess> = {
  text: compared,
  // All part of the text.
  from: ignored,
  verb: ignored,
  resource: ignored,
  entry: ignored,
  // What the text leads to, so rewording it to reach the same thing is told apart from reaching something else.
  resourcePath: compared,
  resourceName: ignored,
};

export const executionFields: FieldTable<SnapshotExecution> = {
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
};
