import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadCases, saveCases } from "./cases.js";
import { compareValues } from "./compare.js";
import { runCases } from "./run.js";

const example = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "examples", "job-ranker");

let dir: string;

beforeEach(async () => {
  // A copy, so running tests never writes into the example in the repository.
  dir = await mkdtemp(path.join(tmpdir(), "fragmentor-cases-"));
  await cp(example, dir, { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("compareValues", () => {
  it("says nothing when the values match", () => {
    expect(compareValues({ a: [1, 2], b: "x" }, { a: [1, 2], b: "x" })).toEqual([]);
  });

  it("points at the part that differs, not the whole value", () => {
    expect(compareValues({ ranked: [{ score: 2 }] }, { ranked: [{ score: 1 }] })).toEqual([
      "output.ranked[0].score was 2, expected 1.",
    ]);
  });

  it("reports a wrong length and still compares the items that exist", () => {
    expect(compareValues([1, 2, 3], [1, 9])).toEqual([
      "output has 3 items, expected 2.",
      "output[1] was 2, expected 9.",
    ]);
  });

  it("names fields that are missing and fields that were not expected", () => {
    expect(compareValues({ b: 1 }, { a: 1 })).toEqual(["output.a is missing.", "output.b was not expected."]);
  });
});

describe("saving and loading tests", () => {
  it("has none until some are saved", async () => {
    // rank-results ships without tests; extract-profile-keywords ships with some.
    expect(await loadCases(dir, "rank-jobs/rank-results")).toEqual([]);
  });

  it("round trips a case with an expectation", async () => {
    const cases = [
      { name: "two skills", input: { profile: { skills: ["TypeScript"] } }, expected: { keywords: ["typescript"] } },
    ];
    await saveCases(dir, "rank-jobs/extract-profile-keywords", cases);
    expect(await loadCases(dir, "rank-jobs/extract-profile-keywords")).toEqual(cases);
  });

  it("keeps a case with no expectation distinguishable from one expecting nothing", async () => {
    await saveCases(dir, "rank-jobs/extract-profile-keywords", [
      { name: "just an input", input: { profile: { skills: [] } } },
    ]);

    const [loaded] = await loadCases(dir, "rank-jobs/extract-profile-keywords");
    expect(loaded).toBeDefined();
    expect("expected" in loaded!).toBe(false);
  });
});

describe("running saved tests", () => {
  const block = "rank-jobs/extract-profile-keywords";

  it("passes a case whose output matches", async () => {
    await saveCases(dir, block, [
      { name: "lowercases and sorts", input: { profile: { skills: ["TypeScript", "Node.js"] } }, expected: { keywords: ["node.js", "typescript"] } },
    ]);

    const [result] = await runCases(dir, block);
    expect(result?.status).toBe("passed");
    expect(result?.differences).toEqual([]);
  });

  it("fails a case whose output differs, and says how", async () => {
    await saveCases(dir, block, [
      { name: "wrong on purpose", input: { profile: { skills: ["TypeScript"] } }, expected: { keywords: ["rust"] } },
    ]);

    const [result] = await runCases(dir, block);
    expect(result?.status).toBe("failed");
    expect(result?.differences).toEqual(['output.keywords[0] was "typescript", expected "rust".']);
  });

  it("runs a case with no expectation and reports what came back", async () => {
    await saveCases(dir, block, [{ name: "just look", input: { profile: { skills: ["Rust"] } } }]);

    const [result] = await runCases(dir, block);
    expect(result?.status).toBe("unchecked");
    expect(result?.output).toEqual({ keywords: ["rust"] });
  });

  it("reports a case whose input the block will not accept", async () => {
    await saveCases(dir, block, [{ name: "bad input", input: { profile: "not an object" } }]);

    const [result] = await runCases(dir, block);
    expect(result?.status).toBe("error");
    expect(result?.inputProblems.join(" ")).toContain("should be an object");
  });

  it("runs several cases against one compilation", async () => {
    await saveCases(dir, block, [
      { name: "one", input: { profile: { skills: ["TypeScript"] } }, expected: { keywords: ["typescript"] } },
      { name: "two", input: { profile: { skills: ["Rust"] } }, expected: { keywords: ["rust"] } },
      { name: "three", input: { profile: { skills: ["Go"] } }, expected: { keywords: ["wrong"] } },
    ]);

    const results = await runCases(dir, block);
    expect(results.map((result) => result.status)).toEqual(["passed", "passed", "failed"]);
  }, 30_000);

  it("has nothing to run when a block has no tests", async () => {
    expect(await runCases(dir, "rank-jobs/rank-results")).toEqual([]);
  });
});
