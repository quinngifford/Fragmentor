import { access } from "node:fs/promises";
import path from "node:path";
import { checkProject } from "./check/check.js";
import type { CheckReport } from "./check/check.js";
import { startProject, writeAgentFiles } from "./codegen/emit.js";
import type { NewProjectSettings } from "./codegen/emit.js";
import { CLAUDE_FILE, GUIDE_FILE } from "./codegen/guide.js";
import { getPack, isKnownLanguage } from "./lang/index.js";
import { loadProject, manifestPath, readManifest, systemOf } from "./project/project.js";
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
  init --mode <structured|visual> --granularity <1-5> [--language <language>]
                         Start a project in a folder: writes fragmentor.json, FRAGMENTOR.md, AGENTS.md and CLAUDE.md.
                         In a folder that is already a project, brings FRAGMENTOR.md up to date.
  check                  Check the diagram, regenerate generated code, check the code, and list unfinished work.
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

function settingsFrom(options: Map<string, string>): NewProjectSettings | string {
  const mode = options.get("mode");
  const granularity = Number(options.get("granularity"));
  if (mode !== "structured" && mode !== "visual") {
    return "fragmentor init needs --mode structured (Fragmentor generates, checks and runs the code) or --mode visual (Fragmentor only draws it).";
  }
  if (![1, 2, 3, 4, 5].includes(granularity)) {
    return "fragmentor init needs --granularity, from 1 (a few large blocks) to 5 (many small ones).";
  }
  return { mode, granularity: granularity as NewProjectSettings["granularity"], language: options.get("language") ?? null };
}

async function init(dir: string, options: Map<string, string>): Promise<number> {
  let files: { written: string[]; kept: string[]; withoutGuide: string[] };

  if (await exists(manifestPath(dir))) {
    try {
      files = await writeAgentFiles(dir, await readManifest(dir));
    } catch (error) {
      console.log(messageOf(error));
      return 1;
    }
    console.log(`${dir} is already a Fragmentor project; its agent files are up to date.`);
  } else {
    const settings = settingsFrom(options);
    if (typeof settings === "string") {
      console.log(`${settings}\n\n${USAGE}`);
      return 1;
    }
    files = await startProject(dir, settings);
    console.log(`Started a ${settings.mode} Fragmentor project in ${dir}.`);
  }

  for (const file of files.written) console.log(`  wrote  ${file}`);
  for (const file of files.kept) console.log(`  kept   ${file}, which already existed`);

  // Those files are the person's and are never changed, but an agent reading
  // one that never mentions the guide would not know the guide is there.
  for (const file of files.withoutGuide) {
    const line = file === CLAUDE_FILE ? `@${GUIDE_FILE}` : `Read ${GUIDE_FILE} before changing anything.`;
    console.log(`\n${file} does not mention ${GUIDE_FILE}. Add this line to it, so an agent reads the guide:\n  ${line}`);
  }

  console.log(`\nNext: read ${GUIDE_FILE}, then fill in fragmentor.json and write the blocks.`);
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
  const visual = report.mode === "visual";
  const lines: string[] = [];
  const systems = report.systems.map((system) => `${system.rootBlock} (${system.displayName})`).join(", ");
  lines.push(`${report.name}  ${report.dir}  (${report.mode} mode)`);
  lines.push(
    report.systems.length === 0
      ? "No systems yet. Add them to fragmentor.json, as FRAGMENTOR.md describes."
      : `${plural(report.blockCount, "block")} in ${plural(report.systems.length, "system")}: ${systems}`,
  );

  lines.push("", "Blocks");
  const problems = [...report.problems].sort((a, b) =>
    a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1,
  );
  if (problems.length === 0) lines.push("  no problems");
  lines.push(...problems.map(problemLine));

  // Only files whose contents changed are written, so each one listed here is
  // news: a new block's implementation to fill in, or code that moved.
  lines.push("", "Generated files");
  for (const problem of report.generated.problems) lines.push(`  ERROR  ${problem}`);
  if (report.generated.problems.length === 0 && report.generated.written.length === 0) {
    lines.push("  everything was already up to date");
  }
  for (const file of report.generated.written) lines.push(`  wrote  ${file}`);

  lines.push("", "Code");
  if (visual) lines.push("  visual mode: Fragmentor draws the code but never checks, runs or changes it");
  for (const system of visual ? [] : report.systems) {
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
    lines.push(visual ? "  every block points at its code" : "  every block is implemented and has tests");
  }
  if (report.unimplemented.length > 0) {
    lines.push(`  ${visual ? "not linked to code yet" : "no implementation yet"} (${report.unimplemented.length} of ${report.blockCount}):`);
    lines.push(...report.unimplemented.map((blockPath) => `    ${blockPath}`));
  }
  if (report.untested.length > 0) {
    lines.push(`  no tests yet (${report.untested.length} of ${report.blockCount}):`);
    lines.push(...report.untested.map((blockPath) => `    ${blockPath}`));
  }

  const warnings = report.problems.filter((d) => d.severity === "warning").length;
  const next = visual ? "" : " Run `fragmentor test` to run the tests.";
  lines.push("");
  lines.push(
    report.errorCount > 0
      ? `Result: ${plural(report.errorCount, "error")}. Fix them and run \`fragmentor check\` again.`
      : `Result: no errors${warnings > 0 ? `, ${plural(warnings, "warning")}` : ""}.${next}`,
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

  if (project.manifest.mode === "visual") {
    console.log("This is a visual project: Fragmentor draws its code but never runs it, so there are no tests to run.");
    return 0;
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

const OPTIONS = new Set(["project", "mode", "granularity", "language"]);

async function main(argv: string[]): Promise<number> {
  const args: string[] = [];
  const options = new Map<string, string>();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const option = /^--([a-z]+)(?:=(.*))?$/.exec(arg);
    if (!option || !OPTIONS.has(option[1]!)) {
      args.push(arg);
      continue;
    }

    const value = option[2] ?? argv[i + 1];
    if (option[2] === undefined) i += 1;
    if (!value) {
      console.log(`--${option[1]} needs a value.\n\n${USAGE}`);
      return 1;
    }
    options.set(option[1]!, value);
  }

  const [command, ...rest] = args;
  const project = options.get("project");

  if (command === "init") return init(path.resolve(project ?? process.cwd()), options);

  if (command === "check" || command === "test") {
    const dir = project ? path.resolve(project) : await findProject(process.cwd());
    if (!dir || !(await exists(manifestPath(dir)))) {
      console.log(
        `${dir ? `There is no fragmentor.json in ${dir}.` : `No fragmentor.json was found in ${process.cwd()} or any folder above it.`}\n` +
          `A project is started from the Fragmentor application with New project…, or with \`fragmentor init\`.`,
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
