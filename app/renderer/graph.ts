import type { SnapshotBlock, SnapshotCapability, SnapshotChild, SnapshotPort } from "../../src/project/snapshot.js";
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
  capabilities: SnapshotCapability[];
  child: SnapshotChild | null;
  block: SnapshotBlock | null;
  groups: BusGroup[];
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
    functionName: "",
    inputs: [],
    outputs: [],
    capabilities: [],
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
      capabilities: [],
      child: null,
      block: null,
      groups: [],
    });
  }

  for (const child of parent.children) {
    const block = snapshot.blocks[child.path];
    if (!block) continue;
    nodes.set(child.block, {
      key: child.block,
      label: block.name,
      sublabel: block.kind === "composite" ? "COMPOSITE" : "LEAF",
      boundary: false,
      outputs: block.outputs,
      capabilities: block.capabilities,
      child,
      block,
      groups: [],
    });
  }

  if (parent.outputs.length > 0) {
    nodes.set("output", {
      key: "output",
      label: "OUT",
      sublabel: parent.name,
      boundary: true,
      outputs: [],
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

  return { parent, nodes, buses, signals };
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
const COL_GAP = 92;
const ROW_GAP = 40;

export interface Measurement {
  leftHeight: number;
  rightHeight: number;
  height: number;
}

export function measure(node: GraphNode): Measurement {
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

  const deepest = Math.max(0, ...depth.values());
  depth.set("output", deepest + 1);

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
