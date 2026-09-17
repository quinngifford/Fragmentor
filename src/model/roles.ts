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
 *
 * A role is the general kind. What something is exactly — a dictionary, a
 * REST API, PostgreSQL — is the block's own `subtype`, written as free text
 * rather than chosen from a list, because no list of those would ever be
 * finished. Blocks of one role share a colour however their subtypes differ.
 */

export type Role =
  | "function"
  | "service"
  | "external"
  | "database"
  | "storage"
  | "queue"
  | "structure"
  | "client";

export interface RoleDefinition {
  /** Shown on the block, in capitals, ahead of the subtype. */
  label: string;
  /** What kind of thing this is, in the agent's guide and the inspector. */
  description: string;
  /** What an entry under `exposes` stands for here, singular: "table", "operation". */
  entryNoun: string;
  /** Examples of what a block of this role might be exactly, to show what a subtype is for. */
  subtypes: string[];
  /** True only for `function`: Fragmentor generates, checks and runs it. */
  isCode: boolean;
}

export const ROLES: Record<Role, RoleDefinition> = {
  function: {
    label: "FUNCTION",
    description: "Code that runs: a function with typed inputs and outputs. This is what a block is unless it says otherwise.",
    entryNoun: "port",
    subtypes: [],
    isCode: true,
  },
  service: {
    label: "SERVICE",
    description:
      "A program of ours that answers requests. The blocks inside one are ordinary blocks, written, checked and run as usual.",
    entryNoun: "operation",
    subtypes: ["REST API", "GraphQL API", "worker", "scheduled job"],
    isCode: false,
  },
  external: {
    label: "EXTERNAL",
    description:
      "Something outside the system we do not write: a third-party API, another team's service. A black box with a known interface.",
    entryNoun: "operation",
    subtypes: ["payment provider", "mail service", "another team's API"],
    isCode: false,
  },
  database: {
    label: "DATABASE",
    description: "A database. Each entry is a table or collection, and its shape is that table's schema.",
    entryNoun: "table",
    subtypes: ["PostgreSQL", "MongoDB", "SQLite"],
    isCode: false,
  },
  storage: {
    label: "STORAGE",
    description: "Files, objects or blobs kept outside the program. Each entry is a bucket, a path or a set of keys.",
    entryNoun: "store",
    subtypes: ["JSON file", "S3 bucket", "object store"],
    isCode: false,
  },
  queue: {
    label: "QUEUE",
    description: "A queue, topic or event stream. Each entry is a channel, and its shape is the message carried on it.",
    entryNoun: "channel",
    subtypes: ["Kafka topic", "message queue", "event stream"],
    isCode: false,
  },
  structure: {
    label: "DATA STRUCTURE",
    description:
      "Data the program holds in memory rather than keeps outside itself: an index, a cache, a table of state that several blocks read.",
    entryNoun: "part",
    subtypes: ["dictionary", "array", "set", "LRU cache"],
    isCode: false,
  },
  client: {
    label: "CLIENT",
    description:
      "Who or what sets the system going, and where data first comes from: a browser, a mobile app, a command-line tool, a scheduled job.",
    entryNoun: "action",
    subtypes: ["browser", "mobile app", "command-line tool"],
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

/** `DATABASE: PostgreSQL`, or just `DATABASE` where the block does not say. */
export function roleLabel(role: Role, subtype?: string): string {
  return subtype ? `${ROLES[role].label}: ${subtype}` : ROLES[role].label;
}
