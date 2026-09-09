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
}

const string: PortType = { kind: "string" };
const number: PortType = { kind: "number" };

export const CAPABILITIES: Record<string, CapabilityDefinition> = {
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
