import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import ts from "typescript";
import { getPack } from "../lang/index.js";
import type { LoadedBlock, Project } from "../project/project.js";

/**
 * Checking a TypeScript system's code against its diagram.
 *
 * The code is typechecked against the generated contracts, so a leaf that
 * returns the wrong shape, or a composite that hands a child the wrong value,
 * fails here before anything runs. A project lives in a folder of its own with
 * nothing installed, yet its contracts import zod, so the checker lends it
 * Fragmentor's copy.
 *
 * Lending zod means code can typecheck that will not run, because the test
 * runner compiles each implementation on its own with nothing installed. So
 * what each block imports is checked as well: types, which disappear when it
 * is compiled, and its own children's code, and nothing else.
 */

export interface CodeProblem {
  /** Relative to the project, with forward slashes. Empty when the problem is not in a file. */
  file: string;
  line: number;
  column: number;
  message: string;
}

const zodDir = path.dirname(createRequire(import.meta.url).resolve("zod/package.json"));

const OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  // The language and nothing else. A block reaches the outside world through
  // its capabilities, so neither Node's globals nor the browser's belong here
  // — and `console` in particular would corrupt the test runner's output.
  lib: ["lib.es2022.d.ts"],
  types: [],
  paths: { zod: [zodDir] },
};

function at(file: string, source: ts.SourceFile, position: number): Omit<CodeProblem, "message"> {
  const { line, character } = source.getLineAndCharacterOfPosition(position);
  return { file, line: line + 1, column: character + 1 };
}

/** True when an import brings in types only, and so disappears when compiled. */
function importsOnlyTypes(statement: ts.ImportDeclaration): boolean {
  const clause = statement.importClause;
  if (!clause) return false; // `import "x"` runs x
  if (clause.isTypeOnly) return true;
  if (clause.name) return false;
  const bindings = clause.namedBindings;
  return (
    bindings !== undefined &&
    ts.isNamedImports(bindings) &&
    bindings.elements.length > 0 &&
    bindings.elements.every((element) => element.isTypeOnly)
  );
}

function importProblems(node: LoadedBlock, file: string, source: ts.SourceFile): CodeProblem[] {
  const compiledName = getPack("typescript").implFile.replace(/\.ts$/, ".js");
  const children = new Set(node.block.children.map((child) => `./${child.block}/${compiledName}`));

  const problems: CodeProblem[] = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;

    const specifier = statement.moduleSpecifier.text;
    if (children.has(specifier) || importsOnlyTypes(statement)) continue;

    problems.push({
      ...at(file, source, statement.getStart(source)),
      message: `"${node.block.name}" imports values from "${specifier}", which will not run: a block can import types and its own children's code, and nothing else. Use \`import type\` for types, and a capability for anything outside the block.`,
    });
  }
  return problems;
}

export function checkSystemCode(project: Project, rootBlock: string): CodeProblem[] {
  const implFile = getPack("typescript").implFile;
  const files = new Map<string, LoadedBlock>();
  for (const node of project.byPath.values()) {
    if (node.path !== rootBlock && !node.path.startsWith(`${rootBlock}/`)) continue;
    const file = path.join(node.dir, implFile);
    if (existsSync(file)) files.set(file, node);
  }

  if (files.size === 0) return [];

  const relative = (fileName: string) => path.relative(project.dir, fileName).split(path.sep).join("/");
  const program = ts.createProgram([...files.keys()], OPTIONS);

  const problems: CodeProblem[] = ts.getPreEmitDiagnostics(program).map((diagnostic) => {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
    if (!diagnostic.file || diagnostic.start === undefined) return { file: "", line: 0, column: 0, message };
    return { ...at(relative(diagnostic.file.fileName), diagnostic.file, diagnostic.start), message };
  });

  for (const [file, node] of files) {
    const source = program.getSourceFile(file);
    if (source) problems.push(...importProblems(node, relative(file), source));
  }

  return problems;
}
