import { emitProject } from "../codegen/emit.js";
import type { EmitResult } from "../codegen/emit.js";
import { getPack, isKnownLanguage } from "../lang/index.js";
import { loadProject } from "../project/project.js";
import type { ProjectDiagnostic } from "../project/project.js";
import { projectSnapshot } from "../project/snapshot.js";
import { checkSystemCode } from "./typescript.js";
import type { CodeProblem } from "./typescript.js";

/**
 * Everything Fragmentor can say about whether a project is sound, in one pass.
 *
 * This is what the coding agent runs after each change. Contracts are
 * regenerated first, so the code is checked against the diagram as it is now
 * rather than as it was when someone last remembered to generate them.
 */

export interface SystemCheck {
  rootBlock: string;
  language: string;
  displayName: string;
  /** False when Fragmentor cannot check code in this language yet. */
  codeChecked: boolean;
  codeProblems: CodeProblem[];
}

export interface CheckReport {
  name: string;
  dir: string;
  blockCount: number;
  /** Problems with the diagram, and with the files that sit beside it. */
  problems: ProjectDiagnostic[];
  generated: EmitResult;
  systems: SystemCheck[];
  /** Blocks whose implementation is still the untouched starting point. */
  unimplemented: string[];
  /** Blocks with no saved tests. */
  untested: string[];
  /** Errors of every kind. Warnings and unfinished work are not errors. */
  errorCount: number;
}

export async function checkProject(projectDir: string): Promise<CheckReport> {
  const project = await loadProject(projectDir);
  const generated = await emitProject(project);
  // Read after generating, so blocks that were only just given an
  // implementation file are counted.
  const snapshot = await projectSnapshot(projectDir);

  const systems: SystemCheck[] = project.systems.map((system) => {
    const pack = isKnownLanguage(system.language) ? getPack(system.language) : null;
    const codeChecked = pack?.canCheck ?? false;
    return {
      rootBlock: system.rootBlock,
      language: system.language,
      displayName: pack?.displayName ?? system.language,
      codeChecked,
      codeProblems: codeChecked ? checkSystemCode(project, system.rootBlock) : [],
    };
  });

  const blocks = Object.values(snapshot.blocks);
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
    unimplemented: blocks.filter((block) => !block.implemented).map((block) => block.path),
    untested: blocks.filter((block) => block.cases.length === 0).map((block) => block.path),
    errorCount,
  };
}
