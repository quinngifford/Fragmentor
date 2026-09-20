import type { SnapshotBlock } from "../../src/project/snapshot.js";
import { requireSnapshot } from "./state.js";

/**
 * The architecture as one drawing: every block of every system, each under
 * the block it is part of.
 *
 * The tree says one thing — what is part of what — and says it with plain
 * lines, so nothing on it can be read as a call or as data going anywhere.
 * What happens at runtime is drawn over it as an execution, and what a block
 * is able to reach is drawn over it as a dependency; both are separate, and
 * both can be put away.
 *
 * Nothing is laid out by hand. A block stands where its place in the
 * hierarchy puts it, and a block with parts can be folded to put them away
 * when a system is too big to read at once.
 */

/** A block's box. Small, because every block of the system is on screen at once. */
export const BOX_W = 168;
export const BOX_H = 40;
/** Between two boxes side by side, and between one row and the next. */
const COL_GAP = 22;
const ROW_GAP = 46;
/** Between two systems, which are separate programs drawn side by side. */
const SYSTEM_GAP = 80;
/**
 * A block whose parts have no parts of their own lists them under it instead
 * of spreading them sideways. Spread, a system of any size is a very wide,
 * very short drawing that has to be shrunk to nothing to fit on screen; the
 * room is underneath it.
 */
const STACK_INDENT = 24;
const STACK_GAP = 10;
/** How far under a block its list begins, leaving room for the line into it. */
const STACK_TOP = 22;

export interface TreeNode {
  /** The block's path, which is also its key on the canvas. */
  path: string;
  block: SnapshotBlock;
  depth: number;
  x: number;
  y: number;
  /** The parts drawn under it: none when it has none, and none while it is folded. */
  children: TreeNode[];
  /** Whether it has parts at all, which is what makes it foldable. */
  hasParts: boolean;
  folded: boolean;
  /** Whether its parts are listed under it rather than spread across the row below. */
  listed: boolean;
}

export interface Tree {
  /** One per system: a project is several programs drawn side by side. */
  roots: TreeNode[];
  nodes: Map<string, TreeNode>;
  width: number;
  height: number;
}

/** Where the line from a block to its parts turns: halfway down the gap between the rows. */
export function busY(node: TreeNode): number {
  return node.y + BOX_H + ROW_GAP / 2;
}

/** Where the line down the side of a listed block's parts runs. */
export function spineX(node: TreeNode): number {
  return node.x + STACK_INDENT / 2;
}

/**
 * Every block placed: parts under whatever they are part of, and a parent
 * centred over them. Leaves take a column each in the order they are written,
 * so the tree never crosses itself and no two boxes can overlap.
 */
export function buildTree(folded: ReadonlySet<string> = new Set()): Tree {
  const snapshot = requireSnapshot();
  const nodes = new Map<string, TreeNode>();
  let cursor = 0;
  let bottom = 0;

  /** The parts a block is drawn with: none while it is folded. */
  const partsOf = (block: SnapshotBlock, isFolded: boolean) => (isFolded ? [] : block.children.filter((part) => snapshot.blocks[part]));

  const place = (path: string, depth: number, y: number): TreeNode | null => {
    const block = snapshot.blocks[path];
    if (!block) return null;
    bottom = Math.max(bottom, y + BOX_H);

    const parts = partsOf(block, folded.has(path));
    const listed = parts.length > 0 && parts.every((part) => snapshot.blocks[part]?.children.length === 0);

    const node: TreeNode = {
      path,
      block,
      depth,
      x: 0,
      y: y,
      children: [],
      hasParts: block.children.length > 0,
      folded: folded.has(path),
      listed,
    };
    nodes.set(path, node);

    if (listed) {
      // Its own column, with its parts listed down it, indented. They are in
      // that column too, so the columns they took as leaves are given back,
      // and the column is widened by however far they are indented.
      node.x = cursor;
      cursor += BOX_W + STACK_INDENT + COL_GAP;
      const beside = cursor;
      parts.forEach((part, at) => {
        const child = place(part, depth + 1, node.y + BOX_H + STACK_TOP + at * (BOX_H + STACK_GAP));
        if (child) {
          child.x = node.x + STACK_INDENT;
          node.children.push(child);
        }
      });
      cursor = beside;
      return node;
    }

    for (const part of parts) {
      const child = place(part, depth + 1, (depth + 1) * (BOX_H + ROW_GAP));
      if (child) node.children.push(child);
    }

    if (node.children.length === 0) {
      node.x = cursor;
      cursor += BOX_W + COL_GAP;
    } else {
      node.x = (node.children[0]!.x + node.children[node.children.length - 1]!.x) / 2;
    }
    return node;
  };

  const roots: TreeNode[] = [];
  for (const system of snapshot.systems) {
    const root = place(system.rootBlock, 0, 0);
    if (!root) continue;
    roots.push(root);
    cursor += SYSTEM_GAP;
  }

  return {
    roots,
    nodes,
    width: Math.max(0, cursor - COL_GAP - (roots.length > 0 ? SYSTEM_GAP : 0)),
    height: bottom,
  };
}

/**
 * The block on screen that stands for a path: itself, or the folded block it
 * is inside. Null for a path that is not in the project at all.
 *
 * Folding is the one thing that hides a block, so it is also the one thing
 * that gathers what happens deeper up to a block that is showing.
 */
export function shownAt(tree: Tree, path: string): TreeNode | null {
  const segments = path.split("/");
  // Everything the tree placed is drawn, so the first one found on the way up
  // from the block itself is the one standing for it.
  for (let depth = segments.length; depth > 0; depth -= 1) {
    const node = tree.nodes.get(segments.slice(0, depth).join("/"));
    if (node) return node;
  }
  return null;
}
