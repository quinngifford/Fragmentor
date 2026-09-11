import { access } from "node:fs/promises";
import path from "node:path";
import { checkProject } from "./check/check.js";
import type { CheckReport } from "./check/check.js";
import { writeAgentFiles } from "./codegen/emit.js";
import { CLAUDE_FILE, GUIDE_FILE } from "./codegen/guide.js";
import { getPack, isKnownLanguage } from "./lang/index.js";
import { loadProject, manifestPath, systemOf } from "./project/project.js";
import type { Project, ProjectDiagnostic } from "./project/project.js";
import { readCases } from "./run/cases.js";
import { runCases } from "./run/run.js";
import type { CaseResult } from "./run/run.js";

/**
 * The `fragmentor` command.
 *
 * It is for the coding agent building a project, not for the person, who
 * works in the application. It gives the agent the same checks the
 * application relies on, as plain text and an exit status.
 */

const USAGE = `Usage: fragmentor <command> [--project <folder>]

Commands:
  init                   Prepare a folder for a coding agent: writes FRAGMENTOR.md, AGENTS.md and CLAUDE.md.
  check                  Check the diagram, regenerate contracts, check the code, and list unfinished work.
  test [block-path ...]  Run the saved tests of every block, or of the named blocks only.

check and test use the nearest folder, from here upwards, that holds fragmentor.json.
init uses the current folder. --project names a folder instead.`;

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Lines up the continuation lines of a long message under its first line. */
const indent = (text: string, by: string) => text.replace(/\n/g, `\n${by}`);

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/** Walks up to the folder holding fragmentor.json, the way git finds a repository. */
async function findProject(start: string): Promise<string | null> {
  let dir = path.resolve(start);
  for (;;) {
    if (await exists(manifestPath(dir))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/* -------------------------------------------------------------------------- */
/* init                                                                        */
/* -------------------------------------------------------------------------- */

async function init(dir: string): Promise<number> {
  const { written, kept, withoutGuide } = await writeAgentFiles(dir);

  console.log(`Prepared ${dir} for a coding agent.`);
  for (const file of written) console.log(`  wrote  ${file}`);
  for (const file of kept) console.log(`  kept   ${file}, which already existed`);

  // Those files are the person's and are never changed, but an agent reading
  // one that never mentions the guide would not know the guide is there.
  for (const file of withoutGuide) {
    const line = file === CLAUDE_FILE ? `@${GUIDE_FILE}` : `Read ${GUIDE_FILE} before changing anything.`;
    console.log(`\n${file} does not mention ${GUIDE_FILE}. Add this line to it, so an agent reads the guide:\n  ${line}`);
  }

  console.log("");
  console.log(
    (await exists(manifestPath(dir)))
      ? "Next: run `fragmentor check`."
      : `Next: read ${GUIDE_FILE}, then write fragmentor.json and the blocks.`,
  );
  return 0;
}

/* -------------------------------------------------------------------------- */
/* check                                                                       */
/* -------------------------------------------------------------------------- */

function problemLine(diagnostic: ProjectDiagnostic): string {
  const label = diagnostic.severity === "error" ? "ERROR" : "WARN ";
  return `  ${label}  ${diagnostic.blockPath}: ${diagnostic.message}`;
}

function formatReport(report: CheckReport): string {
  const lines: string[] = [];
  const systems = report.systems.map((system) => `${system.rootBlock} (${system.displayName})`).join(", ");
  lines.push(`${report.name}  ${report.dir}`);
  lines.push(`${plural(report.blockCount, "block")} in ${plural(report.systems.length, "system")}: ${systems}`);

  lines.push("", "Blocks");
  const problems = [...report.problems].sort((a, b) =>
    a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1,
  );
  if (problems.length === 0) lines.push("  no problems");
  lines.push(...problems.map(problemLine));

  // Only files whose contents changed are written, so each one listed here is
  // news: a new block's implementation to fill in, or a contract that moved.
  lines.push("", "Generated files");
  for (const problem of report.generated.problems) lines.push(`  ERROR  ${problem}`);
  if (report.generated.problems.length === 0 && report.generated.written.length === 0) {
    lines.push("  everything was already up to date");
  }
  for (const file of report.generated.written) lines.push(`  wrote  ${file}`);

  lines.push("", "Code");
  for (const system of report.systems) {
    if (!system.codeChecked) {
      lines.push(`  ${system.rootBlock}: ${system.displayName} code is not checked yet`);
    } else if (system.codeProblems.length === 0) {
      lines.push(`  ${system.rootBlock}: typechecks against its contracts, and imports only what it can run with`);
    }
    for (const problem of system.codeProblems) {
      const where = problem.file ? `${problem.file}:${problem.line}:${problem.column}` : system.rootBlock;
      lines.push(`  ERROR  ${where}  ${indent(problem.message, "         ")}`);
    }
  }

  lines.push("", "Unfinished");
  if (report.unimplemented.length === 0 && report.untested.length === 0) {
    lines.push("  every block is implemented and has tests");
  }
  if (report.unimplemented.length > 0) {
    lines.push(`  no implementation yet (${report.unimplemented.length} of ${report.blockCount}):`);
    lines.push(...report.unimplemented.map((blockPath) => `    ${blockPath}`));
  }
  if (report.untested.length > 0) {
    lines.push(`  no tests yet (${report.untested.length} of ${report.blockCount}):`);
    lines.push(...report.untested.map((blockPath) => `    ${blockPath}`));
  }

  const warnings = report.problems.filter((d) => d.severity === "warning").length;
  lines.push("");
  lines.push(
    report.errorCount > 0
      ? `Result: ${plural(report.errorCount, "error")}. Fix them and run \`fragmentor check\` again.`
      : `Result: no errors${warnings > 0 ? `, ${plural(warnings, "warning")}` : ""}. Run \`fragmentor test\` to run the tests.`,
  );

  return lines.join("\n");
}

async function check(dir: string): Promise<number> {
  let report: CheckReport;
  try {
    report = await checkProject(dir);
  } catch (error) {
    console.log(`The project in ${dir} could not be read.\n\n${messageOf(error)}\n\nFix that and run \`fragmentor check\` again.`);
    return 1;
  }

  console.log(formatReport(report));
  return report.errorCount > 0 ? 1 : 0;
}

/* -------------------------------------------------------------------------- */
/* test                                                                        */
/* -------------------------------------------------------------------------- */

const STATUS_LABEL: Record<CaseResult["status"], string> = {
  passed: "PASS ",
  failed: "FAIL ",
  error: "ERROR",
  unchecked: "RAN  ",
};

function caseLines(result: CaseResult): string[] {
  const lines = [`  ${STATUS_LABEL[result.status]}  ${result.name}`];
  const detail = (text: string) => lines.push(`           ${indent(text, "           ")}`);

  if (result.status === "unchecked") {
    const shown = JSON.stringify(result.output) ?? "undefined";
    detail(`no expectation; it returned ${shown.length > 600 ? `${shown.slice(0, 600)}...` : shown}`);
  }
  if (result.status === "failed") result.differences.forEach(detail);
  if (result.status === "error") {
    detail(result.error ?? "The block failed.");
    result.inputProblems.forEach(detail);
  }
  if (result.status !== "passed" && result.logs.length > 0) detail(`logged: ${result.logs.join(" | ")}`);

  return lines;
}

async function test(dir: string, requested: string[]): Promise<number> {
  let project: Project;
  try {
    project = await loadProject(dir);
  } catch (error) {
    console.log(`The project in ${dir} could not be read.\n\n${messageOf(error)}\n\nRun \`fragmentor check\` for details.`);
    return 1;
  }

  const unknown = requested.filter((blockPath) => !project.byPath.has(blockPath));
  if (unknown.length > 0) {
    const example = [...project.byPath.keys()].at(-1) ?? "";
    console.log(`There is no block at ${unknown.join(", ")}. A block path looks like ${example}.`);
    return 1;
  }

  console.log(`${project.manifest.name}  ${dir}`);

  const counts = { passed: 0, failed: 0, error: 0, unchecked: 0, skipped: 0 };
  const untested: string[] = [];

  for (const blockPath of requested.length > 0 ? requested : [...project.byPath.keys()]) {
    const saved = await readCases(dir, blockPath);
    if (saved.problem) {
      console.log(`\n${blockPath}\n  ERROR  ${saved.problem}`);
      counts.error += 1;
      continue;
    }
    if (saved.cases.length === 0) {
      untested.push(blockPath);
      continue;
    }

    console.log(`\n${blockPath}`);
    const language = systemOf(project, blockPath)?.language ?? "";
    const pack = isKnownLanguage(language) ? getPack(language) : null;
    if (!pack?.canRun) {
      console.log(`  SKIP   ${plural(saved.cases.length, "test")}: Fragmentor cannot run ${pack?.displayName ?? language} blocks yet`);
      counts.skipped += saved.cases.length;
      continue;
    }

    for (const result of await runCases(dir, blockPath)) {
      counts[result.status] += 1;
      console.log(caseLines(result).join("\n"));
    }
  }

  const ran = counts.passed + counts.failed + counts.error + counts.unchecked + counts.skipped;
  console.log("");
  if (ran === 0 && untested.length > 0) {
    console.log("No block has saved tests yet. Add a cases.json beside a block.json; FRAGMENTOR.md describes the format.");
    return 0;
  }

  const summary = [`${counts.passed} passed`, `${counts.failed} failed`, plural(counts.error, "error")];
  if (counts.unchecked > 0) summary.push(`${counts.unchecked} without an expectation`);
  if (counts.skipped > 0) summary.push(`${counts.skipped} skipped`);
  console.log(`Result: ${summary.join(", ")}.`);
  if (untested.length > 0) console.log(`No tests yet: ${untested.join(", ")}`);

  return counts.failed + counts.error > 0 ? 1 : 0;
}

/* -------------------------------------------------------------------------- */
/* Entry                                                                       */
/* -------------------------------------------------------------------------- */

async function main(argv: string[]): Promise<number> {
  const args: string[] = [];
  let project: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--project") {
      project = argv[i + 1];
      i += 1;
      if (!project) {
        console.log(`--project needs a folder.\n\n${USAGE}`);
        return 1;
      }
    } else if (arg.startsWith("--project=")) {
      project = arg.slice("--project=".length);
    } else {
      args.push(arg);
    }
  }

  const [command, ...rest] = args;

  if (command === "init") return init(path.resolve(project ?? process.cwd()));

  if (command === "check" || command === "test") {
    const dir = project ? path.resolve(project) : await findProject(process.cwd());
    if (!dir || !(await exists(manifestPath(dir)))) {
      console.log(
        `${dir ? `There is no fragmentor.json in ${dir}.` : `No fragmentor.json was found in ${process.cwd()} or any folder above it.`}\n` +
          `To start a Fragmentor project in a folder, run \`fragmentor init\` there and read ${GUIDE_FILE}.`,
      );
      return 1;
    }

    // Accept a path however it was typed: with backslashes, or a trailing slash.
    const blockPaths = rest.map((entry) => entry.replace(/\\/g, "/").replace(/\/+$/, ""));
    return command === "check" ? check(dir) : test(dir, blockPaths);
  }

  if (command === "help" || command === "--help" || command === "-h") {
    console.log(USAGE);
    return 0;
  }

  console.log(command ? `Unknown command "${command}".\n\n${USAGE}` : USAGE);
  return 1;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(`fragmentor stopped unexpectedly: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exitCode = 1;
}
