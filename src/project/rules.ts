import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v4";
import { formatAccess } from "../model/block.js";
import { RULES_FILE, formatRule, parseRule, refuseRule } from "../model/rules.js";
import type { RuleKind } from "../model/rules.js";
import { ignoreAllButShared, under } from "./history.js";
import { loadProject, resolveAccess } from "./project.js";
import type { Project, ProjectDiagnostic } from "./project.js";
import type { ProjectReach } from "./reach.js";

/**
 * The person's rules over the architecture, and what stands with them.
 *
 * A rule is made and removed by clicking in the window, never written by the
 * agent: a guard rail written by the party it constrains guards nothing. The
 * file is committed with the project, like notes, so the rules travel with
 * it and git records every change. Each rule is checked against everything
 * known about reach — the access the diagram declares and what the code was
 * read to do — every time the project is read, so the agent's `fragmentor
 * check` and the window can never disagree about whether one is broken.
 *
 * A break Fragmentor is sure of is an error, which stops the agent's check.
 * One it could only guess at — a file it had to count whole, or a planned
 * block, which has no code to read — is a warning, because a guess must
 * never block the agent.
 */

export { RULES_FILE };

export interface Rule {
  /** The sentence, e.g. `app/workers must never reach app/client`. */
  rule: string;
  /** The person's reason, when they gave one. */
  why?: string;
}

/** One rule, evaluated, as the window and the check report read it. */
export interface SnapshotRule {
  rule: string;
  kind: RuleKind;
  from: string;
  to: string;
  fromName: string;
  toName: string;
  why: string | null;
  /** The blocks whose reach breaks it, by path, sorted. Empty while it is kept. */
  brokenBy: string[];
  /** The subset of brokenBy whose break is a guess, so it warns rather than stops the check. */
  guessed: string[];
  /** True when the code could not be read for reach, so only declared access was checked. */
  declaredOnly: boolean;
  /** What is wrong with the rule itself: it names a block that is not in the diagram. */
  problem: string | null;
}

const rulesFileSchema = z
  .object({
    rules: z.array(z.object({ rule: z.string().min(1), why: z.string().min(1).optional() }).strict()),
  })
  .strict();

/** Whether a path, relative to the project with either kind of slash, is the rules file. */
export function isRulesPath(file: string): boolean {
  return file.replace(/\\/g, "/") === RULES_FILE;
}

const rulesPath = (projectDir: string) => path.join(projectDir, ...RULES_FILE.split("/"));

/**
 * The rules as the file holds them. It never throws: a missing file means
 * there are none yet, and a file that cannot be read is a problem to report,
 * never a reason the project cannot open.
 */
export async function loadRules(projectDir: string): Promise<{ rules: Rule[]; problem: string | null }> {
  let text: string;
  try {
    text = await readFile(rulesPath(projectDir), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { rules: [], problem: null };
    return { rules: [], problem: "it could not be read." };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { rules: [], problem: `it is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const parsed = rulesFileSchema.safeParse(raw);
  if (!parsed.success) {
    return { rules: [], problem: parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ") };
  }
  return { rules: parsed.data.rules, problem: null };
}

async function writeRules(projectDir: string, rules: Rule[]): Promise<void> {
  if (rules.length === 0) {
    await rm(rulesPath(projectDir), { force: true });
    return;
  }
  await ignoreAllButShared(projectDir);
  await writeFile(rulesPath(projectDir), `${JSON.stringify({ rules }, null, 2)}\n`, "utf8");
}

/**
 * Adds a rule the person made by clicking. The sentence is parsed and the
 * pair checked against the project as it is, so nothing unspeakable can
 * reach the file, and a file that cannot be read is never written over,
 * which would lose whatever it still says.
 */
export async function addRule(projectDir: string, text: string, why?: string): Promise<void> {
  const parsed = parseRule(text);
  if (parsed === null) {
    throw new Error(`"${text}" is not a rule. A rule reads "app/workers must never reach app/client" or "only app/api may reach app/db".`);
  }
  const project = await loadProject(projectDir);
  const named = (blockPath: string) => {
    const node = project.byPath.get(blockPath);
    if (node === undefined) throw new Error(`There is no block at ${blockPath}.`);
    return { path: blockPath, name: node.block.name, role: node.block.role };
  };
  const loaded = await loadRules(projectDir);
  if (loaded.problem !== null) throw new Error(`The rules file cannot be read, so nothing can be added to it: ${loaded.problem}`);
  const refused = refuseRule(parsed.kind, named(parsed.from), named(parsed.to), loaded.rules.map((each) => each.rule));
  if (refused !== null) throw new Error(refused);
  const reason = why?.trim();
  await writeRules(projectDir, [...loaded.rules, { rule: formatRule(parsed), ...(reason ? { why: reason } : {}) }]);
}

/** Removes a rule by its sentence. Removing the last one removes the file. */
export async function removeRule(projectDir: string, text: string): Promise<void> {
  const loaded = await loadRules(projectDir);
  if (loaded.problem !== null) throw new Error(`The rules file cannot be read, so nothing can be removed from it: ${loaded.problem}`);
  const kept = loaded.rules.filter((each) => each.rule !== text);
  if (kept.length === loaded.rules.length) throw new Error("That rule is not there any more.");
  await writeRules(projectDir, kept);
}

/** One way a block was seen to reach another: what the diagram declares, or what the code was read to do. */
interface ReachSeen {
  from: string;
  to: string;
  evidence: string;
  /** True when Fragmentor read it exactly, rather than counting a file whole. */
  exact: boolean;
}

/**
 * Every rule held against everything known about reach: the access each
 * block declares, resolved as the diagram resolves it, and the edges read
 * from the code. Pure, so two evaluations of the same project say exactly
 * the same words, and a diagnostic the person flagged is recognised again.
 */
export function evaluateRules(project: Project, reach: ProjectReach | null, rules: Rule[]): { rules: SnapshotRule[]; diagnostics: ProjectDiagnostic[] } {
  const seen: ReachSeen[] = [];
  for (const [blockPath, node] of project.byPath) {
    for (const entry of node.block.access) {
      const target = resolveAccess(project, blockPath, entry.resource)?.path;
      if (target !== undefined) seen.push({ from: blockPath, to: target, evidence: `declares "${formatAccess(entry)}"`, exact: true });
    }
  }
  for (const edge of reach?.edges ?? []) seen.push({ from: edge.from, to: edge.to, evidence: edge.evidence, exact: !edge.approximate });

  const evaluated: SnapshotRule[] = [];
  const diagnostics: ProjectDiagnostic[] = [];
  for (const { rule, why } of rules) {
    const parsed = parseRule(rule);
    if (parsed === null) {
      // Only the application writes this file, so a sentence that is not a
      // rule means it was edited by hand, and by whom is git's to say.
      diagnostics.push({
        severity: "error",
        blockPath: RULES_FILE,
        message: `"${rule}" is not a rule Fragmentor knows. This file is written from the window; put the sentence back as git has it.`,
      });
      continue;
    }
    const missing = [parsed.from, parsed.to].find((blockPath) => !project.byPath.has(blockPath));
    const name = (blockPath: string) => project.byPath.get(blockPath)?.block.name ?? blockPath;
    const planned = (blockPath: string) => project.byPath.get(blockPath)?.block.planned ?? false;
    const result: SnapshotRule = {
      rule,
      kind: parsed.kind,
      from: parsed.from,
      to: parsed.to,
      fromName: name(parsed.from),
      toName: name(parsed.to),
      why: why ?? null,
      brokenBy: [],
      guessed: [],
      declaredOnly: reach === null || reach.systemsRead[parsed.from.split("/")[0]!] !== true,
      problem:
        missing === undefined
          ? null
          : `This rule names ${missing}, which is not in the diagram. If the block moved or was renamed, change the rule's path here to follow it; if it is gone, leave the person a note.`,
    };
    evaluated.push(result);
    if (result.problem !== null) {
      // A rule pointing at nothing fails the check, so the agent can never
      // switch a rule off by moving the block it names.
      diagnostics.push({ severity: "error", blockPath: RULES_FILE, message: result.problem });
      continue;
    }

    // How a rule breaks: `never A B` on reach from inside A into B that does
    // not start inside B, and `only A B` on reach into B from outside both.
    const breaks = seen.filter(({ from, to }) => {
      if (!under(parsed.to, to) || under(parsed.to, from)) return false;
      return parsed.kind === "never" ? under(parsed.from, from) : !under(parsed.from, from);
    });
    const byBlock = new Map<string, ReachSeen[]>();
    for (const one of breaks) byBlock.set(one.from, [...(byBlock.get(one.from) ?? []), one]);
    result.brokenBy = [...byBlock.keys()].sort();
    for (const blockPath of result.brokenBy) {
      // Sure only of what was read exactly, between blocks that both exist:
      // a planned block has no code to read, so its declared access is a
      // plan's guess, not something the check may stop the agent over.
      const read = byBlock.get(blockPath)!.some((each) => each.exact);
      const sure = read && !planned(blockPath) && !planned(parsed.to);
      const evidence = [...new Set(byBlock.get(blockPath)!.map((each) => each.evidence))].sort().join("; ");
      const withWhy = why === undefined ? "" : ` (“${why}”)`;
      if (sure) {
        diagnostics.push({ severity: "error", blockPath, message: `Breaks the rule "${rule}"${withWhy}: ${evidence}.` });
        continue;
      }
      // A guess must never read like a certainty, so it says it is one, why
      // it is one, and that it stops nothing.
      result.guessed.push(blockPath);
      const because = planned(blockPath)
        ? "this block is planned, so only its declared access could be checked"
        : !read
          ? "its file was counted whole"
          : `${name(parsed.to)} is planned, so only declared access could be checked`;
      diagnostics.push({
        severity: "warning",
        blockPath,
        message: `May break the rule "${rule}"${withWhy}: ${evidence}. A guess — ${because} — so it does not stop your agent.`,
      });
    }
  }
  return { rules: evaluated, diagnostics };
}
