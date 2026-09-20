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

export interface LanguagePack {
  /** Stored in fragmentor.json. */
  id: string;
  displayName: string;

  /** The generated contract's file name, inside a block's folder. */
  contractFile: string;
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
   * How this language writes an import of a file `relativePath` away, which is
   * how a block's code says it is held to its contract. Null where the
   * language has no settled answer, and so no block of it is ever bound.
   */
  contractSpecifier(relativePath: string): string | null;

  /**
   * Whether Fragmentor can execute a block in this language yet. A pack is
   * useful for generating code before it is useful for running it.
   */
  canRun: boolean;

  /** Whether `fragmentor check` can typecheck code in this language yet. */
  canCheck: boolean;
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
