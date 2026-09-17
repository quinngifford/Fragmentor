import { z } from "zod/v4";
import { describeType, identifierPattern } from "./types.js";
import { tryParseType } from "./typeExpression.js";
import { ROLE_IDS, isArchitecture } from "./roles.js";
import type { Role } from "./roles.js";
import type { PortType } from "./types.js";

/**
 * A block.json file describes the diagram and nothing else.
 *
 * It deliberately does not record whether a block is implemented or whether
 * its tests pass. Those are facts about the working tree and the last test
 * run, and storing them here would create a second source of truth that could
 * disagree with reality. They are derived instead.
 *
 * The file is as small as an agent can write it. The folder gives a block its
 * id, having children is what makes it a composite, a port can be written as
 * just its type, and anything empty can be left out.
 */

export type BlockKind = "leaf" | "composite";

/**
 * How a project relates to its code. In `structured` mode the diagram is a
 * specification: Fragmentor generates the code between blocks, checks the
 * rest against it, and runs it. In `visual` mode the diagram is a picture of
 * code Fragmentor never touches, so its types are free text and nothing is
 * enforced beyond the diagram holding together.
 */
export type Mode = "structured" | "visual";

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

/**
 * One of the things an architecture block offers: a database table, a queue
 * channel, a service operation.
 *
 * Both directions are recorded because they genuinely differ for some of
 * them. A table gives back what was put in, so one shape covers it and the
 * file may write it once. An operation takes a request and returns a
 * response, which are rarely the same, and either may be nothing at all.
 */
export interface Exposed {
  /** What goes in: a row written, a request sent. Null when nothing does. */
  accepts: PortType | null;
  /** What comes back: a row read, a response returned. Null when nothing does. */
  returns: PortType | null;
  /**
   * The child block that answers this operation.
   *
   * Without it a service's operations and the blocks inside it are two lists
   * that never meet: the blocks show inputs arriving from nowhere, because
   * the call that feeds them is the one thing the diagram does not say. With
   * it the call can be followed from whoever makes it all the way to the code
   * that answers it.
   *
   * The two shapes need not match. An operation is what arrives at the edge
   * of the service; the block is what the code calls, and the framework
   * between them parses, validates and fills in whatever else it needs.
   */
  block?: string;
  description?: string;
}

/**
 * What a block does to a resource. A read takes data out, a write puts data
 * in, and a call does both: a request out and a response back.
 */
export type AccessVerb = "reads" | "writes" | "calls";

export const ACCESS_VERBS: AccessVerb[] = ["reads", "writes", "calls"];

/**
 * A block reaching a piece of the architecture: `reads app-db.users`.
 *
 * This is declared by the block that does the touching, the way a capability
 * is, rather than by its parent the way a wire is. A wire is a value handed
 * from one call to the next, which only the parent knows about; reaching a
 * database is something the block itself does, and stays true wherever the
 * block is moved to.
 *
 * The resource is named by id and found by looking outward: the block's
 * parent first, then its parent, up to the top of the system. That is how a
 * handler deep inside a service reaches a database the service keeps beside
 * it, without every level in between having to mention it.
 */
export interface Access {
  verb: AccessVerb;
  /** The id of the architecture block being touched. */
  resource: string;
  /** Which of its exposed entries, or null for the resource as a whole. */
  entry: string | null;
}

export function parseAccessText(text: string): { ok: true; access: Access } | { ok: false; error: string } {
  const parts = text.trim().split(/[ ]+/);
  if (parts.length !== 2) {
    return {
      ok: false,
      error: `An access must be written as "reads app-db.users" or "calls billing.charge", but this reads "${text}".`,
    };
  }

  const [verb, target] = parts as [string, string];
  if (!(ACCESS_VERBS as string[]).includes(verb)) {
    return { ok: false, error: `"${verb}" is not one of ${ACCESS_VERBS.join(", ")}.` };
  }

  const split = target.lastIndexOf(".");
  const resource = split === -1 ? target : target.slice(0, split);
  const entry = split === -1 ? null : target.slice(split + 1);

  if (!blockIdPattern.test(resource)) {
    return { ok: false, error: `"${resource}" is not a block id: it should be kebab-case, naming the block being reached.` };
  }
  if (entry !== null && !identifierPattern.test(entry)) {
    return { ok: false, error: `"${entry}" is not a valid name for one of "${resource}"'s entries.` };
  }

  return { ok: true, access: { verb: verb as AccessVerb, resource, entry } };
}

export function formatAccess(access: Access): string {
  return `${access.verb} ${access.resource}${access.entry === null ? "" : `.${access.entry}`}`;
}

export interface Block {
  id: string;
  name: string;
  responsibility: string;
  kind: BlockKind;
  /**
   * What kind of thing this block stands for. `function` is code Fragmentor
   * owns; every other role is a piece of the architecture the system talks
   * to, and nothing is generated, checked or run for it.
   */
  role: Role;
  /**
   * What it is exactly, within its role: `Dictionary`, `REST API`,
   * `PostgreSQL`. Free text, because no list of these would ever be finished,
   * and it changes nothing but the label — blocks of one role are drawn alike
   * however their subtypes differ.
   */
  subtype?: string;
  inputs: Record<string, Port>;
  outputs: Record<string, Port>;
  /** Architecture blocks only: the tables, channels or operations it offers. */
  exposes: Record<string, Exposed>;
  /** What this block reaches: `reads app-db.users`. Empty for a block that touches nothing. */
  access: Access[];
  capabilities: Record<string, CapabilityPort>;
  /** Composite only. Empty for leaves. */
  children: ChildRef[];
  /** Composite only. Empty for leaves. */
  wires: Wire[];
  /** The user has declared this block will not be decomposed further. */
  pinnedAsLeaf: boolean;
  /**
   * Part of the plan rather than of the program: drawn on the diagram so the
   * intended shape can be seen and argued with, with nothing generated,
   * checked or run for it. Planning spreads downward, so everything inside a
   * planned block is planned too.
   *
   * A loaded block carries the inherited value, not only what its own file
   * said. Anything that writes a loaded block back out would therefore record
   * inheritance as if it had been declared, which would survive the parent
   * being built; nothing does that today.
   */
  planned: boolean;
  /** Visual mode only: the file or folder, optionally `#name`, that this block stands for. */
  code?: string;
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

/** In visual mode a type is shown as the code writes it, and never checked. */
const typeText = z
  .string()
  .min(1, "a type cannot be empty")
  .transform((text): PortType => ({ kind: "text", text }));

/** Lets something usually written in full be written as just its main field. */
function orJust(field: string) {
  return (value: unknown) => (typeof value === "string" ? { [field]: value } : value);
}

/**
 * A planned block's types are free text for the same reason a visual block's
 * are: neither is Fragmentor's to enforce. What flows between planned blocks
 * is often exactly what has not been decided yet, so `"the scored postings"`
 * has to be as writable as `number[]`.
 */
function portSchema(freeText: boolean) {
  return z.preprocess(
    orJust("type"),
    z.object({ type: freeText ? typeText : typeExpression, description: z.string().optional() }).strict(),
  );
}

/**
 * A type on an architecture block: what a table holds, what an operation
 * returns.
 *
 * Nothing is generated, checked or run from these, so they are descriptions
 * rather than contracts. They are read with the ordinary type parser first,
 * because a schema written as `{ id: string; email: string }` can then be
 * drawn field by field on the block. Anything the parser does not recognise
 * — `timestamp`, `jsonb`, `Order[]` in a visual project — is kept as the
 * words it was written in rather than refused, because refusing it would cost
 * the person a correct diagram to gain a check nothing relies on.
 */
const describedType = z
  .string()
  .min(1, "a type cannot be empty")
  .transform((value): PortType => {
    const parsed = tryParseType(value);
    return parsed.ok ? parsed.type : { kind: "text", text: value };
  });

/**
 * Lets a store's entry be written once, as the one shape it holds: a table
 * gives back the rows it was given, so saying it twice would be noise. Either
 * the bare type or `{ "type": ..., "description": ... }` will do, and an
 * operation whose two directions differ writes them out as `accepts` and
 * `returns`.
 *
 * `type` is a real field rather than something rewritten before the schema
 * sees it, so writing it beside `accepts` is refused and said plainly. It
 * used to win silently, which threw away a direction someone had written.
 */
const exposedSchema = z.preprocess(
  (value) => (typeof value === "string" ? { type: value } : value),
  z
    .object({
      type: describedType.optional(),
      accepts: describedType.optional(),
      returns: describedType.optional(),
      block: blockId.optional(),
      description: z.string().optional(),
    })
    .strict()
    .refine((entry) => entry.type === undefined || (entry.accepts === undefined && entry.returns === undefined), {
      message: `"type" is short for both directions at once, so it cannot be written beside "accepts" or "returns"`,
      path: ["type"],
    })
    .refine(
      (entry) => entry.type !== undefined || entry.accepts !== undefined || entry.returns !== undefined,
      { message: "say what goes in, what comes back, or both: nothing at all describes nothing" },
    )
    .transform((entry): Exposed => ({
      accepts: entry.type ?? entry.accepts ?? null,
      returns: entry.type ?? entry.returns ?? null,
      ...(entry.block === undefined ? {} : { block: entry.block }),
      ...(entry.description === undefined ? {} : { description: entry.description }),
    })),
);

const accessSchema = z.string().transform((value, ctx): Access => {
  const parsed = parseAccessText(value);
  if (!parsed.ok) {
    ctx.addIssue({ code: "custom", message: parsed.error });
    return z.NEVER;
  }
  return parsed.access;
});

const capabilityPortSchema = z.preprocess(
  orJust("capability"),
  z.object({ capability: z.string().min(1), description: z.string().optional() }).strict(),
);

const childRefSchema = z
  .preprocess(orJust("block"), z.object({ block: blockId, each: portName.optional() }).strict())
  .transform((child): ChildRef =>
    child.each === undefined
      ? { block: child.block, mode: "once" }
      : { block: child.block, mode: "each", eachOver: child.each },
  );

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

function blockFileSchema(mode: Mode, planned: boolean) {
  const freeText = mode === "visual" || planned;
  return z
    .object({
      name: z.string().min(1).optional(),
      responsibility: z.string().min(1, "every block must state what it is responsible for"),
      role: z
        .enum(ROLE_IDS as [Role, ...Role[]], {
          error: `must be one of ${ROLE_IDS.join(", ")}. Leave it out for an ordinary function block.`,
        })
        .default("function"),
      subtype: z.string().min(1, "a subtype cannot be empty").optional(),
      planned: z.boolean().default(false),
      code: z.string().min(1).optional(),
      inputs: z.record(portName, portSchema(freeText)).default({}),
      outputs: z.record(portName, portSchema(freeText)).default({}),
      exposes: z.record(portName, exposedSchema).default({}),
      access: z.array(accessSchema).default([]),
      capabilities: z.record(portName, capabilityPortSchema).default({}),
      children: z.array(childRefSchema).default([]),
      wires: z.array(wireSchema).default([]),
      pinnedAsLeaf: z.boolean().default(false),
    })
    .strict()
    .refine((file) => file.children.length > 0 || file.wires.length === 0, {
      message: "a block with no children cannot have wires",
      path: ["wires"],
    })
    .refine((file) => mode === "visual" || file.code === undefined, {
      message: `"code" is only for visual mode. In structured mode a block's code is the implementation file in its folder.`,
      path: ["code"],
    })
    .refine((file) => !(planned || file.planned) || file.code === undefined, {
      message: "a planned block stands for code that does not exist yet, so it cannot point at any",
      path: ["code"],
    })
    // An architecture block is a thing the system talks to, not a function
    // that is called, so it has no ports to be called through and no
    // capabilities to be given. What it offers goes in "exposes" instead, and
    // what reaches it says so with "access".
    .refine(
      (file) => !isArchitecture(file.role) || Object.keys(file.inputs).length + Object.keys(file.outputs).length === 0,
      {
        message: `a block with an architecture role is not called, so it has no inputs or outputs. Describe what it offers with "exposes", and join blocks to it with "access".`,
        path: ["inputs"],
      },
    )
    .refine((file) => !isArchitecture(file.role) || Object.keys(file.capabilities).length === 0, {
      message: `capabilities are what a function's code is handed when it runs. An architecture block is not code Fragmentor runs, so it declares none.`,
      path: ["capabilities"],
    })
    .refine((file) => isArchitecture(file.role) || file.subtype === undefined, {
      message: `"subtype" says what kind of thing a block is exactly, which only means something once it has a "role".`,
      path: ["subtype"],
    })
    .refine((file) => isArchitecture(file.role) || Object.keys(file.exposes).length === 0, {
      message: `"exposes" describes the tables, channels or operations of an architecture block. A function block's interface is its inputs and outputs, so give it a "role" or use those.`,
      path: ["exposes"],
    });
}

/** `price-order` -> `Price Order`: the label a block gets when its file does not give one. */
export function nameFromId(id: string): string {
  return id
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Reads the contents of a block.json as the block in folder `id`. Each problem
 * says where it is, e.g. `inputs.order.type: Unknown type "Order"`, because
 * whoever wrote the file has to find it.
 */
export function parseBlockFile(
  raw: unknown,
  id: string,
  mode: Mode = "structured",
  /** True when a block above this one is planned, which makes this one planned too. */
  plannedAbove = false,
): { ok: true; block: Block } | { ok: false; problems: string[] } {
  if (!blockIdPattern.test(id)) {
    return { ok: false, problems: [`the folder name "${id}" must be kebab-case (lowercase letters, digits, single hyphens)`] };
  }

  // Which schema the ports get depends on whether this block is planned, so
  // that is settled before the file is read. It cannot wait until afterwards:
  // a planned block's types are words, which the strict schema refuses.
  // Anything other than `true` falls through to the schema, which says what a
  // planned flag may be.
  const planned =
    plannedAbove || (typeof raw === "object" && raw !== null && (raw as { planned?: unknown }).planned === true);

  const parsed = blockFileSchema(mode, planned).safeParse(raw);
  if (!parsed.success) {
    return { ok: false, problems: parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`) };
  }

  const file = parsed.data;
  const block: Block = {
    id,
    name: file.name ?? nameFromId(id),
    responsibility: file.responsibility,
    kind: file.children.length > 0 ? "composite" : "leaf",
    role: file.role,
    inputs: file.inputs,
    outputs: file.outputs,
    exposes: file.exposes,
    access: file.access,
    capabilities: file.capabilities,
    children: file.children,
    wires: file.wires,
    pinnedAsLeaf: file.pinnedAsLeaf,
    planned,
  };
  if (file.code !== undefined) block.code = file.code;
  if (file.subtype !== undefined) block.subtype = file.subtype;
  return { ok: true, block };
}

/** The same, for a file already known to be valid, such as an example written in code. */
export function blockFromFile(raw: unknown, id: string, mode: Mode = "structured", plannedAbove = false): Block {
  const result = parseBlockFile(raw, id, mode, plannedAbove);
  if (!result.ok) throw new Error(`"${id}" is not a valid block:\n  ${result.problems.join("\n  ")}`);
  return result.block;
}

/** The smallest block.json that reads back as the same block. */
export function blockToFileShape(block: Block): Record<string, unknown> {
  const ports = (record: Record<string, Port>) =>
    Object.fromEntries(
      Object.entries(record).map(([name, port]) => [
        name,
        port.description ? { type: describeType(port.type), description: port.description } : describeType(port.type),
      ]),
    );

  const capabilities = Object.fromEntries(
    Object.entries(block.capabilities).map(([name, cap]) => [
      name,
      cap.description ? { capability: cap.capability, description: cap.description } : cap.capability,
    ]),
  );

  /** A store's entry collapses back to the one shape it was written as. */
  const exposes = Object.fromEntries(
    Object.entries(block.exposes).map(([name, entry]) => {
      const accepts = entry.accepts === null ? undefined : describeType(entry.accepts);
      const returns = entry.returns === null ? undefined : describeType(entry.returns);
      const extra = {
        ...(entry.block === undefined ? {} : { block: entry.block }),
        ...(entry.description === undefined ? {} : { description: entry.description }),
      };
      // A store holds one shape, so both directions collapse back to how it
      // was most likely written: the bare type, or the type with a note.
      if (accepts !== undefined && accepts === returns) {
        return Object.keys(extra).length === 0 ? [name, accepts] : [name, { type: accepts, ...extra }];
      }
      return [
        name,
        {
          ...(accepts === undefined ? {} : { accepts }),
          ...(returns === undefined ? {} : { returns }),
          ...extra,
        },
      ];
    }),
  );

  const file: Record<string, unknown> = {};
  if (block.name !== nameFromId(block.id)) file.name = block.name;
  file.responsibility = block.responsibility;
  if (block.role !== "function") file.role = block.role;
  if (block.subtype !== undefined) file.subtype = block.subtype;
  if (block.planned) file.planned = true;
  if (block.code !== undefined) file.code = block.code;
  if (Object.keys(block.inputs).length > 0) file.inputs = ports(block.inputs);
  if (Object.keys(block.outputs).length > 0) file.outputs = ports(block.outputs);
  if (Object.keys(block.exposes).length > 0) file.exposes = exposes;
  if (block.access.length > 0) file.access = block.access.map(formatAccess);
  if (Object.keys(block.capabilities).length > 0) file.capabilities = capabilities;
  if (block.children.length > 0) {
    file.children = block.children.map((child) =>
      child.mode === "each" ? { block: child.block, each: child.eachOver } : child.block,
    );
  }
  if (block.wires.length > 0) file.wires = block.wires.map(formatWire);
  if (block.pinnedAsLeaf) file.pinnedAsLeaf = true;
  return file;
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
