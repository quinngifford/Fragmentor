import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  rootBlock: "rank-jobs",
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

  await createProject(dir, manifest, root);
  await writeBlock(blockDir(dir, "rank-jobs/score-posting"), child);
}

describe("project round trip", () => {
  it("writes a project and reads back the same hierarchy", async () => {
    await writeSmallProject();
    const project = await loadProject(dir);

    expect(project.manifest).toEqual(manifest);
    expect(project.root.block.id).toBe("rank-jobs");
    expect(project.root.children.map((c) => c.path)).toEqual(["rank-jobs/score-posting"]);
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
