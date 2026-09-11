import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { blockDir, createProject, loadProject, validateProject, writeBlock } from "./project.js";
import type { Manifest } from "./project.js";
import { makeBlock, t } from "../model/testing.js";

let dir: string;

const manifest: Manifest = {
  name: "Job Ranker",
  goal: "Rank job postings against a profile.",
  systems: [{ rootBlock: "rank-jobs", language: "typescript" }],
  granularity: { level: 3, maxDepth: 4 },
};

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "fragmentor-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

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

  it("still reports a real block folder the diagram does not list", async () => {
    await writeSmallProject();
    await writeBlock(blockDir(dir, "rank-jobs/stray"), makeBlock({ id: "stray" }));

    expect(validateProject(await loadProject(dir)).map((d) => d.message)).toContain(
      'There is a folder for "stray" inside "Rank Jobs", but the diagram does not list it as a child.',
    );
  });

  it("warns about a block deeper than the project allows", async () => {
    await writeSmallProject();
    await writeFile(
      path.join(dir, "fragmentor.json"),
      JSON.stringify({ ...manifest, granularity: { level: 3, maxDepth: 1 } }),
      "utf8",
    );

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

  it("explains how to fix a project still using the old single-system manifest", async () => {
    await writeSmallProject();
    await writeFile(
      path.join(dir, "fragmentor.json"),
      JSON.stringify({ name: "Old", goal: "Old shape.", rootBlock: "rank-jobs" }),
      "utf8",
    );

    await expect(loadProject(dir)).rejects.toThrow(/uses the old single-system manifest.*"language": "typescript"/s);
  });

  it("refuses two systems sharing a root block", async () => {
    await writeSmallProject();
    await writeFile(
      path.join(dir, "fragmentor.json"),
      JSON.stringify({
        name: "Twice",
        goal: "Same root twice.",
        systems: [
          { rootBlock: "rank-jobs", language: "typescript" },
          { rootBlock: "rank-jobs", language: "python" },
        ],
      }),
      "utf8",
    );

    await expect(loadProject(dir)).rejects.toThrow(/two systems cannot share a root block/);
  });

  it("refuses a block whose id disagrees with its folder", async () => {
    await writeSmallProject();
    await writeBlock(blockDir(dir, "rank-jobs/score-posting"), makeBlock({ id: "renamed" }));

    await expect(loadProject(dir)).rejects.toThrow(
      /The block in folder "score-posting" calls itself "renamed"/,
    );
  });

  it("explains what is wrong with an invalid block file", async () => {
    await writeSmallProject();
    await writeFile(
      path.join(blockDir(dir, "rank-jobs/score-posting"), "block.json"),
      JSON.stringify({ id: "score-posting", name: "Score", kind: "leaf" }),
      "utf8",
    );

    await expect(loadProject(dir)).rejects.toThrow(/responsibility/);
  });
});
