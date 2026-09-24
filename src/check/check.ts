import { emitProject } from "../codegen/emit.js";
import type { EmitResult } from "../codegen/emit.js";
import type { NoteAuthor } from "../project/notes.js";
import { loadProject } from "../project/project.js";
import type { ProjectDiagnostic } from "../project/project.js";
import { packFor, readAllCode } from "../project/code.js";
import { projectSnapshot } from "../project/snapshot.js";
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
  /** False when Fragmentor cannot check code in this language yet, or has no pack for it. */
  codeChecked: boolean;
  /** How many of the system's blocks are held to a contract, and so checked. */
  codeHeld: number;
  codeProblems: CodeProblem[];
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
   * The open notes, by who they are waiting for, as the block each is on:
   * a block with two notes waiting is named twice. A note is never an error,
   * because it says what someone wants done rather than what is wrong.
   */
  notes: Record<NoteAuthor, string[]>;
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

  const systems: SystemCheck[] = project.systems.map((system) => {
    const pack = packFor(project, system.rootBlock);
    const codeChecked = pack?.canCheck ?? false;
    const held = [...code].filter(
      ([blockPath, found]) =>
        found.bound && (blockPath === system.rootBlock || blockPath.startsWith(`${system.rootBlock}/`)),
    );
    return {
      rootBlock: system.rootBlock,
      language: system.language,
      displayName: pack?.displayName ?? (system.language || "unspecified"),
      codeChecked,
      codeHeld: held.length,
      codeProblems: codeChecked ? checkSystemCode(project, system.rootBlock, code) : [],
    };
  });

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
    notes: {
      agent: snapshot.notes.filter((note) => note.waiting === "agent").map((note) => note.block),
      person: snapshot.notes.filter((note) => note.waiting === "person").map((note) => note.block),
    },
    errorCount,
  };
}
