import { z } from "zod/v4";
import { describeType, identifierPattern } from "./types.js";
import { tryParseType } from "./typeExpression.js";
import type { PortType } from "./types.js";

/**
 * A block.json file describes the diagram and nothing else.
 *
 * It deliberately does not record whether a block is implemented or whether
 * its tests pass. Those are facts about the working tree and the last test
 * run, and storing them here would create a second source of truth that could
 * disagree with reality. They are derived instead.
 */

export type BlockKind = "leaf" | "composite";

export interface Port {
  type: PortType;
  description?: string;
}

/**
 * An effect the block needs supplied from outside: a database, HTTP access,
 * the clock. Capabilities are matched by name down the hierarchy rather than
 * wired individually, so a parent must declare every capability its
 * descendants need. That keeps the diagram free of plumbing lines and makes
 * the generated glue a plain `caps` hand-off.
 */
export interface CapabilityPort {
  capability: string;
  description?: string;
}

/**
 * How a composite invokes one of its children.
 *
 * `once` calls it a single time. `each` calls it per element of the array
 * arriving at `eachOver`, collecting the results in order. These two are the
 * whole control vocabulary for now; conditional logic lives inside leaf
 * blocks until a real example proves a branch primitive is needed.
 */
export interface ChildRef {
  block: string;
  mode: "once" | "each";
  eachOver?: string;
}

export type WireSource =
  | { from: "input"; port: string }
  | { from: "block"; block: string; port: string };

export type WireTarget =
  | { to: "block"; block: string; port: string }
  | { to: "output"; port: string };

export interface Wire {
  source: WireSource;
  target: WireTarget;
}

export interface Block {
  id: string;
  name: string;
  responsibility: string;
  kind: BlockKind;
  inputs: Record<string, Port>;
  outputs: Record<string, Port>;
  capabilities: Record<string, CapabilityPort>;
  /** Composite only. Empty for leaves. */
  children: ChildRef[];
  /** Composite only. Empty for leaves. */
  wires: Wire[];
  /** The user has declared this block will not be decomposed further. */
  pinnedAsLeaf: boolean;
}

/** Block ids are folder names, so they are kebab-case and filesystem-safe. */
export const blockIdPattern = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

const blockId = z
  .string()
  .regex(blockIdPattern, "must be kebab-case (lowercase letters, digits, single hyphens)");

const portName = z.string().regex(identifierPattern, "port names must be valid identifiers");

/**
 * On disk a port's type is written the way a developer writes types, e.g.
 * `{ title: string; salary?: number }[]`. In memory it is the structured form
 * the test bench walks to build a form. describeType and parseType are exact
 * inverses, so the file stays readable without the structure being lossy.
 */
const typeExpression = z.string().transform((value, ctx): PortType => {
  const parsed = tryParseType(value);
  if (!parsed.ok) {
    ctx.addIssue({ code: "custom", message: parsed.error });
    return z.NEVER;
  }
  return parsed.type;
});

const portSchema = z
  .object({
    type: typeExpression,
    description: z.string().optional(),
  })
  .strict();

const capabilityPortSchema = z
  .object({
    capability: z.string().min(1),
    description: z.string().optional(),
  })
  .strict();

const childRefSchema = z
  .object({
    block: blockId,
    mode: z.enum(["once", "each"]).default("once"),
    eachOver: portName.optional(),
  })
  .strict()
  .refine((c) => c.mode !== "each" || c.eachOver !== undefined, {
    message: "a child invoked with mode 'each' must name the input port it iterates over via 'eachOver'",
  })
  .refine((c) => c.mode !== "once" || c.eachOver === undefined, {
    message: "'eachOver' only applies to children invoked with mode 'each'",
  });

/**
 * Wires are written as `source -> destination`, where an endpoint is either
 * `input.<port>` / `output.<port>` for the block's own ports, or
 * `<child-id>.<port>` for one of its children. The same syntax is what the
 * model reads and writes, so there is only one wire notation in the system.
 */
interface Endpoint {
  role: "input" | "output" | "block";
  block?: string;
  port: string;
}

function parseEndpoint(ref: string): Endpoint | undefined {
  const split = ref.lastIndexOf(".");
  if (split <= 0 || split === ref.length - 1) return undefined;

  const head = ref.slice(0, split);
  const port = ref.slice(split + 1);
  if (!identifierPattern.test(port)) return undefined;

  if (head === "input") return { role: "input", port };
  if (head === "output") return { role: "output", port };
  if (!blockIdPattern.test(head)) return undefined;
  return { role: "block", block: head, port };
}

export function parseWireEndpoints(from: string, to: string): { ok: true; wire: Wire } | { ok: false; error: string } {
  const source = parseEndpoint(from);
  if (!source) {
    return { ok: false, error: `The wire source "${from}" is not written as "input.port" or "child-id.port".` };
  }
  const target = parseEndpoint(to);
  if (!target) {
    return { ok: false, error: `The wire destination "${to}" is not written as "output.port" or "child-id.port".` };
  }
  if (source.role === "output") {
    return { ok: false, error: `A wire cannot start at "${from}"; the parent's outputs are destinations, not sources.` };
  }
  if (target.role === "input") {
    return { ok: false, error: `A wire cannot end at "${to}"; the parent's inputs are sources, not destinations.` };
  }

  return {
    ok: true,
    wire: {
      source:
        source.role === "input"
          ? { from: "input", port: source.port }
          : { from: "block", block: source.block!, port: source.port },
      target:
        target.role === "output"
          ? { to: "output", port: target.port }
          : { to: "block", block: target.block!, port: target.port },
    },
  };
}

export function parseWireText(text: string): { ok: true; wire: Wire } | { ok: false; error: string } {
  const parts = text.split("->");
  if (parts.length !== 2) {
    return { ok: false, error: `A wire must be written as "source -> destination", but this reads "${text}".` };
  }
  return parseWireEndpoints(parts[0]!.trim(), parts[1]!.trim());
}

export function formatWire(wire: Wire): string {
  const source =
    wire.source.from === "input" ? `input.${wire.source.port}` : `${wire.source.block}.${wire.source.port}`;
  const target =
    wire.target.to === "output" ? `output.${wire.target.port}` : `${wire.target.block}.${wire.target.port}`;
  return `${source} -> ${target}`;
}

const wireSchema = z.string().transform((value, ctx): Wire => {
  const parsed = parseWireText(value);
  if (!parsed.ok) {
    ctx.addIssue({ code: "custom", message: parsed.error });
    return z.NEVER;
  }
  return parsed.wire;
});

export const blockSchema = z
  .object({
    id: blockId,
    name: z.string().min(1),
    responsibility: z.string().min(1, "every block must state what it is responsible for"),
    kind: z.enum(["leaf", "composite"]),
    inputs: z.record(portName, portSchema).default({}),
    outputs: z.record(portName, portSchema).default({}),
    capabilities: z.record(portName, capabilityPortSchema).default({}),
    children: z.array(childRefSchema).default([]),
    wires: z.array(wireSchema).default([]),
    pinnedAsLeaf: z.boolean().default(false),
  })
  .strict()
  .refine((b) => b.kind === "composite" || b.children.length === 0, {
    message: "a leaf block cannot declare children",
    path: ["children"],
  })
  .refine((b) => b.kind === "composite" || b.wires.length === 0, {
    message: "a leaf block cannot declare wires",
    path: ["wires"],
  }) as unknown as z.ZodType<Block>;

/** The JSON form of a block, with port types written as expressions. */
export function blockToFileShape(block: Block): unknown {
  const ports = (record: Record<string, Port>) =>
    Object.fromEntries(
      Object.entries(record).map(([name, port]) => [
        name,
        port.description ? { type: describeType(port.type), description: port.description } : { type: describeType(port.type) },
      ]),
    );

  return {
    id: block.id,
    name: block.name,
    responsibility: block.responsibility,
    kind: block.kind,
    inputs: ports(block.inputs),
    outputs: ports(block.outputs),
    capabilities: block.capabilities,
    children: block.children,
    wires: block.wires.map(formatWire),
    pinnedAsLeaf: block.pinnedAsLeaf,
  };
}

/** `rank-jobs` -> `rankJobs`. The block's exported function name. */
export function functionNameOf(id: string): string {
  return id.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** `rank-jobs` -> `RankJobs`. The stem for the block's generated type names. */
export function typeStemOf(id: string): string {
  const fn = functionNameOf(id);
  return fn.charAt(0).toUpperCase() + fn.slice(1);
}
