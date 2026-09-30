import type { Block } from "../model/block.js";
import type { PortType } from "../model/types.js";

/**
 * Everything Fragmentor needs to know about a target language.
 *
 * The block model, the validator and the project format know nothing about
 * any language. This is the one seam where that knowledge lives, so that
 * adding a language means adding a pack rather than editing the kernel.
 *
 * A pack owns the whole of each file it produces rather than filling holes in
 * a shared template, because a template that suited two languages at once
 * would produce code that reads naturally in neither.
 */

export interface ContractRequest {
  block: Block;
  /** Slash-joined path from the blocks root, used to reach shared modules. */
  blockPath: string;
  /**
   * For each capability port that is a way into something drawn on the
   * diagram, the shape of what that thing holds: a `Store` bound to a table
   * of accounts is written `Store<Account>` rather than left to `unknown`.
   *
   * It is passed in rather than read off the block because the shape belongs
   * to the block being reached, which only the project has in hand.
   */
  bound?: Record<string, PortType>;
}

/**
 * A place in the project that code leads to: a name that another file
 * declares or exports.
 */
export interface Target {
  /** Relative to the project, with forward slashes. */
  file: string;
  /**
   * The name used. `*` is the whole module used as a value, such as a
   * namespace handed on whole, and null is an import that only runs the file.
   */
  name: string | null;
}

/** What one stretch of code uses: in other files, in its own file, and what could not be read. */
export interface Uses {
  targets: Target[];
  /** Names declared at the top of the same file. */
  local: string[];
  /** Why something it reaches could not be followed, in words, such as `a dynamic import in src/x.ts`. */
  notChecked: string[];
}

/**
 * What one file's code reaches, cut up the way blocks point at code: by the
 * names declared at its top level, and the rest.
 *
 * Imports of the language's built-ins and of installed packages are already
 * left out, because what a package does is the package's business, and every
 * target is a file inside the project.
 */
export interface FileReach {
  /** Each top-level function, class or variable, by name. */
  declarations: Map<string, Uses>;
  /** The declarations that are values rather than functions or classes, such as an object bundling several services, whose parts may be used one at a time. */
  values: Set<string>;
  /** Top-level statements, and imports that only run a file. */
  rest: Uses;
  /**
   * Names the file exports without declaring them: another of its own names
   * under a new one, or a name passed on from another file. Null for one
   * passed on from a package.
   */
  exports: Map<string, { local: string } | Target | null>;
  /** Files every export of which is passed on, as `export * from` does. Null for a package's. */
  exportsAll: (string | null)[];
}

/** How a pack reads what code reaches, for comparing it with what the diagram says. */
export interface ReachReader {
  /** Whether a project file is this language's code, a test of it, or neither. */
  fileKind(file: string): "code" | "test" | null;
  /**
   * Starts one reading of a project, which reads each file handed to it by
   * its path relative to the project and its text. What a reading learns about
   * the disk on the way is kept only while it lasts.
   */
  reading(projectDir: string): (file: string, text: string) => FileReach;
}

export interface LanguagePack {
  /** Stored in fragmentor.json. */
  id: string;
  displayName: string;

  /**
   * Where the generated contract of a block at this slash-joined path is
   * written, relative to the project. TypeScript puts it in the block's own
   * folder; a language whose imports cannot reach a hyphenated folder puts it
   * in a mirror the language can import instead.
   */
  contractPath(blockPath: string): string;
  /** The shared module of capability declarations, at the blocks root. */
  capabilitiesFile: string;

  /** What a block's function is called. */
  functionName(blockId: string): string;
  /** What a block's Input / Output / Caps types are called. */
  typeName(blockId: string, role: "Input" | "Output" | "Caps"): string;

  /** How a port type is written natively. Used for display as well as code. */
  typeExpression(type: PortType): string;

  /**
   * The generated, never-hand-edited half of a block. A block with no
   * outputs returns nothing, and one with no inputs is handed an empty
   * object, so every block is called the same way: with a value and `caps`.
   */
  contractSource(request: ContractRequest): string;
  /** The shared capability declarations for a project. */
  capabilitiesSource(): string;

  /**
   * What a block's code writes to import its contract, which is how it says it
   * is held to it. Both paths are relative to the project: the contract from
   * `contractPath`, and the file the import would be written in. Null where
   * the language has no settled answer, and so no block of it is ever bound.
   */
  contractSpecifier(contractPath: string, fromFile: string): string | null;

  /**
   * Why this language could not import the file a block's code pointer names,
   * in words for whoever wrote it, or null where it could. A file no import
   * can reach — a hyphen in a Python module's name, say — cannot import its
   * contract either, so its block is drawn.
   */
  codeFileProblem?(file: string): string | null;

  /**
   * Why no contract can be written for this block in this language, in words,
   * or null where one can. A Python capability port called `class`, say, has
   * no way of being declared on a protocol. Such a block gets no contract at
   * all, and the why becomes the reason it is drawn.
   */
  contractProblem?(block: Block): string | null;

  /**
   * Whether Fragmentor can execute a block in this language yet. A pack is
   * useful for generating code before it is useful for running it.
   */
  canRun: boolean;

  /** Whether `fragmentor check` can typecheck code in this language yet. */
  canCheck: boolean;

  /** How to read what this language's code reaches. A pack without it cannot say. */
  reach?: ReachReader;
}

const packs = new Map<string, LanguagePack>();

export function registerPack(pack: LanguagePack): void {
  packs.set(pack.id, pack);
}

export function getPack(id: string): LanguagePack {
  const pack = packs.get(id);
  if (!pack) {
    throw new Error(`No language pack for "${id}". Available: ${[...packs.keys()].sort().join(", ") || "none"}.`);
  }
  return pack;
}

export function knownLanguages(): { id: string; displayName: string }[] {
  return [...packs.values()].map((pack) => ({ id: pack.id, displayName: pack.displayName }));
}

export function isKnownLanguage(id: string): boolean {
  return packs.has(id);
}

/**
 * A language named as a person writes it, as the packs know it: `TypeScript`
 * is the `typescript` pack.
 *
 * Meaning the language Fragmentor can check and writing its name the ordinary
 * way should not cost anyone the checks, and a name no pack answers to is left
 * exactly as it was written, because it is theirs to say what their code is in.
 */
export function normaliseLanguage(name: string): string {
  const wanted = name.trim().toLowerCase();
  const found = [...packs.values()].find(
    (pack) => pack.id === wanted || pack.displayName.toLowerCase() === wanted,
  );
  return found?.id ?? name.trim();
}
