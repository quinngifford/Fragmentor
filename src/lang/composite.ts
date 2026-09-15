import type { Block, WireSource } from "../model/block.js";
import { executionOrder } from "../model/validate.js";

/**
 * A composite's code, decided before any language writes it out.
 *
 * A composite does nothing but call its children: take its inputs apart, call
 * each child in an order where every value exists before it is used, and
 * return its outputs. That is its diagram written as calls, so Fragmentor
 * generates it rather than asking anyone to write it, and both packs write
 * out the same plan in their own syntax.
 *
 * Naming is decided here, because two children can produce outputs with the
 * same name and the variables holding them must still differ. A variable is
 * named after the port its value comes from whenever that name is free, which
 * is what makes the code read like the diagram.
 */

export interface Binding {
  port: string;
  variable: string;
}

export interface Callee {
  child: string;
  /** The function the child's module exports. */
  name: string;
  /** What the composite calls it: its own name, unless that name is taken. */
  local: string;
}

export interface Step {
  child: string;
  /** The name the child's function is called by here. */
  callee: string;
  /** For a child called once per item: the input it iterates over, the variable holding the array, and the name for one item. */
  each: { port: string; over: string; item: string } | null;
  /** Its inputs, each taken from a variable. The input it iterates over takes the item. */
  args: Binding[];
  /** Its outputs that something uses, each held in a variable. Arrays, for a child called once per item. */
  outputs: Binding[];
  /** The variable holding what the call returned, when the language needs one. */
  result: string | null;
}

export interface CompositePlan {
  /** Every child's function, in the order the children are listed. */
  callees: Callee[];
  /** The composite's own inputs that something uses. */
  inputs: Binding[];
  steps: Step[];
  /** Every output of the composite, and the variable it is returned from. */
  returns: Binding[];
}

export interface Naming {
  /** A port name as a variable in this language. */
  variable(port: string): string;
  /** Two names run together, for when the plain name is taken: `scorePosting` and `score`. */
  qualified(first: string, second: string): string;
  /** A block's function name. */
  functionName(blockId: string): string;
  /** The variable holding what calling a child returned, or null when the language destructures instead. */
  results(blockId: string, each: boolean): string | null;
  /** Names the language will not accept as variables, and names the generated code already uses. */
  reserved: ReadonlySet<string>;
}

const keyOf = (source: WireSource) => (source.from === "input" ? `input.${source.port}` : `${source.block}.${source.port}`);

/** Assumes the composite passed validation: every input is wired once and nothing loops. */
export function planComposite(block: Block, naming: Naming): CompositePlan {
  const taken = new Set<string>([...naming.reserved, naming.functionName(block.id)]);

  /** The first of these names that is free, or the last with a number on the end. */
  const claim = (...preferred: string[]): string => {
    for (const name of preferred) {
      if (!taken.has(name)) {
        taken.add(name);
        return name;
      }
    }
    const base = preferred.at(-1)!;
    for (let n = 2; ; n += 1) {
      if (!taken.has(`${base}${n}`)) {
        taken.add(`${base}${n}`);
        return `${base}${n}`;
      }
    }
  };

  // Children's functions are named before any variable, so no variable can
  // hide one. A child whose name is already taken — by a name the generated
  // code uses, such as `caps` — is imported under another.
  const callees = block.children.map((child): Callee => {
    const name = naming.functionName(child.block);
    return { child: child.block, name, local: claim(name, naming.qualified(child.block, "block")) };
  });
  const calleeOf = new Map(callees.map((callee) => [callee.child, callee.local]));

  /** The variable holding each source a wire starts from. */
  const holding = new Map<string, string>();
  const used = new Set(block.wires.map((wire) => keyOf(wire.source)));

  const inputs: Binding[] = [];
  for (const port of Object.keys(block.inputs)) {
    if (!used.has(`input.${port}`)) continue;
    const variable = claim(naming.variable(port), naming.qualified("input", port));
    holding.set(`input.${port}`, variable);
    inputs.push({ port, variable });
  }

  const steps: Step[] = [];
  for (const id of executionOrder(block.children, block.wires)) {
    const ref = block.children.find((child) => child.block === id)!;
    let each: Step["each"] = null;

    const args: Binding[] = [];
    for (const wire of block.wires) {
      if (wire.target.to !== "block" || wire.target.block !== id) continue;
      const port = wire.target.port;
      const variable = holding.get(keyOf(wire.source))!;
      if (ref.mode === "each" && ref.eachOver === port) {
        each = { port, over: variable, item: claim(naming.variable(port), naming.qualified(port, "item")) };
        args.push({ port, variable: each.item });
      } else {
        args.push({ port, variable });
      }
    }

    const outputs: Binding[] = [];
    for (const wire of block.wires) {
      if (wire.source.from !== "block" || wire.source.block !== id || holding.has(keyOf(wire.source))) continue;
      const variable = claim(naming.variable(wire.source.port), naming.qualified(id, wire.source.port));
      holding.set(keyOf(wire.source), variable);
      outputs.push({ port: wire.source.port, variable });
    }

    const results = outputs.length > 0 ? naming.results(id, ref.mode === "each") : null;
    steps.push({
      child: id,
      callee: calleeOf.get(id)!,
      each,
      args,
      outputs,
      result: results === null ? null : claim(results),
    });
  }

  const returns = Object.keys(block.outputs).map((port) => {
    const wire = block.wires.find((w) => w.target.to === "output" && w.target.port === port)!;
    return { port, variable: holding.get(keyOf(wire.source))! };
  });

  return { callees, inputs, steps, returns };
}
