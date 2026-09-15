import { existsSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import path from "node:path";
import ts from "typescript";
import { getPack } from "../lang/index.js";
import type { LoadedBlock, Project } from "../project/project.js";

/**
 * Checking a TypeScript system's code against its diagram.
 *
 * The code is typechecked against the generated contracts, so a leaf that
 * returns the wrong shape fails here before anything runs. Contracts import
 * zod, which a project may well not have installed, so the checker lends it
 * Fragmentor's copy. Any other package a block imports is found where the
 * project installed it, exactly as it is when the block runs.
 *
 * What each block imports is checked as well, because the test runner
 * compiles each implementation into a folder of its own: types, which
 * disappear when it is compiled, its own children's code, and packages. Not
 * Node's built-in modules, though, which reach the files, the network and the
 * process directly — that is what capabilities are for.
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

const BUILTINS = new Set(builtinModules);

function isBuiltin(specifier: string): boolean {
  return specifier.startsWith("node:") || BUILTINS.has(specifier.split("/")[0]!);
}

/** A bare name such as `lodash` or `@scope/tool`, as opposed to a path. */
function isPackage(specifier: string): boolean {
  return !specifier.startsWith(".") && !specifier.startsWith("/") && !path.isAbsolute(specifier);
}

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
    if (isPackage(specifier) && !isBuiltin(specifier)) continue;

    problems.push({
      ...at(file, source, statement.getStart(source)),
      message: isBuiltin(specifier)
        ? `"${node.block.name}" imports "${specifier}", one of Node's built-in modules. A block reaches files, the network and the process only through its capabilities, so declare a capability instead.`
        : `"${node.block.name}" imports values from "${specifier}", which will not run: a block can import types, its own children's code, and packages installed in the project, and nothing else. Use \`import type\` for types, and a capability for anything outside the block.`,
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
