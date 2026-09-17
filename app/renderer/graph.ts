import type { AccessVerb } from "../../src/model/block.js";
import type {
  SnapshotAccess,
  SnapshotBlock,
  SnapshotCapability,
  SnapshotChild,
  SnapshotExposed,
  SnapshotPort,
} from "../../src/project/snapshot.js";
import type { Point } from "../../src/project/layout.js";
import { BLOCK_PALETTE, BUS_PALETTE, blockColours, busColors, requireSnapshot, viewSettings } from "./state.js";

/**
 * The diagram as drawn.
 *
 * Two things happen here that the kernel does not do. Connections are grouped
 * into buses — one per source block — so a diagram does not become a thicket of
 * single lines; and the parent's own ports become nodes, so the boundary obeys
 * the same rules as everything else instead of being a special case.
 *
 * Grouping is a view. The kernel still records every signal separately, which
 * is what validation and the conformance check need.
 */

export interface Signal {
  source: string;
  target: string;
  sourcePort: string;
  targetPort: string;
  type: string | null;
  isArray: boolean;
}

export interface BusGroup {
  source: string;
  signals: Signal[];
}

export interface GraphNode {
  key: string;
  label: string;
  sublabel: string;
  boundary: boolean;
  outputs: SnapshotPort[];
  /** Architecture blocks only: the tables, channels or operations drawn inside it. */
  exposes: SnapshotExposed[];
  capabilities: SnapshotCapability[];
  child: SnapshotChild | null;
  block: SnapshotBlock | null;
  groups: BusGroup[];
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

export interface Bus {
  id: string;
  source: string;
  target: string;
  signals: Signal[];
}

export interface Graph {
  parent: SnapshotBlock;
  nodes: Map<string, GraphNode>;
  buses: Map<string, Bus>;
  signals: Signal[];
  accesses: Map<string, AccessLink>;
}

/** The view showing every system in the project side by side. */
export const PROJECT_VIEW = "";

/**
 * The project drawn as if it were one composite whose children are its
 * systems. Systems are never connected, so this diagram has no wires — it
 * exists so a project with several systems can be seen at once.
 */
function projectAsBlock(): SnapshotBlock {
  const snapshot = requireSnapshot();

  return {
    path: PROJECT_VIEW,
    id: PROJECT_VIEW,
    name: snapshot.name,
    responsibility: snapshot.goal,
    kind: "composite",
    // The project itself is never planned, and nothing reads these of it:
    // it is a frame around the systems, not a block anyone can open.
    planned: false,
    holdsPlan: false,
    functionName: "",
    inputs: [],
    outputs: [],
    capabilities: [],
    role: "function" as const,
    subtype: null,
    roleLabel: "",
    architecture: false,
    holdsArchitecture: false,
    exposes: [],
    access: [],
    children: snapshot.systems.map((system) => {
      const root = snapshot.blocks[system.rootBlock];
      return {
        block: system.rootBlock,
        mode: "once" as const,
        eachOver: null,
        path: system.rootBlock,
        kind: root?.kind ?? "leaf",
        name: root?.name ?? system.rootBlock,
        functionName: root?.functionName ?? "",
      };
    }),
    order: snapshot.systems.map((system) => system.rootBlock),
    wires: [],
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

  const signals: Signal[] = parent.wires.map((wire) => ({
    source: wire.source.from === "input" ? "input" : wire.source.block,
    target: wire.target.to === "output" ? "output" : wire.target.block,
    sourcePort: wire.source.port,
    targetPort: wire.target.port,
    type: wire.type,
    isArray: wire.isArray,
  }));

  const nodes = new Map<string, GraphNode>();

  // A boundary with no ports is not worth drawing, which is what makes the
  // project view a plain row of systems rather than an empty IN and OUT.
  if (parent.inputs.length > 0) {
    nodes.set("input", {
      key: "input",
      label: "IN",
      sublabel: parent.name,
      boundary: true,
      outputs: parent.inputs,
      exposes: [],
      capabilities: [],
      child: null,
      block: null,
      groups: [],
    });
  }

  for (const child of parent.children) {
    const block = snapshot.blocks[child.path];
    if (!block) continue;
    // A database is drawn as a database, whether or not it has blocks inside
    // it; only a function is worth labelling by whether it has children.
    nodes.set(child.block, {
      ...(block.architecture
        ? resourceNode(child.block, block)
        : {
            key: child.block,
            label: block.name,
            sublabel: block.planned ? "PLANNED" : block.kind === "composite" ? "COMPOSITE" : "LEAF",
            boundary: false,
            outputs: block.outputs,
            exposes: [],
                  capabilities: block.capabilities,
            block,
            groups: [],
          }),
      child,
    });
  }

  if (parent.outputs.length > 0) {
    nodes.set("output", {
      key: "output",
      label: "OUT",
      sublabel: parent.name,
      boundary: true,
      outputs: [],
      exposes: [],
      capabilities: [],
      child: null,
      block: null,
      groups: [],
    });
  }

  for (const signal of signals) {
    const node = nodes.get(signal.target);
    if (!node) continue;
    let group = node.groups.find((g) => g.source === signal.source);
    if (!group) {
      group = { source: signal.source, signals: [] };
      node.groups.push(group);
    }
    group.signals.push(signal);
  }

  const buses = new Map<string, Bus>();
  for (const signal of signals) {
    const id = `${signal.source}->${signal.target}`;
    let bus = buses.get(id);
    if (!bus) {
      bus = { id, source: signal.source, target: signal.target, signals: [] };
      buses.set(id, bus);
    }
    bus.signals.push(signal);
  }

  const accesses = buildAccesses(parent, nodes);
  addAnsweredOperations(parent, nodes, accesses);
  return { parent, nodes, buses, signals, accesses };
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

  for (const child of parent.children) {
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

        // A store is drawn on the diagram it belongs to and nowhere else, so
        // an access to one kept further out belongs to that diagram, not this
        // one. The diagrams underneath are left to their own functions.
        const key = childPaths.get(target);
        if (key === undefined) continue;

        const id = `${child.block}=>${key}:${access.verb}`;
        let link = links.get(id);
        if (!link) {
          link = {
            id,
            source: child.block,
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
    const side = `${link.source}:${link.direction}`;
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

  nodes.set("input", {
    key: "input",
    label: parent.name,
    sublabel: "ANSWERS",
    boundary: true,
    outputs: [],
    exposes: answered,
    capabilities: [],
    child: null,
    block: parent,
    groups: [],
  });

  answered.forEach((entry, lane) => {
    const id = `input=>${entry.block}:${entry.name}`;
    accesses.set(id, {
      id,
      source: "input",
      target: entry.block!,
      verb: "calls",
      direction: "out",
      entries: [
        {
          text: `answers ${entry.name}`,
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
    outputs: [],
    exposes: block.exposes,
    capabilities: [],
    child: null,
    block,
    groups: [],
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

export function busColour(graph: Graph, view: string, bus: Bus): string {
  const override = busColors.get(view, bus.id);
  if (override) return override;
  // Coloured block by block, what leaves a block matches it. Coloured by
  // role, every bus is data inside the program, so they are shades of the one
  // colour that means that.
  if (viewSettings.colourBy === "block") return blockColour(graph, view, bus.source);
  const order = [...graph.nodes.keys()];
  return BUS_PALETTE[order.indexOf(bus.source) % BUS_PALETTE.length]!;
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

  let left = 0;
  for (const group of node.groups) left += GROUP_HEAD_H + group.signals.length * ROW_H + GROUP_GAP;
  if (left > 0) left -= GROUP_GAP;

  const right = node.outputs.length > 0 ? GROUP_HEAD_H + node.outputs.length * ROW_H : 0;
  const body = Math.max(left, right, ROW_H);

  return {
    leftHeight: left,
    rightHeight: right,
    height: HEAD_H + BODY_PAD + body + BODY_PAD + (node.capabilities.length > 0 ? 20 : 0),
  };
}

/** Where a bus leaves a node: one dot for everything the node produces. */
export function busOutPoint(node: GraphNode, point: Point): Point {
  const { rightHeight } = measure(node);
  const top = point.y + HEAD_H + BODY_PAD;
  return { x: point.x + NODE_W, y: top + (rightHeight > 0 ? rightHeight / 2 : ROW_H / 2) };
}

/** Where a bus lands: the middle of the group of inputs it feeds. */
export function busInPoint(node: GraphNode, point: Point, sourceKey: string): Point {
  let y = point.y + HEAD_H + BODY_PAD;
  for (const group of node.groups) {
    const height = GROUP_HEAD_H + group.signals.length * ROW_H;
    if (group.source === sourceKey) return { x: point.x, y: y + height / 2 };
    y += height + GROUP_GAP;
  }
  return { x: point.x, y: point.y + HEAD_H + BODY_PAD };
}

/* -------------------------------------------------------------------------- */
/* Where an access line runs                                                   */
/* -------------------------------------------------------------------------- */

/** How far apart two access lines sit on the same edge. */
const LANE_H = 11;

/**
 * Where an access line meets the block that declared it.
 *
 * Data leaves a block on its right and arrives on its left, the same way its
 * ports are drawn, so a store kept below it makes a clockwise loop: out of the
 * right, down, and back up into the left. Access lines gather near the foot of
 * the block, clear of the ports, because they are a different kind of
 * connection and should not look like another wire.
 */
function ownEnd(node: GraphNode, point: Point, link: AccessLink): Point {
  const height = measure(node).height;
  const y = Math.max(point.y + HEAD_H + ROW_H, point.y + height - BODY_PAD - link.lane * LANE_H);
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
function resourceEnd(node: GraphNode, point: Point, from: Point, direction: "out" | "in"): Point {
  const height = measure(node).height;
  if (point.y > from.y) {
    // Below: what goes in arrives on its right, what comes back leaves on its
    // left. Both ends of each line are then on the same side of the column,
    // so the loop runs down the outside of it rather than through whatever
    // happens to stand in between.
    return { x: direction === "out" ? point.x + NODE_W : point.x, y: point.y + height / 3 };
  }
  const nearRight = point.x + NODE_W / 2 < from.x;
  return { x: nearRight ? point.x + NODE_W : point.x, y: point.y + height / 2 };
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
  const theirs = resourceEnd(resource, resourceAt, own, link.direction);
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

  const depth = new Map<string, number>([["input", 0]]);

  for (const id of graph.parent.order) {
    if (belowKeys.has(id)) continue;
    let d = 1;
    for (const signal of graph.signals) {
      if (signal.target !== id || signal.source === "input") continue;
      d = Math.max(d, (depth.get(signal.source) ?? 1) + 1);
    }
    depth.set(id, d);
  }

  // What a block calls stands to its right, so a diagram reads from whoever
  // sets the system going through the services to what they depend on.
  // Relaxed rather than sorted, because access can loop where wires cannot.
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

  const deepest = Math.max(0, ...[...depth.entries()].filter(([key]) => !belowKeys.has(key)).map(([, d]) => d));
  if (graph.nodes.has("output")) depth.set("output", deepest + 1);

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

/* -------------------------------------------------------------------------- */
/* The code a connection becomes                                               */
/* -------------------------------------------------------------------------- */

/** `port` when the names already agree, `port: source` when they do not. */
function argFor(signal: Signal): string {
  return signal.sourcePort === signal.targetPort ? signal.targetPort : `${signal.targetPort}: ${signal.sourcePort}`;
}

function signalsOf(node: GraphNode): Signal[] {
  return node.groups.flatMap((group) => group.signals);
}

export function callStatement(graph: Graph, nodeKey: string): string | null {
  if (nodeKey === "input") return null;

  if (nodeKey === "output") {
    const node = graph.nodes.get("output");
    if (!node) return null;
    return `return { ${signalsOf(node).map(argFor).join(", ")} };`;
  }

  const node = graph.nodes.get(nodeKey);
  if (!node?.block) return null;

  const fn = node.block.functionName;
  const produced = node.outputs.map((output) => output.name);
  const signals = signalsOf(node);

  if (node.child && node.child.mode === "each" && node.child.eachOver) {
    const item = node.child.eachOver;
    const over = signals.find((signal) => signal.targetPort === item);
    const arrayVar = over ? over.sourcePort : `${item}s`;
    const rest = signals.filter((signal) => signal.targetPort !== item).map(argFor);
    const results = `${fn}Results`;

    return [
      `const ${results} = await Promise.all(`,
      `  ${arrayVar}.map((${item}) => ${fn}({ ${[item, ...rest].join(", ")} }, caps)),`,
      `);`,
      ...produced.map((name) => `const ${name} = ${results}.map((r) => r.${name});`),
    ].join("\n");
  }

  const binding = produced.length > 0 ? `const { ${produced.join(", ")} } = ` : "";
  return `${binding}await ${fn}({ ${signals.map(argFor).join(", ")} }, caps);`;
}

export function connectionCode(graph: Graph, bus: Bus): string {
  const lines: string[] = [];
  const sourceNode = graph.nodes.get(bus.source);
  const targetNode = graph.nodes.get(bus.target);

  if (bus.source === "input") {
    lines.push(`// ${graph.parent.name} receives these as its own arguments`);
    lines.push(`const { ${bus.signals.map((signal) => signal.sourcePort).join(", ")} } = input;`);
  } else {
    lines.push(`// produced by ${sourceNode?.label ?? bus.source}`);
    lines.push(callStatement(graph, bus.source) ?? "");
  }

  lines.push("");
  lines.push(bus.target === "output" ? `// returned by ${graph.parent.name}` : `// consumed by ${targetNode?.label ?? bus.target}`);
  lines.push(callStatement(graph, bus.target) ?? "");

  return lines.join("\n");
}
