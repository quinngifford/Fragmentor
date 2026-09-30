import { isArchitecture } from "../model/roles.js";
import { getPack, isKnownLanguage } from "../lang/index.js";
import type { LanguagePack } from "../lang/index.js";
import type { Block } from "../model/block.js";
import { declaresSymbol, locateCode, systemOf } from "./project.js";
import type { CodeLocation, LoadedBlock, Project } from "./project.js";

/**
 * Where a block's code is, and whether it is Fragmentor's to check and run.
 *
 * A block says where its implementation lives and nothing more. The codebase's
 * layout is the codebase's own: a block's folder under `blocks/` says where the
 * block sits in the architecture, never where its code sits on disk.
 *
 * Fragmentor writes a contract for a block wherever it can — a function, not
 * planned, in a language there is a pack for, with its inputs and outputs
 * written as types rather than as words. The contract on its own changes
 * nothing about the code. What binds the two is the code importing it: code
 * that imports its contract is typechecked against it, run and tested, and code
 * that does not is drawn and read. The import is the only honest binding there
 * is, because nothing else could hold a function to a shape it never mentions.
 *
 * That makes all of it a fact about one block, which is what let the project's
 * two modes go. One codebase can have a part described as it stands and
 * another built under Fragmentor's eye, and `fragmentor check` says which
 * blocks are which.
 */

export interface BlockCode {
  /** The pointer as written, such as `src/api/book-seats.ts#bookSeats`. */
  pointer: string | null;
  /** Where that pointer leads, when it leads anywhere. */
  location: CodeLocation | null;
  /** Why it leads nowhere, in words for whoever wrote it. */
  problem: string | null;
  /** The contract Fragmentor writes for this block, relative to the project, or null for none. */
  contract: string | null;
  /** What the code has to import to be held to that contract. */
  contractImport: string | null;
  /**
   * True when the code imports its contract, which is what lets Fragmentor
   * check, run and test it — as far as its language can go: a bound block in
   * a language Fragmentor cannot run yet is still only drawn, and says so.
   */
  bound: boolean;
  /**
   * Why Fragmentor draws this block's code rather than checking and running
   * it, in words for the person and the agent, or null when it does check it.
   * Only ever set for a function block that is not planned.
   */
  drawnBecause: string | null;
  /** The function Fragmentor calls: the pointer's `#name`, or the language's name for the block. */
  functionName: string | null;
}

/** The language pack for a block's system, or null when nothing can be generated in it. */
export function packFor(project: Project, blockPath: string): LanguagePack | null {
  const language = systemOf(project, blockPath)?.language;
  return language !== undefined && language !== "" && isKnownLanguage(language) ? getPack(language) : null;
}

/** A contract can only be made of shapes; a port written in words has none. */
function portsAreTyped(block: Block): boolean {
  return [...Object.values(block.inputs), ...Object.values(block.outputs)].every((port) => port.type.kind !== "text");
}

/**
 * The contract file Fragmentor writes for a block, relative to the project, or
 * null where it writes none.
 *
 * The pack says where, so everything Fragmentor generates stays inside
 * `blocks/` and nothing of its appears in the codebase's own tree.
 */
function contractPathOf(node: LoadedBlock, pack: LanguagePack | null): string | null {
  if (pack === null || node.block.planned || isArchitecture(node.block.role) || !portsAreTyped(node.block)) return null;
  return pack.contractPath(node.path);
}

export async function readBlockCode(project: Project, node: LoadedBlock): Promise<BlockCode> {
  const block = node.block;
  const pointer = block.code ?? null;
  const pack = packFor(project, node.path);
  // A contract the language could not write — a capability port named a word
  // it reserves, say — is not written at all, and the why becomes the reason
  // the block is drawn, exactly as ports written in words are treated.
  const unwritable = pack?.contractProblem?.(block) ?? null;
  const contract = unwritable !== null ? null : contractPathOf(node, pack);
  const language = systemOf(project, node.path)?.language ?? "";

  /**
   * Why Fragmentor is only drawing this code. Nothing is said of a block that
   * was never going to be checked: a plan, or something that is not called.
   */
  const drawn = (reason: string | null): string | null =>
    block.planned || isArchitecture(block.role)
      ? null
      : pack === null
        ? `Fragmentor has no language pack for ${language === "" ? "this system's language" : language}`
        : contract === null
          ? (unwritable ?? "its inputs or outputs are written in words rather than as types, so there is no contract to hold it to")
          : reason;

  const nothing: BlockCode = {
    pointer,
    location: null,
    problem: null,
    contract,
    contractImport: null,
    bound: false,
    drawnBecause: drawn(null),
    functionName: null,
  };
  // Nothing is asked of a plan. A block inside one that does not exist yet does
  // not exist either, so a pointer it was written with before whatever holds it
  // became a plan is not followed, and not complained about.
  if (pointer === null || block.planned) return nothing;

  /**
   * A function block's pointer names the function Fragmentor calls. Where it
   * does not say which, the language's name for the block is what it means, and
   * that has to be there as surely as a name written out — otherwise the window
   * would offer to run a block the runner cannot find.
   */
  const named =
    !isArchitecture(block.role) && pack !== null && !pointer.includes("#")
      ? `${pointer}#${pack.functionName(block.id)}`
      : pointer;

  const found = await locateCode(project.dir, named);
  if (!found.ok) return { ...nothing, problem: found.problem };

  const location: CodeLocation = found.location;
  const specifier = pack === null || contract === null ? null : pack.contractSpecifier(contract, location.file);
  // A file the language itself could never import cannot import a contract
  // either, so nothing in it can be bound, however its text reads.
  const fileProblem = specifier === null ? null : (pack?.codeFileProblem?.(location.file) ?? null);
  const functionName = location.symbol ?? pack?.functionName(block.id) ?? null;
  // A folder, or a file too large to read. Nothing can be said about an import
  // in code Fragmentor never read, so it says that instead.
  const unread = location.text === null;
  // Finding the name is forgiving; calling it cannot be. A file that only
  // mentions the name is one the runner would refuse.
  const declared = location.text !== null && functionName !== null && declaresSymbol(location.text, functionName);
  const imports = specifier !== null && location.text !== null && location.text.includes(specifier);
  // The same file under another extension, which a codebase importing with
  // `.ts` extensions may well write, and which Fragmentor does not take as the import.
  const importsOtherwise =
    !imports && specifier !== null && location.text !== null && location.text.includes(specifier.replace(/[.][^./]+$/, ""));
  // A method, `Class.method`, is called on an object, never on its own with a
  // value and `caps`, so nothing can run it even where its file imports the
  // contract. It is drawn like any other code that is not held to one.
  const method = functionName?.includes(".") ?? false;
  const bound = imports && declared && !method && fileProblem === null;

  return {
    pointer,
    location,
    problem: null,
    contract,
    contractImport: specifier,
    bound,
    drawnBecause: drawn(
      specifier === null
        ? `Fragmentor cannot hold ${pack?.displayName ?? "this"} code to a contract yet, so it draws this code`
        : fileProblem !== null
          ? fileProblem
          : unread
            ? `Fragmentor could not read ${location.file}, so it draws this block rather than checking or running it`
            : !declared
              ? `${location.file} does not declare ${functionName ?? "this block's function"}, so there is nothing for Fragmentor to call`
              : bound
                ? pack!.canRun
                  ? null
                  : `Fragmentor cannot run ${pack!.displayName} code yet, so this block is not run or tested`
                : imports
                  ? `${functionName} is a method, and Fragmentor can only call a function on its own, with a value and \`caps\`, so it draws this code rather than running it`
                  : importsOtherwise
                    ? `${location.file} imports its contract, but not as "${specifier}", which is how Fragmentor knows to hold code to it, so it draws this code as it stands`
                    : `${location.file} does not import its contract, so Fragmentor draws this code as it stands rather than checking or running it`,
    ),
    functionName,
  };
}

/** Every block's code, read once, for whoever needs more than one of them. */
export async function readAllCode(project: Project): Promise<Map<string, BlockCode>> {
  const all = new Map<string, BlockCode>();
  for (const [blockPath, node] of project.byPath) all.set(blockPath, await readBlockCode(project, node));
  return all;
}
