import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  mode: "structured",
  existingCode: false,
  start: "build",
  granularity: { level: 3, maxDepth: 3 },
  systems: [{ rootBlock: "double-it", language: "typescript" }],
};

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "fragmentor-snap-"));

  const root = makeBlock({
    id: "double-it",
    name: "Double It",
    inputs: { value: { type: t.number, description: "The number to double." } },
    outputs: { doubled: { type: t.number } },
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
    expect(snapshot.mode).toBe("structured");
    expect(Object.keys(snapshot.blocks).sort()).toEqual(["double-it", "double-it/add-to-self"]);

    const root = snapshot.blocks["double-it"]!;
    expect(root.inputs[0]).toMatchObject({
      name: "value",
      type: "number",
      typeIr: { kind: "number" },
      description: "The number to double.",
    });
    expect(root.functionName).toBe("doubleIt");
    expect(root.code).toBeNull();
  });

  it("lists the blocks each block is made of, and nothing about what calls what", async () => {
    const snapshot = await projectSnapshot(dir);

    expect(snapshot.blocks["double-it"]!.children).toEqual(["double-it/add-to-self"]);
    expect(snapshot.blocks["double-it/add-to-self"]!.children).toEqual([]);
  });

  it("has no sources before anything is generated, and carries them afterwards", async () => {
    expect((await projectSnapshot(dir)).blocks["double-it"]!.sources).toEqual({ impl: null, contract: null });

    await emitProject(await loadProject(dir));

    const after = (await projectSnapshot(dir)).blocks["double-it"]!;
    expect(after.sources.contract).toContain("export const doubleItInput");
    expect(after.sources.impl).toContain("export async function doubleIt");
    // Its code is the agent's to write, whatever is inside it, and the
    // starting point is not code anyone wrote.
    expect(after.implemented).toBe(false);
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
        access: [{ from: null, verb: "reads", resource: "nowhere", entry: null }],
      }),
    );

    const snapshot = await projectSnapshot(dir);
    expect(snapshot.diagnostics.map((d) => d.message)).toContainEqual(expect.stringContaining('no block called "nowhere"'));
    expect(Object.keys(snapshot.blocks)).toHaveLength(2);
  });
});

describe("a visual project's snapshot", () => {
  it("carries the code each block points at, and reports a pointer that leads nowhere", async () => {
    const other = await mkdtemp(path.join(tmpdir(), "fragmentor-snap-"));
    try {
      await writeFile(
        path.join(other, "fragmentor.json"),
        JSON.stringify({ name: "Seen", mode: "visual", language: "Go", granularity: { level: 2 }, systems: [{ rootBlock: "serve" }] }),
        "utf8",
      );
      await mkdir(path.join(other, "blocks", "serve", "handle"), { recursive: true });
      await writeFile(
        path.join(other, "blocks", "serve", "block.json"),
        JSON.stringify({ responsibility: "Serves requests.", code: "main.go#main" }),
        "utf8",
      );
      await writeFile(
        path.join(other, "blocks", "serve", "handle", "block.json"),
        JSON.stringify({ responsibility: "Handles one request.", code: "handler.go#Handle", inputs: { request: "*http.Request" } }),
        "utf8",
      );
      await writeFile(path.join(other, "main.go"), "package main\n\nfunc main() {\n\tserve()\n}\n", "utf8");

      const snapshot = await projectSnapshot(other);
      expect(snapshot.mode).toBe("visual");
      expect(snapshot.language).toBe("Go");
      expect(snapshot.systems).toEqual([{ rootBlock: "serve", language: "Go", displayName: "Go", known: true }]);

      const serve = snapshot.blocks.serve!;
      expect(serve.code).toMatchObject({ pointer: "main.go#main", file: "main.go", line: 3, excerptStart: 1 });
      expect(serve.code!.excerpt).toContain("func main()");
      expect(serve.implemented).toBe(true);
      expect(serve.sources).toEqual({ impl: null, contract: null });

      const handle = snapshot.blocks["serve/handle"]!;
      expect(handle.inputs[0]!.type).toBe("*http.Request");
      expect(handle.code).toBeNull();
      expect(snapshot.diagnostics).toContainEqual({
        severity: "error",
        blockPath: "serve/handle",
        message: '"Handle" points at code that is not there: "handler.go" does not exist.',
      });
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });
});
