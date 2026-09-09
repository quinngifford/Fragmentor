import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { proposeDecomposition } from "./decompose.js";
import { ScriptedModelClient } from "./modelClient.js";
import { createProject, loadProject, validateProject, writeDecomposition } from "../project/project.js";
import { executionOrder } from "../model/validate.js";
import { jobRankerManifest, rankJobsProposal, rankJobsSeed, scorePostingProposal } from "../examples/jobRanker.js";

/**
 * The whole pipeline on one real example: a hand-written root block, two
 * rounds of decomposition, written to disk, read back, and checked. This is
 * the test that would catch the model, the project format, and the validator
 * disagreeing with each other.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "fragmentor-e2e-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function buildJobRanker(): Promise<void> {
  await createProject(dir, jobRankerManifest, rankJobsSeed);

  const root = await proposeDecomposition({
    parent: rankJobsSeed,
    projectGoal: jobRankerManifest.goal,
    blockPath: "rank-jobs",
    granularity: jobRankerManifest.granularity,
    depth: 0,
    client: new ScriptedModelClient([JSON.stringify(rankJobsProposal)]),
  });

  expect(root.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  await writeDecomposition(dir, "rank-jobs", root.parent, root.children);

  const scorer = root.children.find((c) => c.id === "score-posting")!;
  const nested = await proposeDecomposition({
    parent: scorer,
    projectGoal: jobRankerManifest.goal,
    blockPath: "rank-jobs/score-posting",
    granularity: jobRankerManifest.granularity,
    depth: 1,
    client: new ScriptedModelClient([JSON.stringify(scorePostingProposal)]),
  });

  expect(nested.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  await writeDecomposition(dir, "rank-jobs/score-posting", nested.parent, nested.children);
}

describe("decomposing a real project end to end", () => {
  it("produces a hierarchy that reads back off disk and validates", async () => {
    await buildJobRanker();

    const project = await loadProject(dir);
    expect(validateProject(project)).toEqual([]);

    expect([...project.byPath.keys()].sort()).toEqual([
      "rank-jobs",
      "rank-jobs/extract-profile-keywords",
      "rank-jobs/load-postings",
      "rank-jobs/rank-results",
      "rank-jobs/score-posting",
      "rank-jobs/score-posting/compute-relevance",
      "rank-jobs/score-posting/match-keywords",
      "rank-jobs/score-posting/normalize-text",
    ]);
  });

  it("carries the file capability down to the only block that needs it", async () => {
    await buildJobRanker();
    const project = await loadProject(dir);

    expect(project.byPath.get("rank-jobs")!.block.capabilities.files?.capability).toBe("FileSystem");
    expect(project.byPath.get("rank-jobs/load-postings")!.block.capabilities.files?.capability).toBe("FileSystem");
    // Nothing else needed it, so nothing else claims it.
    expect(project.byPath.get("rank-jobs/rank-results")!.block.capabilities).toEqual({});
  });

  it("keeps the per-posting scorer a single-item block despite array wiring", async () => {
    await buildJobRanker();
    const project = await loadProject(dir);

    const root = project.byPath.get("rank-jobs")!.block;
    expect(root.children).toContainEqual({ block: "score-posting", mode: "each", eachOver: "posting" });

    // The scorer itself knows nothing about arrays; `each` supplies the arity.
    const scorer = project.byPath.get("rank-jobs/score-posting")!.block;
    expect(scorer.inputs.posting!.type.kind).toBe("object");
    expect(scorer.outputs.score!.type.kind).toBe("number");
  });

  it("orders the root's children so every value exists before it is used", async () => {
    await buildJobRanker();
    const root = (await loadProject(dir)).byPath.get("rank-jobs")!.block;

    const order = executionOrder(root.children, root.wires);
    expect(order).toHaveLength(4);
    expect(order.indexOf("load-postings")).toBeLessThan(order.indexOf("score-posting"));
    expect(order.indexOf("extract-profile-keywords")).toBeLessThan(order.indexOf("score-posting"));
    expect(order.indexOf("score-posting")).toBeLessThan(order.indexOf("rank-results"));
  });

  it("lets one output feed two different destinations", async () => {
    await buildJobRanker();
    const root = (await loadProject(dir)).byPath.get("rank-jobs")!.block;

    const fromPostings = root.wires.filter(
      (w) => w.source.from === "block" && w.source.block === "load-postings" && w.source.port === "postings",
    );
    expect(fromPostings).toHaveLength(2);
  });

  it("flags the composite as stale-making if a child contract drifts", async () => {
    await buildJobRanker();
    const project = await loadProject(dir);

    // Simulate someone editing a child's contract without updating the parent.
    const child = project.byPath.get("rank-jobs/match-keywords");
    expect(child).toBeUndefined(); // it lives under score-posting, not the root

    const scorer = project.byPath.get("rank-jobs/score-posting")!;
    const matcher = scorer.children.find((c) => c.block.id === "match-keywords")!;
    matcher.block.outputs.matches = { type: { kind: "string" } };

    const diagnostics = validateProject(project);
    expect(diagnostics.map((d) => d.message)).toContainEqual(expect.stringContaining("Type mismatch"));
  });
});
