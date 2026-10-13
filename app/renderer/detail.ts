import type { ProjectSnapshot, SnapshotBlock } from "../../src/project/snapshot.js";
import { analyticsOf, ordinal, reachesOf, usersOf } from "../../src/project/analytics.js";
import type { AnalyticsExtra, Measure, RecordingFacts } from "../../src/project/analytics.js";
import { checkRecording } from "../../src/model/recorded.js";
import { ROLES } from "../../src/model/roles.js";
import { accessArrows, revealBlock, treeInView } from "./canvas.js";
import type { AccessArrow } from "./canvas.js";
import { requireSnapshot, ui } from "./state.js";
import { el, section, subsection } from "./dom.js";
import { typeLine } from "./highlight.js";

/**
 * What a block holds, written out.
 *
 * Every block says the same two things in the same two places: its
 * **interface**, meaning whatever the rest of the system uses it through, and
 * what it **reaches**. A function's interface is the values it takes, gives
 * back and needs supplied; a database's is its tables, a queue's its channels,
 * a service's its operations. The heading is the same for all of them and the
 * part inside it carries the word for that kind of thing, so someone who has
 * read one block's panel can predict the next one's.
 *
 * The same sections are read in two places — down the inspector, and in the
 * window a block opens — so they are written once here.
 */

/** `in { … }` and `out { … }`, with the label quiet and the shape coloured. */
function shapeLine(label: string | null, shape: string): HTMLElement {
  const line = el("div", "pshape");
  if (label) line.append(el("span", "pshape-label", label));
  line.append(typeLine(shape));
  return line;
}

/**
 * The ports of one kind, under the word for that kind.
 *
 * `Inputs`, `Outputs` and `Capabilities` are three parts of one interface
 * rather than three sections of the panel, because a caller needs all three to
 * call the thing and none of them means anything without the others.
 */
function portGroup(
  title: string,
  ports: { name: string; type?: string; capability?: string; description: string | null }[],
  isCapability = false,
): HTMLElement {
  const node = subsection(title);
  if (ports.length === 0) {
    node.append(el("p", "bench-note", "None."));
    return node;
  }

  const list = el("div", "ports");
  for (const port of ports) {
    const line = el("div", `port-row${isCapability ? " cap" : ""}`);
    line.append(el("div", "pname", port.name));
    line.append(shapeLine(null, (isCapability ? port.capability : port.type) ?? ""));
    if (port.description) line.append(el("div", "pdesc", port.description));
    list.append(line);
  }
  node.append(list);
  return node;
}

/** Where one of a block's entries leads, when it leads anywhere. */
export interface EntryRoute {
  /** The entry this is about. */
  entry: string;
  /** `Booking API · bookSeats → Book Seats`, as far as it could be followed. */
  route: string;
  /** The block at the end of it, when the end is code. */
  endsAt: string | null;
}

/** One of this block's entries, and where what happens when it is used ends up. */
export interface Leads {
  entry: string;
  /** The way there in words, for the entry's own row. */
  route: string;
  /** Where it ends up. */
  last: SnapshotBlock;
}

/**
 * Where each of this block's entries leads.
 *
 * A button on a client calls an operation on a service; that operation says
 * which block answers it; and that block is code, with a contract and a test
 * bench. The kernel follows those links end to end, as it does to find the
 * code a recording runs, and one route answers two questions here — where
 * does this button go, and can it be pressed — so the row saying where it
 * leads and the button that runs it can never disagree about it.
 */
export function entryLeads(block: SnapshotBlock): Leads[] {
  if (!block.architecture) return [];
  const blocks = requireSnapshot().blocks;

  return block.exposes.flatMap((entry) => {
    const rest = entry.route.slice(1).map((step) => ({ block: blocks[step.path]!, entry: step.entry }));
    const last = rest.at(-1);
    if (!last) return [];

    return [
      {
        entry: entry.name,
        route: rest.map((step) => (step.entry ? `${step.block.name} · ${step.entry}` : step.block.name)).join("  →  "),
        last: last.block,
      },
    ];
  });
}

/** The same routes, as the entries' own rows want them. */
export function routesOf(leads: Leads[]): EntryRoute[] {
  return leads.map(({ entry, route, last }) => ({
    entry,
    route,
    endsAt: last.architecture ? null : last.path,
  }));
}

/**
 * What an architecture block offers: its tables, channels, operations or
 * actions, each with its shape and, where it leads somewhere, the route it
 * sets going.
 *
 * The route belongs on the entry's own row rather than in a list of its own.
 * A section that repeated every entry's name to say where it led was the panel
 * saying the same thing twice, and "when this happens" never said what it was
 * a heading for.
 */
function exposedGroup(block: SnapshotBlock, routes: EntryRoute[] = []): HTMLElement {
  const noun = ROLES[block.role].entryNoun;
  const node = subsection(`${noun.charAt(0).toUpperCase()}${noun.slice(1)}s`);

  if (block.exposes.length === 0) {
    node.append(
      el(
        "p",
        "bench-note",
        block.role === "component"
          ? "None listed. A group of parts offers whatever the parts inside it do."
          : `No ${noun}s listed yet.`,
      ),
    );
    return node;
  }

  const list = el("div", "ports");
  for (const entry of block.exposes) {
    const line = el("div", "port-row");
    line.append(el("div", "pname", entry.name));

    // A store holds one shape, so saying it twice would read as two things.
    if (entry.accepts !== null && entry.accepts === entry.returns) {
      line.append(shapeLine(null, entry.accepts));
    } else {
      if (entry.accepts !== null) line.append(shapeLine("in", entry.accepts));
      if (entry.returns !== null) line.append(shapeLine("out", entry.returns));
    }

    if (entry.description) line.append(el("div", "pdesc", entry.description));

    const leads = routes.find((each) => each.entry === entry.name);
    if (leads) {
      const where = el("div", "proute");
      where.append(el("span", "proute-label", "runs"), el("span", "proute-text", leads.route));
      if (leads.endsAt !== null) {
        const open = el("button", "btn quiet tiny", "Go there");
        open.title = "Show the block where this is answered";
        open.addEventListener("click", () => revealBlock(leads.endsAt!));
        where.append(open);
      }
      line.append(where);
    }

    list.append(line);
  }

  node.append(list);
  return node;
}

/** A row of a block another block reaches, or is reached by, with the ways it does and Show. */
function reachRow(snapshot: ProjectSnapshot, other: { path: string; planned: boolean; detail: string }): HTMLElement {
  const line = el("div", "port-row reach");
  const name = snapshot.blocks[other.path]?.name ?? other.path;
  const where = el("div", "pwhere");
  where.append(el("span", "reach-name", other.planned ? `${name} · planned` : name));
  const open = el("button", "btn quiet tiny", "Show");
  open.type = "button";
  open.addEventListener("click", () => revealBlock(other.path));
  where.append(open);
  line.append(where, el("div", "reach-way", other.detail));
  return line;
}

/** What this block reaches, with each resource named as it was found, and what its code was read to reach. */
export function reachesSection(block: SnapshotBlock, snapshot?: ProjectSnapshot): HTMLElement | null {
  // Reached in the code but not declared: only where the snapshot carries what was read.
  const inCode = snapshot === undefined ? [] : reachesOf(snapshot, block.path).filter((other) => other.detail.includes("in the code:"));
  if (block.access.length === 0 && block.reachNotChecked.length === 0 && inCode.length === 0) return null;

  const node = section("Reaches");
  const list = el("div", "ports");

  for (const access of block.access) {
    const line = el("div", "port-row cap");
    line.append(el("div", "pname", access.verb));

    if (access.resourcePath === null) {
      const missing = el("div", "ptype bad");
      missing.textContent = `${access.resource} — nothing of that name is among its parts, beside it, or above it`;
      line.append(missing);
    } else {
      // The thing reached and the way to it on one line, because the button
      // is about that one resource and nothing else on the row.
      const where = el("div", "pwhere");
      where.append(el("span", "ptype", access.entry === null ? access.resourceName : `${access.resourceName} · ${access.entry}`));
      const open = el("button", "btn quiet tiny", "Show");
      open.addEventListener("click", () => revealBlock(access.resourcePath!));
      where.append(open);
      line.append(where);
    }

    list.append(line);
  }
  // Then what its code was read to reach, its own parts left out: the declared
  // ways are rows of their own above, so these rows say only the code's ways.
  for (const other of inCode) {
    const ways = other.detail.split("; ").filter((way) => way.startsWith("in the code:")).join("; ");
    list.append(reachRow(snapshot!, { ...other, detail: ways }));
  }

  node.append(list);
  // What its code reaches is checked against these, so what could not be
  // followed there is said here, where a missing line would be looked for.
  if (block.reachNotChecked.length > 0) {
    node.append(el("p", "bench-note", `Not checked in the code: ${block.reachNotChecked.join("; ")}.`));
  }
  return node;
}

/** The blocks that reach this one, each once, with the ways they do. Null when nobody does, or the snapshot does not say. */
export function usedBySection(block: SnapshotBlock, snapshot: ProjectSnapshot): HTMLElement | null {
  if ((snapshot.reachSeen ?? []).length === 0) return null;
  const users = usersOf(snapshot, block.path);
  if (users.length === 0) return null;
  const node = section("Used by");
  const list = el("div", "ports");
  for (const user of users) list.append(reachRow(snapshot, user));
  node.append(list);
  return node;
}

/** One measure as the panel shows it: the number with its words, then the sentence saying what it is computed from. */
function measureRows(measure: Measure): HTMLElement {
  const line = el("div", `port-row measure${measure.band === "warn" ? " warn" : ""}`);
  const head = el("div", "pwhere");
  head.append(el("span", "measure-label", measure.label));
  if (measure.unavailable !== null) {
    head.append(el("span", "measure-value measure-none", measure.unavailable));
    line.append(head);
    return line;
  }
  const rank = measure.rank === null ? "" : ` — ${ordinal(measure.rank.place)} of ${measure.rank.of} ${measure.rank.kind}`;
  head.append(el("span", "measure-value", `${measure.text}${rank}`));
  line.append(head);
  for (const row of measure.rows) if (row.band === "warn") line.append(el("div", "measure-over", row.text));
  if (measure.of !== "") line.append(el("div", "pdesc", measure.of));
  return line;
}

/** The recordings made this session, each held to what was written down the way the execution bar holds it. */
function recordingsForAnalytics(snapshot: ProjectSnapshot): RecordingFacts[] {
  const facts: RecordingFacts[] = [];
  for (const [id, recording] of ui.recordings) {
    const execution = snapshot.executions.find((each) => each.id === id);
    if (!execution) continue;
    let check: RecordingFacts["check"] = null;
    if (execution.declared !== null || execution.expect !== null) {
      const found = checkRecording(execution, recording.trace, recording.scope, recording.complete);
      const notSeen = recording.complete ? found.steps.filter((step) => step.verdict === "not-seen").length : 0;
      check = { agreed: found.expectations.failures.length === 0 && notSeen === 0, notSeen, failures: found.expectations.failures.length };
    }
    facts.push({ execution: id, name: execution.name, trace: recording.trace, complete: recording.complete, truncated: recording.truncated, check });
  }
  return facts;
}

/** What this reader adds to the snapshot's measurements: its recordings in the application, nothing on the exported page. */
export function analyticsExtra(snapshot: ProjectSnapshot): AnalyticsExtra {
  if (document.body.dataset.export !== undefined) return { recordingsUnavailable: "not on this page: recordings are made in Fragmentor itself" };
  return { recordings: recordingsForAnalytics(snapshot) };
}

/**
 * This block's own numbers, each followed by the sentence saying what it is
 * computed from, as the Architecture Analytics window shows them. Null for a
 * page or a past snapshot that carries nothing to measure from.
 */
export function measurementsSection(block: SnapshotBlock, snapshot: ProjectSnapshot): HTMLElement | null {
  if ((snapshot.reachSeen ?? []).length === 0) return null;
  const analytics = analyticsOf(snapshot, analyticsExtra(snapshot));
  const node = section("Measurements");
  let any = false;
  for (const dimension of analytics.dimensions) {
    const own = dimension.blocks[block.path];
    if (own === undefined || own.length === 0) continue;
    const part = subsection(dimension.name);
    const list = el("div", "ports");
    for (const measure of own) list.append(measureRows(measure));
    part.append(list);
    node.append(part);
    any = true;
  }
  if (!any) return null;
  node.append(el("p", "bench-note", "A measurement is a number compared within this system, never a problem. View › Architecture Analytics shows every block's."));
  return node;
}

/**
 * The one section that says what a block can be used through, whatever kind of
 * thing it is. Every block panel has it, so it is the one heading a reader can
 * count on finding in the same place on every block.
 *
 * `routes` is only ever given for a block whose entries lead somewhere, which
 * is the inspector's business rather than the window's.
 */
export function interfaceSection(block: SnapshotBlock, routes: EntryRoute[] = []): HTMLElement {
  const node = section("Interface");

  if (!block.architecture) {
    node.append(portGroup("Inputs", block.inputs));
    node.append(portGroup("Outputs", block.outputs));
    if (block.capabilities.length > 0) node.append(portGroup("Capabilities", block.capabilities, true));
    return node;
  }

  node.append(exposedGroup(block, routes));
  return node;
}

/** Named and coloured the way the block is drawn on the canvas. */
export function roleBadge(block: SnapshotBlock): HTMLElement {
  const badge = el("span", "badge role", block.roleLabel.toLowerCase());
  badge.dataset.role = block.role;
  return badge;
}

/**
 * A block's name and path, and the badges saying what kind of thing it is,
 * what state it is in and what it is written in. `document` is for a page
 * that cannot run anything, where code held to a contract says only that.
 */
export function blockHead(block: SnapshotBlock, options?: { document?: boolean }): { head: HTMLElement; badges: HTMLElement } {
  const head = el("div", "insp-head");
  head.append(el("h2", undefined, block.name), el("div", "insp-id", block.path));

  const badges = el("div", "badges");
  // For a database or a queue, what it is matters more than whether it has
  // blocks inside it, so the role takes the first badge.
  badges.append(roleBadge(block));
  // What state a block is in: whether the code it points at is there, and
  // whether Fragmentor holds that code to a contract or only draws it. A block
  // that names no code at all — a service, a group of parts — says nothing,
  // because "not code" of a service was worse than saying nothing.
  const state = block.planned
    ? "planned"
    : block.code === null
      ? null
      : !block.implemented
        ? "code not found"
        : block.runnable
          ? options?.document
            ? "held to its contract"
            : "checked and runnable"
          : "drawn";
  if (state) badges.append(el("span", `badge state${block.planned ? " planned" : ""}`, state));
  if (block.language) badges.append(el("span", "badge", block.language));
  head.append(badges);
  return { head, badges };
}

/** What a block is for, and what kind of thing it is when it is not code, or not built yet. */
export function blockAbout(block: SnapshotBlock): HTMLElement[] {
  const about: HTMLElement[] = [el("p", "responsibility", block.responsibility)];

  // A block that is not code says what kind of thing it is, under what it
  // does, with the kind in its own colour as the badge above has it. It is a
  // quiet line rather than the dashed box a planned block gets: a database is
  // not a warning about anything, and what Fragmentor does not do with it is
  // already said by the sections it has none of.
  if (block.architecture) {
    const kind = el("p", "role-note");
    const word = el("span", "role-note-kind", `${ROLES[block.role].label}:`);
    word.dataset.role = block.role;
    kind.append(word, document.createTextNode(` ${ROLES[block.role].description}`));
    about.push(kind);
  }

  if (block.planned) {
    about.push(
      el(
        "p",
        "planned-note",
        "Planned: part of the architecture rather than of the program. Its ports say what is meant to flow rather than what does, its wiring can be as loose as the plan is, and Fragmentor generates, checks and runs nothing for it.",
      ),
    );
  }
  return about;
}

/** The project's name, folder, badges and goal, at the top of its panel. */
export function projectHead(snapshot: ProjectSnapshot): HTMLElement[] {
  const head = el("div", "insp-head");
  head.append(el("h2", undefined, snapshot.name));
  // An exported page names no folder.
  if (snapshot.dir !== "") head.append(el("div", "insp-id", snapshot.dir));
  const badges = el("div", "badges");
  badges.append(el("span", "badge", `granularity ${snapshot.granularity.level}`));
  if (snapshot.language) badges.append(el("span", "badge", snapshot.language));
  head.append(badges);
  return snapshot.goal ? [head, el("p", "responsibility", snapshot.goal)] : [head];
}

/** The project's systems, each with its top block and what it is written in. */
export function systemsSection(snapshot: ProjectSnapshot): HTMLElement {
  const systems = section("Systems");
  const list = el("div", "ports");
  for (const system of snapshot.systems) {
    const root = snapshot.blocks[system.rootBlock];
    const row = el("div", "port-row");
    row.append(el("div", "pname", root?.name ?? system.rootBlock));
    row.append(el("div", "ptype", system.known ? system.displayName : `${system.language} — no language pack`));
    if (root) row.append(el("div", "pdesc", root.responsibility));
    list.append(row);
  }
  systems.append(list);
  return systems;
}

/** One dependency arrow picked out on the tree. */
export function accessPanel(panel: HTMLElement, arrow: AccessArrow): void {
  const snapshot = requireSnapshot();
  const source = snapshot.blocks[arrow.source];
  const target = snapshot.blocks[arrow.target];

  const head = el("div", "insp-head");
  head.append(el("h2", undefined, `${source?.name ?? arrow.source} and ${target?.name ?? arrow.target}`));
  head.append(el("div", "insp-id", "dependency"));
  panel.append(head);

  panel.append(
    el(
      "p",
      "responsibility",
      "Something this block is able to reach. It says nothing about what happens, or when: that is what an execution shows.",
    ),
  );

  // The same two headings a block's own panel uses: what this reaches, and the
  // interface it reaches it through.
  const reaches = section("Reaches");
  const list = el("div", "ports");
  for (const access of arrow.entries) {
    const row = el("div", "port-row cap");
    row.append(el("div", "pname", access.verb));
    row.append(el("div", "ptype", access.entry === null ? "the whole thing" : access.entry));
    list.append(row);
  }
  reaches.append(list);
  panel.append(reaches);

  if (target?.architecture) {
    const shape = interfaceSection(target);
    shape.append(el("p", "bench-note", `What ${target.name} offers, whoever reaches it.`));
    panel.append(shape);
  }
}

export function multiPanel(panel: HTMLElement): void {
  const snapshot = requireSnapshot();
  const keys = [...ui.selection];
  const head = el("div", "insp-head");
  head.append(el("h2", undefined, `${keys.length} blocks selected`), el("div", "insp-id", keys.join(", ")));
  panel.append(head);

  const tree = treeInView();
  const between = tree
    ? [...accessArrows(tree).values()].filter((arrow) => ui.selection.has(arrow.source) && ui.selection.has(arrow.target))
    : [];
  if (between.length > 0) {
    const node = section("Reaches");
    const list = el("div", "ports");
    for (const arrow of between) {
      const row = el("div", "port-row");
      row.append(el("div", "pname", `${snapshot.blocks[arrow.source]?.name} → ${snapshot.blocks[arrow.target]?.name}`));
      row.append(el("div", "ptype", arrow.entries.map((entry) => entry.text).join(", ")));
      list.append(row);
    }
    node.append(list);
    panel.append(node);
  }

  panel.append(el("p", "bench-note", "Ctrl-click a block to add or remove it from the selection."));
}
