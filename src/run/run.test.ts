import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runBlock } from "./run.js";

/**
 * These run the example project's real code in a real subprocess. They are the
 * only tests that prove a block can actually be executed rather than only
 * generated.
 */

const projectDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "examples", "job-ranker");

const profile = { skills: ["TypeScript", "Node.js", "testing"] };

describe("running a leaf", () => {
  it("returns what the block computed", async () => {
    const result = await runBlock({
      projectDir,
      blockPath: "rank-jobs/extract-profile-keywords",
      input: { profile },
    });

    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ keywords: ["node.js", "testing", "typescript"] });
    expect(result.outputProblems).toEqual([]);
  });

  it("gives a capability that reads from the project", async () => {
    const result = await runBlock({
      projectDir,
      blockPath: "rank-jobs/load-postings",
      input: { path: "postings.json" },
    });

    expect(result.ok).toBe(true);
    const output = result.output as { postings: { title: string }[] };
    expect(output.postings).toHaveLength(4);
    expect(output.postings[0]!.title).toBe("Senior TypeScript Engineer");
  });

  it("refuses to read outside the project", async () => {
    const result = await runBlock({
      projectDir,
      blockPath: "rank-jobs/load-postings",
      input: { path: "../../package.json" },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("outside the project");
  });

  it("reports what a block threw, rather than swallowing it", async () => {
    const result = await runBlock({
      projectDir,
      blockPath: "rank-jobs/load-postings",
      input: { path: "does-not-exist.json" },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe("checking the contract on both sides", () => {
  it("refuses input that does not match, without running anything", async () => {
    const result = await runBlock({
      projectDir,
      blockPath: "rank-jobs/extract-profile-keywords",
      input: { profile: { skills: "TypeScript" } },
    });

    expect(result.ok).toBe(false);
    expect(result.inputProblems).toEqual([expect.stringContaining("input.profile.skills should be a list")]);
    expect(result.durationMs).toBe(0);
  });

  it("names a missing input", async () => {
    const result = await runBlock({ projectDir, blockPath: "rank-jobs/extract-profile-keywords", input: {} });
    expect(result.inputProblems).toEqual(["input.profile is missing."]);
  });
});

describe("running a composite", () => {
  it("runs the whole system, calling every block underneath", async () => {
    const result = await runBlock({
      projectDir,
      blockPath: "rank-jobs",
      input: { sourcePath: "postings.json", profile },
    });

    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.outputProblems).toEqual([]);

    const output = result.output as { ranked: { title: string; score: number; reasons: string[] }[] };
    expect(output.ranked).toHaveLength(4);

    // The TypeScript roles should beat the warehouse job on this profile.
    expect(output.ranked[0]!.title).toBe("Senior TypeScript Engineer");
    expect(output.ranked.at(-1)!.title).toBe("Warehouse Supervisor");
    expect(output.ranked.at(-1)!.score).toBe(0);
    expect(output.ranked[0]!.reasons.join(" ")).toContain("typescript");

    // Ordering is by score, best first.
    const scores = output.ranked.map((entry) => entry.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  }, 30_000);
});

describe("a language that cannot run yet", () => {
  it("says so plainly instead of failing oddly", async () => {
    const result = await runBlock({
      projectDir,
      blockPath: "embed-postings/clean-text",
      input: { posting: { title: "x", description: "y" } },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("cannot run Python blocks yet");
  });
});
