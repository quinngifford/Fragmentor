import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { blockDir, createProject, writeBlock, loadProject } from "./project.js";
import type { Manifest } from "./project.js";
import { loadLayout, layoutPath, saveViewLayout } from "./layout.js";
import { projectSnapshot } from "./snapshot.js";
import { emitProject } from "../codegen/emit.js";
import { makeBlock, t } from "../model/testing.js";

let dir: string;

const manifest: Manifest = {
  name: "Doubler",
  goal: "Double a number.",
  systems: [{ rootBlock: "double-it", language: "typescript" }],
  granularity: { level: 3, maxDepth: 3 },
};

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "fragmentor-snap-"));

  const root = makeBlock({
    id: "double-it",
    name: "Double It",
    kind: "composite",
    inputs: { value: { type: t.number, description: "The number to double." } },
    outputs: { doubled: { type: t.number } },
    children: [{ block: "add-to-self", mode: "once" }],
    wires: [
      { source: { from: "input", port: "value" }, target: { to: "block", block: "add-to-self", port: "value" } },
      { source: { from: "block", block: "add-to-self", port: "sum" }, target: { to: "output", port: "doubled" } },
    ],
  });

  const child = makeBlock({
    id: "add-to-self",
    name: "Add To Self",
    inputs: { value: { type: t.number } },
    outputs: { sum: { type: t.number } },
  });

  await createProject(dir, manifest, [root]);
  await writeBlock(blockDir(dir, "double-it/add-to-self"), child);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("layout", () => {
  it("is empty when the project has never been arranged", async () => {
    expect(await loadLayout(dir)).toEqual({});
  });

  it("round trips one diagram's positions", async () => {
    await saveViewLayout(dir, "double-it", { input: { x: 10.6, y: 20.2 }, "add-to-self": { x: 300, y: 40 } });

    expect(await loadLayout(dir)).toEqual({
      "double-it": { input: { x: 11, y: 20 }, "add-to-self": { x: 300, y: 40 } },
    });
  });

  it("leaves other diagrams alone when one is rearranged", async () => {
    await saveViewLayout(dir, "double-it", { input: { x: 1, y: 1 } });
    await saveViewLayout(dir, "double-it/add-to-self", { input: { x: 2, y: 2 } });

    const layout = await loadLayout(dir);
    expect(Object.keys(layout).sort()).toEqual(["double-it", "double-it/add-to-self"]);
    expect(layout["double-it"]).toEqual({ input: { x: 1, y: 1 } });
  });

  it("ignores a layout file it cannot read rather than failing to open the project", async () => {
    await writeFile(layoutPath(dir), "{ not json", "utf8");
    expect(await loadLayout(dir)).toEqual({});
  });
});

describe("projectSnapshot", () => {
  it("describes every block, with types both as text and as structure", async () => {
    const snapshot = await projectSnapshot(dir);

    expect(snapshot.name).toBe("Doubler");
    expect(Object.keys(snapshot.blocks).sort()).toEqual(["double-it", "double-it/add-to-self"]);

    const root = snapshot.blocks["double-it"]!;
    expect(root.inputs[0]).toMatchObject({
      name: "value",
      type: "number",
      typeIr: { kind: "number" },
      description: "The number to double.",
    });
    expect(root.functionName).toBe("doubleIt");
  });

  it("reports what each wire carries, and its execution order", async () => {
    const root = (await projectSnapshot(dir)).blocks["double-it"]!;

    expect(root.wires.map((w) => `${w.text} :: ${w.type}`)).toEqual([
      "input.value -> add-to-self.value :: number",
      "add-to-self.sum -> output.doubled :: number",
    ]);
    expect(root.order).toEqual(["add-to-self"]);
  });

  it("has no sources before anything is generated, and carries them afterwards", async () => {
    expect((await projectSnapshot(dir)).blocks["double-it"]!.sources).toEqual({ impl: null, contract: null });

    await emitProject(await loadProject(dir));

    const after = (await projectSnapshot(dir)).blocks["double-it"]!;
    expect(after.sources.contract).toContain("export const doubleItInput");
    expect(after.sources.impl).toContain("export async function doubleIt");
  });

  it("carries the saved layout so the canvas opens where it was left", async () => {
    await saveViewLayout(dir, "double-it", { "add-to-self": { x: 400, y: 120 } });
    const snapshot = await projectSnapshot(dir);
    expect(snapshot.layout["double-it"]).toEqual({ "add-to-self": { x: 400, y: 120 } });
  });

  it("reports diagnostics rather than throwing, so a broken project still opens", async () => {
    await writeBlock(
      blockDir(dir, "double-it/add-to-self"),
      makeBlock({
        id: "add-to-self",
        name: "Add To Self",
        inputs: { value: { type: t.string } },
        outputs: { sum: { type: t.number } },
      }),
    );

    const snapshot = await projectSnapshot(dir);
    expect(snapshot.diagnostics.map((d) => d.message)).toContainEqual(expect.stringContaining("Type mismatch"));
    expect(Object.keys(snapshot.blocks)).toHaveLength(2);
  });
});
