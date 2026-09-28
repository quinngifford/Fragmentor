import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { projectSnapshot } from "../../src/project/snapshot.js";
import { BOX_H, BOX_W, buildTree, shownAt } from "./tree.js";
import type { Tree } from "./tree.js";
import { ui } from "./state.js";

/**
 * The architecture as one drawing. Where each block lands is decided here,
 * before anything is drawn, so this is where it is held still: parts under
 * what they are part of, nothing on top of anything else, and folding as the
 * one thing that takes a block off the drawing.
 */

const messenger = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "examples", "messenger");

beforeAll(async () => {
  ui.snapshot = await projectSnapshot(messenger);
});

/** No two boxes of the tree on top of each other. */
function expectApart(tree: Tree): void {
  const boxes = [...tree.nodes.values()];
  for (const a of boxes) {
    for (const b of boxes) {
      if (a.path >= b.path) continue;
      const apart = a.x + BOX_W <= b.x || b.x + BOX_W <= a.x || a.y + BOX_H <= b.y || b.y + BOX_H <= a.y;
      expect(apart, `${a.path} and ${b.path} overlap`).toBe(true);
    }
  }
}

describe("the whole system as a tree", () => {
  it("puts the system at the top and every part under what it is part of", () => {
    const tree = buildTree();
    expect(tree.roots.map((root) => root.path)).toEqual(["app"]);
    expect(tree.nodes.size).toBe(Object.keys(ui.snapshot!.blocks).length);

    for (const node of tree.nodes.values()) {
      for (const child of node.children) {
        expect(child.depth, child.path).toBe(node.depth + 1);
        expect(child.y, child.path).toBeGreaterThan(node.y + BOX_H);
      }
    }
  });

  it("centres a block over its parts", () => {
    const tree = buildTree();
    const api = tree.nodes.get("app/api")!;
    const first = api.children[0]!;
    const last = api.children[api.children.length - 1]!;
    expect(api.x).toBe((first.x + last.x) / 2);
    expect(first.x).toBeLessThan(last.x);
  });

  it("leaves no two blocks on top of each other, whatever is folded", () => {
    expectApart(buildTree());
    // Folding one part turns the row it is in into a list, when the rest of
    // that row has no parts either; neither way may anything overlap.
    for (const block of Object.values(ui.snapshot!.blocks)) {
      if (block.children.length > 0) expectApart(buildTree(new Set([block.path])));
    }
  });

  it("folds a block's parts away, and stands for them while they are gone", () => {
    const whole = buildTree();
    const folded = buildTree(new Set(["app/client"]));

    expect(whole.nodes.has("app/client/ui/send-button")).toBe(true);
    expect(folded.nodes.has("app/client/ui/send-button")).toBe(false);
    expect(folded.nodes.get("app/client")!.folded).toBe(true);
    expect(folded.width).toBeLessThan(whole.width);

    // What happens inside a folded block is drawn at the block itself.
    expect(shownAt(folded, "app/client/ui/send-button")!.path).toBe("app/client");
    // Nothing else is folded, so everything else stands for itself.
    expect(shownAt(folded, "app/api/router")!.path).toBe("app/api/router");
    expect(shownAt(folded, "nothing/here")).toBeNull();
  });
});

describe("a block whose parts are listed, beside one whose parts run deeper", () => {
  /** A system of whatever shape, built straight into a snapshot. */
  function shaped(parts: Record<string, string[]>): void {
    const snapshot = ui.snapshot!;
    const blocks: Record<string, (typeof snapshot.blocks)[string]> = {};
    const some = Object.values(snapshot.blocks)[0]!;
    for (const [path, children] of Object.entries(parts)) {
      blocks[path] = { ...some, path, id: path.split("/").at(-1)!, children };
    }
    ui.snapshot = { ...snapshot, blocks, systems: [{ ...snapshot.systems[0]!, rootBlock: "root" }] };
  }

  it("leaves room for the list, which is indented and would otherwise reach into the next column", () => {
    // The shape that matters: one branch lists leaves, the one beside it goes
    // deeper, so the two are drawn side by side at different depths.
    shaped({
      root: ["root/listed", "root/spread"],
      "root/listed": ["root/listed/l1", "root/listed/l2"],
      "root/listed/l1": [],
      "root/listed/l2": [],
      "root/spread": ["root/spread/c1"],
      "root/spread/c1": ["root/spread/c1/deep"],
      "root/spread/c1/deep": [],
    });

    const tree = buildTree();
    expect(tree.nodes.size).toBe(7);
    expectApart(tree);
  });

  it("lists parts once the ones with parts of their own are folded away, which is what makes folding narrow a row", () => {
    shaped({
      root: ["root/deep", "root/leaf"],
      "root/deep": ["root/deep/inner"],
      "root/deep/inner": [],
      "root/leaf": [],
    });

    const spread = buildTree();
    const folded = buildTree(new Set(["root/deep"]));
    expect(spread.nodes.get("root")!.listed).toBe(false);
    expect(folded.nodes.get("root")!.listed).toBe(true);
    expect(folded.nodes.get("root/deep")!.folded).toBe(true);
    expect(folded.width).toBeLessThan(spread.width);
    expectApart(folded);
  });
});
