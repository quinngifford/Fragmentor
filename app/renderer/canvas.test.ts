import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { projectSnapshot } from "../../src/project/snapshot.js";
import { BOX_H, BOX_W, buildTree } from "./tree.js";
import type { Tree } from "./tree.js";
import { READABLE_SCALE, boundsOf, fittedCamera } from "./canvas.js";
import { ui } from "./state.js";

/**
 * Where the view goes when the drawing is fitted to the window. A system that
 * fits at a size its names can be read at is shown whole, as it always was; a
 * larger one opens at its top, readable, and only Fit shrinks it to specks.
 */

const examples = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "examples");
/** The canvas the self-check's window leaves beside the inspector. */
const WIDE = 1235;
const HIGH = 880;

/** Where a block of the tree lands on a canvas, under a camera. */
function onScreen(tree: Tree, path: string, camera: { cx: number; cy: number; scale: number }) {
  const node = tree.nodes.get(path)!;
  const x = (node.x - camera.cx) * camera.scale + WIDE / 2;
  const y = (node.y - camera.cy) * camera.scale + HIGH / 2;
  return x >= 0 && y >= 0 && x + BOX_W * camera.scale <= WIDE && y + BOX_H * camera.scale <= HIGH;
}

function fits(tree: Tree) {
  const bounds = boundsOf(tree);
  const top = tree.roots[0]!;
  return {
    readable: fittedCamera(bounds, WIDE, HIGH, top.x + BOX_W / 2),
    whole: fittedCamera(bounds, WIDE, HIGH, null),
  };
}

describe("fitting the drawing to the window", () => {
  it("shows the examples whole, exactly as before", async () => {
    for (const [example, scale] of [["tickets", 0.77], ["messenger", 0.83]] as const) {
      ui.snapshot = await projectSnapshot(path.join(examples, example));
      const { readable, whole } = fits(buildTree());
      expect(readable, example).toEqual(whole);
      expect(whole.scale, example).toBeCloseTo(scale, 2);
    }
  });

  it("opens a large system readable, at its top, and Fit shows all of it", async () => {
    // About a hundred and ten blocks: five parts, three under each, and six
    // under each of those, which is wider than the window at any readable size.
    const snapshot = await projectSnapshot(path.join(examples, "messenger"));
    const some = Object.values(snapshot.blocks)[0]!;
    const blocks: Record<string, typeof some> = {};
    const add = (at: string, children: string[]) => {
      blocks[at] = { ...some, path: at, id: at.split("/").at(-1)!, children };
    };
    const parts = (at: string, count: number) => Array.from({ length: count }, (_, n) => `${at}/part-${n + 1}`);
    add("root", parts("root", 5));
    for (const part of parts("root", 5)) {
      add(part, parts(part, 3));
      for (const inner of parts(part, 3)) {
        add(inner, parts(inner, 6));
        for (const leaf of parts(inner, 6)) add(leaf, []);
      }
    }
    ui.snapshot = { ...snapshot, blocks, systems: [{ ...snapshot.systems[0]!, rootBlock: "root" }] };

    const tree = buildTree();
    expect(tree.nodes.size).toBe(111);
    const { readable, whole } = fits(tree);

    expect(readable.scale).toBe(READABLE_SCALE);
    expect(onScreen(tree, "root", readable)).toBe(true);
    // It is only too wide, so it is cut at the sides and nowhere else.
    for (const node of tree.nodes.values()) {
      const y = (node.y - readable.cy) * readable.scale + HIGH / 2;
      expect(y >= 0 && y + BOX_H * readable.scale <= HIGH, node.path).toBe(true);
    }

    expect(whole.scale).toBeLessThan(READABLE_SCALE);
    for (const node of tree.nodes.keys()) expect(onScreen(tree, node, whole), node).toBe(true);
  });

  it("shows what is too tall from its top, and what is too wide from where it starts, without running off its edge", () => {
    const tall = fittedCamera({ x: 0, y: 0, width: 400, height: 5000 }, WIDE, HIGH, 200);
    expect(tall.scale).toBe(READABLE_SCALE);
    expect(tall.cy).toBe(HIGH / 2 / READABLE_SCALE);
    expect(tall.cx).toBe(200);

    const wide = fittedCamera({ x: 0, y: 0, width: 8000, height: 300 }, WIDE, HIGH, 10);
    expect(wide.cx).toBe(WIDE / 2 / READABLE_SCALE);
    expect(wide.cy).toBe(150);
  });
});
