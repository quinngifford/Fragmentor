import { CAPABILITIES, canRead, reachesResource } from "../model/capabilities.js";
import { describeType } from "../model/types.js";
import type { PortType } from "../model/types.js";
import { resolveAccess } from "./project.js";
import type { LoadedBlock, Project } from "./project.js";

/**
 * What a block's capability ports are ways into.
 *
 * A `Store` or `Queue` port is not a general effect like the clock: it is a
 * way into one particular table, file or channel that somebody drew. Which
 * one is said by the access naming the port, so working it out means
 * resolving that access — which needs the project, not just the block.
 *
 * Three things ask the same question and must get the same answer: the
 * contract generator, which writes the port's type; the runner, which has to
 * build a substitute for it; and the test bench, which has to offer somewhere
 * to put the rows the run will read. So it is answered once, here.
 */

export interface BoundStore {
  /** The capability port on the block, as its code refers to it. */
  port: string;
  /** `Store` or `Queue`. */
  capability: string;
  /**
   * What it is a way into, as one name: `support-desk/accounts-file.accounts`.
   *
   * The resource is written as its path from the blocks root rather than as
   * the id the access used, because two blocks in different parts of a system
   * may reach different stores by the same id, and a run has to keep them
   * apart.
   */
  target: string;
  /** For showing a person what they are filling in. */
  resourceName: string;
  entry: string;
  /** What it holds. Null when the entry is described in words the parser did not recognise. */
  shape: PortType | null;
  /** Whether rows can be put there before a run, or only watched as the run puts them there. */
  seedable: boolean;
}

/** The one name a run keeps a store's contents under. */
export function storeTarget(resourcePath: string, entry: string): string {
  return `${resourcePath}.${entry}`;
}

/**
 * The bound ports of one block. A port whose access cannot be resolved is left
 * out rather than guessed at: `check` reports it, and a run that invented a
 * substitute for it would hide the mistake behind a working test.
 */
export function boundStores(project: Project, node: LoadedBlock): BoundStore[] {
  const found: BoundStore[] = [];

  for (const [port, declared] of Object.entries(node.block.capabilities)) {
    if (!reachesResource(declared.capability)) continue;

    const bound = node.block.access.find((each) => each.from === port);
    if (!bound || bound.entry === null) continue;

    const resource = resolveAccess(project, node.path, bound.resource);
    const entry = resource?.block.exposes[bound.entry];
    if (!resource || !entry) continue;

    // A store entry holds one shape, which is why its file may write it once.
    // Whichever direction is there is read, since a channel says only what
    // goes onto it and a read-only table only what comes off it.
    const shape: PortType | null = entry.returns ?? entry.accepts;
    found.push({
      port,
      capability: declared.capability,
      target: storeTarget(resource.path, bound.entry),
      resourceName: resource.block.name,
      entry: bound.entry,
      // A shape the parser kept as words describes something it has no way to
      // check, so the run lets whatever is seeded through rather than
      // refusing rows against a type that is really a sentence.
      shape: shape === null || shape.kind === "text" ? null : shape,
      seedable: canRead(declared.capability),
    });
  }

  return found;
}

/**
 * The bound ports a run has to supply: those of the block being run.
 *
 * Only that block's, because capabilities flow down by name — a child is
 * handed the same object its parent was given — so the ports the run must
 * build are exactly the ones the block at the top declares. Its descendants
 * declare the same names, and `check` holds them to the same kinds.
 */
export function storesForRun(project: Project, blockPath: string): BoundStore[] {
  const node = project.byPath.get(blockPath);
  return node ? boundStores(project, node) : [];
}

/** `Store<{ id: string }>`, or `Store` for a port with nothing to fill in. */
export function describeBound(store: BoundStore): string {
  const parameter = CAPABILITIES[store.capability]?.parameter;
  if (!parameter) return store.capability;
  return `${store.capability}<${store.shape ? describeType(store.shape) : "unknown"}>`;
}
