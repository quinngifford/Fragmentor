import { access } from "node:fs/promises";
import path from "node:path";
import { checkProject } from "./check/check.js";
import type { CheckReport } from "./check/check.js";
import { startProject, writeAgentFiles } from "./codegen/emit.js";
import type { NewProjectSettings } from "./codegen/emit.js";
import { CLAUDE_FILE, GUIDE_FILE } from "./codegen/guide.js";
import { getPack, isKnownLanguage } from "./lang/index.js";
import { readAllCode } from "./project/code.js";
import { loadExecutions } from "./project/executions.js";
import { NOTES_DIR, addNote, describeRun, isNoteWithin, loadNotes, replyToNote, waitingOn } from "./project/notes.js";
import type { Note } from "./project/notes.js";
import { evaluate } from "./run/expect.js";
import { isArchitecture } from "./model/roles.js";
import { loadProject, locateCode, manifestPath, readManifest, systemOf } from "./project/project.js";
import type { Project, ProjectDiagnostic } from "./project/project.js";
import { casesPath, readCases } from "./run/cases.js";
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
  init --granularity <1-5> [--language <language>] [--existing-code] [--start <plan|build>]
                         Start a project in a folder: writes fragmentor.json, FRAGMENTOR.md, AGENTS.md and CLAUDE.md.
                         --existing-code says the folder already holds code to work from.
                         --start plan draws the architecture as planned blocks before any of it is built.
                         In a folder that is already a project, brings FRAGMENTOR.md up to date.
  check                  Check the diagram, regenerate generated code, check the code, and list unfinished work.
  test [block-path ...]  Run the saved tests of every block, or of the named blocks only, and hold each
                         execution to its own expectations.
  notes [block-path]     List the notes waiting for you, on every block or only on that block and its parts,
                         with where each block's code and tests are. Run it when the person says "review fragmentor".
  reply <note-id> <text>
                         Answer a note once it is done, which hands it back to the person.
  note <block-path> <text>
                         Leave a note on a block for the person to read in Fragmentor.

init uses the current folder; the others use the nearest folder, from here upwards, that holds fragmentor.json.
--project names a folder instead. Everything after a note's block path or id is its text, so put --project
before it. Text that is just - is read from standard input.`;

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
/** "a", "a and b", "a, b and c", each named once. */
const listed = (items: string[]) => {
  const once = [...new Set(items)];
  return once.length <= 1 ? (once[0] ?? "") : `${once.slice(0, -1).join(", ")} and ${once.at(-1)}`;
};
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
  const granularity = Number(options.get("granularity"));
  if (![1, 2, 3, 4, 5].includes(granularity)) {
    return "fragmentor init needs --granularity, from 1 (a few large blocks) to 5 (many small ones).";
  }
  const language = options.get("language") ?? null;
  const start = options.get("start") ?? "build";
  if (start !== "plan" && start !== "build") {
    return "fragmentor init needs --start plan (draw the architecture as planned blocks first) or --start build (build it as you go).";
  }
  if (options.has("existing-code") && start === "plan") {
    return "Code that already exists is described or rebuilt, not planned, so --existing-code and --start plan cannot go together.";
  }
  return {
    granularity: granularity as NewProjectSettings["granularity"],
    language,
    existingCode: options.has("existing-code"),
    start,
  };
}

async function init(dir: string, options: Map<string, string>): Promise<number> {
  let files: { written: string[]; kept: string[]; withoutGuide: string[]; history?: string };

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
    console.log(`Started a Fragmentor project in ${dir}.`);
  }

  for (const file of files.written) console.log(`  wrote  ${file}`);
  for (const file of files.kept) console.log(`  kept   ${file}, which already existed`);
  // Only a new project starts a repository, so only a new project says so.
  if (files.history !== undefined) console.log(`\n${files.history}`);

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
  return `  ${label}  ${diagnostic.blockPath}: ${indent(diagnostic.message, "         ")}`;
}

function formatReport(report: CheckReport): string {
  const lines: string[] = [];
  const systems = report.systems.map((system) => `${system.rootBlock} (${system.displayName})`).join(", ");
  lines.push(`${report.name}  ${report.dir}`);
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
  for (const file of report.generated.removed) lines.push(`  took away  ${file}, because Fragmentor no longer writes it`);

  lines.push("", "Code");
  for (const system of report.systems) {
    if (!system.codeChecked) {
      lines.push(`  ${system.rootBlock}: ${system.displayName || "this system's language"} code is drawn, not checked or run`);
    } else if (system.codeHeld === 0) {
      lines.push(`  ${system.rootBlock}: no block's code imports its contract, so all of it is drawn rather than checked`);
    } else if (system.codeProblems.length === 0) {
      lines.push(`  ${system.rootBlock}: typechecks against its contracts, and imports only what it can run with`);
    }
    for (const problem of system.codeProblems) {
      const where = problem.file ? `${problem.file}:${problem.line}:${problem.column}` : system.rootBlock;
      lines.push(`  ERROR  ${where}  ${indent(problem.message, "         ")}`);
    }
  }

  // A block Fragmentor is quietly not checking is worse than one it says it
  // cannot, so each of them says why here.
  if (report.drawnOnly.length > 0) {
    lines.push("", "Drawn, not checked");
    for (const drawn of report.drawnOnly) lines.push(`  ${drawn.blockPath}: ${drawn.reason}`);
  }

  // Neither a plan nor a piece of the architecture is unfinished work, so
  // both are kept apart from it. One is a drawing of what has not been
  // started; the other is not Fragmentor's to write at all.
  if (report.planned.length > 0) {
    lines.push("", "Planned");
    lines.push(`  ${plural(report.planned.length, "block")} drawn but not built, with nothing generated, checked or run:`);
    lines.push(...report.planned.map((blockPath) => `    ${blockPath}`));
  }

  if (report.architecture.length > 0) {
    lines.push("", "Architecture");
    lines.push(`  ${plural(report.architecture.length, "block")} that are not called, so have no code of their own:`);
    lines.push(...report.architecture.map((blockPath) => `    ${blockPath}`));
  }

  const built = report.blockCount - report.planned.length - report.architecture.length;
  lines.push("", "Unfinished");
  if (built === 0) {
    lines.push("  nothing here is Fragmentor's to build: every block is a plan or a piece of the architecture");
  } else if (report.unimplemented.length === 0 && report.untested.length === 0) {
    lines.push("  every block points at code that is there, and every block Fragmentor runs has tests");
  }
  if (report.unimplemented.length > 0) {
    lines.push(`  the code is not there (${report.unimplemented.length} of ${built}):`);
    lines.push(...report.unimplemented.map((blockPath) => `    ${blockPath}`));
  }
  if (report.untested.length > 0) {
    lines.push(`  no tests yet (${report.untested.length} of ${built}):`);
    lines.push(...report.untested.map((blockPath) => `    ${blockPath}`));
  }

  // A note says what someone wants done rather than what is wrong, so it is
  // kept apart from the problems and never changes the result. The agent is
  // told they are there, not asked to stop what it is doing for them.
  const { agent, person } = report.notes;
  if (agent.length > 0 || person.length > 0) {
    lines.push("", "Notes");
    if (agent.length > 0) {
      lines.push(`  ${agent.length} waiting for you, on ${listed(agent)}. Run \`fragmentor notes\` when the person asks you to review them.`);
    }
    if (person.length > 0) lines.push(`  ${person.length} waiting for the person, on ${listed(person)}.`);
  }

  const warnings = report.problems.filter((d) => d.severity === "warning").length;
  const next = report.systems.some((system) => system.codeHeld > 0) ? " Run `fragmentor test` to run the tests." : "";
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

  const unknown = requested.filter((blockPath) => !project.byPath.has(blockPath));
  if (unknown.length > 0) {
    const example = [...project.byPath.keys()].at(-1) ?? "";
    console.log(`There is no block at ${unknown.join(", ")}. A block path looks like ${example}.`);
    return 1;
  }

  console.log(`${project.manifest.name}  ${dir}`);

  const code = await readAllCode(project);
  const counts = { passed: 0, failed: 0, error: 0, unchecked: 0, skipped: 0 };
  const untested: string[] = [];
  /** Blocks with no code to run: a plan, or a block that is not called. */
  const inThePlan: string[] = [];
  /** Blocks Fragmentor draws rather than runs, with the reason. */
  const drawn: string[] = [];

  for (const blockPath of requested.length > 0 ? requested : [...project.byPath.keys()]) {
    // A planned block has no code to run, and neither has a block that is not
    // a function. Nothing about either is untested, so they are passed over
    // rather than failing to load.
    const node = project.byPath.get(blockPath);
    if (node && (node.block.planned || isArchitecture(node.block.role))) {
      inThePlan.push(blockPath);
      continue;
    }

    // Code Fragmentor is only drawing cannot be run, so its saved tests are
    // not run either, and saying so beats reporting each of them as an error.
    const found = code.get(blockPath);
    if (found && !found.bound) {
      drawn.push(`${blockPath}: ${found.problem ?? found.drawnBecause ?? "Fragmentor does not run this block."}`);
      continue;
    }

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
  if (ran === 0 && untested.length === 0 && inThePlan.length === 0) {
    console.log("There is nothing to test yet: this project has no blocks Fragmentor can run.");
    return 0;
  }
  if (ran === 0 && untested.length > 0) {
    console.log("No block has saved tests yet. Add a cases.json beside a block.json; FRAGMENTOR.md describes the format.");
    return 0;
  }

  const summary = [`${counts.passed} passed`, `${counts.failed} failed`, plural(counts.error, "error")];
  if (counts.unchecked > 0) summary.push(`${counts.unchecked} without an expectation`);
  if (counts.skipped > 0) summary.push(`${counts.skipped} skipped`);
  console.log(`Result: ${summary.join(", ")}.`);
  if (untested.length > 0) console.log(`No tests yet: ${untested.join(", ")}`);
  // Said plainly, because a block with saved tests that quietly never runs
  // reads as a test runner that lost them.
  if (inThePlan.length > 0) console.log(`Not run, because they have no code: ${inThePlan.join(", ")}`);
  for (const each of drawn) console.log(`Not run, because Fragmentor only draws this code: ${each}`);

  // Naming blocks asks about those blocks, so the executions are left alone.
  const executionFailures = requested.length > 0 ? 0 : await testExecutions(dir);
  return counts.failed + counts.error + executionFailures > 0 ? 1 : 0;
}

/**
 * Holds each execution to the expectations written beside it.
 *
 * What this proves is worth being exact about. A trace an agent wrote down is
 * its reading of the code, so evaluating it against its own expectations says
 * the two agree with each other — it catches a file that contradicts itself,
 * and it cannot catch a file that is wrong about the code. Once Fragmentor
 * records a run, the same expectations run against what really happened, and
 * the same failures mean something much stronger.
 */
async function testExecutions(dir: string): Promise<number> {
  const { executions, problems } = await loadExecutions(dir);
  if (problems.length > 0) {
    console.log(`\nExecutions\n  ERROR  ${problems.join("\n  ERROR  ")}`);
    return problems.length;
  }
  if (executions.length === 0) return 0;

  const withExpectations = executions.filter((execution) => execution.expect !== null && execution.declared !== null);
  console.log("\nExecutions");
  if (withExpectations.length === 0) {
    console.log(`  ${plural(executions.length, "execution")}, none of which says what must happen. Add an "expect" to make one a test.`);
    return 0;
  }

  let failed = 0;
  for (const execution of executions) {
    if (execution.expect === null || execution.declared === null) {
      console.log(`  ${execution.id}: nothing to check`);
      continue;
    }
    const { failures } = evaluate(execution.declared, execution.expect);
    console.log(`  ${failures.length === 0 ? "MET  " : "FAILED"} ${execution.id}`);
    for (const failure of failures) console.log(`           ${indent(failure, "           ")}`);
    if (failures.length > 0) failed += 1;
  }

  console.log(
    failed === 0
      ? "  Each of these holds a trace written down from reading the code to what that same file says must happen, so it catches a file that contradicts itself, not one that is wrong about the code."
      : `  ${plural(failed, "execution")} does not do what its own file says must happen.`,
  );
  return failed;
}

/* -------------------------------------------------------------------------- */
/* notes, reply and note                                                       */
/* -------------------------------------------------------------------------- */

/** When a message was written, to the minute, or as it was written where that is not a date. */
function when(at: string): string {
  const time = new Date(at);
  return Number.isNaN(time.getTime()) ? at : `${time.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * Where a note's block is written down and where its code and tests are, so
 * the agent goes straight there rather than searching the codebase for it.
 */
async function whereLines(project: Project, note: Note): Promise<string[]> {
  const node = project.byPath.get(note.block);
  if (!node) {
    return [`  That block is not there any more. If it moved, change "block" in ${NOTES_DIR}/${note.id}.json to its new path.`];
  }

  const lines = [`  block  blocks/${note.block}/block.json`];
  if (node.block.code !== undefined) {
    const found = await locateCode(project.dir, node.block.code);
    if (!found.ok) {
      lines.push(`  code   ${node.block.code}, which leads nowhere: ${found.problem}`);
    } else {
      const { file, line, symbol } = found.location;
      lines.push(`  code   ${file}${line === null ? "" : `:${line}`}${symbol === null ? "" : `  (${symbol})`}`);
    }
  }
  if (await exists(casesPath(project.dir, note.block))) lines.push(`  tests  blocks/${note.block}/cases.json`);
  return lines;
}

/** A note's whole conversation, oldest first, with any run flagged beside a message. */
function conversationLines(note: Note): string[] {
  const lines: string[] = [];
  for (const message of note.messages) {
    lines.push(`  ${message.from}, ${when(message.at)}`, `    ${indent(message.text, "    ")}`);
    if (message.run) lines.push(...describeRun(message.run).map((line) => `      ${indent(line, "      ")}`));
  }
  return lines;
}

/**
 * Every open note waiting for the agent, or only those on one block and its
 * parts, each with everything needed to act on it. What the person is still
 * to answer is only counted, because it is not the agent's to do.
 */
async function notes(dir: string, within: string | undefined): Promise<number> {
  let project: Project;
  try {
    project = await loadProject(dir);
  } catch (error) {
    console.log(`The project in ${dir} could not be read.\n\n${messageOf(error)}\n\nRun \`fragmentor check\` for details.`);
    return 1;
  }

  if (within !== undefined && !project.byPath.has(within)) {
    const example = [...project.byPath.keys()].at(-1) ?? "";
    console.log(`There is no block at ${within}. A block path looks like ${example}.`);
    return 1;
  }

  const loaded = await loadNotes(dir);
  const here = within === undefined ? loaded.notes : loaded.notes.filter((note) => isNoteWithin(note, within));
  const forYou = here.filter((note) => waitingOn(note) === "agent");
  const forPerson = here.filter((note) => waitingOn(note) === "person");
  const on = within === undefined ? "" : ` on ${within} or its parts`;

  console.log(`${project.manifest.name}  ${dir}\n`);
  console.log(
    forYou.length === 0
      ? `No notes${on} are waiting for you.`
      : `${plural(forYou.length, "note")}${on} ${forYou.length === 1 ? "is" : "are"} waiting for you.`,
  );

  for (const note of forYou) {
    const node = project.byPath.get(note.block);
    console.log(`\n${note.id}  on ${note.block}${node ? ` (${node.block.name})` : ""}`);
    console.log([...(await whereLines(project, note)), "", ...conversationLines(note)].join("\n"));
  }

  if (forPerson.length > 0) {
    const blocks = listed(forPerson.map((note) => note.block));
    console.log(`\n${plural(forPerson.length, "note")}${on} ${forPerson.length === 1 ? "is" : "are"} waiting for the person rather than you, on ${blocks}.`);
  }
  // A note is never quietly dropped, so one that cannot be read is named.
  if (loaded.problems.length > 0) {
    const count = loaded.problems.length;
    console.log(`\n${plural(count, "note")} cannot be read, so ${count === 1 ? "it is" : "they are"} not listed:`);
    for (const { file, problem } of loaded.problems) console.log(`  ${file}: ${indent(problem, "    ")}`);
  }
  if (forYou.length > 0) console.log(`\nWhen a note is done, answer it with \`fragmentor reply <id> "<what you did>"\`.`);
  return 0;
}

/**
 * A note's text: the words after the block or note it is for, or standard
 * input where they are exactly `-`, which gets quotes and several lines
 * through a shell intact. Standard input is read only then, because reading
 * it when nothing is being sent would wait for ever.
 */
async function textFrom(words: string[]): Promise<string> {
  if (words.length !== 1 || words[0] !== "-") return words.join(" ");
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").replace(/\r\n/g, "\n");
}

async function reply(dir: string, id: string | undefined, words: string[]): Promise<number> {
  if (id === undefined) {
    console.log(`fragmentor reply needs the note's id and what to say: fragmentor reply <note-id> "<what you did>".`);
    return 1;
  }
  try {
    const answered = await replyToNote(dir, id, "agent", await textFrom(words));
    console.log(`Answered note ${answered.id} on ${answered.block}.`);
    console.log("It is the person's now: they resolve it in Fragmentor once they are satisfied, or reply if not.");
    return 0;
  } catch (error) {
    console.log(messageOf(error));
    return 1;
  }
}

async function note(dir: string, blockPath: string | undefined, words: string[]): Promise<number> {
  if (blockPath === undefined) {
    console.log(`fragmentor note needs the block to leave it on and what to say: fragmentor note <block-path> "<text>".`);
    return 1;
  }
  try {
    const left = await addNote(dir, blockPath, "agent", await textFrom(words));
    console.log(`Left note ${left.id} on ${left.block}.`);
    console.log("The person will see it on the block in Fragmentor, and can reply to it there.");
    return 0;
  } catch (error) {
    console.log(messageOf(error));
    return 1;
  }
}

/* -------------------------------------------------------------------------- */
/* Entry                                                                       */
/* -------------------------------------------------------------------------- */

const OPTIONS = new Set(["project", "granularity", "language", "start"]);
/** Options that are simply there or not, and take no value. */
const FLAGS = new Set(["existing-code"]);

async function main(argv: string[]): Promise<number> {
  const args: string[] = [];
  const options = new Map<string, string>();

  for (let i = 0; i < argv.length; i += 1) {
    // A note's text is everything after the block or note it is for, and may
    // itself say --project, so none of it is read as an option.
    if (args.length === 2 && (args[0] === "note" || args[0] === "reply")) {
      args.push(...argv.slice(i));
      break;
    }

    const arg = argv[i]!;
    const option = /^--([a-z][a-z-]*)(?:=(.*))?$/.exec(arg);
    if (!option || !(OPTIONS.has(option[1]!) || FLAGS.has(option[1]!))) {
      args.push(arg);
      continue;
    }

    if (FLAGS.has(option[1]!)) {
      options.set(option[1]!, "");
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

  if (command === "check" || command === "test" || command === "notes" || command === "reply" || command === "note") {
    const dir = project ? path.resolve(project) : await findProject(process.cwd());
    if (!dir || !(await exists(manifestPath(dir)))) {
      console.log(
        `${dir ? `There is no fragmentor.json in ${dir}.` : `No fragmentor.json was found in ${process.cwd()} or any folder above it.`}\n` +
          `A project is started from the Fragmentor application with New project…, or with \`fragmentor init\`.`,
      );
      return 1;
    }

    // Accept a path however it was typed: with backslashes, or a trailing slash.
    const asPath = (entry: string) => entry.replace(/\\/g, "/").replace(/\/+$/, "");
    if (command === "check") return check(dir);
    if (command === "test") return test(dir, rest.map(asPath));
    if (command === "reply") return reply(dir, rest[0], rest.slice(1));
    if (command === "note") return note(dir, rest[0] === undefined ? undefined : asPath(rest[0]), rest.slice(1));
    if (rest.length > 1) {
      console.log(`fragmentor notes takes one block path at most, and was given ${rest.length}.`);
      return 1;
    }
    return notes(dir, rest[0] === undefined ? undefined : asPath(rest[0]));
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
