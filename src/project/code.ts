import path from "node:path";
import { isArchitecture } from "../model/roles.js";
import { getPack, isKnownLanguage } from "../lang/index.js";
import type { LanguagePack } from "../lang/index.js";
import type { Block } from "../model/block.js";
import { blockDir, locateCode, systemOf } from "./project.js";
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
 * that imports its contract is typechecked against it, run and tested, and
 * code that does not is drawn and read. The import is the only honest binding
 * there is, because nothing else could hold a function to a shape it never
 * mentions.
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
  /** True when the code imports its contract, so Fragmentor checks, runs and tests it. */
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
 * It sits in the block's own folder, so everything Fragmentor generates stays
 * inside `blocks/` and nothing of its appears in the codebase's own tree.
 */
export function contractPathOf(project: Project, node: LoadedBlock, pack: LanguagePack | null): string | null {
  if (pack === null || node.block.planned || isArchitecture(node.block.role) || !portsAreTyped(node.block)) return null;
  const dir = path.relative(project.dir, blockDir(project.dir, node.path)).split(path.sep).join("/");
  return `${dir}/${pack.contractFile}`;
}

/** The path one project file writes to reach another, as an import: `../../blocks/app/log-in/contract.ts`. */
function relativeFrom(fromFile: string, toFile: string): string {
  const relative = path.posix.relative(path.posix.dirname(fromFile), toFile);
  return relative.startsWith(".") ? relative : `./${relative}`;
}

export async function readBlockCode(project: Project, node: LoadedBlock): Promise<BlockCode> {
  const pointer = node.block.code ?? null;
  const pack = packFor(project, node.path);
  const contract = contractPathOf(project, node, pack);
  const drawn = (reason: string | null) =>
    node.block.planned || isArchitecture(node.block.role) ? null : reason;

  const language = systemOf(project, node.path)?.language ?? "";
  const noPack = `Fragmentor has no language pack for ${language === "" ? "this system's language" : language}`;
  const words =
    "its inputs or outputs are written in words rather than as types, so there is no contract to hold it to";

  const nothing: BlockCode = {
    pointer,
    location: null,
    problem: null,
    contract,
    contractImport: null,
    bound: false,
    drawnBecause: drawn(pack === null ? noPack : contract === null ? words : null),
    functionName: null,
  };
  if (pointer === null) return nothing;

  const found = await locateCode(project.dir, pointer);
  if (!found.ok) return { ...nothing, problem: found.problem };

  const location: CodeLocation = found.location;
  const specifier =
    pack === null || contract === null ? null : pack.contractSpecifier(relativeFrom(location.file, contract));
  const bound = specifier !== null && location.text !== null && location.text.includes(specifier);

  return {
    pointer,
    location,
    problem: null,
    contract,
    contractImport: specifier,
    bound,
    drawnBecause: drawn(
      pack === null
        ? noPack
        : contract === null
          ? words
          : bound
            ? null
            : `${location.file} does not import ${specifier ?? "its contract"}, so Fragmentor draws this code rather than checking or running it`,
    ),
    functionName: location.symbol ?? pack?.functionName(node.block.id) ?? null,
  };
}

/** Every block's code, read once, for whoever needs more than one of them. */
export async function readAllCode(project: Project): Promise<Map<string, BlockCode>> {
  const all = new Map<string, BlockCode>();
  for (const [blockPath, node] of project.byPath) all.set(blockPath, await readBlockCode(project, node));
  return all;
}
