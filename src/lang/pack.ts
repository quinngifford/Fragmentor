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
}

export interface LanguagePack {
  /** Stored in fragmentor.json. */
  id: string;
  displayName: string;

  /** File names inside a block's folder. */
  contractFile: string;
  implFile: string;
  /** The shared module of capability declarations, at the blocks root. */
  capabilitiesFile: string;

  /** What a block's function is called. */
  functionName(blockId: string): string;
  /** What a block's Input / Output / Caps types are called. */
  typeName(blockId: string, role: "Input" | "Output" | "Caps"): string;

  /** How a port type is written natively. Used for display as well as code. */
  typeExpression(type: PortType): string;

  /** The generated, never-hand-edited half of a block. */
  contractSource(request: ContractRequest): string;
  /** The frame a leaf's implementation is written inside, created once. */
  implScaffold(block: Block): string;
  /**
   * The whole of a composite's implementation, generated from its diagram. A
   * composite does nothing but call its children, so there is nothing in it
   * for anyone to write and nothing that can drift from the diagram.
   */
  compositeSource(block: Block): string;
  /** The shared capability declarations for a project. */
  capabilitiesSource(): string;

  /**
   * Whether Fragmentor can execute a block in this language yet. A pack is
   * useful for generating code before it is useful for running it.
   */
  canRun: boolean;

  /** Whether `fragmentor check` can typecheck code in this language yet. */
  canCheck: boolean;

  /**
   * A block whose implementation still looks like this has not been written.
   * Used to report progress honestly rather than counting files.
   */
  isUnimplemented(implSource: string): boolean;
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
