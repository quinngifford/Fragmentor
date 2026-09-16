/**
 * What a block stands for in the system.
 *
 * Until now every block was a function, which is enough to describe a program
 * but not enough to describe an application. A function that loads a user
 * showed an input arriving from nowhere and rows leaving for nowhere; where
 * the data actually lived was not on the diagram at all. A role says what
 * kind of thing a block is, so a database, a queue or another team's service
 * can be drawn as itself and the functions that touch it can be joined to it.
 *
 * Exactly one role is code: `function`. Every other role is architecture —
 * something the system talks to, rather than something Fragmentor writes,
 * checks or runs. That single distinction is what the rest of the system
 * branches on, so adding a role is adding a description, not a code path.
 */

export type Role = "function" | "service" | "external" | "database" | "storage" | "queue" | "client";

/**
 * How the things a block exposes are shaped.
 *
 * `store` entries hold data: a table, a bucket, a channel. One shape covers
 * both directions, because what is put in is what comes back out.
 *
 * `operations` entries answer requests, so the two directions differ: what is
 * sent, and what comes back.
 */
export type ExposeShape = "store" | "operations";

export interface RoleDefinition {
  id: Role;
  /** Shown on the block, in capitals. */
  label: string;
  /** What kind of thing this is, in the agent's guide and the inspector. */
  description: string;
  /** What an entry under `exposes` stands for here, singular: "table", "operation". */
  entryNoun: string;
  shape: ExposeShape;
  /** True only for `function`: Fragmentor generates, checks and runs it. */
  isCode: boolean;
}

export const ROLES: Record<Role, RoleDefinition> = {
  function: {
    id: "function",
    label: "FUNCTION",
    description: "Code that runs: a function with typed inputs and outputs. This is what a block is unless it says otherwise.",
    entryNoun: "port",
    shape: "store",
    isCode: true,
  },
  service: {
    id: "service",
    label: "SERVICE",
    description:
      "A program of ours that answers requests: a backend, a microservice, a web server, a worker. Its children, if it has any, are ordinary blocks.",
    entryNoun: "operation",
    shape: "operations",
    isCode: false,
  },
  external: {
    id: "external",
    label: "EXTERNAL",
    description:
      "Something outside the system that we do not write: a third-party API, a payment provider, another team's service. A black box with a known interface.",
    entryNoun: "operation",
    shape: "operations",
    isCode: false,
  },
  database: {
    id: "database",
    label: "DATABASE",
    description: "A database. Each entry is a table or collection, and its shape is that table's schema.",
    entryNoun: "table",
    shape: "store",
    isCode: false,
  },
  storage: {
    id: "storage",
    label: "STORAGE",
    description: "Files, objects, blobs or a cache. Each entry is a bucket, a path or a set of keys, and its shape is what is kept there.",
    entryNoun: "store",
    shape: "store",
    isCode: false,
  },
  queue: {
    id: "queue",
    label: "QUEUE",
    description: "A queue, topic or event stream. Each entry is a channel, and its shape is the message carried on it.",
    entryNoun: "channel",
    shape: "store",
    isCode: false,
  },
  client: {
    id: "client",
    label: "CLIENT",
    description:
      "Who or what sets the system going: a browser, a mobile app, a command-line tool, a scheduled job, a webhook from outside. This is where data originates.",
    entryNoun: "action",
    shape: "operations",
    isCode: false,
  },
};

export const ROLE_IDS = Object.keys(ROLES) as Role[];

/** Every role but `function`: something the system talks to rather than code Fragmentor owns. */
export const ARCHITECTURE_ROLES = ROLE_IDS.filter((role) => !ROLES[role].isCode);

/**
 * Whether a block stands for something the system talks to rather than code.
 *
 * Everything that treats architecture differently asks this rather than
 * comparing roles, so a new role needs no change anywhere else: nothing is
 * generated for it, nothing is checked in it, nothing runs, and its wiring is
 * read as a description rather than as a specification.
 */
export function isArchitecture(role: Role): boolean {
  return !ROLES[role].isCode;
}

export function roleLabel(role: Role): string {
  return ROLES[role].label;
}

/**
 * How a block's exposed entries are worded in a sentence: "tables", "channels",
 * "operations". Used wherever a message has to name them.
 */
export function entryNoun(role: Role, plural = false): string {
  const noun = ROLES[role].entryNoun;
  return plural ? `${noun}s` : noun;
}
