import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { blockDir, createProject, holdsPlan, loadProject, locateCode, validateProject, writeBlock } from "./project.js";
import type { Manifest } from "./project.js";
import { makeBlock, t } from "../model/testing.js";

let dir: string;

const manifest: Manifest = {
  name: "Job Ranker",
  goal: "Rank job postings against a profile.",
  mode: "structured",
  existingCode: false,
  start: "build",
  granularity: { level: 3, maxDepth: 4 },
  systems: [{ rootBlock: "rank-jobs", language: "typescript" }],
};

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "fragmentor-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const writeManifestJson = (value: unknown) => writeFile(path.join(dir, "fragmentor.json"), JSON.stringify(value), "utf8");

/** Root composite with one child that scores a posting. */
async function writeSmallProject() {
  const root = makeBlock({
    id: "rank-jobs",
    name: "Rank Jobs",
    kind: "composite",
    inputs: { posting: { type: t.object({ title: t.string }) } },
    outputs: { score: { type: t.number } },
    children: [{ block: "score-posting", mode: "once" }],
    wires: [
      { source: { from: "input", port: "posting" }, target: { to: "block", block: "score-posting", port: "posting" } },
      { source: { from: "block", block: "score-posting", port: "score" }, target: { to: "output", port: "score" } },
    ],
  });

  const child = makeBlock({
    id: "score-posting",
    inputs: { posting: { type: t.object({ title: t.string }) } },
    outputs: { score: { type: t.number } },
  });

  await createProject(dir, manifest, [root]);
  await writeBlock(blockDir(dir, "rank-jobs/score-posting"), child);
}

describe("project round trip", () => {
  it("writes a project and reads back the same hierarchy", async () => {
    await writeSmallProject();
    const project = await loadProject(dir);

    expect(project.manifest).toEqual(manifest);
    expect(project.systems[0]!.root.block.id).toBe("rank-jobs");
    expect(project.systems[0]!.root.children.map((c) => c.path)).toEqual(["rank-jobs/score-posting"]);
    expect([...project.byPath.keys()].sort()).toEqual(["rank-jobs", "rank-jobs/score-posting"]);
  });

  it("finds no problems with a consistent project", async () => {
    await writeSmallProject();
    expect(validateProject(await loadProject(dir))).toEqual([]);
  });

  it("reports a folder the diagram does not know about", async () => {
    await writeSmallProject();
    await writeBlock(blockDir(dir, "rank-jobs/stray"), makeBlock({ id: "stray" }));

    const found = validateProject(await loadProject(dir));
    expect(found.map((d) => d.message)).toContain(
      'There is a folder for "stray" inside "Rank Jobs", but the diagram does not list it as a child.',
    );
  });

  it("reports a child the diagram lists but disk does not have", async () => {
    await writeSmallProject();
    const root = makeBlock({
      id: "rank-jobs",
      name: "Rank Jobs",
      kind: "composite",
      inputs: { posting: { type: t.object({ title: t.string }) } },
      outputs: { score: { type: t.number } },
      children: [{ block: "score-posting", mode: "once" }, { block: "missing", mode: "once" }],
      wires: [
        {
          source: { from: "input", port: "posting" },
          target: { to: "block", block: "score-posting", port: "posting" },
        },
        { source: { from: "block", block: "score-posting", port: "score" }, target: { to: "output", port: "score" } },
      ],
    });
    await writeBlock(blockDir(dir, "rank-jobs"), root);

    const found = validateProject(await loadProject(dir));
    expect(found.map((d) => d.message)).toContain(
      '"Rank Jobs" refers to a child block "missing" that does not exist.',
    );
  });

  it("ignores folders that are not blocks, so build artefacts do not break it", async () => {
    await writeSmallProject();

    // Exactly what `python -m compileall` leaves next to a generated file.
    await mkdir(path.join(blockDir(dir, "rank-jobs/score-posting"), "__pycache__"), { recursive: true });
    await writeFile(
      path.join(blockDir(dir, "rank-jobs/score-posting"), "__pycache__", "block.json"),
      "not a block at all",
      "utf8",
    );
    // A directory named like a block but holding none is not one either.
    await mkdir(path.join(blockDir(dir, "rank-jobs"), "notes"), { recursive: true });

    const project = await loadProject(dir);
    expect([...project.byPath.keys()].sort()).toEqual(["rank-jobs", "rank-jobs/score-posting"]);
    expect(validateProject(project)).toEqual([]);
  });

  it("gives a block the id of its folder, and a name made from it unless the file gives one", async () => {
    await writeSmallProject();
    await mkdir(blockDir(dir, "rank-jobs/extra-step"), { recursive: true });
    await writeFile(path.join(blockDir(dir, "rank-jobs/extra-step"), "block.json"), JSON.stringify({ responsibility: "x" }), "utf8");

    const block = (await loadProject(dir)).byPath.get("rank-jobs/extra-step")!.block;
    expect(block.id).toBe("extra-step");
    expect(block.name).toBe("Extra Step");
  });

  it("warns about a block deeper than the project allows", async () => {
    await writeSmallProject();
    await writeManifestJson({ ...manifest, granularity: { level: 3, maxDepth: 1 } });

    expect(validateProject(await loadProject(dir))).toEqual([
      {
        severity: "warning",
        blockPath: "rank-jobs/score-posting",
        message: '"score-posting" is 2 levels deep, but the project allows at most 1 (granularity.maxDepth in fragmentor.json).',
      },
    ]);
  });

  it("says why a block file could not be read", async () => {
    await writeSmallProject();
    await writeFile(path.join(blockDir(dir, "rank-jobs/score-posting"), "block.json"), "{ not json", "utf8");

    await expect(loadProject(dir)).rejects.toThrow(/Could not read the block definition at .*block\.json: .*JSON/s);
  });

  it("explains what is wrong with an invalid block file", async () => {
    await writeSmallProject();
    await writeFile(path.join(blockDir(dir, "rank-jobs/score-posting"), "block.json"), JSON.stringify({ name: "Score" }), "utf8");

    await expect(loadProject(dir)).rejects.toThrow(/responsibility/);
  });
});

describe("block paths", () => {
  it("refuse anything that could lead outside the blocks folder", () => {
    expect(() => blockDir(dir, "rank-jobs/../../../elsewhere")).toThrow(/is not a block path/);
    expect(() => blockDir(dir, "rank-jobs/..")).toThrow(/is not a block path/);
    expect(blockDir(dir, "rank-jobs/score-posting")).toBe(path.join(dir, "blocks", "rank-jobs", "score-posting"));
  });
});

describe("project settings", () => {
  it("may have no systems yet, while it waits for the agent to define them", async () => {
    await writeManifestJson({ name: "Waiting", mode: "structured", granularity: { level: 2 } });

    const project = await loadProject(dir);
    expect(project.systems).toEqual([]);
    expect(project.manifest).toEqual({
      name: "Waiting",
      goal: "",
      mode: "structured",
  existingCode: false,
  start: "build",
      granularity: { level: 2, maxDepth: 4 },
      systems: [],
    });
  });

  it("says what the person has to decide that a project file leaves out", async () => {
    await writeManifestJson({ name: "Undecided", systems: [] });

    await expect(loadProject(dir)).rejects.toThrow(/mode: must be "structured".*granularity: must say how finely/s);
  });

  it("explains how to fix a project still using the old single-system manifest", async () => {
    await writeSmallProject();
    await writeManifestJson({ name: "Old", goal: "Old shape.", rootBlock: "rank-jobs" });

    await expect(loadProject(dir)).rejects.toThrow(/uses the old single-system manifest.*"language": "typescript"/s);
  });

  it("refuses two systems sharing a root block", async () => {
    await writeSmallProject();
    await writeManifestJson({
      ...manifest,
      systems: [
        { rootBlock: "rank-jobs", language: "typescript" },
        { rootBlock: "rank-jobs", language: "python" },
      ],
    });

    await expect(loadProject(dir)).rejects.toThrow(/two systems cannot share a root block/);
  });

  it("gives each system the project's language unless it names its own", async () => {
    await writeSmallProject();
    await writeManifestJson({ ...manifest, language: "typescript", systems: [{ rootBlock: "rank-jobs" }] });

    expect((await loadProject(dir)).systems[0]!.language).toBe("typescript");
  });

  it("asks for a language when neither a structured system nor its project names one", async () => {
    await writeSmallProject();
    await writeManifestJson({ ...manifest, systems: [{ rootBlock: "rank-jobs" }] });

    await expect(loadProject(dir)).rejects.toThrow(/does not say what language the system "rank-jobs"/);
  });

  it("reports a structured system in another language than the one the person chose", async () => {
    await writeSmallProject();
    await writeManifestJson({ ...manifest, language: "python" });

    expect(validateProject(await loadProject(dir)).map((d) => d.message)).toContain(
      'The system "rank-jobs" is written in typescript, but this project is set to python, so every system in it uses python.',
    );
  });
});

describe("a visual project", () => {
  it("reads blocks whose types are the code's own, which structured mode would refuse", async () => {
    await writeManifestJson({ name: "Seen", mode: "visual", granularity: { level: 3 }, systems: [{ rootBlock: "serve" }] });
    await mkdir(blockDir(dir, "serve"), { recursive: true });
    await writeFile(
      path.join(blockDir(dir, "serve"), "block.json"),
      JSON.stringify({ responsibility: "Serves requests.", code: "src/server.ts#serve", inputs: { port: "Port" } }),
      "utf8",
    );

    const project = await loadProject(dir);
    expect(project.systems[0]!.language).toBe("");
    expect(project.byPath.get("serve")!.block.inputs.port!.type).toEqual({ kind: "text", text: "Port" });
  });
});

describe("locateCode", () => {
  const source = [
    'import { priceOrder } from "./order.js";',
    "",
    "export function priceOrders(orders) { return orders.map(priceOrder); }",
    "export function priceOrder(order) { return 1; }",
    "",
    "class Cart {",
    "  items = [];",
    "  total() { return 0; }",
    "}",
  ].join("\n");

  beforeEach(async () => {
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "src", "pricing.ts"), source, "utf8");
  });

  it("finds where a name is declared, not where it is first mentioned", async () => {
    const found = await locateCode(dir, "src/pricing.ts#priceOrder");
    expect(found).toMatchObject({ ok: true, location: { file: "src/pricing.ts", symbol: "priceOrder", line: 4 } });
  });

  it("finds a method inside its class", async () => {
    expect(await locateCode(dir, "src/pricing.ts#Cart.total")).toMatchObject({ ok: true, location: { line: 8 } });
  });

  it("accepts a file or a folder on its own", async () => {
    expect(await locateCode(dir, "src/pricing.ts")).toMatchObject({ ok: true, location: { line: null, text: source } });
    expect(await locateCode(dir, "src")).toMatchObject({ ok: true, location: { file: "src", text: null } });
  });

  it("says what is wrong with a pointer that leads nowhere", async () => {
    expect(await locateCode(dir, "src/missing.ts")).toEqual({ ok: false, problem: '"src/missing.ts" does not exist.' });
    expect(await locateCode(dir, "src/pricing.ts#discount")).toEqual({
      ok: false,
      problem: '"src/pricing.ts" has nothing called "discount".',
    });
    expect(await locateCode(dir, "../elsewhere.ts")).toEqual({
      ok: false,
      problem: '"../elsewhere.ts" points outside the project folder.',
    });
  });
});

describe("planned blocks", () => {
  it("spread downward, and are felt by every block above them", async () => {
    await writeSmallProject();

    // Only the middle block says it is planned. The one inside it says
    // nothing, and the one above it is real.
    await writeBlock(
      blockDir(dir, "rank-jobs/score-posting"),
      makeBlock({
        id: "score-posting",
        kind: "composite",
        planned: true,
        inputs: { posting: { type: t.object({ title: t.string }) } },
        outputs: { score: { type: t.number } },
        children: [{ block: "weigh-keywords", mode: "once" }],
      }),
    );
    await writeBlock(blockDir(dir, "rank-jobs/score-posting/weigh-keywords"), makeBlock({ id: "weigh-keywords" }));

    const project = await loadProject(dir);
    expect(project.byPath.get("rank-jobs/score-posting")!.block.planned).toBe(true);
    expect(project.byPath.get("rank-jobs/score-posting/weigh-keywords")!.block.planned).toBe(true);

    // The block above is real, but has no code to generate until the plan
    // beneath it is built.
    expect(project.byPath.get("rank-jobs")!.block.planned).toBe(false);
    expect(holdsPlan(project.byPath.get("rank-jobs")!)).toBe(true);
  });
});

describe("a project file written before the questions were asked", () => {
  it("reads as one started from nothing and built as it went", async () => {
    await writeManifestJson({
      name: "Older",
      goal: "",
      mode: "structured",
      language: "typescript",
      granularity: { level: 3, maxDepth: 4 },
      systems: [],
    });
    const project = await loadProject(dir);
    expect(project.manifest.existingCode).toBe(false);
    expect(project.manifest.start).toBe("build");
  });
});
