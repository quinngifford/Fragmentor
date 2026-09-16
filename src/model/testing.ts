import type { Block } from "./block.js";
import type { PortType } from "./types.js";

/** Terse block construction for tests. */
export function makeBlock(partial: Partial<Block> & { id: string }): Block {
  return {
    name: partial.id,
    responsibility: `does whatever ${partial.id} does`,
    kind: "leaf",
    inputs: {},
    outputs: {},
    capabilities: {},
    children: [],
    wires: [],
    pinnedAsLeaf: false,
    planned: false,
    ...partial,
  };
}

export const t = {
  string: { kind: "string" } as PortType,
  /** A type written as words, as a planned or visual block writes one. */
  text: (text: string): PortType => ({ kind: "text", text }),
  number: { kind: "number" } as PortType,
  boolean: { kind: "boolean" } as PortType,
  array: (of: PortType): PortType => ({ kind: "array", of }),
  object: (fields: Record<string, PortType>): PortType => ({
    kind: "object",
    fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { type: v }])),
  }),
};
