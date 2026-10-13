import { emitProject } from "../codegen/emit.js";
import { analyticsOf, codeFilesOf } from "../project/analytics.js";
import { codeChanges } from "../project/history.js";
import type { EmitResult } from "../codegen/emit.js";
import type { NoteAuthor } from "../project/notes.js";
import { loadProject } from "../project/project.js";
import type { ProjectDiagnostic } from "../project/project.js";
import { boundBlocks, packFor, readAllCode } from "../project/code.js";
import { projectSnapshot } from "../project/snapshot.js";
import type { SnapshotRule } from "../project/rules.js";
import { checkPythonSystem } from "./python.js";
import { checkSystemCode } from "./typescript.js";
import type { CodeProblem } from "./typescript.js";

/**
 * Everything Fragmentor can say about whether a project is sound, in one pass.
 *
 * This is what the coding agent runs after each change. Contracts are
 * regenerated first, so the code is checked against the diagram as it is now
 * rather than as it was when someone last remembered to generate them.
 *
 * What is checked depends on what each block turns out to be rather than on
 * anything the project declares: the diagram always, and the code of whichever
 * blocks are held to a contract. The rest is drawn, and the report says which
 * blocks those are and why, because a block Fragmentor is quietly not checking
 * is worse than one it says it cannot.
 */

export interface SystemCheck {
  rootBlock: string;
  language: string;
  displayName: string;
  /** False when Fragmentor has no pack for this language, and so cannot check its code. */
  codeChecked: boolean;
  /** How many of the system's blocks are held to a contract, and so checked. */
  codeHeld: number;
  codeProblems: CodeProblem[];
  /** The interpreter that checked the code, where finding one is part of the job. */
  interpreter?: string;
  /** False when what its code reaches is not read, so reach the diagram leaves out cannot be found there. */
  reachRead: boolean;
}

/** A block whose code Fragmentor draws rather than checks, and why. */
export interface DrawnOnly {
  blockPath: string;
  reason: string;
}

export interface CheckReport {
  name: string;
  dir: string;
  blockCount: number;
  /** Problems with the diagram, and with the files that sit beside it. */
  problems: ProjectDiagnostic[];
  generated: EmitResult;
  systems: SystemCheck[];
  /** Blocks that are part of the plan rather than of the program. */
  planned: string[];
  /**
   * Blocks that stand for something the system talks to rather than code:
   * a database, a queue, another team's service.
   */
  architecture: string[];
  /**
   * Function blocks whose code is not there: either nobody has written it yet,
   * or it has moved and the block still points where it was. Fragmentor cannot
   * tell those apart, so it reports the one fact and lets whoever knows decide.
   * Planned blocks are not among these: nothing about a plan is unfinished, it
   * is simply not started.
   */
  unimplemented: string[];
  /** Function blocks Fragmentor draws rather than checks and runs, and why. */
  drawnOnly: DrawnOnly[];
  /** Blocks Fragmentor can run that have no saved tests. */
  untested: string[];
  /**
   * What could not be followed in reading what each block's code reaches, by
   * block, so reach that is not found is never taken for reach that is not there.
   */
  reachNotChecked: { blockPath: string; reasons: string[] }[];
  /** Files whose code reaches something but lies under no block's pointer. */
  reachUnpointed: string[];
  /**
   * The person's rules, each already held to the diagram and the code. A
   * broken one is among the problems above; this is the whole list, kept
   * ones too, so the agent knows the rules before it breaks one.
   */
  rules: SnapshotRule[];
  /**
   * The open notes, by who they are waiting for, as the block each is on:
   * a block with two notes waiting is named twice. A note is never an error,
   * because it says what someone wants done rather than what is wrong.
   */
  notes: Record<NoteAuthor, string[]>;
  /**
   * How many weak spots the measurements found: findings with evidence,
   * never problems, which `fragmentor analytics` lists.
   */
  weakSpots: number;
  /** Errors of every kind. Warnings and unfinished work are not errors. */
  errorCount: number;
}

export async function checkProject(projectDir: string): Promise<CheckReport> {
  const project = await loadProject(projectDir);
  // What binds a block to a contract is its code importing one, which is true
  // or not before anything is generated, so this is read once and passed on.
  const code = await readAllCode(project);
  const generated = await emitProject(project, code);
  const snapshot = await projectSnapshot(projectDir);

  const systems: SystemCheck[] = await Promise.all(
    project.systems.map(async (system) => {
      const pack = packFor(project, system.rootBlock);
      const codeChecked = pack !== null;
      // Each language checks its own way: TypeScript compiles in this
      // process, Python asks the project's interpreter and bundled pyright.
      const python =
        codeChecked && pack?.id === "python" ? await checkPythonSystem(project, system.rootBlock, code) : null;
      return {
        rootBlock: system.rootBlock,
        language: system.language,
        displayName: pack?.displayName ?? (system.language || "unspecified"),
        codeChecked,
        codeHeld: boundBlocks(project, system.rootBlock, code).length,
        codeProblems: python ? python.problems : codeChecked ? checkSystemCode(project, system.rootBlock, code) : [],
        ...(python?.interpreter ? { interpreter: python.interpreter } : {}),
        reachRead: snapshot.systems.find((each) => each.rootBlock === system.rootBlock)?.reachRead ?? false,
      };
    }),
  );

  const blocks = Object.values(snapshot.blocks);
  // Work that is somebody's to finish: code that is not only a plan.
  const real = blocks.filter((block) => !block.planned && !block.architecture);
  const errorCount =
    snapshot.diagnostics.filter((d) => d.severity === "error").length +
    generated.problems.length +
    systems.reduce((count, system) => count + system.codeProblems.length, 0);

  return {
    name: snapshot.name,
    dir: snapshot.dir,
    blockCount: blocks.length,
    problems: snapshot.diagnostics,
    generated,
    systems,
    planned: blocks.filter((block) => block.planned).map((block) => block.path),
    architecture: blocks.filter((block) => !block.planned && block.architecture).map((block) => block.path),
    unimplemented: real.filter((block) => !block.implemented).map((block) => block.path),
    drawnOnly: real
      .filter((block) => block.drawnBecause !== null)
      .map((block) => ({ blockPath: block.path, reason: block.drawnBecause! })),
    untested: real.filter((block) => block.runnable && block.cases.length === 0).map((block) => block.path),
    reachNotChecked: blocks
      .filter((block) => block.reachNotChecked.length > 0)
      .map((block) => ({ blockPath: block.path, reasons: block.reachNotChecked })),
    reachUnpointed: snapshot.reachUnpointed,
    rules: snapshot.rules,
    notes: {
      agent: snapshot.notes.filter((note) => note.waiting === "agent").map((note) => note.block),
      person: snapshot.notes.filter((note) => note.waiting === "person").map((note) => note.block),
    },
    weakSpots: analyticsOf(snapshot, { changes: await codeChanges(projectDir, codeFilesOf(snapshot).all) }).weakSpots.reduce((count, kind) => count + kind.spots.length, 0),
    errorCount,
  };
}
