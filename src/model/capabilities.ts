import type { Role } from "./roles.js";
import type { PortType } from "./types.js";

/**
 * The effects a block can ask for, described without reference to any one
 * language.
 *
 * A capability is an interface supplied from outside the block, which is what
 * lets any block run in isolation with a substitute in place. Operations are
 * described using the same port type language as everything else, so a
 * language pack can render them as a TypeScript interface, a Python protocol,
 * or whatever else fits — and none of that knowledge sits in the model.
 *
 * The catalogue is fixed for now. A user-defined capability is a real feature,
 * but nothing yet needs one, and a fixed set keeps generated code honest about
 * what a block can reach.
 */

export interface CapabilityOperation {
  /** Canonical name in lowerCamelCase; each pack renders it its own way. */
  name: string;
  description: string;
  parameters: { name: string; type: PortType }[];
  /** null when the operation returns nothing. */
  returns: PortType | null;
  /** Whether callers must wait for it. */
  async: boolean;
}

export interface CapabilityDefinition {
  name: string;
  description: string;
  operations: CapabilityOperation[];
  /**
   * The roles of the block this capability reaches, when it reaches one.
   *
   * A `Store` is a way into a particular database, file or structure, and a
   * `Queue` into a particular channel. Which one is not part of the
   * capability: the block says that with an access naming the port, so the
   * line already on the diagram is the same line the code runs along. Left
   * out for a capability that reaches nothing anyone drew, such as the clock.
   */
  reaches?: Role[];
  /**
   * The type a capability of this kind is written in terms of, filled in per
   * port from whatever the block it reaches exposes: a `Store` bound to a
   * table of accounts is a `Store<Account>`.
   *
   * Its operations refer to it as free text, which is exactly what it is from
   * the model's side — a name the pack fills in, never a type the model
   * checks.
   */
  parameter?: string;
}

const string: PortType = { kind: "string" };
const number: PortType = { kind: "number" };

/** Stands in for whatever a bound store holds; each pack renders it its own way. */
const ROW: PortType = { kind: "text", text: "Row" };
const MESSAGE: PortType = { kind: "text", text: "Message" };

export const CAPABILITIES: Record<string, CapabilityDefinition> = {
  Store: {
    name: "Store",
    description: "Reads and writes the rows of one table, file or structure.",
    reaches: ["database", "storage", "structure"],
    parameter: "Row",
    operations: [
      {
        name: "read",
        description: "One row by its key, or null when there is none.",
        parameters: [{ name: "key", type: string }],
        returns: { kind: "union", of: [ROW, { kind: "null" }] },
        async: true,
      },
      {
        name: "list",
        description: "Every row, in the order they were put in.",
        parameters: [],
        returns: { kind: "array", of: ROW },
        async: true,
      },
      {
        name: "write",
        description: "Puts a row under a key, replacing whatever was there.",
        parameters: [
          { name: "key", type: string },
          { name: "row", type: ROW },
        ],
        returns: null,
        async: true,
      },
      {
        name: "remove",
        description: "Takes a row away. Does nothing when there is none.",
        parameters: [{ name: "key", type: string }],
        returns: null,
        async: true,
      },
    ],
  },
  Queue: {
    name: "Queue",
    description: "Puts messages on one channel. Nothing waits for them to arrive.",
    reaches: ["queue"],
    parameter: "Message",
    operations: [
      {
        name: "send",
        description: "Puts one message on the channel.",
        parameters: [{ name: "message", type: MESSAGE }],
        returns: null,
        async: true,
      },
    ],
  },
  FileSystem: {
    name: "FileSystem",
    description: "Reads and writes files.",
    operations: [
      {
        name: "readFile",
        description: "Reads a file as text.",
        parameters: [{ name: "path", type: string }],
        returns: string,
        async: true,
      },
      {
        name: "writeFile",
        description: "Writes text to a file, replacing what was there.",
        parameters: [
          { name: "path", type: string },
          { name: "contents", type: string },
        ],
        returns: null,
        async: true,
      },
    ],
  },
  Http: {
    name: "Http",
    description: "Fetches over the network.",
    operations: [
      {
        name: "get",
        description: "Fetches a URL and returns the body as text.",
        parameters: [{ name: "url", type: string }],
        returns: string,
        async: true,
      },
    ],
  },
  Clock: {
    name: "Clock",
    description: "Reads the current time.",
    operations: [
      {
        name: "now",
        description: "Milliseconds since the epoch.",
        parameters: [],
        returns: number,
        async: false,
      },
    ],
  },
  Random: {
    name: "Random",
    description: "Produces random numbers.",
    operations: [
      {
        name: "next",
        description: "A number from 0 up to but not including 1.",
        parameters: [],
        returns: number,
        async: false,
      },
    ],
  },
  Logger: {
    name: "Logger",
    description: "Records what happened.",
    operations: [
      {
        name: "log",
        description: "Records one message.",
        parameters: [{ name: "message", type: string }],
        returns: null,
        async: false,
      },
    ],
  },
};

export function isKnownCapability(name: string): boolean {
  return Object.hasOwn(CAPABILITIES, name);
}

export function capabilityNames(): string[] {
  return Object.keys(CAPABILITIES);
}

/**
 * Whether a capability of this kind is a way into one particular block on the
 * diagram, and so needs an access naming the port to say which.
 */
export function reachesResource(name: string): boolean {
  return (CAPABILITIES[name]?.reaches?.length ?? 0) > 0;
}

/**
 * Whether what a capability of this kind is a way into can be put there before
 * a run, rather than only watched as the run puts it there.
 *
 * It is the same question as whether anything comes back out: a table can be
 * seeded because a block reads it, and a channel cannot because nothing on the
 * diagram reads one. Asked of the operations rather than written down beside
 * them, so the two cannot come to disagree.
 */
export function canRead(name: string): boolean {
  const definition = CAPABILITIES[name];
  if (!definition?.parameter) return false;

  const mentions = (type: PortType): boolean => {
    if (type.kind === "text") return type.text === definition.parameter;
    if (type.kind === "array") return mentions(type.of);
    if (type.kind === "union") return type.of.some(mentions);
    return false;
  };

  return definition.operations.some((operation) => operation.returns !== null && mentions(operation.returns));
}

/** The capability kinds that reach a block of this role, for saying what to use instead. */
export function capabilitiesReaching(role: Role): string[] {
  return Object.values(CAPABILITIES)
    .filter((capability) => capability.reaches?.includes(role))
    .map((capability) => capability.name);
}
