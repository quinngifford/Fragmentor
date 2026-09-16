import type {
  SnapshotAccess,
  SnapshotBlock,
  SnapshotCapability,
  SnapshotChild,
  SnapshotExposed,
  SnapshotPort,
} from "../../src/project/snapshot.js";
import type { Point } from "../../src/project/layout.js";
import { BUS_PALETTE, busColors, requireSnapshot } from "./state.js";

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
  /**
   * A resource that lives above this diagram rather than in it, drawn here
   * because something in here reaches it. Dragging or opening it still works;
   * it is simply not one of this parent's children.
   */
  referenced: boolean;
  capabilities: SnapshotCapability[];
  child: SnapshotChild | null;
  block: SnapshotBlock | null;
  groups: BusGroup[];
}

/**
 * Everything one block reaches in another, drawn as a single line.
 *
 * Accesses are gathered from a child and from everything inside it, so the
 * diagram above a service shows the databases its handlers use without the
 * service having to repeat them. They are grouped per pair of blocks for the
 * same reason wires are: three reads and a write between two blocks are one
 * relationship, not four lines.
 */
export interface AccessLink {
  id: string;
  source: string;
  target: string;
  entries: SnapshotAccess[];
  /** True when nothing here declared it: it came from a block inside. */
  fromWithin: boolean;
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
      referenced: false,
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
        ? resourceNode(child.block, block, false)
        : {
            key: child.block,
            label: block.name,
            sublabel: block.planned ? "PLANNED" : block.kind === "composite" ? "COMPOSITE" : "LEAF",
            boundary: false,
            outputs: block.outputs,
            exposes: [],
            referenced: false,
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
      referenced: false,
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

  return { parent, nodes, buses, signals, accesses: buildAccesses(parent, nodes) };
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
        if (target === null || target === child.path || target.startsWith(`${child.path}/`)) continue;

        // The resource is a child of this parent, or it lives further out and
        // is brought in so the line has somewhere to land.
        let key = childPaths.get(target);
        if (key === undefined) {
          const resource = snapshot.blocks[target];
          if (!resource) continue;
          key = resource.id;
          if (!nodes.has(key)) nodes.set(key, resourceNode(key, resource, true));
        }

        const id = `${child.block}=>${key}`;
        let link = links.get(id);
        if (!link) {
          link = { id, source: child.block, target: key, entries: [], fromWithin: true };
          links.set(id, link);
        }
        if (block.path === child.path) link.fromWithin = false;
        if (!link.entries.some((each) => each.text === access.text)) link.entries.push(access);
      }
    }
  }

  return links;
}

/** A block drawn as the thing it stands for rather than as a function. */
function resourceNode(key: string, block: SnapshotBlock, referenced: boolean): GraphNode {
  return {
    key,
    label: block.name,
    sublabel: block.planned ? "PLANNED" : block.roleLabel,
    boundary: false,
    outputs: [],
    exposes: block.exposes,
    referenced,
    capabilities: [],
    child: null,
    block,
    groups: [],
  };
}

export function busColour(graph: Graph, view: string, bus: Bus): string {
  const override = busColors.get(view, bus.id);
  if (override) return override;
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

/** Columns by dependency, so an untouched diagram still reads left to right. */
export function autoLayout(graph: Graph): Map<string, Point> {
  const depth = new Map<string, number>([["input", 0]]);

  for (const id of graph.parent.order) {
    let d = 1;
    for (const signal of graph.signals) {
      if (signal.target !== id || signal.source === "input") continue;
      d = Math.max(d, (depth.get(signal.source) ?? 1) + 1);
    }
    depth.set(id, d);
  }

  // What a block reaches sits to its right, so a diagram reads from whoever
  // sets the system going, through the services, to the stores behind them.
  // Relaxed rather than sorted, because access can loop where wires cannot.
  for (let pass = 0; pass < graph.accesses.size; pass += 1) {
    let moved = false;
    for (const link of graph.accesses.values()) {
      const wanted = (depth.get(link.source) ?? 1) + 1;
      if ((depth.get(link.target) ?? 0) < wanted) {
        depth.set(link.target, wanted);
        moved = true;
      }
    }
    if (!moved) break;
  }

  const deepest = Math.max(0, ...depth.values());
  if (graph.nodes.has("output")) depth.set("output", deepest + 1);

  const columns = new Map<number, GraphNode[]>();
  for (const node of graph.nodes.values()) {
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

  return placed;
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
