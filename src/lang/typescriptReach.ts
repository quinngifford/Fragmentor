import { realpathSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import ts from "typescript";
import type { FileReach, FunctionShape, ReachReader, Target, Uses } from "./pack.js";

/**
 * Reading TypeScript for what it declares and what it reaches.
 *
 * Only the parser and the compiler's own module resolver are used, never the
 * type checker, because this runs every time the diagram is redrawn and a
 * checker would cost seconds where the parser costs milliseconds. What that
 * gives up is knowing what a value is; what it keeps is knowing which
 * imported name each piece of code uses, which is what reaching is.
 *
 * What is read is kept for each file until its text changes, so a redraw
 * after one file is saved parses one file. Imports are resolved afresh for
 * each reading of a project, because adding or removing some other file can
 * change where one leads without this file changing at all.
 */

/** A name declared at the top of a file, and where. */
export interface OutlineDeclaration {
  name: string;
  kind: "function" | "class" | "variable" | "enum" | "namespace" | "default";
  /** Character offsets of the whole statement, from its first token to its end. */
  start: number;
  end: number;
  /** The line the statement starts on, counting from 1. */
  line: number;
  exported: boolean;
}

/** One import statement. */
export interface OutlineImport {
  specifier: string;
  /** Each name it brings in as a value, and what it is called where it comes from: `default`, or `*` for a namespace. */
  names: Record<string, string>;
  /** True when it brings in types only, and so disappears when compiled. */
  typeOnly: boolean;
  /** True for `import "x"`, which runs a file for what it does. */
  sideEffect: boolean;
  line: number;
}

export interface Outline {
  declarations: OutlineDeclaration[];
  imports: OutlineImport[];
}

/** Uses before their imports are resolved: each import named by what the code wrote. */
interface RawUses {
  imports: { specifier: string; name: string | null }[];
  local: string[];
  dynamic: { kind: "import" | "require"; specifier: string | null }[];
}

interface Parsed {
  outline: Outline;
  declarations: Map<string, RawUses>;
  rest: RawUses;
  exports: Map<string, { local: string } | { specifier: string; name: string }>;
  exportsAll: string[];
  values: Set<string>;
  functions: FunctionShape[];
}

/* -------------------------------------------------------------------------- */
/* The shape of each function                                                  */
/* -------------------------------------------------------------------------- */

const BRANCHING_OPERATORS = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

/** One more way through: a branch, a loop, a case with a test, a catch, or a short-circuit. `?.` and a default value add nothing. */
function branches(node: ts.Node): number {
  if (
    ts.isIfStatement(node) ||
    ts.isConditionalExpression(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node) ||
    ts.isCatchClause(node) ||
    ts.isCaseClause(node)
  ) {
    return 1;
  }
  return ts.isBinaryExpression(node) && BRANCHING_OPERATORS.has(node.operatorToken.kind) ? 1 : 0;
}

/** A statement that is a piece of code, not a container or a declaration of a type or another function. */
function isCounted(node: ts.Node): boolean {
  return (
    ts.isStatement(node) &&
    !ts.isBlock(node) &&
    !ts.isEmptyStatement(node) &&
    !ts.isImportDeclaration(node) &&
    !ts.isFunctionDeclaration(node) &&
    !ts.isClassDeclaration(node) &&
    !ts.isInterfaceDeclaration(node) &&
    !ts.isTypeAliasDeclaration(node)
  );
}

const ordinalOf = (n: number): string => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10 > 3 ? 0 : n % 10]}`;

type FunctionNode = ts.FunctionLikeDeclaration & { body: ts.Node };

const isFunctionNode = (node: ts.Node): node is FunctionNode => ts.isFunctionLike(node) && (node as ts.FunctionLikeDeclaration).body !== undefined;

/** The name a declaration's left side gives whatever it is assigned, or null. */
function assignedName(node: ts.Node): string | null {
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (ts.isPropertyAssignment(parent) && (ts.isIdentifier(parent.name) || ts.isStringLiteral(parent.name))) return parent.name.text;
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.right === node) return parent.left.getText();
  if (ts.isPropertyDeclaration(parent) && (ts.isIdentifier(parent.name) || ts.isStringLiteral(parent.name))) return parent.name.text;
  return null;
}

/** What holds a class or object literal, by the name it is declared under. */
function holderName(node: ts.Node): string | null {
  if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) return node.name?.text ?? assignedName(node) ?? "default";
  if (ts.isObjectLiteralExpression(node)) return assignedName(node);
  return null;
}

/** Every function in a file, nested ones on their own, named as the measurements name them. */
function shapesOf(source: ts.SourceFile): FunctionShape[] {
  const shapes: FunctionShape[] = [];
  const lineOf = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

  /** The top-level declaration a node is in: the name a block's pointer could use. */
  const topOf = (node: ts.Node): string | null => {
    let statement: ts.Node = node;
    while (statement.parent && !ts.isSourceFile(statement.parent)) statement = statement.parent;
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) return statement.name?.text ?? "default";
    if (ts.isVariableStatement(statement)) {
      const declaration = statement.declarationList.declarations.find((each) => each.pos <= node.pos && node.end <= each.end);
      return declaration && ts.isIdentifier(declaration.name) ? declaration.name.text : null;
    }
    return null;
  };

  const nameOf = (node: FunctionNode, enclosing: string | null, nth: number): string => {
    if (ts.isFunctionDeclaration(node)) return node.name?.text ?? "default";
    if (ts.isConstructorDeclaration(node)) return `${holderName(node.parent) ?? "default"}.constructor`;
    if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
      const own = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : node.name.getText(source);
      const holder = holderName(node.parent);
      return holder === null ? own : `${holder}.${own}`;
    }
    if (ts.isFunctionExpression(node) && node.name) return node.name.text;
    const assigned = assignedName(node);
    if (assigned !== null) {
      const holder = ts.isPropertyAssignment(node.parent) ? holderName(node.parent.parent) : null;
      return holder === null ? assigned : `${holder}.${assigned}`;
    }
    return `${ordinalOf(nth)} function ${enclosing === null ? "in the file" : `inside ${enclosing}`}`;
  };

  const visit = (node: ts.Node, enclosing: string | null, counter: { n: number }): void => {
    if (isFunctionNode(node)) {
      counter.n += 1;
      const name = nameOf(node, enclosing, counter.n);
      let paths = 1;
      let statements = 0;
      const inner = { n: 0 };
      const body = node.body;
      const walk = (child: ts.Node): void => {
        if (isFunctionNode(child)) {
          visit(child, name, inner);
          return;
        }
        paths += branches(child);
        if (isCounted(child)) statements += 1;
        ts.forEachChild(child, walk);
      };
      // An arrow function with an expression for a body is one statement's worth of code.
      if (ts.isBlock(body)) ts.forEachChild(body, walk);
      else {
        statements = 1;
        walk(body);
      }
      // Default values and parameter patterns can hold functions of their own.
      for (const parameter of node.parameters) ts.forEachChild(parameter, walk);
      shapes.push({ name, top: topOf(node), line: lineOf(node), paths, statements });
      return;
    }
    ts.forEachChild(node, (child) => visit(child, enclosing, counter));
  };
  visit(source, null, { n: 0 });
  return shapes.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
}

const BUILTINS = new Set(builtinModules);

export function isBuiltin(specifier: string): boolean {
  return specifier.startsWith("node:") || BUILTINS.has(specifier.split("/")[0]!);
}

/** True when an import brings in types only, and so disappears when compiled. */
export function importsOnlyTypes(statement: ts.ImportDeclaration): boolean {
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

const CODE = /\.(ts|tsx|mts|cts)$/;
// Jest's and Vitest's, Nest's `.e2e-spec`, Cypress's `.cy`, and the folders tests and their helpers are kept in.
const TEST = /[.-](test|spec|e2e|cy)\.[cm]?tsx?$/;
const TEST_FOLDERS = new Set(["__tests__", "__mocks__", "test", "tests", "testing", "e2e", "cypress"]);

function fileKind(file: string): "code" | "test" | null {
  if (!CODE.test(file) || /\.d\.[cm]?ts$/.test(file)) return null;
  return TEST.test(file) || file.split("/").slice(0, -1).some((folder) => TEST_FOLDERS.has(folder)) ? "test" : "code";
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                     */
/* -------------------------------------------------------------------------- */

const parsedFiles = new Map<string, { text: string; parsed: Parsed }>();

function parse(fileName: string, text: string): Parsed {
  const cached = parsedFiles.get(fileName);
  if (cached?.text === text) return cached.parsed;
  const parsed = parseText(fileName, text);
  parsedFiles.set(fileName, { text, parsed });
  return parsed;
}

/**
 * What a file declares at its top level and what it imports, for anything
 * that needs to know where a function is without guessing from its text.
 */
export function outline(file: string, text: string): Outline {
  return parse(path.resolve(file), text).outline;
}

function isExported(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function isDefault(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) => (ts.isOmittedExpression(element) ? [] : bindingNames(element.name)));
}

function stringArgument(call: ts.CallExpression): string | null {
  const first = call.arguments[0];
  return first && ts.isStringLiteralLike(first) ? first.text : null;
}

/** The names a node brings into scope for what is inside it, which hide a top-level name of the same spelling. */
function declaredWithin(node: ts.Node): string[] {
  const names: string[] = [];
  const fromStatements = (statements: readonly ts.Statement[]) => {
    for (const statement of statements) {
      if (ts.isVariableStatement(statement)) {
        for (const each of statement.declarationList.declarations) names.push(...bindingNames(each.name));
      } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name) {
        names.push(statement.name.text);
      }
    }
  };
  // A `var` anywhere in a function's body belongs to the whole function, not the block it is written in.
  const hoisted = (inner: ts.Node): void => {
    if (ts.isFunctionLike(inner) || ts.isClassLike(inner)) return;
    if (ts.isVariableDeclarationList(inner) && (inner.flags & ts.NodeFlags.BlockScoped) === 0) {
      for (const each of inner.declarations) names.push(...bindingNames(each.name));
    }
    ts.forEachChild(inner, hoisted);
  };
  if (ts.isFunctionLike(node)) {
    for (const parameter of node.parameters) names.push(...bindingNames(parameter.name));
    if (ts.isFunctionExpression(node) && node.name) names.push(node.name.text);
    const body = (node as { body?: ts.Node }).body;
    if (body !== undefined && ts.isBlock(body)) ts.forEachChild(body, hoisted);
  } else if (ts.isClassExpression(node) && node.name) {
    names.push(node.name.text);
  } else if (ts.isBlock(node) || ts.isModuleBlock(node)) {
    fromStatements(node.statements);
  } else if (ts.isCaseBlock(node)) {
    for (const clause of node.clauses) fromStatements(clause.statements);
  } else if ((ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) && node.initializer && ts.isVariableDeclarationList(node.initializer)) {
    for (const each of node.initializer.declarations) names.push(...bindingNames(each.name));
  } else if (ts.isCatchClause(node) && node.variableDeclaration) {
    names.push(...bindingNames(node.variableDeclaration.name));
  }
  return names;
}

/** Whether an identifier stands for a value there, rather than naming a property, a declaration or a label. */
function isReference(id: ts.Identifier): boolean {
  const parent = id.parent;
  if (ts.isShorthandPropertyAssignment(parent)) return parent.name === id || parent.objectAssignmentInitializer === id;
  const named = parent as unknown as { name?: ts.Node; propertyName?: ts.Node; label?: ts.Node };
  return named.name !== id && named.propertyName !== id && named.label !== id;
}

function parseText(fileName: string, text: string): Parsed {
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const lineOf = (position: number) => source.getLineAndCharacterOfPosition(position).line + 1;

  const imports = new Map<string, { specifier: string; name: string }>();
  const outlined: Outline = { declarations: [], imports: [] };
  const exports: Parsed["exports"] = new Map();
  const exportsAll: string[] = [];
  const exportedNames = new Set<string>();
  /** The statements each top-level name is declared by, in order; a function can be declared more than once to overload it. */
  const declared = new Map<string, ts.Node[]>();
  const restNodes: ts.Node[] = [];
  const values = new Set<string>();
  const sideEffects: string[] = [];

  const declare = (name: string, node: ts.Node, statement: ts.Statement, kind: OutlineDeclaration["kind"]) => {
    const earlier = declared.get(name) ?? [];
    declared.set(name, [...earlier, node]);
    // An overloaded function is one declaration, from its first signature to its body.
    const last = earlier[earlier.length - 1];
    if (last !== undefined && ts.isFunctionDeclaration(last) && ts.isFunctionDeclaration(node)) {
      const entry = outlined.declarations.filter((each) => each.name === name).pop()!;
      entry.end = statement.end;
      entry.exported ||= isExported(statement);
      return;
    }
    const start = statement.getStart(source);
    outlined.declarations.push({ name, kind, start, end: statement.end, line: lineOf(start), exported: ts.isExportAssignment(statement) || isExported(statement) });
  };

  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const specifier = statement.moduleSpecifier.text;
      const clause = statement.importClause;
      const typeOnly = importsOnlyTypes(statement);
      const names: Record<string, string> = {};
      if (clause && !clause.isTypeOnly) {
        if (clause.name) names[clause.name.text] = "default";
        const bindings = clause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) names[bindings.name.text] = "*";
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) if (!element.isTypeOnly) names[element.name.text] = (element.propertyName ?? element.name).text;
        }
      }
      for (const [local, name] of Object.entries(names)) imports.set(local, { specifier, name });
      if (!clause) sideEffects.push(specifier);
      outlined.imports.push({ specifier, names, typeOnly, sideEffect: !clause, line: lineOf(statement.getStart(source)) });
    } else if (
      ts.isImportEqualsDeclaration(statement) &&
      !statement.isTypeOnly &&
      ts.isExternalModuleReference(statement.moduleReference) &&
      ts.isStringLiteral(statement.moduleReference.expression)
    ) {
      // `import x = require("y")`, which is a namespace by another name.
      const specifier = statement.moduleReference.expression.text;
      imports.set(statement.name.text, { specifier, name: "*" });
      outlined.imports.push({ specifier, names: { [statement.name.text]: "*" }, typeOnly: false, sideEffect: false, line: lineOf(statement.getStart(source)) });
    } else if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) continue;
      const specifier = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : null;
      const clause = statement.exportClause;
      if (!clause) {
        if (specifier !== null) exportsAll.push(specifier);
      } else if (ts.isNamespaceExport(clause)) {
        if (specifier !== null) exports.set(clause.name.text, { specifier, name: "*" });
      } else {
        for (const element of clause.elements) {
          if (element.isTypeOnly) continue;
          const name = (element.propertyName ?? element.name).text;
          exports.set(element.name.text, specifier === null ? { local: name } : { specifier, name });
          if (specifier === null) exportedNames.add(name);
        }
      }
    } else if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
      const kind = ts.isFunctionDeclaration(statement) ? "function" : "class";
      const name = statement.name?.text ?? "default";
      declare(name, statement, statement, kind);
      if (statement.name && isDefault(statement)) exports.set("default", { local: name });
    } else if (ts.isVariableStatement(statement)) {
      for (const each of statement.declarationList.declarations) {
        const initial = each.initializer;
        const kind = initial && (ts.isArrowFunction(initial) || ts.isFunctionExpression(initial)) ? "function" : "variable";
        for (const name of bindingNames(each.name)) {
          declare(name, each, statement, kind);
          if (kind === "variable") values.add(name);
        }
      }
    } else if (ts.isEnumDeclaration(statement)) {
      declare(statement.name.text, statement, statement, "enum");
    } else if (ts.isModuleDeclaration(statement) && ts.isIdentifier(statement.name)) {
      declare(statement.name.text, statement, statement, "namespace");
      values.add(statement.name.text);
    } else if (ts.isExportAssignment(statement)) {
      // `export default x` names something declared or imported; anything else is its own declaration.
      if (ts.isIdentifier(statement.expression)) {
        exports.set("default", { local: statement.expression.text });
        exportedNames.add(statement.expression.text);
      } else {
        declare("default", statement.expression, statement, "default");
        if (ts.isObjectLiteralExpression(statement.expression) || ts.isArrayLiteralExpression(statement.expression)) values.add("default");
      }
    } else if (!ts.isInterfaceDeclaration(statement) && !ts.isTypeAliasDeclaration(statement) && !ts.isImportDeclaration(statement)) {
      restNodes.push(statement);
    }
  }

  for (const each of outlined.declarations) if (exportedNames.has(each.name)) each.exported = true;
  const functions = shapesOf(source);

  // An export of a name the file imported rather than declared passes that import on.
  for (const [name, entry] of exports) {
    const imported = "local" in entry && !declared.has(entry.local) ? imports.get(entry.local) : undefined;
    if (imported) exports.set(name, imported);
  }

  const usesOf = (roots: ts.Node[]): RawUses => {
    const uses: RawUses = { imports: [], local: [], dynamic: [] };
    const visit = (node: ts.Node, hidden: ReadonlySet<string>): void => {
      // `make<string>` without a call is a value given type arguments; only the arguments are types.
      if (ts.isExpressionWithTypeArguments(node) && !ts.isHeritageClause(node.parent)) return visit(node.expression, hidden);
      // Types disappear when compiled, so nothing named only in one is reached.
      if (ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return;
      if (ts.isHeritageClause(node)) {
        // A class extends a value; anything implements, or an interface extends, only types.
        if (node.token === ts.SyntaxKind.ExtendsKeyword && ts.isClassLike(node.parent)) for (const type of node.types) visit(type.expression, hidden);
        return;
      }
      if (ts.isIdentifier(node)) {
        if (!isReference(node) || hidden.has(node.text)) return;
        const imported = imports.get(node.text);
        if (imported) {
          let name = imported.name;
          if (name === "*") {
            // `db.users` uses `users`; a namespace used any other way is used whole.
            const parent = node.parent;
            if (ts.isPropertyAccessExpression(parent) && parent.expression === node) name = parent.name.text;
            else if (ts.isElementAccessExpression(parent) && parent.expression === node && ts.isStringLiteralLike(parent.argumentExpression)) name = parent.argumentExpression.text;
          }
          uses.imports.push({ specifier: imported.specifier, name });
        } else if (declared.has(node.text)) {
          uses.local.push(node.text);
        }
        return;
      }
      if (ts.isCallExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          uses.dynamic.push({ kind: "import", specifier: stringArgument(node) });
        } else if (ts.isIdentifier(node.expression) && node.expression.text === "require" && !hidden.has("require") && !declared.has("require")) {
          uses.dynamic.push({ kind: "require", specifier: stringArgument(node) });
        }
      }
      const inner = declaredWithin(node);
      const next = inner.length === 0 ? hidden : new Set([...hidden, ...inner]);
      ts.forEachChild(node, (child) => visit(child, next));
    };
    for (const root of roots) visit(root, new Set());
    return uses;
  };

  const declarations = new Map<string, RawUses>();
  for (const [name, nodes] of declared) declarations.set(name, usesOf(nodes));
  const rest = usesOf(restNodes);
  rest.imports.push(...sideEffects.map((specifier) => ({ specifier, name: null })));

  return { outline: outlined, declarations, rest, exports, exportsAll, values, functions };
}

/* -------------------------------------------------------------------------- */
/* Resolving imports                                                           */
/* -------------------------------------------------------------------------- */

const BUNDLER: ts.CompilerOptions = { module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler };

/** What a tsconfig.json gives: its compiler options, `extends` and all, and the configs it refers to. */
interface Config {
  options: ts.CompilerOptions;
  references: string[];
}

/** Each tsconfig read, with the time it was last changed, so an edit to it is noticed. */
const configs = new Map<string, { changed: number; config: Config }>();

function readConfig(configPath: string): Config {
  const changed = statSync(configPath).mtimeMs;
  const known = configs.get(configPath);
  if (known?.changed === changed) return known.config;
  // Only the options are wanted. Listing the files the config covers would walk
  // the whole project, which on a large one costs more than everything else.
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...ts.sys,
    readDirectory: () => [],
    onUnRecoverableConfigFileDiagnostic: () => {},
  });
  const config = {
    options: parsed?.options ?? BUNDLER,
    references: (parsed?.projectReferences ?? []).map((reference) => ts.resolveProjectReferencePath(reference)),
  };
  configs.set(configPath, { changed, config });
  return config;
}

/**
 * Files a bundler lets code import that are not code: stylesheets, images,
 * fonts, media and data. Nearly every component imports some, and none of
 * them reaches anything, so they are passed over without a word.
 */
const NOT_CODE = /\.(css|scss|sass|less|styl|pcss|svg|png|jpe?g|gif|webp|avif|ico|bmp|tiff?|woff2?|ttf|otf|eot|mp3|mp4|webm|ogg|wav|flac|json|jsonc|json5|ya?ml|toml|csv|txt|md|html?|xml|graphql|gql)$/i;

/**
 * Whether a specifier names a place in the project rather than a package: a
 * path, a `paths` alias or a subpath import. `@/` and `~/` are always aliases,
 * because no package can be called that, so one that leads nowhere is said
 * to lead nowhere even where no tsconfig declares it.
 */
function namesAPlace(specifier: string, options: ts.CompilerOptions): boolean {
  if (/^[./#~]|^@\//.test(specifier) || path.isAbsolute(specifier)) return true;
  return Object.keys(options.paths ?? {}).some((pattern) => {
    const star = pattern.indexOf("*");
    return star === -1 ? specifier === pattern : specifier.startsWith(pattern.slice(0, star)) && specifier.endsWith(pattern.slice(star + 1));
  });
}

type Resolved = { file: string } | "outside" | "missing";

/** A function that works each answer out once, and gives it from memory after that. */
function remembering<T>(work: (key: string) => T): (key: string) => T {
  const known = new Map<string, T>();
  return (key) => {
    if (!known.has(key)) known.set(key, work(key));
    return known.get(key)!;
  };
}

/**
 * Resolves imports for one reading of a project, from files named by their
 * real path, the project's folder with every link in it followed.
 *
 * Where an import leads is a file of the project, somewhere outside it (a
 * built-in, a package, or code beyond the project folder), or nowhere that
 * could be found. It is decided after resolving rather than by how the
 * specifier looks, because an alias such as `@/db` looks exactly like a
 * package and a workspace package installed by link is the project's own code.
 *
 * What resolving learns about the disk — which files exist, which tsconfig
 * covers which folder, where each import leads — is kept for this reading
 * only. By the next one a file may have been added or removed, which changes
 * where an import leads without the importing file changing at all.
 */
function resolving(root: string): (fileName: string, specifier: string) => Resolved {
  const host: ts.ModuleResolutionHost = {
    fileExists: remembering((file) => ts.sys.fileExists(file)),
    directoryExists: remembering((dir) => ts.sys.directoryExists(dir)),
    realpath: remembering((file) => ts.sys.realpath?.(file) ?? file),
    readFile: remembering((file) => ts.sys.readFile(file)),
    getCurrentDirectory: () => ts.sys.getCurrentDirectory(),
    getDirectories: (dir) => ts.sys.getDirectories(dir),
  };
  const configAt = remembering(readConfig);
  // A tsconfig that only refers to others, as Vite's does, leaves the options
  // that matter, its `paths` above all, to those others, so each is tried in turn.
  const optionsIn = remembering((dir): ts.CompilerOptions[] => {
    const configPath = ts.findConfigFile(dir, host.fileExists);
    if (configPath === undefined) return [BUNDLER];
    const config = configAt(configPath);
    return [config.options, ...config.references.filter(host.fileExists).map((each) => configAt(each).options)];
  });

  const resolveWith = (specifier: string, fileName: string, options: ts.CompilerOptions) =>
    ts.resolveModuleName(specifier, fileName, options, host).resolvedModule ??
    // Code run by a bundler or tsx often imports in ways its tsconfig would
    // not allow, and it still means the file it names.
    (options.moduleResolution === ts.ModuleResolutionKind.Bundler
      ? undefined
      : ts.resolveModuleName(specifier, fileName, { ...options, ...BUNDLER }, host).resolvedModule);

  const resolve = (fileName: string, specifier: string): Resolved => {
    // A bundler's query, such as `?url` or `?raw`, is not part of the file's name.
    if (isBuiltin(specifier) || NOT_CODE.test(specifier.replace(/\?.*$/, ""))) return "outside";
    const tried = optionsIn(path.dirname(fileName));
    let found: ts.ResolvedModuleFull | undefined;
    for (const options of tried) {
      found = resolveWith(specifier, fileName, options);
      if (found) break;
    }
    if (!found) return tried.some((options) => namesAPlace(specifier, options)) ? "missing" : "outside";
    if (found.extension === ts.Extension.Json) return "outside";
    // Judged by where the file really is, not by `isExternalLibraryImport`,
    // which the compiler sets for a workspace package linked into
    // node_modules even though its source is the project's own.
    const relative = path.relative(root, path.resolve(found.resolvedFileName));
    if (relative.startsWith("..") || path.isAbsolute(relative) || relative.split(path.sep).includes("node_modules")) return "outside";
    return { file: relative.split(path.sep).join("/") };
  };

  // An import leads to the same place from any file in one folder.
  const answers = new Map<string, Resolved>();
  return (fileName, specifier) => {
    const key = `${path.dirname(fileName)}\n${specifier}`;
    if (!answers.has(key)) answers.set(key, resolve(fileName, specifier));
    return answers.get(key)!;
  };
}

function resolveUses(raw: RawUses, file: string, resolve: (specifier: string) => Resolved): Uses {
  const targets = new Map<string, Target>();
  const notChecked = new Set<string>();
  for (const { specifier, name } of raw.imports) {
    const found = resolve(specifier);
    if (found === "missing") notChecked.add(`an import of "${specifier}" in ${file} that could not be found`);
    else if (found !== "outside") targets.set(`${found.file}#${name}`, { file: found.file, name });
  }
  for (const { kind, specifier } of raw.dynamic) {
    // One that names a package is as silent as an import of it would be.
    if (specifier !== null && resolve(specifier) === "outside") continue;
    const written = specifier === null ? "" : ` of "${specifier}"`;
    notChecked.add(kind === "import" ? `a dynamic import${written} in ${file}` : `a require${written} in ${file}`);
  }
  return { targets: [...targets.values()], local: [...new Set(raw.local)], notChecked: [...notChecked] };
}

/** Starts one reading of a project, which reads each file handed to it. */
function reading(projectDir: string): (file: string, text: string) => FileReach {
  // The compiler follows links when it finds a package but not when it finds
  // a path, so a project opened through a link, a short name or a linked temp
  // folder is read from where it really is, or its own files would all seem
  // to lie outside it.
  const root = realpathSync.native(projectDir);
  const resolveFrom = resolving(root);
  return (file, text) => {
    const fileName = path.resolve(root, file);
    const parsed = parse(fileName, text);
    const resolve = (specifier: string) => resolveFrom(fileName, specifier);

    const declarations = new Map<string, Uses>();
    for (const [name, raw] of parsed.declarations) declarations.set(name, resolveUses(raw, file, resolve));

    const exports: FileReach["exports"] = new Map();
    for (const [name, entry] of parsed.exports) {
      if ("local" in entry) {
        exports.set(name, entry);
        continue;
      }
      // One that leads nowhere is left out, so following it finds nothing and says so.
      const found = resolve(entry.specifier);
      if (found !== "missing") exports.set(name, found === "outside" ? null : { file: found.file, name: entry.name });
    }

    const exportsAll: FileReach["exportsAll"] = [];
    for (const specifier of parsed.exportsAll) {
      const found = resolve(specifier);
      if (found === "outside") exportsAll.push(null);
      else if (found !== "missing") exportsAll.push(found.file);
    }

    return { declarations, values: parsed.values, rest: resolveUses(parsed.rest, file, resolve), exports, exportsAll, functions: parsed.functions };
  };
}

export const typescriptReach: ReachReader = { fileKind, reading };
