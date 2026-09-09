import { z } from "zod/v4";
import { blockSchema } from "../model/block.js";
import type { Block, Wire, WireSource, WireTarget } from "../model/block.js";
import { describeType } from "../model/types.js";
import { tryParseType } from "../model/typeExpression.js";
import { validateComposite } from "../model/validate.js";
import type { Diagnostic } from "../model/validate.js";
import type { Granularity } from "../project/project.js";
import type { ModelClient, ModelTurn } from "./modelClient.js";

/**
 * Asks the model how a block should be broken into children, then holds the
 * answer to the same rules the rest of the system enforces.
 *
 * The important part is not the prompt, it is the loop: a proposal is turned
 * into real blocks and run through the ordinary validator, and anything wrong
 * is handed back to the model in its own terms. The validator, not the
 * prompt, is what makes the output trustworthy.
 */

const proposedPortSchema = z.object({
  /** A type expression, e.g. `{ title: string; tags: string[] }[]`. */
  type: z.string(),
  description: z.string().optional(),
});

const proposedCapabilitySchema = z.object({
  capability: z.string(),
  description: z.string().optional(),
});

const proposedChildSchema = z.object({
  id: z.string(),
  name: z.string(),
  responsibility: z.string(),
  inputs: z.record(z.string(), proposedPortSchema).optional(),
  outputs: z.record(z.string(), proposedPortSchema).optional(),
  capabilities: z.record(z.string(), proposedCapabilitySchema).optional(),
  mode: z.enum(["once", "each"]).optional(),
  eachOver: z.string().optional(),
  /** The model's judgement on whether this child still contains structure worth drawing. */
  likelyLeaf: z.boolean(),
});

const proposedWireSchema = z.object({
  /** `input.<port>` or `<child-id>.<port>` */
  from: z.string(),
  /** `output.<port>` or `<child-id>.<port>` */
  to: z.string(),
});

export const proposalSchema = z.object({
  /** Why this particular split, in a sentence or two. Shown to the user. */
  reasoning: z.string(),
  children: z.array(proposedChildSchema).min(1),
  wires: z.array(proposedWireSchema),
  /** Capabilities the work turned out to need that the parent does not yet declare. */
  addedParentCapabilities: z.record(z.string(), proposedCapabilitySchema).optional(),
});

export type Proposal = z.infer<typeof proposalSchema>;

export interface DecompositionResult {
  proposal: Proposal;
  /** The parent with its children and wiring filled in. Not yet written to disk. */
  parent: Block;
  children: Block[];
  /** Children the model believes still contain structure worth decomposing. */
  furtherDecomposition: string[];
  diagnostics: Diagnostic[];
  attempts: number;
}

const RESERVED_IDS = new Set(["input", "output"]);

const GRANULARITY_GUIDANCE: Record<Granularity["level"], string> = {
  1: "Split only where the block plainly contains separate responsibilities. Prefer 2 or 3 substantial children. Leave real work inside each child.",
  2: "Prefer 2 to 4 children, each a substantial piece of work.",
  3: "Prefer 3 to 5 children, each with one clear responsibility, each roughly 30 to 80 lines of code.",
  4: "Prefer 4 to 6 fairly small children, each roughly 20 to 50 lines of code.",
  5: "Break the work down aggressively into small single-purpose children, each roughly 10 to 30 lines of code. Still do not create a child that is a single expression.",
};

function buildSystemPrompt(): string {
  return `You are the decomposition engine inside Fragmentor, a tool that builds software as a hierarchy of blocks with precisely defined contracts, in the spirit of a Simulink block diagram.

You are given one block and you decide how it should be broken into child blocks.

## What a block is

A block is a real function. It has typed inputs, typed outputs, and capability ports for effects it needs supplied from outside (a database, HTTP access, the clock). A block is either a leaf, which is plain code, or a composite, whose behaviour comes from its children and the connections between them.

## Rules you must follow

1. The children together must fully implement the parent's stated responsibility. Nothing more, nothing less.
2. Every input of the parent must be consumed by at least one wire.
3. Every output of the parent must be produced by exactly one wire.
4. Every input of every child must be driven by exactly one wire.
5. Data flows forward only. Two children may not feed into each other in a loop.
6. A child that needs a capability the parent does not have forces the parent to gain it. Declare those in addedParentCapabilities. Do not invent capabilities a child does not genuinely need.
7. Do not create a child whose whole body would be a single expression. If a step is too small to justify being its own function, it belongs as a line inside a sibling, not as a block.
8. Child ids are kebab-case, unique among siblings, and never "input" or "output".

## The control vocabulary

A child runs either once, or once per item of an array.

- mode "once" is the default.
- mode "each" runs the child once per element of the array arriving at the input named by eachOver, and collects the results. When a child runs with mode "each", the wire into its eachOver port carries an array of that port's declared type, and every wire out of that child carries an array of its declared output type. Its other inputs receive the same value on every iteration.

There is no conditional block. Branching, error handling and early exits live inside a leaf block's code, not on the diagram.

## Type syntax

Types are written the way a TypeScript developer would write them, built only from:

- string, number, boolean, null, unknown
- literals such as "remote" or 42 or true
- unions with | , for example "remote" | "hybrid" | "onsite" or string | null
- arrays with [] , for example string[]
- objects, for example { title: string; salary?: number }

Bracket a union inside an array: (string | number)[]. There are no named types, no generics, and no interfaces. Write the shape out in full.

## Wires

A wire is written as two endpoint strings.

- from is either "input.<portName>" or "<child-id>.<outputPortName>"
- to is either "output.<portName>" or "<child-id>.<inputPortName>"

## Judgement

For each child, set likelyLeaf to true when the child is a single coherent piece of code with no further structure worth drawing, and false when it clearly contains several steps that deserve their own blocks.

Write responsibilities as a plain statement of what the block is accountable for. Be specific about the real work.`;
}

function describeBlockContract(block: Block): string {
  const ports = (record: Record<string, { type: unknown; description?: string }>, label: string) => {
    const entries = Object.entries(record);
    if (entries.length === 0) return `${label}: none`;
    const lines = entries.map(([name, port]) => {
      const type = describeType(port.type as Parameters<typeof describeType>[0]);
      return `  - ${name}: ${type}${port.description ? ` — ${port.description}` : ""}`;
    });
    return `${label}:\n${lines.join("\n")}`;
  };

  const capabilities = Object.entries(block.capabilities);
  const capabilityText =
    capabilities.length === 0
      ? "capabilities: none"
      : `capabilities:\n${capabilities
          .map(([name, cap]) => `  - ${name}: ${cap.capability}${cap.description ? ` — ${cap.description}` : ""}`)
          .join("\n")}`;

  return [
    `name: ${block.name}`,
    `responsibility: ${block.responsibility}`,
    ports(block.inputs, "inputs"),
    ports(block.outputs, "outputs"),
    capabilityText,
  ].join("\n");
}

export interface DecomposeOptions {
  parent: Block;
  /** What the whole project is for, so children are named in context. */
  projectGoal: string;
  /** Where this block sits, e.g. `rank-jobs/score-posting`. */
  blockPath: string;
  granularity: Granularity;
  depth: number;
  client: ModelClient;
  maxAttempts?: number;
}

function buildTaskPrompt(options: DecomposeOptions): string {
  const { parent, projectGoal, blockPath, granularity, depth } = options;

  return `## The software being built

${projectGoal}

## The block to decompose

It sits at ${blockPath}, ${depth === 0 ? "at the top of the hierarchy" : `${depth} level${depth === 1 ? "" : "s"} down`}.

${describeBlockContract(parent)}

## How finely to divide it

${GRANULARITY_GUIDANCE[granularity.level]}

The hierarchy may not go deeper than ${granularity.maxDepth} levels, and this block is at level ${depth}.${
    depth + 1 >= granularity.maxDepth
      ? " Its children will be the deepest level, so every child must be implementable as plain code."
      : ""
  }

Propose the children of this block, the wiring between them, and any capabilities the parent must gain.`;
}

interface EndpointRef {
  block?: string;
  port: string;
  role: "input" | "output" | "block";
}

function parseEndpoint(ref: string): EndpointRef | undefined {
  const split = ref.lastIndexOf(".");
  if (split <= 0 || split === ref.length - 1) return undefined;

  const head = ref.slice(0, split);
  const port = ref.slice(split + 1);

  if (head === "input") return { role: "input", port };
  if (head === "output") return { role: "output", port };
  return { role: "block", block: head, port };
}

/**
 * Turns a proposal into real blocks and reports everything wrong with it.
 * Nothing here talks to the model; it is the same check the rest of the
 * system applies to a hand-drawn diagram.
 */
export function buildBlocksFromProposal(
  parent: Block,
  proposal: Proposal,
): { parent: Block; children: Block[]; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const error = (message: string) => diagnostics.push({ severity: "error", message });

  const children: Block[] = [];
  const seen = new Set<string>();

  for (const proposed of proposal.children) {
    if (RESERVED_IDS.has(proposed.id)) {
      error(`"${proposed.id}" cannot be used as a block id because it is how wires refer to the parent's own ports.`);
      continue;
    }
    if (proposed.id === parent.id) {
      error(`A child cannot have the same id as its parent ("${parent.id}").`);
      continue;
    }
    if (seen.has(proposed.id)) {
      error(`Two children were both given the id "${proposed.id}".`);
      continue;
    }
    seen.add(proposed.id);

    const convertPorts = (
      ports: Record<string, { type: string; description?: string }> | undefined,
      label: string,
    ): Block["inputs"] => {
      const converted: Block["inputs"] = {};
      for (const [name, port] of Object.entries(ports ?? {})) {
        const parsed = tryParseType(port.type);
        if (!parsed.ok) {
          error(`The ${label} "${name}" of "${proposed.id}" has a type that could not be read: ${parsed.error}`);
          continue;
        }
        converted[name] = port.description
          ? { type: parsed.type, description: port.description }
          : { type: parsed.type };
      }
      return converted;
    };

    const candidate = {
      id: proposed.id,
      name: proposed.name,
      responsibility: proposed.responsibility,
      kind: "leaf" as const,
      inputs: convertPorts(proposed.inputs, "input"),
      outputs: convertPorts(proposed.outputs, "output"),
      capabilities: proposed.capabilities ?? {},
      children: [],
      wires: [],
      pinnedAsLeaf: false,
    };

    const parsed = blockSchema.safeParse(candidate);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        error(`Child "${proposed.id}" is not valid at ${issue.path.join(".") || "(root)"}: ${issue.message}`);
      }
      continue;
    }

    children.push(parsed.data);
  }

  const wires: Wire[] = [];
  for (const proposedWire of proposal.wires) {
    const from = parseEndpoint(proposedWire.from);
    const to = parseEndpoint(proposedWire.to);

    if (!from) {
      error(`The wire source "${proposedWire.from}" is not written as "input.port" or "child-id.port".`);
      continue;
    }
    if (!to) {
      error(`The wire destination "${proposedWire.to}" is not written as "output.port" or "child-id.port".`);
      continue;
    }
    if (from.role === "output") {
      error(`A wire cannot start at "${proposedWire.from}"; the parent's outputs are destinations, not sources.`);
      continue;
    }
    if (to.role === "input") {
      error(`A wire cannot end at "${proposedWire.to}"; the parent's inputs are sources, not destinations.`);
      continue;
    }

    const source: WireSource =
      from.role === "input" ? { from: "input", port: from.port } : { from: "block", block: from.block!, port: from.port };
    const target: WireTarget =
      to.role === "output" ? { to: "output", port: to.port } : { to: "block", block: to.block!, port: to.port };

    wires.push({ source, target });
  }

  const updatedParent: Block = {
    ...parent,
    kind: "composite",
    capabilities: { ...parent.capabilities, ...(proposal.addedParentCapabilities ?? {}) },
    children: proposal.children
      .filter((c) => seen.has(c.id))
      .map((c) =>
        c.mode === "each" && c.eachOver
          ? { block: c.id, mode: "each" as const, eachOver: c.eachOver }
          : { block: c.id, mode: "once" as const },
      ),
    wires,
  };

  diagnostics.push(...validateComposite(updatedParent, new Map(children.map((c) => [c.id, c]))));

  return { parent: updatedParent, children, diagnostics };
}

function describeProblems(diagnostics: Diagnostic[]): string {
  const errors = diagnostics.filter((d) => d.severity === "error");
  const lines = errors.map((d) => `- ${d.message}`).join("\n");
  return `That proposal does not hold together. These problems must be fixed:

${lines}

Produce a corrected proposal. Keep whatever was right; change only what these problems require.`;
}

export async function proposeDecomposition(options: DecomposeOptions): Promise<DecompositionResult> {
  const { client, parent } = options;
  const maxAttempts = options.maxAttempts ?? 3;
  const system = buildSystemPrompt();
  const messages: ModelTurn[] = [{ role: "user", content: buildTaskPrompt(options) }];

  let last: DecompositionResult | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const raw = await client.complete({ system, messages, schema: proposalSchema });

    let proposal: Proposal;
    try {
      proposal = proposalSchema.parse(JSON.parse(raw));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (attempt === maxAttempts) {
        throw new Error(`The model's decomposition could not be read after ${attempt} attempts: ${message}`);
      }
      messages.push({ role: "assistant", content: raw });
      messages.push({
        role: "user",
        content: `That response could not be read as a decomposition proposal: ${message}\n\nProduce a corrected proposal.`,
      });
      continue;
    }

    const built = buildBlocksFromProposal(parent, proposal);
    last = {
      proposal,
      parent: built.parent,
      children: built.children,
      furtherDecomposition: proposal.children.filter((c) => !c.likelyLeaf).map((c) => c.id),
      diagnostics: built.diagnostics,
      attempts: attempt,
    };

    const hasErrors = built.diagnostics.some((d) => d.severity === "error");
    if (!hasErrors) return last;

    if (attempt === maxAttempts) return last;

    messages.push({ role: "assistant", content: raw });
    messages.push({ role: "user", content: describeProblems(built.diagnostics) });
  }

  // Unreachable: the loop either returns or throws.
  throw new Error("Decomposition ended without a result.");
}
