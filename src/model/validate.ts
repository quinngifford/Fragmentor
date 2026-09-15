import type { Block, ChildRef, Mode, Wire } from "./block.js";
import { describeType, typesEqual } from "./types.js";
import type { PortType } from "./types.js";

/**
 * What a child's input port expects on the wire. A child invoked once per
 * item declares the type of a single item, but the wire feeding the port it
 * iterates over carries the whole array.
 */
function inputTypeOnWire(ref: ChildRef, def: Block, port: string): PortType | undefined {
  const declared = def.inputs[port]?.type;
  if (!declared) return undefined;
  return ref.mode === "each" && ref.eachOver === port ? { kind: "array", of: declared } : declared;
}

/** What a child's output port produces on the wire, accounting for `each`. */
function outputTypeOnWire(ref: ChildRef, def: Block, port: string): PortType | undefined {
  const declared = def.outputs[port]?.type;
  if (!declared) return undefined;
  return ref.mode === "each" ? { kind: "array", of: declared } : declared;
}

/**
 * The type of the value a wire actually carries. This is what the canvas
 * shows when someone selects a wire, and what a recorded run is checked
 * against.
 */
export function wireCarriedType(
  parent: Block,
  children: Map<string, Block>,
  wire: Wire,
): PortType | undefined {
  const source = wire.source;
  if (source.from === "input") return parent.inputs[source.port]?.type;

  const def = children.get(source.block);
  const ref = parent.children.find((c) => c.block === source.block);
  if (!def || !ref) return undefined;
  return outputTypeOnWire(ref, def, source.port);
}

export interface Diagnostic {
  severity: "error" | "warning";
  /** Plain language. These are shown to the user in the canvas, not just logged. */
  message: string;
  /** Where in the block the problem lives, e.g. `wires[2]`. */
  path?: string;
}

/**
 * Checks a composite block against the contracts of its children.
 *
 * Everything here is a statement about the diagram alone. In structured mode
 * the diagram becomes code, so it has to be complete and its types have to
 * line up. In visual mode it is a picture of code that exists anyway: what it
 * refers to must exist, but a gap in it is only worth pointing out, its types
 * are free text, and a loop may be exactly what the code does.
 */
export function validateComposite(parent: Block, children: Map<string, Block>, mode: Mode = "structured"): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const error = (message: string, path?: string) => diagnostics.push({ severity: "error", message, path });
  const warn = (message: string, path?: string) => diagnostics.push({ severity: "warning", message, path });
  const visual = mode === "visual";
  const incomplete = visual ? warn : error;

  if (parent.kind !== "composite") {
    if (parent.children.length > 0 || parent.wires.length > 0) {
      error(`"${parent.name}" is a leaf block but declares children or wires.`);
    }
    return diagnostics;
  }

  if (parent.pinnedAsLeaf) {
    error(
      `"${parent.name}" is pinned as a leaf, but it has been given children. Make it a leaf again, or set "pinnedAsLeaf" to false if the person agrees.`,
    );
  }

  // --- children resolve and are unique -------------------------------------

  const seen = new Set<string>();
  const present: ChildRef[] = [];

  parent.children.forEach((child, i) => {
    if (child.block === "input" || child.block === "output") {
      error(
        `"${parent.name}" has a child called "${child.block}", but that id is reserved: wires use "${child.block}.<port>" for the parent's own ports.`,
        `children[${i}]`,
      );
      return;
    }
    if (seen.has(child.block)) {
      error(`"${parent.name}" lists the child block "${child.block}" more than once.`, `children[${i}]`);
      return;
    }
    seen.add(child.block);

    const def = children.get(child.block);
    if (!def) {
      error(`"${parent.name}" refers to a child block "${child.block}" that does not exist.`, `children[${i}]`);
      return;
    }

    if (child.mode === "each") {
      if (child.eachOver === undefined) {
        error(`"${child.block}" runs once per item but does not say which input it iterates over.`, `children[${i}]`);
      } else if (!(child.eachOver in def.inputs)) {
        error(
          `"${child.block}" is set to iterate over an input called "${child.eachOver}", but it has no such input.`,
          `children[${i}]`,
        );
      }
    }

    present.push(child);
  });

  const childOf = (id: string): Block | undefined => (seen.has(id) ? children.get(id) : undefined);
  const refOf = (id: string): ChildRef | undefined => present.find((c) => c.block === id);

  // --- wires resolve on both ends ------------------------------------------

  /** Counts how many wires drive each sink, keyed `block:port` or `output:port`. */
  const drivers = new Map<string, number>();
  const usedSources = new Set<string>();

  const resolveSource = (wire: Wire, i: number): PortType | undefined => {
    const path = `wires[${i}]`;
    if (wire.source.from === "input") {
      const port = parent.inputs[wire.source.port];
      if (!port) {
        error(`A wire starts from an input "${wire.source.port}" that "${parent.name}" does not have.`, path);
        return undefined;
      }
      usedSources.add(`input:${wire.source.port}`);
      return port.type;
    }

    const def = childOf(wire.source.block);
    const ref = refOf(wire.source.block);
    if (!def || !ref) {
      error(`A wire starts from "${wire.source.block}", which is not a child of "${parent.name}".`, path);
      return undefined;
    }
    const type = outputTypeOnWire(ref, def, wire.source.port);
    if (!type) {
      error(`A wire starts from an output "${wire.source.port}" that "${wire.source.block}" does not produce.`, path);
      return undefined;
    }
    usedSources.add(`block:${wire.source.block}:${wire.source.port}`);
    return type;
  };

  const resolveTarget = (wire: Wire, i: number): PortType | undefined => {
    const path = `wires[${i}]`;
    if (wire.target.to === "output") {
      const port = parent.outputs[wire.target.port];
      if (!port) {
        error(`A wire ends at an output "${wire.target.port}" that "${parent.name}" does not have.`, path);
        return undefined;
      }
      drivers.set(`output:${wire.target.port}`, (drivers.get(`output:${wire.target.port}`) ?? 0) + 1);
      return port.type;
    }

    const def = childOf(wire.target.block);
    const ref = refOf(wire.target.block);
    if (!def || !ref) {
      error(`A wire ends at "${wire.target.block}", which is not a child of "${parent.name}".`, path);
      return undefined;
    }
    const type = inputTypeOnWire(ref, def, wire.target.port);
    if (!type) {
      error(`A wire ends at an input "${wire.target.port}" that "${wire.target.block}" does not accept.`, path);
      return undefined;
    }
    const key = `block:${wire.target.block}:${wire.target.port}`;
    drivers.set(key, (drivers.get(key) ?? 0) + 1);
    return type;
  };

  parent.wires.forEach((wire, i) => {
    const sourceType = resolveSource(wire, i);
    const targetType = resolveTarget(wire, i);
    if (!visual && sourceType && targetType && !typesEqual(sourceType, targetType)) {
      error(
        `Type mismatch on a wire: the source carries ${describeType(sourceType)} but the destination expects ${describeType(targetType)}.`,
        `wires[${i}]`,
      );
    }
  });

  // --- every sink is driven exactly once -----------------------------------

  for (const ref of present) {
    const def = childOf(ref.block);
    if (!def) continue;
    for (const port of Object.keys(def.inputs)) {
      const count = drivers.get(`block:${ref.block}:${port}`) ?? 0;
      if (count === 0) {
        incomplete(`Nothing is connected to "${ref.block}" input "${port}".`);
      } else if (count > 1) {
        incomplete(`"${ref.block}" input "${port}" is driven by ${count} wires; it can only accept one.`);
      }
    }
  }

  for (const port of Object.keys(parent.outputs)) {
    const count = drivers.get(`output:${port}`) ?? 0;
    if (count === 0) {
      incomplete(`Nothing produces "${parent.name}" output "${port}".`);
    } else if (count > 1) {
      incomplete(`"${parent.name}" output "${port}" is driven by ${count} wires; it can only accept one.`);
    }
  }

  // --- unused sources are suspicious but legal -----------------------------

  for (const port of Object.keys(parent.inputs)) {
    if (!usedSources.has(`input:${port}`)) {
      warn(`"${parent.name}" takes an input "${port}" that nothing inside it uses.`);
    }
  }

  for (const ref of present) {
    const def = childOf(ref.block);
    if (!def) continue;
    for (const port of Object.keys(def.outputs)) {
      if (!usedSources.has(`block:${ref.block}:${port}`)) {
        warn(`"${ref.block}" produces an output "${port}" that nothing uses.`);
      }
    }
  }

  // A visual project draws code as it is, and neither passes capabilities
  // down nor runs anything, so the last two rules are about generated code.
  if (visual) return diagnostics;

  // --- capabilities are supplied by the parent -----------------------------

  for (const ref of present) {
    const def = childOf(ref.block);
    if (!def) continue;
    for (const [name, cap] of Object.entries(def.capabilities)) {
      const supplied = parent.capabilities[name];
      if (!supplied) {
        error(
          `"${ref.block}" needs the capability "${name}" (${cap.capability}), but "${parent.name}" does not declare it.`,
        );
      } else if (supplied.capability !== cap.capability) {
        error(
          `"${ref.block}" needs "${name}" to be ${cap.capability}, but "${parent.name}" supplies ${supplied.capability}.`,
        );
      }
    }
  }

  // --- the graph runs in some order ----------------------------------------

  const cycle = findCycle(present, parent.wires);
  if (cycle) {
    error(`These blocks feed into each other in a loop, so there is no order to run them in: ${cycle.join(" -> ")}.`);
  }

  return diagnostics;
}

/** Returns the blocks forming a dependency cycle, or undefined if the graph is runnable. */
function findCycle(children: ChildRef[], wires: Wire[]): string[] | undefined {
  const edges = new Map<string, Set<string>>();
  for (const child of children) edges.set(child.block, new Set());

  for (const wire of wires) {
    if (wire.source.from !== "block" || wire.target.to !== "block") continue;
    edges.get(wire.source.block)?.add(wire.target.block);
  }

  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];

  const visit = (node: string): string[] | undefined => {
    const current = state.get(node);
    if (current === "done") return undefined;
    if (current === "visiting") return [...stack.slice(stack.indexOf(node)), node];

    state.set(node, "visiting");
    stack.push(node);
    for (const next of edges.get(node) ?? []) {
      const found = visit(next);
      if (found) return found;
    }
    stack.pop();
    state.set(node, "done");
    return undefined;
  };

  for (const child of children) {
    const found = visit(child.block);
    if (found) return found;
  }
  return undefined;
}

/**
 * Children in an order that respects their data dependencies. Blocks caught
 * in a loop, which only a visual diagram may have, come last in the order
 * they were listed, so every child still appears exactly once.
 */
export function executionOrder(children: ChildRef[], wires: Wire[]): string[] {
  const incoming = new Map<string, Set<string>>();
  for (const child of children) incoming.set(child.block, new Set());

  for (const wire of wires) {
    if (wire.source.from !== "block" || wire.target.to !== "block") continue;
    if (wire.source.block === wire.target.block) continue;
    incoming.get(wire.target.block)?.add(wire.source.block);
  }

  const ordered: string[] = [];
  const remaining = new Set(children.map((c) => c.block));

  while (remaining.size > 0) {
    // Declaration order breaks ties, so the generated code reads in the order
    // the diagram lists its blocks whenever dependencies allow it.
    const ready = [...remaining].filter((id) => [...(incoming.get(id) ?? [])].every((dep) => !remaining.has(dep)));
    if (ready.length === 0) break;
    for (const id of ready) {
      ordered.push(id);
      remaining.delete(id);
    }
  }

  return [...ordered, ...remaining];
}
