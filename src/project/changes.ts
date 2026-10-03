import type { Address, TraceEvent } from "../model/trace.js";
import type { PortType } from "../model/types.js";
import { typesEqual } from "../model/typesEqual.js";
import type { ProjectSnapshot, SnapshotAccess, SnapshotBlock, SnapshotExecution, SnapshotExposed, SnapshotPort } from "./snapshot.js";

/**
 * What changed in a project between two snapshots of it, in words.
 *
 * The two are compared as Fragmentor reads them, not as files: the order an
 * object's fields are written in, or a part becoming a plan because what holds
 * it did, is not a change, and a block that moved is one block that moved, not
 * one removed and another added. What each field of a snapshot counts for is
 * decided in snapshotFields.ts.
 *
 * A block is its folder, so moves are inferred, and only where the evidence
 * is unambiguous: the block's own path, then its parent's move, then the code
 * it points at, then its id and role, each only where exactly one block on
 * each side has it, and last a system's root, where one went, one came, and
 * most of the parts of the one are found in the other. Anything else is honestly
 * removed plus new. Once blocks
 * are paired, what the older side says about where things are is read as
 * where they went, so a move does not also show as a change to every block
 * reaching the moved one and every execution passing through it.
 *
 * Pure, with only type imports and typesEqual, so the window can load it.
 */

export interface BlockChange {
  /** Where the block is now; for a removed one, where it was. */
  path: string;
  name: string;
  kind: "new" | "removed" | "moved" | "changed";
  /** Planned then, and not now. */
  built: boolean;
  /** Where a moved block was. */
  from?: string;
  /** What shows a moved block is the one that was at `from`: "same code: src/x.ts#f", "same name", or, for a system renamed, "its parts went with it". */
  by?: string;
  /** Each change to it, as a line of its own. */
  lines: string[];
}

export interface ExecutionChange {
  id: string;
  name: string;
  kind: "new" | "removed" | "changed";
  /** What sets it going, in its own words where it has them. */
  trigger: string;
  lines: string[];
}

export interface ProjectChanges {
  /** In order of their paths. A part removed with a removed block is counted on its row, not listed. */
  blocks: BlockChange[];
  /** Where each block found on both sides was, by where it is now. */
  pairs: Record<string, string>;
  executions: ExecutionChange[];
}

const parentOf = (blockPath: string): string | null => (blockPath.includes("/") ? blockPath.slice(0, blockPath.lastIndexOf("/")) : null);

/** "A", "A and B", or "A, B and C". */
function listNames(names: string[]): string {
  return names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

export const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** How changed blocks are grouped, in order, wherever they are listed or counted. */
export const CHANGE_GROUPS: [title: string, test: (change: BlockChange) => boolean][] = [
  ["New", (change) => change.kind === "new"],
  ["Built", (change) => change.built],
  ["Moved", (change) => change.kind === "moved" && !change.built],
  ["Changed", (change) => change.kind === "changed" && !change.built],
  ["Removed", (change) => change.kind === "removed"],
];

/** A value as JSON with its objects' keys sorted, so writing them in another order is not a change. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_, each: unknown) =>
    each !== null && typeof each === "object" && !Array.isArray(each)
      ? Object.fromEntries(Object.entries(each).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : each,
  );
}

const WITH_PARENT = "with its parent";

/**
 * Which block now each block then is, by where it was: the pairing rules in
 * the order the module's comment gives them.
 */
function pairBlocks(then: Record<string, SnapshotBlock>, now: Record<string, SnapshotBlock>): Map<string, { to: string; by: string | null }> {
  const pairs = new Map<string, { to: string; by: string | null }>();
  const taken = new Set<string>();
  const join = (from: string, to: string, by: string | null) => {
    pairs.set(from, { to, by });
    taken.add(to);
  };
  const unpaired = () => Object.keys(then).filter((each) => !pairs.has(each));

  for (const each of Object.keys(then)) if (each in now) join(each, each, null);

  // A folder that moved took its parts with it. Parents first, so a part of a
  // part follows too.
  const carry = () => {
    const depth = (each: string) => each.split("/").length;
    for (const each of unpaired().sort((a, b) => depth(a) - depth(b))) {
      const parent = parentOf(each);
      const moved = parent === null ? undefined : pairs.get(parent);
      if (parent === null || moved === undefined || moved.to === parent) continue;
      const to = `${moved.to}${each.slice(parent.length)}`;
      if (to in now && !taken.has(to)) join(each, to, WITH_PARENT);
    }
  };

  /** Pairs the blocks left whose key is had by exactly one of them on each side. */
  const byKey = (key: (block: SnapshotBlock) => string | null, evidence: (block: SnapshotBlock) => string) => {
    const index = (blocks: Record<string, SnapshotBlock>, paths: string[]) => {
      const found = new Map<string, string[]>();
      for (const each of paths) {
        const k = key(blocks[each]!);
        if (k !== null) found.set(k, [...(found.get(k) ?? []), each]);
      }
      return found;
    };
    const gone = index(then, unpaired());
    const come = index(now, Object.keys(now).filter((each) => !taken.has(each)));
    for (const [k, from] of gone) {
      const to = come.get(k);
      if (from.length === 1 && to?.length === 1) join(from[0]!, to[0]!, evidence(then[from[0]!]!));
    }
    carry();
  };

  // Only a function's code is its own: a component pointing at a folder shares it with every part inside.
  byKey(
    (block) => (block.planned || block.architecture || block.code === null ? null : block.code.pointer),
    (block) => `same code: ${block.code!.pointer}`,
  );
  byKey(
    (block) => `${block.id} ${block.role}`,
    () => "same name",
  );

  // A system renamed has nothing of its own to know it by: it is the one
  // system gone and the one come, when most of its parts are found in the new
  // one. One part kept, such as a database, by a system started afresh beside
  // it does not make the new system the old one renamed.
  const goneRoot = unpaired().filter((each) => parentOf(each) === null);
  const newRoot = Object.keys(now).filter((each) => parentOf(each) === null && !taken.has(each));
  if (goneRoot.length === 1 && newRoot.length === 1) {
    const parts = Object.keys(then).filter((each) => parentOf(each) === goneRoot[0]);
    const went = parts.filter((each) => pairs.get(each) !== undefined && parentOf(pairs.get(each)!.to) === newRoot[0]);
    if (went.length * 2 > parts.length) {
      join(goneRoot[0]!, newRoot[0]!, "its parts went with it");
      carry();
    }
  }

  // A part found by its code before its group was found by name still went
  // with its group, and is not a move of its own.
  for (const [from, pair] of pairs) {
    const parent = parentOf(from);
    const went = parent === null ? undefined : pairs.get(parent);
    if (pair.by !== null && parent !== null && went !== undefined && pair.to === `${went.to}${from.slice(parent.length)}`) pair.by = WITH_PARENT;
  }
  return pairs;
}

/** An address as the other side would write it, once the blocks that moved are where they went. */
type MapPath = (blockPath: string) => string;

const addressText = (address: Address | null, map: MapPath) =>
  address === null ? "" : `${map(address.path)}${address.entry === null ? "" : `.${address.entry}`}`;

/** `app/api.send`, with its block's path mapped. Block ids never contain a dot. */
function mapAt(at: string, map: MapPath): string {
  const dot = at.indexOf(".");
  return dot === -1 ? map(at) : `${map(at.slice(0, dot))}${at.slice(dot)}`;
}

/** Whether a block said itself that it is a plan, rather than being inside one. */
function declaredPlanned(blocks: Record<string, SnapshotBlock>, blockPath: string): boolean {
  const parent = parentOf(blockPath);
  return blocks[blockPath]!.planned && !(parent !== null && blocks[parent]?.planned === true);
}

/** Every description of an object field anywhere in a type, by its dotted path. */
function fieldDescriptions(type: PortType, at: string, into = new Map<string, string>()): Map<string, string> {
  if (type.kind === "object") {
    for (const [name, field] of Object.entries(type.fields)) {
      const here = `${at}.${name}`;
      if (field.description !== undefined) into.set(here, field.description);
      fieldDescriptions(field.type, here, into);
    }
  } else if (type.kind === "array") {
    fieldDescriptions(type.of, at, into);
  } else if (type.kind === "union") {
    for (const member of type.of) fieldDescriptions(member, at, into);
  }
  return into;
}

/**
 * Inputs or outputs, by name. A type is compared as a structure, so writing an
 * object's fields in another order changes nothing, and a description changes
 * only the words, so it is never said to change the type.
 */
function portLines(word: string, then: SnapshotPort[], now: SnapshotPort[]): string[] {
  const lines: string[] = [];
  const before = new Map(then.map((port) => [port.name, port]));
  for (const port of now) {
    const old = before.get(port.name);
    if (old === undefined) {
      lines.push(`${word} ${port.name} added: ${port.type}`);
    } else if (!typesEqual(old.typeIr, port.typeIr)) {
      lines.push(`${word} ${port.name} is now ${port.type}, was ${old.type}`);
    } else {
      if (old.description !== port.description) lines.push(`description of ${word} ${port.name} changed`);
      const was = fieldDescriptions(old.typeIr, port.name);
      const is = fieldDescriptions(port.typeIr, port.name);
      for (const field of new Set([...was.keys(), ...is.keys()])) {
        if (was.get(field) !== is.get(field)) lines.push(`description of ${word} ${field} changed`);
      }
    }
  }
  for (const port of then) if (!now.some((each) => each.name === port.name)) lines.push(`${word} ${port.name} removed`);
  return lines;
}

/**
 * What an architecture block offers, by name: a table by its columns, as a set,
 * and anything else by the type as written.
 */
function exposedLines(then: SnapshotExposed[], now: SnapshotExposed[]): string[] {
  const lines: string[] = [];
  const before = new Map(then.map((entry) => [entry.name, entry]));
  for (const entry of now) {
    const old = before.get(entry.name);
    if (old === undefined) {
      lines.push(`now offers ${entry.name}`);
      continue;
    }
    const takes = () => {
      if (old.accepts !== entry.accepts) lines.push(`${entry.name} now takes ${entry.accepts ?? "nothing"}, was ${old.accepts ?? "nothing"}`);
    };
    const gives = () => {
      if (old.returns !== entry.returns) lines.push(`${entry.name} now gives back ${entry.returns ?? "nothing"}, was ${old.returns ?? "nothing"}`);
    };
    if (old.fields.length > 0 && entry.fields.length > 0) {
      // The columns describe what comes back, or what goes in when nothing
      // does. What goes in is compared as written only where it is a shape
      // of its own, as a table's is not.
      const alsoTakes = (each: SnapshotExposed) => (each.returns === null || each.accepts === each.returns ? "" : (each.accepts ?? "nothing"));
      if (alsoTakes(old) !== alsoTakes(entry)) takes();
      // Nor do they say whether anything comes back at all.
      if ((old.returns === null) !== (entry.returns === null)) gives();
      const columns = new Map(old.fields.map((field) => [field.name, field]));
      for (const field of entry.fields) {
        const was = columns.get(field.name);
        if (was === undefined) lines.push(`${entry.name}: field ${field.name} added: ${field.type}${field.optional ? ", optional" : ""}`);
        else if (was.type !== field.type) lines.push(`${entry.name}: field ${field.name} is now ${field.type}, was ${was.type}`);
        else if (was.optional !== field.optional) lines.push(`${entry.name}: field ${field.name} is now ${field.optional ? "optional" : "required"}`);
      }
      for (const field of old.fields) if (!entry.fields.some((each) => each.name === field.name)) lines.push(`${entry.name}: field ${field.name} removed`);
    } else {
      takes();
      gives();
    }
    if (old.block !== entry.block) lines.push(`${entry.name} is now answered by ${entry.block ?? "nothing"}, was ${old.block ?? "nothing"}`);
    if (old.description !== entry.description) lines.push(`description of ${entry.name} changed`);
  }
  for (const entry of then) if (!now.some((each) => each.name === entry.name)) lines.push(`no longer offers ${entry.name}`);
  return lines;
}

/**
 * What a block reaches, by the text it is written in and where that leads.
 * Text reworded to reach the same thing, as when what it reaches moved, is
 * said to be only that.
 */
function accessLines(then: SnapshotAccess[], now: SnapshotAccess[], map: MapPath): string[] {
  const lines: string[] = [];
  const target = (entry: SnapshotAccess) => (entry.resourcePath === null ? null : map(entry.resourcePath));
  const gone = then.filter((entry) => !now.some((each) => each.text === entry.text));
  for (const entry of now) {
    const old = then.find((each) => each.text === entry.text);
    if (old !== undefined) {
      if (target(old) !== entry.resourcePath) lines.push(`access "${entry.text}" now leads to ${entry.resourcePath ?? "nothing"}, was ${target(old) ?? "nothing"}`);
      continue;
    }
    const same = gone.findIndex(
      (each) => entry.resourcePath !== null && target(each) === entry.resourcePath && each.from === entry.from && each.verb === entry.verb && each.entry === entry.entry,
    );
    if (same === -1) {
      lines.push(`access added: ${entry.text}`);
    } else {
      lines.push(`access "${gone[same]!.text}" reworded as "${entry.text}", same target`);
      gone.splice(same, 1);
    }
  }
  for (const entry of gone) lines.push(`access removed: ${entry.text}`);
  return lines;
}

/**
 * The code a block points at and what Fragmentor makes of it. Only asked of a
 * block that is not a plan on either side: a plan's pointer is not followed,
 * so its code is neither there nor gone.
 */
function codeLines(then: SnapshotBlock, block: SnapshotBlock, now: Record<string, SnapshotBlock>, moved: boolean): string[] {
  const lines: string[] = [];
  if (then.implemented !== block.implemented) {
    lines.push(block.implemented ? `its code is there now: ${block.code?.pointer ?? block.files.code}` : `its code is not there any more: ${block.files.code}`);
  }
  if (then.code === null && block.code === null) {
    // Code that is not there on either side is still looked for where the block points.
    if (then.files.code !== block.files.code) lines.push(`now points at ${block.files.code || "nothing"}, was ${then.files.code || "nothing"}`);
  } else if (then.code !== null && block.code !== null) {
    if (then.code.pointer !== block.code.pointer) {
      lines.push(`now points at ${block.code.pointer}, was ${then.code.pointer}`);
    } else if (then.code.hash !== block.code.hash) {
      // A file several blocks point at changes for each of them, whichever one's function it was.
      const file = block.code.file;
      const others = Object.values(now).filter((each) => each.path !== block.path && each.code?.file === file);
      lines.push(`code changed in ${file}${others.length === 0 ? "" : `, which ${listNames(others.map((each) => each.name))} also ${others.length === 1 ? "points" : "point"} at`}`);
    }
  }
  if (then.runnable !== block.runnable) {
    lines.push(block.runnable ? "Fragmentor runs it now" : `Fragmentor no longer runs it${block.drawnBecause === null ? "" : `: ${block.drawnBecause}`}`);
  } else if (then.drawnBecause !== block.drawnBecause && then.implemented && block.implemented) {
    // The reason names the import the code is missing, which is written from
    // where the code is to where the block is, so a block that moved or was
    // pointed elsewhere is given the same reason in other words.
    const reworded = then.drawnBecause !== null && block.drawnBecause !== null && (moved || then.code?.pointer !== block.code?.pointer);
    if (!reworded) lines.push(block.drawnBecause === null ? "no longer only drawn" : `drawn, not run: ${block.drawnBecause}`);
  }
  // Only a block Fragmentor runs has saved tests to speak of.
  if (then.runnable && block.runnable) {
    const before = new Map(then.cases.map((each) => [each.name, each]));
    for (const each of block.cases) {
      const old = before.get(each.name);
      if (old === undefined) lines.push(`test added: "${each.name}"`);
      else if (canonical({ ...old, name: "" }) !== canonical({ ...each, name: "" })) lines.push(`test changed: "${each.name}"`);
    }
    for (const each of then.cases) if (!block.cases.some((other) => other.name === each.name)) lines.push(`test removed: "${each.name}"`);
  }
  return lines;
}

/** Every difference between one block then and now, as lines. */
function blockLines(
  then: ProjectSnapshot["blocks"],
  thenPath: string,
  now: ProjectSnapshot["blocks"],
  nowPath: string,
  map: MapPath,
): string[] {
  const old = then[thenPath]!;
  const block = now[nowPath]!;
  const lines: string[] = [];
  if (old.name !== block.name) lines.push(`renamed "${block.name}", was "${old.name}"`);
  if (old.responsibility !== block.responsibility) lines.push(`responsibility changed: ${block.responsibility}`);
  if (old.role !== block.role || old.subtype !== block.subtype) lines.push(`now ${block.roleLabel}, was ${old.roleLabel}`);
  if (declaredPlanned(now, nowPath) && !old.planned) lines.push("now planned, and nothing of it is built or run");
  lines.push(...portLines("input", old.inputs, block.inputs));
  lines.push(...portLines("output", old.outputs, block.outputs));
  lines.push(...exposedLines(old.exposes, block.exposes));

  const capabilities = new Map(old.capabilities.map((each) => [each.name, each]));
  for (const each of block.capabilities) {
    const was = capabilities.get(each.name);
    if (was === undefined) lines.push(`capability ${each.name} added: ${each.capability}`);
    else if (was.capability !== each.capability) lines.push(`capability ${each.name} is now ${each.capability}, was ${was.capability}`);
    else if (was.description !== each.description) lines.push(`description of capability ${each.name} changed`);
  }
  for (const each of old.capabilities) if (!block.capabilities.some((other) => other.name === each.name)) lines.push(`capability ${each.name} removed`);

  lines.push(...accessLines(old.access, block.access, map));
  if (!old.planned && !block.planned) lines.push(...codeLines(old, block, now, thenPath !== nowPath));
  return lines;
}

/** A step as it is compared: what it does and where, not what it carried or what it is numbered. */
function stepKey(event: TraceEvent, map: MapPath): string {
  if (event.type === "return") return `return|${addressText(event.from, map)}|${addressText(event.to, map)}`;
  if (event.type === "effect") return `effect|${event.kind}|${addressText(event.at, map)}|${event.description ?? ""}|${event.code ?? ""}`;
  return `${event.kind}|${addressText(event.from, map)}|${addressText(event.to, map)}|${event.description ?? ""}|${event.code ?? ""}`;
}

const triggerOf = (execution: SnapshotExecution) => execution.trigger.description ?? `${execution.trigger.kind} at ${execution.trigger.at}`;

function executionLines(then: SnapshotExecution, now: SnapshotExecution, map: MapPath): string[] {
  const lines: string[] = [];
  if (then.name !== now.name) lines.push(`renamed "${now.name}", was "${then.name}"`);
  if (then.description !== now.description) lines.push("description changed");
  if (then.expects !== now.expects) lines.push(now.expects ? "now says what must happen" : "no longer says what must happen");

  const trigger = (execution: SnapshotExecution, at: string) =>
    [execution.trigger.kind, at, execution.trigger.description ?? "", execution.trigger.code ?? ""].join("|");
  if (trigger(then, mapAt(then.trigger.at, map)) !== trigger(now, now.trigger.at)) lines.push(`trigger changed: ${triggerOf(now)}`);

  if (then.declared === null || now.declared === null) {
    if (then.declared !== now.declared) lines.push(now.declared === null ? "no longer has a trace written down" : "now has a trace written down");
    return lines;
  }
  const before = then.declared.events.map((event) => stepKey(event, map));
  const after = now.declared.events.map((event) => stepKey(event, (each) => each));
  const first = after.findIndex((key, i) => key !== before[i]);
  const differs = first !== -1 ? first : before.length !== after.length ? Math.min(before.length, after.length) : -1;
  if (differs !== -1) {
    const counts = before.length === after.length ? plural(after.length, "step") : `${before.length} → ${plural(after.length, "step")}`;
    lines.push(`${counts}, first different at step ${differs + 1}`);
  }
  return lines;
}

/**
 * What changed from `then` to `now`. A `then` of null is before the project
 * existed, so everything in it is new.
 */
export function changesBetween(then: ProjectSnapshot | null, now: ProjectSnapshot): ProjectChanges {
  const was = then?.blocks ?? {};
  const pairs = pairBlocks(was, now.blocks);
  const map: MapPath = (blockPath) => pairs.get(blockPath)?.to ?? blockPath;
  const cameFrom = new Map([...pairs].map(([from, { to, by }]) => [to, { from, by }]));
  // Parts removed from a block that is still there, by where it was.
  const removedFrom = new Map<string, string[]>();
  const blocks: BlockChange[] = [];

  for (const blockPath of Object.keys(was).sort()) {
    if (pairs.has(blockPath)) continue;
    const parent = parentOf(blockPath);
    // A part of a removed block goes with it, and is counted on its row.
    if (parent !== null && parent in was && !pairs.has(parent)) continue;
    if (parent !== null && pairs.has(parent)) removedFrom.set(parent, [...(removedFrom.get(parent) ?? []), was[blockPath]!.name]);
    // Only parts nothing between them and it was kept: one inside a part that
    // moved away has a row of its own, or is counted on the one it moved with.
    const goesWith = (each: string) => {
      for (let at: string = each; at !== blockPath; at = parentOf(at)!) if (pairs.has(at)) return false;
      return true;
    };
    const parts = Object.keys(was).filter((each) => each.startsWith(`${blockPath}/`) && goesWith(each)).length;
    blocks.push({
      path: blockPath,
      name: was[blockPath]!.name,
      kind: "removed",
      built: false,
      lines: parts === 0 ? [] : [`and ${plural(parts, "part")} of it`],
    });
  }

  for (const [blockPath, block] of Object.entries(now.blocks)) {
    const found = cameFrom.get(blockPath);
    if (found === undefined) {
      const lines = declaredPlanned(now.blocks, blockPath) ? ["planned, and nothing of it is built or run yet"] : [];
      blocks.push({ path: blockPath, name: block.name, kind: "new", built: false, lines });
      continue;
    }
    const lines = blockLines(was, found.from, now.blocks, blockPath, map);
    const removed = removedFrom.get(found.from) ?? [];
    if (removed.length > 0) lines.push(`${removed.length === 1 ? "part" : `${removed.length} parts`} removed: ${listNames(removed)}`);
    const built = declaredPlanned(was, found.from) && !block.planned;
    const moved = found.by !== null && found.by !== WITH_PARENT;
    if (!moved && !built && lines.length === 0) continue;
    blocks.push({
      path: blockPath,
      name: block.name,
      kind: moved ? "moved" : "changed",
      built,
      ...(moved ? { from: found.from, by: found.by! } : {}),
      lines,
    });
  }
  blocks.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const executions: ExecutionChange[] = [];
  const before = new Map((then?.executions ?? []).map((execution) => [execution.id, execution]));
  for (const execution of now.executions) {
    const old = before.get(execution.id);
    const lines = old === undefined ? [] : executionLines(old, execution, map);
    if (old === undefined || lines.length > 0) {
      executions.push({ id: execution.id, name: execution.name, kind: old === undefined ? "new" : "changed", trigger: triggerOf(execution), lines });
    }
  }
  for (const execution of then?.executions ?? []) {
    if (!now.executions.some((each) => each.id === execution.id)) {
      executions.push({ id: execution.id, name: execution.name, kind: "removed", trigger: triggerOf(execution), lines: [] });
    }
  }
  executions.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return { blocks, pairs: Object.fromEntries([...pairs].map(([from, { to }]) => [to, from])), executions };
}

/**
 * The changes as plain text, grouped as the window groups them, for the agent
 * or anyone reading them outside the window. `since` finishes "Changes …" and
 * "No changes …": "since the last commit".
 */
export function changesText(changes: ProjectChanges, since: string): string {
  if (changes.blocks.length === 0 && changes.executions.length === 0) return `No changes ${since}.`;
  const out = [`Changes ${since}:`];
  const group = (title: string, rows: { head: string; lines: string[] }[]) => {
    if (rows.length === 0) return;
    out.push("", title);
    for (const row of rows) out.push(`  ${row.head}`, ...row.lines.map((line) => `      ${line}`));
  };
  const rows = (test: (change: BlockChange) => boolean) =>
    changes.blocks.filter(test).map((change) => ({
      head: `${change.from === undefined ? "" : `${change.from} → `}${change.path}  ${change.name}${change.by === undefined ? "" : ` (${change.by})`}`,
      lines: change.lines,
    }));

  for (const [title, test] of CHANGE_GROUPS) group(title, rows(test));
  group(
    "Executions",
    changes.executions.map((change) => ({ head: `${change.id}  ${change.name}: ${change.kind}, set going by ${change.trigger}`, lines: change.lines })),
  );
  return out.join("\n");
}
