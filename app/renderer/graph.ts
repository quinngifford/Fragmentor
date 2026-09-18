import type { AccessVerb } from "../../src/model/block.js";
import type {
  SnapshotAccess,
  SnapshotBlock,
  SnapshotCapability,
  SnapshotExposed,
  SnapshotPort,
} from "../../src/project/snapshot.js";
import type { Point } from "../../src/project/layout.js";
import { BLOCK_PALETTE, blockColours, requireSnapshot } from "./state.js";

/**
 * The diagram as drawn: one block's parts, and what they reach.
 *
 * A diagram shows what a block is made of. Nothing on it says what calls
 * what or in what order; a function's inputs and outputs are drawn as what
 * it takes and gives back, not as the ends of anything.
 */

export interface GraphNode {
  key: string;
  label: string;
  sublabel: string;
  boundary: boolean;
  /** A function's contract, where it has one: what it takes and what it gives back. */
  inputs: SnapshotPort[];
  outputs: SnapshotPort[];
  /** Architecture blocks only: the tables, channels or operations drawn inside it. */
  exposes: SnapshotExposed[];
  capabilities: SnapshotCapability[];
  block: SnapshotBlock | null;
}

/**
 * Everything one block reaches in another with the same verb, drawn as a
 * single line.
 *
 * Direction is the most important thing about an access, so lines are grouped
 * per verb rather than per pair of blocks. A database that is read and written
 * gets two lines: one leaving the block that writes it and one arriving at the
 * block that reads it. Merged into one they would say only "these two are
 * connected", which is the least of what is known.
 *
 * Accesses are gathered from a child and from everything inside it, so the
 * diagram above a service shows the databases its handlers use without the
 * service having to repeat them.
 */
export interface AccessLink {
  id: string;
  /** The block that reaches, which is always the one that declared it. */
  source: string;
  /** Which of its own entries does the reaching, or null for the block as a whole. */
  from: string | null;
  /** The block reached. */
  target: string;
  verb: AccessVerb;
  /** Which way the data moves: out of the source, or into it. */
  direction: "out" | "in";
  entries: SnapshotAccess[];
  /** True when nothing here declared it: it came from a block inside. */
  fromWithin: boolean;
  /** Its place among the lines on the same side of the same block, from 0. */
  lane: number;
}

/** Reading takes data out of a resource; writing and calling send it the other way. */
function directionOf(verb: AccessVerb): "out" | "in" {
  return verb === "reads" ? "in" : "out";
}

export interface Graph {
  parent: SnapshotBlock;
  nodes: Map<string, GraphNode>;
  accesses: Map<string, AccessLink>;
}

/** The view showing every system in the project side by side. */
export const PROJECT_VIEW = "";

/**
 * The key of the way into a service on its own diagram. Written so that no
 * block id could ever be it: a block's id is lowercase letters, digits and
 * hyphens, and a block called "input" must not be mistaken for this.
 */
export const WAY_IN = "(way in)";

/**
 * The project drawn as if it were one block whose parts are its systems, so
 * a project with several systems can be seen at once.
 */
function projectAsBlock(): SnapshotBlock {
  const snapshot = requireSnapshot();

  return {
    path: PROJECT_VIEW,
    id: PROJECT_VIEW,
    name: snapshot.name,
    responsibility: snapshot.goal,
    // The project itself is never planned, and nothing reads these of it:
    // it is a frame around the systems, not a block anyone can open.
    planned: false,
    functionName: "",
    inputs: [],
    outputs: [],
    capabilities: [],
    stores: [],
    role: "function" as const,
    subtype: null,
    roleLabel: "",
    architecture: false,
    exposes: [],
    access: [],
    children: snapshot.systems.map((system) => system.rootBlock),
    sources: { impl: null, contract: null },
    language: "",
    files: { impl: "", contract: "" },
    implemented: false,
    cases: [],
    code: null,
  };
}

export function buildGraph(view: string): Graph | null {
  const snapshot = requireSnapshot();
  const parent = view === PROJECT_VIEW ? projectAsBlock() : snapshot.blocks[view];
  if (!parent || parent.children.length === 0) return null;

  const nodes = new Map<string, GraphNode>();
  for (const childPath of parent.children) {
    const block = snapshot.blocks[childPath];
    if (!block) continue;
    const key = childPath.split("/").at(-1)!;
    // A database is drawn as a database, whatever is inside it.
    nodes.set(
      key,
      block.architecture
        ? resourceNode(key, block)
        : {
            key,
            label: block.name,
            sublabel: block.planned ? "PLANNED" : block.roleLabel,
            boundary: false,
            inputs: block.inputs,
            outputs: block.outputs,
            exposes: [],
            capabilities: block.capabilities,
            block,
          },
    );
  }

  const accesses = buildAccesses(parent, nodes);
  addAnsweredOperations(parent, nodes, accesses);
  return { parent, nodes, accesses };
}

/**
 * The access lines this diagram shows, and any resource it has to bring in
 * from above to land them on.
 *
 * A child's own accesses are drawn, and so are those of everything inside it,
 * because the level above a service should show which databases its handlers
 * use without the service repeating them. An access reaching something that
 * lives inside the child itself is left out: it belongs to that child's own
 * diagram, and drawn here it would be a line from a block to itself.
 */
function buildAccesses(parent: SnapshotBlock, nodes: Map<string, GraphNode>): Map<string, AccessLink> {
  const snapshot = requireSnapshot();
  const links = new Map<string, AccessLink>();
  const childPaths = new Map([...nodes.values()].filter((node) => node.block).map((node) => [node.block!.path, node.key]));

  for (const childPath of parent.children) {
    const child = { path: childPath, block: childPath.split("/").at(-1)! };
    const inside = Object.values(snapshot.blocks).filter(
      (block) => block.path === child.path || block.path.startsWith(`${child.path}/`),
    );

    for (const block of inside) {
      for (const access of block.access) {
        const target = access.resourcePath;
        // Nothing, something inside the child (which is that child's own
        // diagram to show), or the block this diagram is of — each of which
        // would be a line from a block to itself.
        if (target === null || target === parent.path || target === child.path || target.startsWith(`${child.path}/`)) {
          continue;
        }

        // Drawn to whichever block on this diagram holds what is reached, so
        // `infrastructure/db` lands on the infrastructure block while it is
        // closed. A store kept further out belongs to the diagram it is on,
        // not this one: the diagrams underneath are left to their own parts.
        const holder = [...childPaths].find(([drawn]) => target === drawn || target.startsWith(`${drawn}/`));
        if (holder === undefined) continue;
        const key = holder[1];

        // Grouped by what does the reaching as well as by what is reached, so
        // two buttons calling two operations are two lines rather than one
        // saying the blocks are connected. That is only an entry of the block
        // on screen when the block itself declared it and is the kind of
        // block that has entries. On a function, or on anything inside the
        // block on screen, it names a capability port, which is how the code
        // gets there rather than a separate line on this diagram.
        const from = block.path === child.path && block.architecture ? access.from : null;
        const id = `${child.block}${from === null ? "" : `.${from}`}=>${key}:${access.verb}`;
        let link = links.get(id);
        if (!link) {
          link = {
            id,
            source: child.block,
            from,
            target: key,
            verb: access.verb,
            direction: directionOf(access.verb),
            entries: [],
            fromWithin: true,
            lane: 0,
          };
          links.set(id, link);
        }
        if (block.path === child.path) link.fromWithin = false;
        if (!link.entries.some((each) => each.text === access.text)) link.entries.push(access);
      }
    }
  }

  // Lines leaving one side of one block are spread apart, or several would
  // land on the same point and read as one.
  const lanes = new Map<string, number>();
  for (const link of links.values()) {
    const side = `${link.source}:${link.direction}:${link.from ?? ""}`;
    link.lane = lanes.get(side) ?? 0;
    lanes.set(side, link.lane + 1);
  }

  return links;
}

/**
 * The way into a service: its operations, and the block each one leads to.
 *
 * Without this a service's diagram is a set of blocks with their inputs
 * arriving from nowhere, because the call that feeds them is the one thing it
 * does not say. The boundary carries the operations the service answers, and
 * a line runs from each to the block that answers it, so a call can be
 * followed from whoever made it to the code that deals with it.
 */
function addAnsweredOperations(
  parent: SnapshotBlock,
  nodes: Map<string, GraphNode>,
  accesses: Map<string, AccessLink>,
): void {
  const answered = parent.exposes.filter((entry) => entry.block !== null && nodes.has(entry.block));
  if (!parent.architecture || answered.length === 0) return;

  nodes.set(WAY_IN, {
    key: WAY_IN,
    label: parent.name,
    sublabel: "ANSWERS",
    boundary: true,
    inputs: [],
    outputs: [],
    exposes: answered,
    capabilities: [],
    block: parent,
  });

  answered.forEach((entry, lane) => {
    const id = `${WAY_IN}=>${entry.block}:${entry.name}`;
    accesses.set(id, {
      id,
      source: WAY_IN,
      from: entry.name,
      target: entry.block!,
      verb: "calls",
      direction: "out",
      entries: [
        {
          text: `answers ${entry.name}`,
          from: entry.name,
          verb: "calls",
          resource: entry.block!,
          resourcePath: null,
          resourceName: entry.name,
          entry: entry.name,
        },
      ],
      fromWithin: false,
      lane,
    });
  });
}

/** A block drawn as the thing it stands for rather than as a function. */
function resourceNode(key: string, block: SnapshotBlock): GraphNode {
  return {
    key,
    label: block.name,
    sublabel: block.planned ? "PLANNED" : block.roleLabel,
    boundary: false,
    inputs: [],
    outputs: [],
    exposes: block.exposes,
    capabilities: [],
    block,
  };
}

/**
 * The colour a block is drawn in when the diagram is coloured block by block.
 *
 * Taken from where the block sits in the diagram, so neighbours are never
 * given neighbouring hues, and so the same block keeps its colour between
 * redraws for as long as the diagram holds the same blocks.
 */
export function blockColour(graph: Graph, view: string, key: string): string {
  const chosen = blockColours.get(view, key);
  if (chosen) return chosen;
  const order = [...graph.nodes.keys()];
  const at = order.indexOf(key);
  return BLOCK_PALETTE[(at < 0 ? 0 : at) % BLOCK_PALETTE.length]!;
}

/* -------------------------------------------------------------------------- */
/* Geometry                                                                    */
/* -------------------------------------------------------------------------- */

export const NODE_W = 208;
export const HEAD_H = 34;
export const ROW_H = 17;
export const GROUP_HEAD_H = 14;
export const GROUP_GAP = 7;
export const BODY_PAD = 9;
/** A column of a table, which is set smaller than a port so a schema fits. */
export const FIELD_H = 13;
const COL_GAP = 92;
const ROW_GAP = 40;

/** Columns shown before a schema is cut short, so a wide table is not a tall block. */
const MOST_FIELDS = 5;

/**
 * What one exposed entry shows underneath its name: a table's columns where
 * it has them, and otherwise the one line that says what it carries. This is
 * the whole reason a database is worth drawing rather than naming.
 */
/**
 * How much of a line fits across a block, in characters.
 *
 * A block is a fixed width and its fields are drawn in a monospaced 9px, so
 * about this much reaches the far edge. A type longer than that has to be cut
 * somewhere, and cutting it here keeps it from being drawn straight across
 * whatever sits to the right of the block. The whole of it is still one hover
 * away, so nothing is lost, only folded.
 */
const MOST_CHARS = 32;

export function fitLine(line: string): string {
  return line.length <= MOST_CHARS ? line : `${line.slice(0, MOST_CHARS - 1)}…`;
}

export function entryLines(entry: SnapshotExposed): string[] {
  if (entry.fields.length > 0) {
    const shown = entry.fields.slice(0, MOST_FIELDS).map((field) => `${field.name}${field.optional ? "?" : ""}: ${field.type}`);
    const hidden = entry.fields.length - shown.length;
    return hidden > 0 ? [...shown, `and ${hidden} more`] : shown;
  }
  if (entry.accepts !== null && entry.returns !== null && entry.accepts !== entry.returns) {
    return [`${entry.accepts} to ${entry.returns}`];
  }
  return [entry.returns ?? entry.accepts ?? ""];
}

export interface Measurement {
  leftHeight: number;
  rightHeight: number;
  height: number;
}

export function measure(node: GraphNode): Measurement {
  // A block drawn as a database or a queue has no ports to stack up the
  // sides; what it holds goes down the middle instead.
  if (node.exposes.length > 0) {
    let body = 0;
    for (const entry of node.exposes) body += GROUP_HEAD_H + entryLines(entry).length * FIELD_H + GROUP_GAP;
    return {
      leftHeight: 0,
      rightHeight: 0,
      height: HEAD_H + BODY_PAD + Math.max(body - GROUP_GAP, ROW_H) + BODY_PAD,
    };
  }

  const left = node.inputs.length > 0 ? GROUP_HEAD_H + node.inputs.length * ROW_H : 0;
  const right = node.outputs.length > 0 ? GROUP_HEAD_H + node.outputs.length * ROW_H : 0;
  const body = Math.max(left, right, ROW_H);

  return {
    leftHeight: left,
    rightHeight: right,
    height: HEAD_H + BODY_PAD + body + BODY_PAD + (node.capabilities.length > 0 ? 20 : 0),
  };
}

/* -------------------------------------------------------------------------- */
/* Where an access line runs                                                   */
/* -------------------------------------------------------------------------- */

/** How far apart two access lines sit on the same edge. */
const LANE_H = 11;

/**
 * The middle of one exposed entry, measured down from the top of the block.
 *
 * A line that names an entry at either end meets it there rather than at the
 * edge of the box, so a button joins the operation it triggers rather than
 * the service it happens to be in. Null when the block has no such entry.
 */
export function exposedRow(node: GraphNode, name: string | null): number | null {
  if (name === null) return null;
  let y = HEAD_H + BODY_PAD;
  for (const entry of node.exposes) {
    const height = GROUP_HEAD_H + entryLines(entry).length * FIELD_H;
    if (entry.name === name) return y + height / 2;
    y += height + GROUP_GAP;
  }
  return null;
}

/**
 * Where an access line meets the block that declared it.
 *
 * Data leaves a block on its right and arrives on its left, the same way its
 * ports are drawn, so a store kept below it makes a clockwise loop: out of the
 * right, down, and back up into the left. Access lines gather near the foot of
 * the block, clear of its contract, which they have nothing to do with.
 */
function ownEnd(node: GraphNode, point: Point, link: AccessLink): Point {
  const height = measure(node).height;
  const row = exposedRow(node, link.from);
  const y =
    row === null ? Math.max(point.y + HEAD_H + ROW_H, point.y + height - BODY_PAD - link.lane * LANE_H) : point.y + row;
  return { x: link.direction === "out" ? point.x + NODE_W : point.x, y };
}

/**
 * Where an access line meets the resource.
 *
 * A resource kept below is met on its top edge, at one side for what goes in
 * and the other for what comes out, which is what closes the loop without the
 * two lines crossing. One standing beside the block is met on its near edge,
 * so the line stays short.
 */
function resourceEnd(
  node: GraphNode,
  point: Point,
  from: Point,
  direction: "out" | "in",
  entry: string | null,
): Point {
  const height = measure(node).height;
  const row = exposedRow(node, entry);
  if (point.y > from.y) {
    // Below: what goes in arrives on its right, what comes back leaves on its
    // left. Both ends of each line are then on the same side of the column,
    // so the loop runs down the outside of it rather than through whatever
    // happens to stand in between.
    return { x: direction === "out" ? point.x + NODE_W : point.x, y: point.y + (row ?? height / 3) };
  }
  const nearRight = point.x + NODE_W / 2 < from.x;
  return { x: nearRight ? point.x + NODE_W : point.x, y: point.y + (row ?? height / 2) };
}

/** The two ends of an access line, in the order the data travels. */
export function accessEnds(
  graph: Graph,
  layout: Map<string, Point>,
  link: AccessLink,
): { from: Point; to: Point } | null {
  const owner = graph.nodes.get(link.source);
  const resource = graph.nodes.get(link.target);
  const ownerAt = layout.get(link.source);
  const resourceAt = layout.get(link.target);
  if (!owner || !resource || !ownerAt || !resourceAt) return null;

  const own = ownEnd(owner, ownerAt, link);
  const theirs = resourceEnd(resource, resourceAt, own, link.direction, link.entries[0]?.entry ?? null);
  return link.direction === "out" ? { from: own, to: theirs } : { from: theirs, to: own };
}

/* -------------------------------------------------------------------------- */
/* Arrangement                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Roles kept below the blocks that reach them rather than beside them.
 *
 * A store is not a step in the flow. It is read and written by the same block,
 * often in the same breath, so putting it further along says something untrue
 * about when it happens. A queue written and never read here is an endpoint
 * but not the destination — the system's answer goes back to whoever asked —
 * so it belongs under the flow as well, not at the end of it.
 */
const KEPT_BELOW = new Set(["database", "storage", "queue"]);

function isKeptBelow(node: GraphNode): boolean {
  return node.block !== null && KEPT_BELOW.has(node.block.role);
}

/** Columns by dependency, with what is kept below placed under whatever reaches it. */
export function autoLayout(graph: Graph): Map<string, Point> {
  // A store nothing in this diagram reaches has nothing to sit under, so it
  // takes its chances in the columns like anything else.
  const reached = new Set([...graph.accesses.values()].map((link) => link.target));
  const below = [...graph.nodes.values()].filter((node) => isKeptBelow(node) && reached.has(node.key));
  const belowKeys = new Set(below.map((node) => node.key));
  const inFlow = [...graph.nodes.values()].filter((node) => !belowKeys.has(node.key));

  const depth = new Map<string, number>([[WAY_IN, 0]]);
  for (const node of inFlow) if (node.key !== WAY_IN) depth.set(node.key, 1);

  // What a block calls stands to its right, so a diagram reads from whoever
  // sets the system going through the services to what they depend on.
  // Relaxed rather than sorted, because access can loop.
  for (let pass = 0; pass < graph.accesses.size; pass += 1) {
    let moved = false;
    for (const link of graph.accesses.values()) {
      if (belowKeys.has(link.target) || link.direction === "in") continue;
      const wanted = (depth.get(link.source) ?? 1) + 1;
      if ((depth.get(link.target) ?? 0) < wanted) {
        depth.set(link.target, wanted);
        moved = true;
      }
    }
    if (!moved) break;
  }

  const columns = new Map<number, GraphNode[]>();
  for (const node of inFlow) {
    const d = depth.get(node.key) ?? 0;
    const column = columns.get(d);
    if (column) column.push(node);
    else columns.set(d, [node]);
  }

  let tallest = 0;
  for (const column of columns.values()) {
    const total = column.reduce((h, n) => h + measure(n).height, 0) + ROW_GAP * (column.length - 1);
    tallest = Math.max(tallest, total);
  }

  const placed = new Map<string, Point>();
  for (const [d, column] of [...columns.entries()].sort((a, b) => a[0] - b[0])) {
    const total = column.reduce((h, n) => h + measure(n).height, 0) + ROW_GAP * (column.length - 1);
    let y = (tallest - total) / 2;
    for (const node of column) {
      placed.set(node.key, { x: d * (NODE_W + COL_GAP), y });
      y += measure(node).height + ROW_GAP;
    }
  }

  placeBelow(graph, below, placed);
  return placed;
}

/** How far under the blocks that reach it a store is set down. */
const BELOW_GAP = 64;

/**
 * Stores go under whatever reaches them: across, the average of the blocks
 * that touch them; down, clear of the lowest of them.
 *
 * Anything already standing where one would land pushes it lower, whether
 * that is another store or a block of the flow that happens to hang down
 * further than the one being read. A diagram with a store hidden behind
 * something else is worse than a tall one.
 */
function placeBelow(graph: Graph, below: GraphNode[], placed: Map<string, Point>): void {
  const anchors = (key: string) =>
    [...graph.accesses.values()]
      .filter((link) => link.target === key)
      .map((link) => ({ node: graph.nodes.get(link.source), at: placed.get(link.source) }))
      .filter((each): each is { node: GraphNode; at: Point } => Boolean(each.node && each.at));

  const wanted = below
    .map((node) => {
      const reaching = anchors(node.key);
      if (reaching.length === 0) return { node, x: 0, y: 0 };
      const x = reaching.reduce((total, each) => total + each.at.x, 0) / reaching.length;
      const y = Math.max(...reaching.map((each) => each.at.y + measure(each.node).height)) + BELOW_GAP;
      return { node, x, y };
    })
    .sort((a, b) => a.x - b.x);

  const belowKeys = new Set(below.map((node) => node.key));
  const settled = [...graph.nodes.values()]
    .filter((node) => !belowKeys.has(node.key) && placed.has(node.key))
    .map((node) => ({ ...placed.get(node.key)!, height: measure(node).height }));

  for (const each of wanted) {
    let { x, y } = each;
    const height = measure(each.node).height;
    // Whatever is already standing here pushes it lower, however many passes
    // that takes: clearing one block can put it under the next.
    for (let pass = 0; pass < settled.length; pass += 1) {
      const above = settled.find(
        (other) =>
          x < other.x + NODE_W + 24 && other.x < x + NODE_W + 24 && y < other.y + other.height + ROW_GAP && y + height > other.y,
      );
      if (!above) break;
      y = above.y + above.height + ROW_GAP;
    }
    settled.push({ x, y, height });
    placed.set(each.node.key, { x: Math.round(x), y: Math.round(y) });
  }
}

export function layoutFor(graph: Graph, view: string): Map<string, Point> {
  const saved = requireSnapshot().layout[view] ?? {};
  const auto = autoLayout(graph);
  const result = new Map<string, Point>();
  for (const node of graph.nodes.values()) {
    const stored = saved[node.key];
    result.set(node.key, stored ? { ...stored } : (auto.get(node.key) ?? { x: 0, y: 0 }));
  }
  return result;
}
