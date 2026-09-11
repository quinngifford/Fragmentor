import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { languageOf, loadProject, validateProject } from "./project.js";
import { executionOrder } from "../model/validate.js";

/**
 * The example projects are checked in exactly as an agent would leave them,
 * so they are the closest thing to real use the suite has. These tests hold
 * them to the rules, and use them to exercise the parts of the model that are
 * easy to get wrong.
 */

const examples = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "examples");
const jobRanker = path.join(examples, "job-ranker");

describe("the job-ranker example", () => {
  it("reads off disk and validates cleanly", async () => {
    const project = await loadProject(jobRanker);
    expect(validateProject(project)).toEqual([]);

    expect([...project.byPath.keys()].sort()).toEqual([
      "embed-postings",
      "embed-postings/clean-text",
      "embed-postings/embed-text",
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
    const project = await loadProject(jobRanker);

    expect(project.byPath.get("rank-jobs")!.block.capabilities.files?.capability).toBe("FileSystem");
    expect(project.byPath.get("rank-jobs/load-postings")!.block.capabilities.files?.capability).toBe("FileSystem");
    // Nothing else needed it, so nothing else claims it.
    expect(project.byPath.get("rank-jobs/rank-results")!.block.capabilities).toEqual({});
  });

  it("keeps the per-posting scorer a single-item block despite array wiring", async () => {
    const project = await loadProject(jobRanker);

    const root = project.byPath.get("rank-jobs")!.block;
    expect(root.children).toContainEqual({ block: "score-posting", mode: "each", eachOver: "posting" });

    // The scorer itself knows nothing about arrays; `each` supplies the arity.
    const scorer = project.byPath.get("rank-jobs/score-posting")!.block;
    expect(scorer.inputs.posting!.type.kind).toBe("object");
    expect(scorer.outputs.score!.type.kind).toBe("number");
  });

  it("orders the root's children so every value exists before it is used", async () => {
    const root = (await loadProject(jobRanker)).byPath.get("rank-jobs")!.block;

    const order = executionOrder(root.children, root.wires);
    expect(order).toHaveLength(4);
    expect(order.indexOf("load-postings")).toBeLessThan(order.indexOf("score-posting"));
    expect(order.indexOf("extract-profile-keywords")).toBeLessThan(order.indexOf("score-posting"));
    expect(order.indexOf("score-posting")).toBeLessThan(order.indexOf("rank-results"));
  });

  it("lets one output feed two different destinations", async () => {
    const root = (await loadProject(jobRanker)).byPath.get("rank-jobs")!.block;

    const fromPostings = root.wires.filter(
      (w) => w.source.from === "block" && w.source.block === "load-postings" && w.source.port === "postings",
    );
    expect(fromPostings).toHaveLength(2);
  });

  it("keeps two systems side by side, each in its own language", async () => {
    const project = await loadProject(jobRanker);

    expect(project.systems.map((s) => [s.rootBlock, s.language])).toEqual([
      ["rank-jobs", "typescript"],
      ["embed-postings", "python"],
    ]);

    // A block's language follows the system it sits in.
    expect(languageOf(project, "rank-jobs/score-posting/match-keywords")).toBe("typescript");
    expect(languageOf(project, "embed-postings/embed-text")).toBe("python");
  });

  it("notices when a child's contract drifts from what its parent wires to it", async () => {
    const project = await loadProject(jobRanker);

    // Someone edits a child's contract without updating the parent.
    const scorer = project.byPath.get("rank-jobs/score-posting")!;
    const matcher = scorer.children.find((c) => c.block.id === "match-keywords")!;
    matcher.block.outputs.matches = { type: { kind: "string" } };

    expect(validateProject(project).map((d) => d.message)).toContainEqual(expect.stringContaining("Type mismatch"));
  });
});

describe("the contract-generator example", () => {
  it("reads off disk and validates cleanly", async () => {
    expect(validateProject(await loadProject(path.join(examples, "contract-generator")))).toEqual([]);
  });
});
