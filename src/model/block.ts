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
 * id, the folders inside it are its parts, a port can be written as just its
 * type, and anything empty can be left out.
 *
 * What a block contains is what it is made of, and nothing more. A block's
 * children are not steps it runs or functions it calls in some order; what
 * runs when is an execution's business, recorded or written down as a trace
 * (see `trace.ts`), never the tree's.
 */

export interface Port {
  type: PortType;
  description?: string;
}

/**
 * An effect the block needs supplied from outside: a database, HTTP access,
 * the clock. A block that calls another hands it its own `caps`, so a caller
 * has to hold every capability, under the same name, that the blocks it calls
 * ask for. The typechecker holds it to that at the call.
 */
export interface CapabilityPort {
  capability: string;
  description?: string;
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

export interface Access {
  /**
   * What at this end does the reaching, or null for the block as a whole.
   *
   * On an architecture block it is one of its own entries. A client with five
   * buttons calling five operations is five separate things happening, and
   * without this they would all leave the block at one point and say only
   * that the two are connected. Named at both ends, the line runs from the
   * button to the operation it triggers, which is what it actually does.
   *
   * On a function block it is one of its capability ports, and that is how a
   * `Store` or `Queue` learns which block it is a way into. The alternative
   * was a second field on the capability saying the same thing the access
   * already says, which could then disagree with it. This way the line drawn
   * on the diagram and the line the code runs along cannot come apart: there
   * is only one of them.
   */
  from: string | null;
  verb: AccessVerb;
  /**
   * The architecture block being touched: its id, found by looking outward
   * from the block that reaches it, or a path from a block found that way,
   * such as `infrastructure/db` for a database kept inside a group of them.
   */
  resource: string;
  /** Which of its exposed entries, or null for the resource as a whole. */
  entry: string | null;
}

export function parseAccessText(text: string): { ok: true; access: Access } | { ok: false; error: string } {
  const parts = text.trim().split(/[ ]+/);
  if (parts.length !== 2 && parts.length !== 3) {
    return {
      ok: false,
      error: `An access must be written as "reads app-db.users", or "accounts reads app-db.users" to name the capability port or entry at this end of it, but this reads "${text}".`,
    };
  }

  const [from, verb, target] =
    parts.length === 3 ? (parts as [string, string, string]) : [null, ...(parts as [string, string])];

  if (!(ACCESS_VERBS as string[]).includes(verb)) {
    return { ok: false, error: `"${verb}" is not one of ${ACCESS_VERBS.join(", ")}.` };
  }
  if (from !== null && !identifierPattern.test(from)) {
    return { ok: false, error: `"${from}" is not a valid name for a capability port or an entry of this block.` };
  }

  const split = target.lastIndexOf(".");
  const resource = split === -1 ? target : target.slice(0, split);
  const entry = split === -1 ? null : target.slice(split + 1);

  if (!resource.split("/").every((segment) => blockIdPattern.test(segment))) {
    return {
      ok: false,
      error: `"${resource}" is not a block id: it should be kebab-case, naming the block being reached, or a path to it such as "infrastructure/db".`,
    };
  }
  if (entry !== null && !identifierPattern.test(entry)) {
    return { ok: false, error: `"${entry}" is not a valid name for one of "${resource}"'s entries.` };
  }

  return { ok: true, access: { from, verb: verb as AccessVerb, resource, entry } };
}

export function formatAccess(access: Access): string {
  const target = `${access.resource}${access.entry === null ? "" : `.${access.entry}`}`;
  return `${access.from === null ? "" : `${access.from} `}${access.verb} ${target}`;
}

export interface Block {
  id: string;
  name: string;
  responsibility: string;
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
  /**
   * Where this block's implementation lives: a file or folder relative to the
   * project, optionally followed by `#` and the name of a function, class or
   * method. Every function block that is not planned has one, because the
   * code's layout is the codebase's business and not the diagram's.
   */
  code?: string;
}

/** Block ids are folder names, so they are kebab-case and filesystem-safe. */
export const blockIdPattern = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

const blockId = z
  .string()
  .regex(blockIdPattern, "must be kebab-case (lowercase letters, digits, single hyphens)");

const portName = z.string().regex(identifierPattern, "port names must be valid identifiers");

/** Lets something usually written in full be written as just its main field. */
function orJust(field: string) {
  return (value: unknown) => (typeof value === "string" ? { [field]: value } : value);
}

/**
 * A port's type is read with the type parser first, and kept as the words it
 * was written in when the parser does not recognise them.
 *
 * Both happen in real projects. A block Fragmentor generates a contract for
 * needs `{ id: string }[]`, and gets a contract, a form and a check out of it.
 * A block standing for code that already exists writes what that code writes,
 * `Promise<Order[]>`, and a planned block writes `"the scored postings"`,
 * because what flows between planned blocks is usually the thing still being
 * decided. Refusing either would cost a correct diagram to gain a check
 * nothing can rely on; `fragmentor check` says instead what it cannot do with
 * words.
 */
function portSchema() {
  return z.preprocess(
    orJust("type"),
    z.object({ type: describedType, description: z.string().optional() }).strict(),
  );
}

/**
 * Every type in a block file: a port's, a table's, an operation's.
 *
 * On disk a type is written the way a developer writes types, e.g.
 * `{ title: string; salary?: number }[]`. In memory it is the structured form
 * the test bench walks to build a form, and describeType and parseType are
 * exact inverses, so the file stays readable without the structure being
 * lossy. Anything the parser does not recognise — `timestamp`, `jsonb`,
 * `Promise<Order[]>` — is kept as the words it was written in rather than
 * refused, because refusing it would cost a correct diagram to gain a check
 * nothing can rely on. What Fragmentor cannot then do with it, `fragmentor
 * check` says.
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

function blockFileSchema(planned: boolean) {
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
      inputs: z.record(portName, portSchema()).default({}),
      outputs: z.record(portName, portSchema()).default({}),
      exposes: z.record(portName, exposedSchema).default({}),
      access: z.array(accessSchema).default([]),
      capabilities: z.record(portName, capabilityPortSchema).default({}),
      pinnedAsLeaf: z.boolean().default(false),
    })
    .strict()
    // Only what this file itself says: a block planned from above was written
    // before whatever holds it became a plan, and refusing to read it would
    // take the whole diagram down for a pointer nothing looks at.
    .refine((file) => !file.planned || file.code === undefined, {
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
      message: `"exposes" describes the tables, channels or operations of an architecture block. A function block's interface is its inputs and outputs, where it has any, so give it a "role" or use those.`,
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
  /** True when a block above this one is planned, which makes this one planned too. */
  plannedAbove = false,
): { ok: true; block: Block } | { ok: false; problems: string[] } {
  if (!blockIdPattern.test(id)) {
    return { ok: false, problems: [`the folder name "${id}" must be kebab-case (lowercase letters, digits, single hyphens)`] };
  }

  // Both belonged to the model this one replaced, in which a block's
  // children were steps wired output to input. Saying so is worth more than
  // "unrecognised key", because the fix is to stop describing order at all.
  if (typeof raw === "object" && raw !== null) {
    const retired = [
      "children" in raw
        ? `children: a block's parts are the block folders inside its folder, so there is no list of them to keep. Remove "children".`
        : null,
      "wires" in raw
        ? `wires: blocks are not wired together. Code calls the blocks it needs directly, and what happens when is an execution's trace, not the diagram. Remove "wires".`
        : null,
    ].filter((problem): problem is string => problem !== null);
    if (retired.length > 0) return { ok: false, problems: retired };
  }

  // Which schema the ports get depends on whether this block is planned, so
  // that is settled before the file is read. It cannot wait until afterwards:
  // a planned block's types are words, which the strict schema refuses.
  // Anything other than `true` falls through to the schema, which says what a
  // planned flag may be.
  const planned =
    plannedAbove || (typeof raw === "object" && raw !== null && (raw as { planned?: unknown }).planned === true);

  const parsed = blockFileSchema(planned).safeParse(raw);
  if (!parsed.success) {
    return { ok: false, problems: parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`) };
  }

  const file = parsed.data;
  const block: Block = {
    id,
    name: file.name ?? nameFromId(id),
    responsibility: file.responsibility,
    role: file.role,
    inputs: file.inputs,
    outputs: file.outputs,
    exposes: file.exposes,
    access: file.access,
    capabilities: file.capabilities,
    pinnedAsLeaf: file.pinnedAsLeaf,
    planned,
  };
  if (file.code !== undefined) block.code = file.code;
  if (file.subtype !== undefined) block.subtype = file.subtype;
  return { ok: true, block };
}

/** The same, for a file already known to be valid, such as an example written in code. */
export function blockFromFile(raw: unknown, id: string, plannedAbove = false): Block {
  const result = parseBlockFile(raw, id, plannedAbove);
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
