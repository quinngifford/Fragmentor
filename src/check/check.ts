import { emitProject } from "../codegen/emit.js";
import type { EmitResult } from "../codegen/emit.js";
import type { Mode } from "../model/block.js";
import { getPack, isKnownLanguage } from "../lang/index.js";
import { loadProject } from "../project/project.js";
import type { ProjectDiagnostic } from "../project/project.js";
import { projectSnapshot } from "../project/snapshot.js";
import { checkSystemCode } from "./typescript.js";
import type { CodeProblem } from "./typescript.js";

/**
 * Everything Fragmentor can say about whether a project is sound, in one pass.
 *
 * This is what the coding agent runs after each change. Contracts and
 * composites are regenerated first, so the code is checked against the
 * diagram as it is now rather than as it was when someone last remembered to
 * generate them. A visual project has no code of Fragmentor's to check: what
 * is checked there is the diagram, and that it points at code that exists.
 */

export interface SystemCheck {
  rootBlock: string;
  language: string;
  displayName: string;
  /** False when Fragmentor cannot check code in this language yet, or does not check it at all. */
  codeChecked: boolean;
  codeProblems: CodeProblem[];
}

export interface CheckReport {
  name: string;
  dir: string;
  mode: Mode;
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
   * Real blocks whose own code is not Fragmentor's to write, because a
   * planned block or a piece of the architecture sits beneath them. Nobody is
   * meant to write these, so they are not unfinished work either.
   */
  waiting: string[];
  /**
   * Blocks whose implementation is still the untouched starting point, or in
   * a visual project, blocks not yet linked to the code they stand for.
   * Neither planned blocks nor the blocks waiting on them are among these:
   * nothing about a plan is unfinished, it is simply not started.
   */
  unimplemented: string[];
  /** Blocks with no saved tests. Always empty in a visual project, which has none. */
  untested: string[];
  /** Errors of every kind. Warnings and unfinished work are not errors. */
  errorCount: number;
}

export async function checkProject(projectDir: string): Promise<CheckReport> {
  const project = await loadProject(projectDir);
  const visual = project.manifest.mode === "visual";
  const generated = await emitProject(project);
  // Read after generating, so blocks that were only just given an
  // implementation file are counted.
  const snapshot = await projectSnapshot(projectDir);

  const systems: SystemCheck[] = project.systems.map((system) => {
    const pack = !visual && isKnownLanguage(system.language) ? getPack(system.language) : null;
    const codeChecked = pack?.canCheck ?? false;
    return {
      rootBlock: system.rootBlock,
      language: system.language,
      displayName: pack?.displayName ?? (system.language || "unspecified"),
      codeChecked,
      codeProblems: codeChecked ? checkSystemCode(project, system.rootBlock) : [],
    };
  });

  const blocks = Object.values(snapshot.blocks);
  // Work that is somebody's to finish: not a plan, not a piece of the
  // architecture, and not a block whose code waits on either.
  const real = blocks.filter(
    (block) => !block.planned && !block.holdsPlan && !block.architecture && !block.holdsArchitecture,
  );
  const errorCount =
    snapshot.diagnostics.filter((d) => d.severity === "error").length +
    generated.problems.length +
    systems.reduce((count, system) => count + system.codeProblems.length, 0);

  return {
    name: snapshot.name,
    dir: snapshot.dir,
    mode: project.manifest.mode,
    blockCount: blocks.length,
    problems: snapshot.diagnostics,
    generated,
    systems,
    planned: blocks.filter((block) => block.planned).map((block) => block.path),
    architecture: blocks.filter((block) => !block.planned && block.architecture).map((block) => block.path),
    waiting: blocks
      .filter((block) => !block.planned && !block.architecture && (block.holdsPlan || block.holdsArchitecture))
      .map((block) => block.path),
    unimplemented: real.filter((block) => !block.implemented).map((block) => block.path),
    untested: visual ? [] : real.filter((block) => block.cases.length === 0).map((block) => block.path),
    errorCount,
  };
}
