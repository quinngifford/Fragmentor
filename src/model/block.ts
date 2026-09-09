import { z } from "zod";
import { identifierPattern, portTypeSchema } from "./types.js";
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

const portSchema = z
  .object({
    type: portTypeSchema,
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

const wireSourceSchema = z.discriminatedUnion("from", [
  z.object({ from: z.literal("input"), port: portName }).strict(),
  z.object({ from: z.literal("block"), block: blockId, port: portName }).strict(),
]);

const wireTargetSchema = z.discriminatedUnion("to", [
  z.object({ to: z.literal("block"), block: blockId, port: portName }).strict(),
  z.object({ to: z.literal("output"), port: portName }).strict(),
]);

const wireSchema = z
  .object({
    source: wireSourceSchema,
    target: wireTargetSchema,
  })
  .strict();

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
  }) as unknown as z.ZodType<Block, z.ZodTypeDef, unknown>;

/** `rank-jobs` -> `rankJobs`. The block's exported function name. */
export function functionNameOf(id: string): string {
  return id.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** `rank-jobs` -> `RankJobs`. The stem for the block's generated type names. */
export function typeStemOf(id: string): string {
  const fn = functionNameOf(id);
  return fn.charAt(0).toUpperCase() + fn.slice(1);
}
