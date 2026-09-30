/**
 * The sentences a rule is written in, and which pairs of blocks may have one.
 *
 * A rule is the person's guard rail over the architecture: "app/workers must
 * never reach app/client", or "only tickets/booking-api may reach
 * tickets/tickets-db". Each names two blocks by their absolute paths, and a
 * path means that block and everything inside it, so a rule between two
 * groups needs no wildcards. There are no verbs, entries or transitive rules:
 * a rule is about which parts may touch which, not how.
 *
 * This module is shared by the kernel, which checks the rules, and the
 * window, which offers them, so the two can never disagree about what a rule
 * says. The window loads it as a plain module, so nothing here may import
 * zod or anything of Node's.
 */

export type RuleKind = "never" | "only";

export interface ParsedRule {
  kind: RuleKind;
  /** The reaching side: what is held back by "never", or alone let through by "only". */
  from: string;
  /** The block the rule protects. */
  to: string;
}

/** Where the rules live, written by the application and committed with the project. */
export const RULES_FILE = ".fragmentor/rules.json";

/**
 * A block's path and nothing else: no dot, so a rule can never name an entry.
 * A rule is about blocks, because entries are how something is reached and a
 * rule only says whether it may be.
 */
const PATH = /^[^\s.]+(\/[^\s.]+)*$/;

export function formatRule(rule: ParsedRule): string {
  return rule.kind === "never" ? `${rule.from} must never reach ${rule.to}` : `only ${rule.from} may reach ${rule.to}`;
}

/** The rule a sentence writes down, or null when it is not one of the two sentences. */
export function parseRule(text: string): ParsedRule | null {
  const never = /^(\S+) must never reach (\S+)$/.exec(text);
  const only = /^only (\S+) may reach (\S+)$/.exec(text);
  const match = never ?? only;
  if (match === null || !PATH.test(match[1]!) || !PATH.test(match[2]!)) return null;
  return { kind: never !== null ? "never" : "only", from: match[1]!, to: match[2]! };
}

/** As much of a block as a refusal needs to know. */
export interface RuleBlock {
  path: string;
  name: string;
  role: string;
}

/** The roles that are only ever reached, so a rule from one would watch for something that cannot happen. */
const REACHED_ONLY = new Set(["database", "storage", "structure", "queue"]);

const inside = (root: string, path: string) => path === root || path.startsWith(`${root}/`);

/**
 * Why there can be no rule between these two blocks, as a plain sentence, or
 * null when there can. The reasons are structural — the pair could never
 * break the rule, or already has one — so the window can refuse before
 * anything is written.
 */
export function refuseRule(kind: RuleKind, from: RuleBlock, to: RuleBlock, existing: string[]): string | null {
  if (from.path === to.path) return "A rule needs two different blocks.";
  if (inside(to.path, from.path)) return `"${from.name}" is inside "${to.name}", so it may always reach it.`;
  if (inside(from.path, to.path)) return `"${to.name}" is inside "${from.name}", which may always reach its own parts.`;
  if (from.path.split("/")[0] !== to.path.split("/")[0]) {
    return `"${from.name}" and "${to.name}" are separate programs, which never reach each other anyway.`;
  }
  if (REACHED_ONLY.has(from.role)) return `"${from.name}" is a ${from.role}: it is reached, and never reaches anything itself.`;
  if (existing.includes(formatRule({ kind, from: from.path, to: to.path }))) return "That is already a rule.";
  return null;
}
