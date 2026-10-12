import type { Role } from "../model/roles.js";
import type { BlockFunctions, NamedFunction } from "./reach.js";
import type { ReachSeen } from "./rules.js";
import type { ProjectSnapshot, SnapshotBlock } from "./snapshot.js";

/**
 * Architecture Analytics: what can be measured about a system from its
 * diagram, its code and what was recorded, said as numbers compared within
 * the system, each with the sentence that says what it is computed from.
 *
 * Three words are kept apart everywhere. A *measurement* is a number with its
 * sentence. A *weak spot* is a finding with evidence, the few worth asking
 * the agent about, with a note it can be handed in; it is never a problem.
 * A *problem* is an error or a warning, and lives in the diagnostics; nothing
 * here ever becomes one. A thing not measured is said to be unmeasured, in the
 * same words everywhere, and is never shown as healthy.
 *
 * Every dependency is counted from the snapshot's one list of who reaches
 * whom, which the rules are checked against too, so a Used by list, a count
 * here and a rule can never disagree. Only exact entries count: a file that
 * had to be counted whole is already a warning elsewhere.
 *
 * Pure, with only type imports, so the window, the exported page and the
 * `fragmentor` command all run this one module and cannot differ.
 */

/* -------------------------------------------------------------------------- */
/* What comes out                                                              */
/* -------------------------------------------------------------------------- */

/** One block's line under a measure: the block, its number, and the words beside it. */
export interface Row {
  path: string;
  name: string;
  value: number;
  /** The number as the row prints it, with its words: `5`, `0.33 (1 of 3 go out)`. */
  text: string;
  /** What produced it, in Reaches' words: `in the code: findEvent`, `on the diagram: reads events`. */
  detail: string | null;
  planned: boolean;
  /** Set only where a validated threshold allows colour. */
  band: "warn" | null;
}

/** One measurement: a number, the one sentence that says what it is computed from, and what produced it. */
export interface Measure {
  id: string;
  label: string;
  /** The headline as words: `5`, `0.33`, `—`, or a whole sentence for a group. */
  text: string;
  value: number | null;
  /** What the number is computed from. Stated once here; every reader prints it, visibly. */
  of: string;
  /** The blocks or entries behind the number, highest first. */
  rows: Row[];
  /** The kind's least, middle and most, over `n` things, for a system's measure. */
  spread: { min: number; median: number; max: number; n: number; kind: string } | null;
  /** This block's place among the system's blocks of its kind, ties sharing a place. */
  rank: { place: number; of: number; kind: string } | null;
  /** Its share of the system's total, where a total means something. */
  share: number | null;
  band: "warn" | null;
  /** The words shown instead of a number when it is not measured, not built yet, or not on this page. */
  unavailable: string | null;
}

export interface Dimension {
  id: string;
  name: string;
  /** By system root: the system's own measures, each with its rows. */
  system: Record<string, Measure[]>;
  /** By block path: that block's own measures. */
  blocks: Record<string, Measure[]>;
}

/** A finding with evidence: the few things worth asking the agent about. Never a problem. */
export interface WeakSpot {
  kind: "cycle" | "complexity" | "hotspot";
  /** One line, without counts or line numbers, so it survives edits: `Parts that use each other in a circle: UI and State`. */
  headline: string;
  /** The block a note about it goes on, or null when no block can hold one. */
  block: string | null;
  blockName: string;
  evidence: string[];
  band: "warn" | null;
}

export interface WeakSpotKind {
  kind: WeakSpot["kind"];
  title: string;
  /** True when this kind was looked for in every system, so "none" is a finding and not an absence. */
  measured: boolean;
  /** Why not, when it was not: the words shown instead of green. */
  reason: string | null;
  spots: WeakSpot[];
}

export interface Analytics {
  weakSpots: WeakSpotKind[];
  dimensions: Dimension[];
  /** By system root: what was not measured there, and why, in the words shown. */
  notMeasured: { system: string; name: string; reasons: string[] }[];
  /** Each system in a line: how much there is to compare. */
  systems: { root: string; name: string; blocks: number; dependencies: number }[];
}

/** What a renderer may add that the snapshot does not hold. Empty until recordings and git history land. */
export interface AnalyticsExtra {
  recordings?: unknown[];
  changes?: Record<string, number> | null;
}

/* -------------------------------------------------------------------------- */
/* The words everything prints                                                 */
/* -------------------------------------------------------------------------- */

/** The one wording for what is not there, printed the same by the window, the page and the command. */
export const NOT_BUILT_YET = "not built yet";

/** The provisional limits for ways through a function (cyclomatic complexity), with the words of Decision 2. */
export const WAYS_LISTED_OVER = 10;
export const WAYS_LIMIT = 15;
export const WAYS_WORDS = {
  over10: "past 10; a published guideline (NIST) allows up to 15 with a reason",
  over15: "past 15, the most that guideline allows",
};

export const WEAK_SPOT_TITLES: Record<WeakSpot["kind"], string> = {
  cycle: "Parts that use each other in a circle",
  complexity: `Functions with more than ${WAYS_LISTED_OVER} ways through`,
  hotspot: "Changes often and is hard to follow",
};

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

/** The deepest block holding all of these, or "" when they are in different systems. */
export function holding(blockPaths: string[]): string {
  const segments = blockPaths.map((each) => each.split("/"));
  const first = segments[0]!;
  const differs = first.findIndex((segment, i) => segments.some((other) => other[i] !== segment));
  return first.slice(0, differs === -1 ? first.length : differs).join("/");
}

/** True when `part` is strictly inside `block`. */
const inside = (block: string, part: string): boolean => part.startsWith(`${block}/`);

const systemOf = (path: string): string => path.split("/")[0]!;

/** The part of `parent` that `path` falls under, or null when `path` is `parent` or outside it. `parent` "" means the systems themselves. */
function partUnder(parent: string, path: string): string | null {
  if (parent === "") return systemOf(path);
  if (!inside(parent, path)) return null;
  return `${parent}/${path.slice(parent.length + 1).split("/")[0]!}`;
}

/** Which blocks are compared with which: a function with functions, a database with stores. */
export function kindOf(role: Role): string {
  switch (role) {
    case "function":
      return "function blocks";
    case "component":
      return "components";
    case "service":
      return "services";
    case "client":
      return "clients";
    case "external":
      return "external services";
    default:
      return "stores";
  }
}

const isStore = (role: Role): boolean => role === "database" || role === "storage" || role === "structure" || role === "queue";

export function ordinal(n: number): string {
  const rest = n % 100;
  const suffix = rest >= 11 && rest <= 13 ? "th" : n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th";
  return `${n}${suffix}`;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** The names of several blocks, each once, joined for a sentence or a headline. */
function names(snapshot: ProjectSnapshot, paths: string[]): string[] {
  return paths.map((each) => snapshot.blocks[each]?.name ?? each);
}

/** A row's words for an entry, as Reaches prints them. */
function entryWords(entry: ReachSeen, snapshot: ProjectSnapshot): string {
  if (entry.on === "code") return `in the code: ${entry.evidence.replace(/ from .*$/, "")}`;
  const target = entry.entry ?? snapshot.blocks[entry.to]?.name ?? entry.to;
  return `on the diagram: ${entry.verb ?? "reaches"} ${target}`;
}

/** Every way a pair reaches, once each, the diagram's ways first, in an order that does not depend on how the entries came. */
function detailOf(entries: ReachSeen[], snapshot: ProjectSnapshot): string {
  const words = [...new Set(entries.map((each) => entryWords(each, snapshot)))];
  const drawn = (text: string) => text.startsWith("on the diagram");
  words.sort((a, b) => (drawn(a) === drawn(b) ? a.localeCompare(b) : drawn(a) ? -1 : 1));
  return words.join("; ");
}

/* -------------------------------------------------------------------------- */
/* Who reaches whom                                                            */
/* -------------------------------------------------------------------------- */

/** The exact entries, as a measurement reads them: never a block reaching itself, its own part or what holds it. */
function direct(snapshot: ProjectSnapshot): ReachSeen[] {
  return (snapshot.reachSeen ?? []).filter(
    (each) => each.exact && each.from !== each.to && !inside(each.from, each.to) && !inside(each.to, each.from),
  );
}

/** The blocks that reach this one, each once, with the words of every way they do. */
export function usersOf(snapshot: ProjectSnapshot, path: string): { path: string; planned: boolean; detail: string }[] {
  const byUser = new Map<string, ReachSeen[]>();
  for (const entry of direct(snapshot)) if (entry.to === path) byUser.set(entry.from, [...(byUser.get(entry.from) ?? []), entry]);
  return [...byUser.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([user, entries]) => ({
      path: user,
      planned: entries.some((each) => each.planned),
      detail: detailOf(entries, snapshot),
    }));
}

/** The blocks this one reaches, each once, with the words of every way it does. */
export function reachesOf(snapshot: ProjectSnapshot, path: string): { path: string; planned: boolean; detail: string }[] {
  const byTarget = new Map<string, ReachSeen[]>();
  for (const entry of direct(snapshot)) if (entry.from === path) byTarget.set(entry.to, [...(byTarget.get(entry.to) ?? []), entry]);
  return [...byTarget.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([target, entries]) => ({
      path: target,
      planned: entries.some((each) => each.planned),
      detail: detailOf(entries, snapshot),
    }));
}

/** Every pair that reaches, once: `from>to`. */
function pairs(entries: ReachSeen[]): Set<string> {
  return new Set(entries.map((each) => `${each.from}>${each.to}`));
}

/**
 * An entry read at the level of one block's parts: the two parts its ends
 * fall under, or null when either end is the block itself or outside it, or
 * both ends fall under the same part.
 */
function lift(entry: ReachSeen, parent: string): [string, string] | null {
  const a = partUnder(parent, entry.from);
  const b = partUnder(parent, entry.to);
  if (a === null || b === null || a === b) return null;
  return [a, b];
}

/** Tarjan's strongly connected components over an adjacency list; only groups of two or more come back. */
function cycles(nodes: string[], edges: Map<string, Set<string>>): string[][] {
  let next = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const found: string[][] = [];
  const visit = (v: string): void => {
    index.set(v, next);
    low.set(v, next);
    next += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of edges.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
    }
    if (low.get(v) === index.get(v)) {
      const group: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        group.push(w);
      } while (w !== v);
      if (group.length > 1) found.push(group.sort());
    }
  };
  for (const node of [...nodes].sort()) if (!index.has(node)) visit(node);
  return found.sort((a, b) => a[0]!.localeCompare(b[0]!));
}

/* -------------------------------------------------------------------------- */
/* The measurements                                                            */
/* -------------------------------------------------------------------------- */

const measure = (fields: Partial<Measure> & Pick<Measure, "id" | "label" | "text" | "of">): Measure => ({
  value: null,
  rows: [],
  spread: null,
  rank: null,
  share: null,
  band: null,
  unavailable: null,
  ...fields,
});

const row = (snapshot: ProjectSnapshot, path: string, value: number, text: string, detail: string | null = null, planned = false): Row => ({
  path,
  name: snapshot.blocks[path]?.name ?? path,
  value,
  text,
  detail,
  planned,
  band: null,
});

/** A block's place among the blocks of its kind in its system, by a value, highest first, ties sharing a place. */
function rankOf(values: Map<string, number>, blocks: SnapshotBlock[], block: SnapshotBlock): Measure["rank"] {
  const kind = kindOf(block.role);
  const peers = blocks.filter((each) => kindOf(each.role) === kind);
  if (peers.length < 2) return null;
  const own = values.get(block.path) ?? 0;
  if (own === 0) return null;
  const above = peers.filter((each) => (values.get(each.path) ?? 0) > own).length;
  return { place: above + 1, of: peers.length, kind };
}

function spreadOf(values: Map<string, number>, blocks: SnapshotBlock[], kind: string): Measure["spread"] {
  const numbers = blocks.map((each) => values.get(each.path) ?? 0);
  if (numbers.length === 0) return null;
  return { min: Math.min(...numbers), median: median(numbers), max: Math.max(...numbers), n: numbers.length, kind };
}

/** The words for an outward share: what 0 and 1 mean, said every time. */
function outwardWords(ca: number, ce: number): { value: number | null; text: string } {
  if (ca + ce === 0) return { value: null, text: "— (no dependencies either way)" };
  const share = round2(ce / (ca + ce));
  const words = ce === 0 ? "everything leans on it" : ca === 0 ? "it leans on everything" : `${ce} of ${ca + ce} go out`;
  return { value: share, text: `${share} (${words})` };
}

interface SystemView {
  root: string;
  name: string;
  blocks: SnapshotBlock[];
  entries: ReachSeen[];
  reachRead: boolean;
}

/**
 * Everything measured, from a snapshot and whatever the renderer can add.
 * The output is the same for the same input whatever order the blocks or
 * entries come in.
 */
export function analyticsOf(snapshot: ProjectSnapshot, extra: AnalyticsExtra = {}): Analytics {
  void extra;
  const all = Object.values(snapshot.blocks).sort((a, b) => a.path.localeCompare(b.path));
  const entries = direct(snapshot);
  const systems: SystemView[] = snapshot.systems.map((system) => ({
    root: system.rootBlock,
    name: snapshot.blocks[system.rootBlock]?.name ?? system.rootBlock,
    blocks: all.filter((each) => systemOf(each.path) === system.rootBlock),
    entries: entries.filter((each) => systemOf(each.from) === system.rootBlock),
    reachRead: system.reachRead,
  }));

  const dimensions: Dimension[] = [
    coupling(snapshot, systems),
    modularity(snapshot, systems),
    cohesion(snapshot, systems),
    complexity(snapshot, systems),
    maintainability(snapshot, systems),
    unbuilt("runtime", "Runtime performance", systems),
    reliability(snapshot, systems),
    scalability(snapshot, systems),
  ];

  const notMeasured = snapshot.systems
    .map((system) => ({
      system: system.rootBlock,
      name: snapshot.blocks[system.rootBlock]?.name ?? system.rootBlock,
      reasons: system.reachNotReadBecause === null ? [] : [system.reachNotReadBecause],
    }))
    .filter((each) => each.reasons.length > 0);

  return {
    weakSpots: [cycleSpots(snapshot, systems), complexitySpots(snapshot, systems), unbuiltKind("hotspot")],
    dimensions,
    notMeasured,
    systems: systems.map((system) => ({
      root: system.root,
      name: system.name,
      blocks: system.blocks.length,
      dependencies: pairs(system.entries).size,
    })),
  };
}

/** A whole dimension that a later phase fills in, saying so in the one wording. */
function unbuilt(id: string, name: string, systems: SystemView[]): Dimension {
  const system: Dimension["system"] = {};
  const blocks: Dimension["blocks"] = {};
  for (const each of systems) {
    system[each.root] = [measure({ id, label: name, text: NOT_BUILT_YET, of: "", unavailable: NOT_BUILT_YET })];
    for (const block of each.blocks) blocks[block.path] = [measure({ id, label: name, text: NOT_BUILT_YET, of: "", unavailable: NOT_BUILT_YET })];
  }
  return { id, name, system, blocks };
}

function unbuiltKind(kind: WeakSpot["kind"]): WeakSpotKind {
  return { kind, title: WEAK_SPOT_TITLES[kind], measured: false, reason: NOT_BUILT_YET, spots: [] };
}

const fromWhere = (reachRead: boolean): string =>
  reachRead ? "the code that was read to reach it, and the access the diagram declares" : "the access the diagram declares only, since its code is not read";

function coupling(snapshot: ProjectSnapshot, systems: SystemView[]): Dimension {
  const system: Dimension["system"] = {};
  const blocks: Dimension["blocks"] = {};
  for (const each of systems) {
    const users = new Map<string, number>();
    const reaches = new Map<string, number>();
    const outward = new Map<string, number | null>();
    for (const block of each.blocks) {
      const ca = usersOf(snapshot, block.path).length;
      const ce = reachesOf(snapshot, block.path).length;
      users.set(block.path, ca);
      reaches.set(block.path, ce);
      outward.set(block.path, outwardWords(ca, ce).value);
    }
    const usedByOf = `Counted from ${fromWhere(each.reachRead)}: each block that reaches this one, once, however many ways it does.`;
    const reachesOfWords = `Counted from ${fromWhere(each.reachRead)}: each block this one reaches, once, its own parts left out.`;
    const outwardOf =
      "Of the dependencies a block has, the share that go out from it: 0 means everything leans on it, 1 means it leans on everything. Martin's instability, a direction with no target value.";

    // The system: who is used the most, who reaches the most, and the dependencies that point the settled way round.
    const top = (values: Map<string, number>) =>
      each.blocks
        .filter((block) => (values.get(block.path) ?? 0) > 0)
        .sort((a, b) => (values.get(b.path) ?? 0) - (values.get(a.path) ?? 0) || a.path.localeCompare(b.path))
        .map((block) => row(snapshot, block.path, values.get(block.path)!, String(values.get(block.path))));
    const usedRows = top(users);
    const reachRows = top(reaches);
    const settled: Row[] = [];
    for (const pair of [...pairs(each.entries)].sort()) {
      const [from, to] = pair.split(">") as [string, string];
      const a = outward.get(from);
      const b = outward.get(to);
      if (a === null || a === undefined || b === null || b === undefined || !(b > a)) continue;
      const fromName = snapshot.blocks[from]?.name ?? from;
      const toName = snapshot.blocks[to]?.name ?? to;
      settled.push(row(snapshot, from, b - a, `${fromName} (outward share ${a}) → ${toName} (outward share ${b})`));
    }
    const shared = sharedEntries(snapshot, each);
    system[each.root] = [
      measure({
        id: "used-by",
        label: "Used by",
        text: usedRows.length === 0 ? "nothing is used by another block" : `most: ${usedRows[0]!.name} (${usedRows[0]!.value})`,
        value: usedRows[0]?.value ?? 0,
        of: usedByOf,
        rows: usedRows,
        spread: spreadOf(users, each.blocks, "blocks"),
      }),
      measure({
        id: "reaches",
        label: "Reaches",
        text: reachRows.length === 0 ? "nothing reaches another block" : `most: ${reachRows[0]!.name} (${reachRows[0]!.value})`,
        value: reachRows[0]?.value ?? 0,
        of: reachesOfWords,
        rows: reachRows,
        spread: spreadOf(reaches, each.blocks, "blocks"),
      }),
      measure({
        id: "settled",
        label: "Pointing at a less settled part",
        text: String(settled.length),
        value: settled.length,
        of: "A dependency from a block whose dependencies mostly come in, to one whose dependencies mostly go out: a part whose dependencies mostly go out is less settled, and leaning on it means moving when it moves. The Stable Dependencies Principle; both outward shares are shown.",
        rows: settled,
      }),
      shared,
    ];

    for (const block of each.blocks) {
      const ca = users.get(block.path)!;
      const ce = reaches.get(block.path)!;
      const out = outwardWords(ca, ce);
      blocks[block.path] = [
        measure({
          id: "used-by",
          label: "Used by",
          text: String(ca),
          value: ca,
          of: usedByOf,
          rows: usersOf(snapshot, block.path).map((user) => row(snapshot, user.path, 1, user.detail, user.detail, user.planned)),
          rank: rankOf(users, each.blocks, block),
        }),
        measure({
          id: "reaches",
          label: "Reaches",
          text: String(ce),
          value: ce,
          of: reachesOfWords,
          rows: reachesOf(snapshot, block.path).map((target) => row(snapshot, target.path, 1, target.detail, target.detail, target.planned)),
          rank: rankOf(reaches, each.blocks, block),
        }),
        measure({ id: "outward", label: "Outward share", text: out.text, value: out.value, of: outwardOf }),
        ...(isStore(block.role) ? [storeEntries(snapshot, each, block)] : []),
      ];
    }
  }
  return { id: "coupling", name: "Coupling", system, blocks };
}

/** How many blocks touch each table or channel, from the diagram's declared access. */
function sharedEntries(snapshot: ProjectSnapshot, system: SystemView): Measure {
  const rows: Row[] = [];
  for (const store of system.blocks.filter((block) => isStore(block.role))) rows.push(...storeEntries(snapshot, system, store).rows);
  rows.sort((a, b) => b.value - a.value || a.text.localeCompare(b.text));
  return measure({
    id: "shared",
    label: "Shared tables and channels",
    text: rows.length === 0 ? "no table or channel is named by a declared access" : `most: ${rows[0]!.text}`,
    value: rows[0]?.value ?? 0,
    of: "Counted from the diagram: the blocks whose declared access names each table or channel, each block once. A caller declares what its parts need, so a block may be counted here for a table only its parts touch.",
    rows,
  });
}

function storeEntries(snapshot: ProjectSnapshot, system: SystemView, store: SnapshotBlock): Measure {
  const byEntry = new Map<string, Map<string, Set<string>>>();
  for (const entry of system.entries) {
    if (entry.on !== "diagram" || entry.to !== store.path || entry.entry === null) continue;
    const verbs = byEntry.get(entry.entry) ?? new Map<string, Set<string>>();
    const blocks = verbs.get(entry.verb ?? "reaches") ?? new Set<string>();
    blocks.add(entry.from);
    verbs.set(entry.verb ?? "reaches", blocks);
    byEntry.set(entry.entry, verbs);
  }
  const rows = [...byEntry.entries()]
    .map(([name, verbs]) => {
      const all = new Set([...verbs.values()].flatMap((each) => [...each]));
      const parts = [...verbs.entries()].sort().map(([verb, blocks]) => `${blocks.size} ${verb}`);
      return row(snapshot, store.path, all.size, `${store.name} · ${name}: ${all.size} ${all.size === 1 ? "block" : "blocks"} (${parts.join(", ")})`, null);
    })
    .sort((a, b) => b.value - a.value || a.text.localeCompare(b.text));
  return measure({
    id: "shared",
    label: "Shared tables and channels",
    text: rows.length === 0 ? "no tables or channels listed" : `most: ${rows[0]!.text}`,
    value: rows[0]?.value ?? 0,
    of: "Counted from the diagram: the blocks whose declared access names each table or channel, each block once.",
    rows,
  });
}

/** Of the dependencies a block's parts are involved in, the share that stay between its parts. */
function modularity(snapshot: ProjectSnapshot, systems: SystemView[]): Dimension {
  const system: Dimension["system"] = {};
  const blocks: Dimension["blocks"] = {};
  const of =
    "Of the dependencies a block's parts are involved in, counted as pairs of blocks, the share that stay between its parts rather than coming in from outside or going out. Only blocks with at least two parts are measured.";
  for (const each of systems) {
    const rows: Row[] = [];
    for (const block of each.blocks) {
      if (block.children.length < 2) continue;
      const between = new Set<string>();
      const into = new Set<string>();
      const out = new Set<string>();
      for (const entry of each.entries) {
        const lifted = lift(entry, block.path);
        if (lifted !== null) {
          between.add(`${lifted[0]}>${lifted[1]}`);
          continue;
        }
        const fromIn = entry.from === block.path || inside(block.path, entry.from);
        const toIn = entry.to === block.path || inside(block.path, entry.to);
        if (!fromIn && toIn) into.add(`${entry.from}>${entry.to}`);
        if (fromIn && !toIn) out.add(`${entry.from}>${entry.to}`);
      }
      const total = between.size + into.size + out.size;
      const share = total === 0 ? null : round2(between.size / total);
      const text = total === 0 ? "— (its parts have no dependencies)" : `${share} (${between.size} between its parts, ${into.size} coming in, ${out.size} going out)`;
      rows.push(row(snapshot, block.path, share ?? 0, text));
      blocks[block.path] = [measure({ id: "kept-inside", label: "Kept inside", text, value: share, of })];
    }
    rows.sort((a, b) => b.value - a.value || a.path.localeCompare(b.path));
    const root = rows.find((each) => each.path === each.path.split("/")[0]);
    system[each.root] = [
      measure({
        id: "kept-inside",
        label: "Kept inside",
        text: rows.length === 0 ? "no block has two or more parts" : root === undefined ? `most: ${rows[0]!.name}, ${rows[0]!.text}` : `${each.name}: ${root.text}`,
        value: root?.value ?? rows[0]?.value ?? null,
        of,
        rows,
      }),
    ];
  }
  return { id: "modularity", name: "Modularity", system, blocks };
}

/** Whether a block's parts form one connected whole or several that share nothing. */
function cohesion(snapshot: ProjectSnapshot, systems: SystemView[]): Dimension {
  const system: Dimension["system"] = {};
  const blocks: Dimension["blocks"] = {};
  const of =
    "Two parts are joined when one reaches the other, or both use the same table or channel; the groups are the parts that are joined, directly or through others. One group means the parts belong together; several mean they share nothing. Adapted from LCOM4 (Hitz and Montazeri, 1995); no limit is published for blocks, so it is a measurement only.";
  for (const each of systems) {
    const rows: Row[] = [];
    for (const block of each.blocks) {
      if (block.children.length < 2) continue;
      const parent = new Map<string, string>(block.children.map((child) => [child, child]));
      const find = (x: string): string => {
        while (parent.get(x) !== x) x = parent.get(x)!;
        return x;
      };
      const union = (a: string, b: string): void => {
        parent.set(find(a), find(b));
      };
      const byEntry = new Map<string, Set<string>>();
      for (const entry of each.entries) {
        const lifted = lift(entry, block.path);
        if (lifted !== null) union(lifted[0], lifted[1]);
        if (entry.on === "diagram" && entry.entry !== null) {
          const under = partUnder(block.path, entry.from);
          if (under === null) continue;
          const key = `${entry.to}.${entry.entry}`;
          byEntry.set(key, new Set([...(byEntry.get(key) ?? []), under]));
        }
      }
      for (const sharers of byEntry.values()) {
        const [first, ...rest] = [...sharers];
        for (const other of rest) union(first!, other);
      }
      const groups = new Map<string, string[]>();
      for (const child of block.children) groups.set(find(child), [...(groups.get(find(child)) ?? []), child]);
      const listed = [...groups.values()]
        .map((members) => names(snapshot, members.sort()).join(" + "))
        .sort((a, b) => a.localeCompare(b));
      const count = listed.length;
      const text = `${block.name}: its ${block.children.length} parts form ${count} ${count === 1 ? "group" : "groups"}: ${listed.join(" · ")}`;
      rows.push(row(snapshot, block.path, count, text, null));
      blocks[block.path] = [measure({ id: "groups", label: "Groups among its parts", text, value: count, of })];
    }
    rows.sort((a, b) => b.value - a.value || a.path.localeCompare(b.path));
    system[each.root] = [
      measure({
        id: "groups",
        label: "Groups among parts",
        text: rows.length === 0 ? "no block has two or more parts" : `most groups: ${rows[0]!.text}`,
        value: rows[0]?.value ?? null,
        of,
        rows,
      }),
    ];
  }
  return { id: "cohesion", name: "Cohesion", system, blocks };
}

/** What Fragmentor can say about trust from the snapshot: what it can run, and what has tests. */
function reliability(snapshot: ProjectSnapshot, systems: SystemView[]): Dimension {
  const system: Dimension["system"] = {};
  const blocks: Dimension["blocks"] = {};
  const heldOf = "Code that imports its contract can be run here with substitutes for what it reaches; code that does not is only drawn. Counted over the blocks that point at code.";
  const testsOf = "Tests saved from runs of a block; only code held to its contract can have them. Counted from the saved tests beside each block.";
  for (const each of systems) {
    const withCode = each.blocks.filter((block) => block.role === "function" && !block.planned);
    const held = withCode.filter((block) => block.runnable);
    const drawn = withCode.filter((block) => !block.runnable);
    const tests = new Map<string, number>(held.map((block) => [block.path, block.cases.length]));
    const untested = held.filter((block) => block.cases.length === 0);
    system[each.root] = [
      measure({
        id: "held",
        label: "Held to a contract",
        text: withCode.length === 0 ? "no function blocks yet" : `${held.length} of ${withCode.length} function ${withCode.length === 1 ? "block" : "blocks"}`,
        value: held.length,
        of: heldOf,
        rows: drawn.map((block) => row(snapshot, block.path, 0, `${block.name}: drawn, ${block.drawnBecause ?? "not held to a contract"}`, block.drawnBecause)),
      }),
      measure({
        id: "tests",
        label: "Saved tests",
        text:
          held.length === 0
            ? "no block is held to a contract, so none can have saved tests"
            : `${[...tests.values()].reduce((sum, n) => sum + n, 0)} over ${held.length} held ${held.length === 1 ? "block" : "blocks"}, ${untested.length} with none`,
        value: [...tests.values()].reduce((sum, n) => sum + n, 0),
        of: testsOf,
        rows: held
          .map((block) => row(snapshot, block.path, block.cases.length, String(block.cases.length)))
          .sort((a, b) => b.value - a.value || a.path.localeCompare(b.path)),
        spread: held.length > 0 ? spreadOf(tests, held, "held blocks") : null,
      }),
      measure({
        id: "failure",
        label: "Failure in use",
        text: "not measured",
        of: "",
        unavailable: "not measured: needs runs of your app in use, or its monitoring",
      }),
    ];
    for (const block of each.blocks) {
      if (block.role !== "function" || block.planned) continue;
      blocks[block.path] = [
        measure({
          id: "held",
          label: "Held to a contract",
          text: block.runnable ? "yes" : `no: ${block.drawnBecause ?? "not held to a contract"}`,
          value: block.runnable ? 1 : 0,
          of: heldOf,
        }),
        measure({
          id: "tests",
          label: "Saved tests",
          text: block.runnable ? String(block.cases.length) : "none can be saved: only code held to a contract runs here",
          value: block.runnable ? block.cases.length : null,
          of: testsOf,
          rank: block.runnable ? rankOf(tests, held, block) : null,
        }),
      ];
    }
  }
  return { id: "reliability", name: "Reliability", system, blocks };
}

/** Statically, who shares a store: blocks that use the same database cannot scale apart from it. */
function scalability(snapshot: ProjectSnapshot, systems: SystemView[]): Dimension {
  const system: Dimension["system"] = {};
  const blocks: Dimension["blocks"] = {};
  const of = "The blocks that use each database, storage or structure, counted as Used by is: blocks that share a store cannot scale apart from it.";
  for (const each of systems) {
    const stores = each.blocks.filter((block) => block.role === "database" || block.role === "storage" || block.role === "structure");
    const rows = stores
      .map((store) => {
        const users = usersOf(snapshot, store.path);
        return row(snapshot, store.path, users.length, `${store.name}: used by ${users.length}`, users.map((user) => `${snapshot.blocks[user.path]?.name ?? user.path} · ${user.detail}${user.planned ? " (planned)" : ""}`).join("\n") || null);
      })
      .sort((a, b) => b.value - a.value || a.path.localeCompare(b.path));
    system[each.root] = [
      measure({
        id: "shares",
        label: "Shares a store",
        text: stores.length === 0 ? "no databases, storage or structures drawn" : `most: ${rows[0]!.text}`,
        value: rows[0]?.value ?? null,
        of,
        rows,
        unavailable: stores.length === 0 ? "no databases, storage or structures drawn" : null,
      }),
      measure({
        id: "load",
        label: "Under load",
        text: "not measurable here",
        of: "",
        unavailable: "not measurable here; needs load or production data",
      }),
    ];
    for (const store of stores) {
      const users = usersOf(snapshot, store.path);
      blocks[store.path] = [
        measure({
          id: "shares",
          label: "Shared by",
          text: `${users.length} ${users.length === 1 ? "block" : "blocks"} that cannot scale apart from it`,
          value: users.length,
          of,
          rows: users.map((user) => row(snapshot, user.path, 1, user.detail, user.detail, user.planned)),
        }),
      ];
    }
  }
  return { id: "scalability", name: "Scalability", system, blocks };
}

/* -------------------------------------------------------------------------- */
/* The code's shape                                                            */
/* -------------------------------------------------------------------------- */

const WAYS_OF =
  "Ways through a function: 1 plus each if, ?:, loop, case with a test, catch and short-circuit (&&, ||, ??), a nested function counted on its own. Cyclomatic complexity (McCabe 1976), counted when the code is read for what it reaches. The limit of 10 is a published guideline, not a rule of this project.";
const statementsWord = (n: number): string => `${n} ${n === 1 ? "statement" : "statements"}`;
const SIZE_OF =
  "Statements inside each function, counted when the code is read for what it reaches. A block's are its functions' added up; its share is of every statement in its system's code.";

/** The functions credited to one system's blocks, by block; code under no block goes with the first system. */
function functionsOf(snapshot: ProjectSnapshot, system: SystemView, first: boolean): Map<string, BlockFunctions> {
  const byBlock = new Map<string, BlockFunctions>();
  for (const [owner, credited] of Object.entries(snapshot.functions ?? {})) {
    if (owner === "" ? first : systemOf(owner) === system.root) byBlock.set(owner, credited);
  }
  return byBlock;
}

/** The words beside a function over the listed limit, from Decision 2. */
export function waysWords(paths: number): string {
  return paths > WAYS_LIMIT ? WAYS_WORDS.over15 : WAYS_WORDS.over10;
}

function namedRow(snapshot: ProjectSnapshot, owner: string, fn: NamedFunction): Row {
  return {
    path: owner,
    name: owner === "" ? "under no block" : (snapshot.blocks[owner]?.name ?? owner),
    value: fn.paths,
    text: `${fn.name}: ${fn.paths} ways through — ${waysWords(fn.paths)}`,
    detail: `${fn.file}:${fn.line}`,
    planned: false,
    band: fn.paths > WAYS_LISTED_OVER ? "warn" : null,
  };
}

/** How many ways there are through each function, and which are over the listed limit. */
function complexity(snapshot: ProjectSnapshot, systems: SystemView[]): Dimension {
  const system: Dimension["system"] = {};
  const blocks: Dimension["blocks"] = {};
  systems.forEach((each, index) => {
    const reason = snapshot.systems.find((candidate) => candidate.rootBlock === each.root)?.reachNotReadBecause ?? null;
    const credited = functionsOf(snapshot, each, index === 0);
    const allPaths = [...credited.values()].flatMap((fn) => fn.paths);
    if (reason !== null || allPaths.length === 0) {
      const unavailable = reason !== null ? `not measured: ${reason}` : "no code yet";
      system[each.root] = [measure({ id: "ways", label: "Ways through", text: unavailable, of: "", unavailable })];
      for (const block of each.blocks) if (block.role === "function") blocks[block.path] = [measure({ id: "ways", label: "Ways through its code", text: unavailable, of: "", unavailable })];
      return;
    }
    const named = [...credited.entries()].flatMap(([owner, fn]) => fn.named.map((named) => ({ owner, named })));
    const longest = [...named].sort((a, b) => b.named.paths - a.named.paths || a.named.file.localeCompare(b.named.file) || a.named.line - b.named.line)[0]!;
    const over = named.filter(({ named: fn }) => fn.paths > WAYS_LISTED_OVER).sort((a, b) => b.named.paths - a.named.paths || a.named.file.localeCompare(b.named.file));
    const overLimit = allPaths.filter((paths) => paths > WAYS_LIMIT).length;
    system[each.root] = [
      measure({
        id: "ways",
        label: "Ways through",
        text: `most: ${longest.named.name}, ${longest.named.paths}`,
        value: longest.named.paths,
        of: WAYS_OF,
        spread: { min: Math.min(...allPaths), median: median(allPaths), max: Math.max(...allPaths), n: allPaths.length, kind: "functions in the code" },
      }),
      measure({
        id: "over",
        label: `Over ${WAYS_LISTED_OVER}`,
        text: over.length === 0 ? "none" : `${over.length} (${overLimit} over ${WAYS_LIMIT})`,
        value: over.length,
        of: `Functions with more than ${WAYS_LISTED_OVER} ways through, as the weak spots list them; ${WAYS_LIMIT} is the most NIST's guideline allows, with a reason.`,
        rows: over.map(({ owner, named: fn }) => namedRow(snapshot, owner, fn)),
      }),
    ];
    const most = new Map<string, number>();
    for (const [owner, fn] of credited) if (owner !== "") most.set(owner, fn.paths[fn.paths.length - 1] ?? 0);
    for (const block of each.blocks) {
      const fn = credited.get(block.path);
      if (fn === undefined) {
        if (block.role === "function" && !block.planned) blocks[block.path] = [measure({ id: "ways", label: "Ways through its code", text: "no code read", of: "", unavailable: "no code read" })];
        continue;
      }
      const top = fn.named[0]!;
      const count = fn.paths.length;
      blocks[block.path] = [
        measure({
          id: "ways",
          label: "Ways through its code",
          text: count === 1 ? `${top.paths} (${top.name})` : `most ${top.paths}, in ${top.name} · ${count} functions`,
          value: top.paths,
          of: WAYS_OF,
          rows: fn.named.filter((named) => named.paths > WAYS_LISTED_OVER).map((named) => namedRow(snapshot, block.path, named)),
          rank: rankOf(most, each.blocks, block),
          band: top.paths > WAYS_LISTED_OVER ? "warn" : null,
        }),
      ];
    }
  });
  return { id: "complexity", name: "Complexity", system, blocks };
}

/** How much code there is, where, as facts: statements per function and per block, and code under no block. */
function maintainability(snapshot: ProjectSnapshot, systems: SystemView[]): Dimension {
  const system: Dimension["system"] = {};
  const blocks: Dimension["blocks"] = {};
  const changes = measure({ id: "changes", label: "Changes", text: NOT_BUILT_YET, of: "", unavailable: NOT_BUILT_YET });
  systems.forEach((each, index) => {
    const reason = snapshot.systems.find((candidate) => candidate.rootBlock === each.root)?.reachNotReadBecause ?? null;
    const credited = functionsOf(snapshot, each, index === 0);
    const total = [...credited.values()].reduce((sum, fn) => sum + fn.statements, 0);
    const sizes = [...credited.values()].flatMap((fn) => fn.sizes);
    if (reason !== null || sizes.length === 0) {
      const unavailable = reason !== null ? `not measured: ${reason}` : "no code yet";
      system[each.root] = [measure({ id: "size", label: "Size", text: unavailable, of: "", unavailable }), changes];
      for (const block of each.blocks) if (block.role === "function") blocks[block.path] = [measure({ id: "size", label: "Size", text: unavailable, of: "", unavailable }), changes];
      return;
    }
    const share = (statements: number) => (total === 0 ? 0 : Math.round((100 * statements) / total));
    const named = [...credited.entries()].flatMap(([owner, fn]) => fn.named.map((named) => ({ owner, named })));
    const biggest = [...named].sort((a, b) => b.named.statements - a.named.statements || a.named.file.localeCompare(b.named.file) || a.named.line - b.named.line)[0]!;
    const perBlock = new Map<string, number>();
    for (const [owner, fn] of credited) if (owner !== "") perBlock.set(owner, fn.statements);
    const rows = each.blocks
      .filter((block) => perBlock.has(block.path))
      .map((block) => row(snapshot, block.path, perBlock.get(block.path)!, `${statementsWord(perBlock.get(block.path)!)} (${share(perBlock.get(block.path)!)}%)`))
      .sort((a, b) => b.value - a.value || a.path.localeCompare(b.path));
    const nobodys = credited.get("");
    system[each.root] = [
      measure({
        id: "size",
        label: "Size",
        text: `${statementsWord(total)} in ${sizes.length} ${sizes.length === 1 ? "function" : "functions"} in the code · most: ${biggest.named.name}, ${biggest.named.statements} (${share(biggest.named.statements)}%)`,
        value: total,
        of: SIZE_OF,
        rows,
        spread: { min: Math.min(...sizes), median: median(sizes), max: Math.max(...sizes), n: sizes.length, kind: "functions in the code" },
      }),
      measure({
        id: "unowned",
        label: "Code under no block",
        text: nobodys === undefined ? "none" : `${statementsWord(nobodys.statements)} (${share(nobodys.statements)}%) in ${nobodys.files.join(", ")}`,
        value: nobodys?.statements ?? 0,
        of: "Statements in functions of files that no block's pointer covers and no block's code followed as its own: code the drawing does not account for.",
      }),
      changes,
    ];
    for (const block of each.blocks) {
      const statements = perBlock.get(block.path);
      if (statements === undefined) {
        if (block.role === "function" && !block.planned) blocks[block.path] = [measure({ id: "size", label: "Size", text: "no code read", of: "", unavailable: "no code read" }), changes];
        continue;
      }
      blocks[block.path] = [
        measure({
          id: "size",
          label: "Size",
          text: `${statementsWord(statements)} (${share(statements)}% of ${each.name})`,
          value: statements,
          of: SIZE_OF,
          rank: rankOf(perBlock, each.blocks, block),
          share: total === 0 ? null : round2(statements / total),
        }),
        changes,
      ];
    }
  });
  return { id: "maintainability", name: "Maintainability", system, blocks };
}

/* -------------------------------------------------------------------------- */
/* Weak spots                                                                  */
/* -------------------------------------------------------------------------- */

function cycleSpots(snapshot: ProjectSnapshot, systems: SystemView[]): WeakSpotKind {
  const spots: WeakSpot[] = [];
  const parents = new Set<string>();
  for (const system of systems) for (const block of system.blocks) if (block.children.length >= 2) parents.add(block.path);
  if (systems.length >= 2) parents.add("");
  const entries = systems.flatMap((system) => system.entries);
  for (const parent of [...parents].sort()) {
    const children = parent === "" ? systems.map((system) => system.root) : snapshot.blocks[parent]!.children;
    const edges = new Map<string, Set<string>>();
    const lifted: { pair: [string, string]; entry: ReachSeen }[] = [];
    for (const entry of entries) {
      const pair = lift(entry, parent);
      if (pair === null) continue;
      lifted.push({ pair, entry });
      edges.set(pair[0], new Set([...(edges.get(pair[0]) ?? []), pair[1]]));
    }
    for (const group of cycles(children, edges)) {
      const members = new Set(group);
      const evidence = lifted
        .filter(({ pair }) => members.has(pair[0]) && members.has(pair[1]))
        .map(({ pair, entry }) => {
          const where = entry.on === "code" ? "in the code" : "on the diagram";
          return `${where}: ${snapshot.blocks[pair[0]]?.name ?? pair[0]} → ${snapshot.blocks[pair[1]]?.name ?? pair[1]}, ${entry.evidence}${entry.planned ? " (planned)" : ""}`;
        });
      const held = holding(group);
      const block = held === "" ? group[0]! : held;
      spots.push({
        kind: "cycle",
        headline: `${WEAK_SPOT_TITLES.cycle}: ${names(snapshot, group).join(" and ")}`,
        block,
        blockName: snapshot.blocks[block]?.name ?? block,
        evidence: [...new Set(evidence)].sort(),
        band: null,
      });
    }
  }
  const unread = systems.filter((system) => !system.reachRead);
  return {
    kind: "cycle",
    title: WEAK_SPOT_TITLES.cycle,
    measured: unread.length === 0,
    reason: unread.length === 0 ? null : `only the diagram's arrows were followed in ${unread.map((system) => system.name).join(", ")}`,
    spots,
  };
}

function complexitySpots(snapshot: ProjectSnapshot, systems: SystemView[]): WeakSpotKind {
  const spots: WeakSpot[] = [];
  systems.forEach((each, index) => {
    for (const [owner, fn] of functionsOf(snapshot, each, index === 0)) {
      for (const named of fn.named) {
        if (named.paths <= WAYS_LISTED_OVER) continue;
        spots.push({
          kind: "complexity",
          headline: `${WEAK_SPOT_TITLES.complexity}: ${named.name} in ${named.file}`,
          block: owner === "" ? null : owner,
          blockName: owner === "" ? "no block" : (snapshot.blocks[owner]?.name ?? owner),
          evidence: [`${named.paths} ways through — ${waysWords(named.paths)}`, `${named.file}:${named.line}`],
          band: "warn",
        });
      }
    }
  });
  spots.sort((a, b) => Number(b.evidence[0]!.split(" ")[0]) - Number(a.evidence[0]!.split(" ")[0]) || a.headline.localeCompare(b.headline));
  const unread = systems.filter((system) => !system.reachRead);
  return {
    kind: "complexity",
    title: WEAK_SPOT_TITLES.complexity,
    measured: unread.length === 0,
    reason: unread.length === 0 ? null : unread.map((system) => snapshot.systems.find((candidate) => candidate.rootBlock === system.root)?.reachNotReadBecause ?? "the code is not read").join("; "),
    spots,
  };
}

/* -------------------------------------------------------------------------- */
/* Notes                                                                       */
/* -------------------------------------------------------------------------- */

const NOTE_LINES_SHOWN = 8;

/** The note a flagged weak spot hands the agent. Its first line is the headline, which is how it is recognised again. */
export function weakSpotNote(spot: WeakSpot): string {
  const shown = spot.evidence.slice(0, NOTE_LINES_SHOWN);
  const more = spot.evidence.length - shown.length;
  const lines = [`Weak spot: ${spot.headline}`, ...shown.map((line) => `- ${line}`)];
  if (more > 0) lines.push(`- and ${more} more`);
  if (spot.kind === "complexity") lines.push("The limit is provisional: a published guideline, not a rule of this project.");
  lines.push(
    `Fragmentor found this. Improve it, or reply saying why it should stay. \`fragmentor analytics${spot.block === null ? "" : ` ${spot.block}`}\` shows whether it is still there.`,
  );
  return lines.join("\n");
}

/** Whether a note is the one a weak spot would have been flagged with. */
export function isWeakSpotNote(text: string, spot: WeakSpot): boolean {
  return text.split("\n")[0] === `Weak spot: ${spot.headline}`;
}
