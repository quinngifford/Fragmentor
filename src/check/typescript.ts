import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { importsOnlyTypes, isBuiltin } from "../lang/typescriptReach.js";
import { boundBlocks } from "../project/code.js";
import type { BlockCode } from "../project/code.js";
import type { LoadedBlock, Project } from "../project/project.js";

/**
 * Checking a TypeScript system's code against its diagram.
 *
 * Only the files whose blocks are bound to a contract are compiled — the ones
 * that import it. The rest of the codebase is nobody's to hold to Fragmentor's
 * rules, and compiling it here, with a compiler set up for blocks, would
 * report hundreds of things about code Fragmentor was only ever asked to draw.
 *
 * What is compiled is typechecked against those contracts, so a function that
 * returns the wrong shape fails here before anything runs.
 *
 * What each block imports is checked as well, because the test runner compiles
 * a system's bound files into a folder of its own and runs it from there:
 * types, which disappear when it is compiled, the code of other bound blocks
 * in the same system, which is compiled beside it, and packages installed in
 * the project itself, which is the one place the runner looks. Not Node's
 * built-in modules, though, which reach the files, the network and the process
 * directly — that is what capabilities are for.
 */

export interface CodeProblem {
  /** Relative to the project, with forward slashes. Empty when the problem is not in a file. */
  file: string;
  line: number;
  column: number;
  message: string;
}

const OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  // The language, the few standard globals below, and nothing else. A block
  // reaches the outside world through its capabilities, so neither Node's
  // globals nor the browser's belong here — and `console` in particular would
  // corrupt the test runner's output.
  lib: ["lib.es2022.d.ts"],
  types: [],
};

/**
 * The few standard globals that only compute, which a block has when it runs
 * as it would anywhere else, declared as the web platform has them. None of
 * them reaches outside the process, which is what keeps the rest out.
 */
const STANDARD_GLOBALS = `
interface URLSearchParams {
  readonly size: number;
  append(name: string, value: string): void;
  delete(name: string, value?: string): void;
  get(name: string): string | null;
  getAll(name: string): string[];
  has(name: string, value?: string): boolean;
  set(name: string, value: string): void;
  sort(): void;
  toString(): string;
  forEach(callback: (value: string, key: string, parent: URLSearchParams) => void): void;
  entries(): IterableIterator<[string, string]>;
  keys(): IterableIterator<string>;
  values(): IterableIterator<string>;
  [Symbol.iterator](): IterableIterator<[string, string]>;
}
declare var URLSearchParams: {
  prototype: URLSearchParams;
  new (init?: string[][] | Record<string, string> | string | URLSearchParams): URLSearchParams;
};
interface URL {
  hash: string;
  host: string;
  hostname: string;
  href: string;
  readonly origin: string;
  password: string;
  pathname: string;
  port: string;
  protocol: string;
  search: string;
  readonly searchParams: URLSearchParams;
  username: string;
  toString(): string;
  toJSON(): string;
}
declare var URL: {
  prototype: URL;
  new (url: string | URL, base?: string | URL): URL;
  canParse(url: string | URL, base?: string | URL): boolean;
};
interface TextEncoder {
  readonly encoding: string;
  encode(input?: string): Uint8Array;
  encodeInto(source: string, destination: Uint8Array): { read: number; written: number };
}
declare var TextEncoder: { prototype: TextEncoder; new (): TextEncoder };
interface TextDecoder {
  readonly encoding: string;
  readonly fatal: boolean;
  readonly ignoreBOM: boolean;
  decode(input?: ArrayBuffer | ArrayBufferView, options?: { stream?: boolean }): string;
}
declare var TextDecoder: {
  prototype: TextDecoder;
  new (label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean }): TextDecoder;
};
interface AbortSignal {
  readonly aborted: boolean;
  readonly reason: any;
  throwIfAborted(): void;
  addEventListener(type: "abort", listener: () => void): void;
  removeEventListener(type: "abort", listener: () => void): void;
}
interface AbortController {
  readonly signal: AbortSignal;
  abort(reason?: any): void;
}
declare var AbortController: { prototype: AbortController; new (): AbortController };
declare function structuredClone<T>(value: T, options?: { transfer?: unknown[] }): T;
`;

/** Where the checker says those globals are declared. Nothing is written there. */
const STANDARD_GLOBALS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fragmentor-standard-globals.d.ts");

/** A compiler host that reads the project from disk, and those globals from the text above. */
function hostWithStandardGlobals(): ts.CompilerHost {
  const host = ts.createCompilerHost(OPTIONS);
  const getSourceFile = host.getSourceFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  host.getSourceFile = (fileName, language, ...rest) =>
    path.resolve(fileName) === STANDARD_GLOBALS_FILE
      ? ts.createSourceFile(fileName, STANDARD_GLOBALS, language)
      : getSourceFile(fileName, language, ...rest);
  host.fileExists = (fileName) => path.resolve(fileName) === STANDARD_GLOBALS_FILE || fileExists(fileName);
  return host;
}

/** A bare name such as `lodash` or `@scope/tool`, as opposed to a path. */
function isPackage(specifier: string): boolean {
  return !specifier.startsWith(".") && !specifier.startsWith("/") && !path.isAbsolute(specifier);
}

/** A package's name as installed: `lodash` for `lodash/fp`, `@scope/tool` for `@scope/tool/extra`. */
function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

/** True when an import such as `./contract.js` leads to a `.d.ts` file and no code, as a contract does. */
function declarationsOnly(imported: string): boolean {
  const stem = imported.replace(/\.js$/, "");
  return existsSync(`${stem}.d.ts`) && !existsSync(`${stem}.ts`);
}

function at(file: string, source: ts.SourceFile, position: number): Omit<CodeProblem, "message"> {
  const { line, character } = source.getLineAndCharacterOfPosition(position);
  return { file, line: line + 1, column: character + 1 };
}

function importProblems(
  node: LoadedBlock,
  file: string,
  source: ts.SourceFile,
  projectDir: string,
  /** The compiled code of every block in the system that can be called, as absolute paths. */
  callable: Set<string>,
): CodeProblem[] {
  const from = path.dirname(path.join(projectDir, ...file.split("/")));
  const problems: CodeProblem[] = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;

    const specifier = statement.moduleSpecifier.text;
    if (statement.importClause?.isTypeOnly) continue;
    if (!isPackage(specifier) && callable.has(path.resolve(from, specifier))) continue;
    const where = at(file, source, statement.getStart(source));

    if (importsOnlyTypes(statement)) {
      // `import { type X }` is compiled away here, but a build with
      // verbatimModuleSyntax, or Node running TypeScript, keeps it as an
      // import of the file, and a contract is declarations with no file to run.
      if (!isPackage(specifier) && declarationsOnly(path.resolve(from, specifier))) {
        problems.push({
          ...where,
          message: `"${node.block.name}" imports types from "${specifier}" without \`import type\`. A build that keeps imports as written, such as Node running TypeScript, turns this into an import of a file that is not there, because that file holds only declarations. Write \`import type { … }\`.`,
        });
      }
    } else if (isBuiltin(specifier)) {
      problems.push({
        ...where,
        message: `"${node.block.name}" imports "${specifier}", one of Node's built-in modules. A block reaches files, the network and the process only through its capabilities, so declare a capability instead.`,
      });
    } else if (!isPackage(specifier)) {
      problems.push({
        ...where,
        message: `"${node.block.name}" imports values from "${specifier}", which will not run: a block can import types, the code of another block in this system that is held to its contract, and packages installed in the project, and nothing else. Use \`import type\` for types, a block for a shared helper, and a capability for anything outside the system.`,
      });
    } else if (!existsSync(path.join(projectDir, "node_modules", packageName(specifier)))) {
      // Found anywhere else, it would typecheck and still fail to run.
      problems.push({
        ...where,
        message: `"${node.block.name}" imports "${specifier}", which is not installed in the project, so it will not run. Install it in the project folder: npm install ${packageName(specifier)}`,
      });
    }
  }
  return problems;
}

export function checkSystemCode(project: Project, rootBlock: string, code: Map<string, BlockCode>): CodeProblem[] {
  /** The file each block of this system is held to its contract in. */
  const files = new Map<string, LoadedBlock>();
  for (const block of boundBlocks(project, rootBlock, code)) {
    files.set(path.join(project.dir, ...block.file.split("/")), project.byPath.get(block.path)!);
  }

  if (files.size === 0) return [];

  // What an import of one of these files resolves to once it is compiled.
  const callable = new Set([...files.keys()].map((file) => file.replace(/\.ts$/, ".js")));

  const relative = (fileName: string) => path.relative(project.dir, fileName).split(path.sep).join("/");
  const program = ts.createProgram([...files.keys(), STANDARD_GLOBALS_FILE], OPTIONS, hostWithStandardGlobals());

  const problems: CodeProblem[] = ts.getPreEmitDiagnostics(program).map((diagnostic) => {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
    if (!diagnostic.file || diagnostic.start === undefined) return { file: "", line: 0, column: 0, message };
    return { ...at(relative(diagnostic.file.fileName), diagnostic.file, diagnostic.start), message };
  });

  for (const [file, node] of files) {
    const source = program.getSourceFile(file);
    if (source) problems.push(...importProblems(node, relative(file), source, project.dir, callable));
  }

  return problems;
}
