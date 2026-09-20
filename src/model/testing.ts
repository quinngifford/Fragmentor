import { camelCase } from "../lang/naming.js";
import type { Block } from "./block.js";
import type { PortType } from "./types.js";

/**
 * Terse block construction for tests.
 *
 * A function block that is not planned says where its code is, as every real
 * one does, so a test only writes a pointer when the pointer is the point. A
 * test about a block saying nothing at all writes its block.json itself.
 */
export function makeBlock(partial: Partial<Block> & { id: string }): Block {
  const block: Block = {
    name: partial.id,
    responsibility: `does whatever ${partial.id} does`,
    role: "function",
    inputs: {},
    outputs: {},
    exposes: {},
    access: [],
    capabilities: {},
    pinnedAsLeaf: false,
    planned: false,
    ...partial,
  };
  if (block.role === "function" && !block.planned && !("code" in partial)) {
    block.code = `src/${block.id}.ts#${camelCase(block.id)}`;
  }
  return block;
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
