import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkProject } from "./check.js";

const examples = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "examples");

let dir: string;

beforeEach(async () => {
  // A copy outside the repository, which is where real projects live: nothing
  // is installed there, so the checker has to manage on its own.
  dir = await mkdtemp(path.join(tmpdir(), "fragmentor-check-"));
  await cp(path.join(examples, "job-ranker"), dir, { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const file = (...parts: string[]) => path.join(dir, "blocks", ...parts);

describe("checkProject", () => {
  it("passes the example, checking its TypeScript system", async () => {
    const report = await checkProject(dir);

    expect(report.problems).toEqual([]);
    expect(report.errorCount).toBe(0);
    expect(report.systems).toEqual([
      { rootBlock: "rank-jobs", language: "typescript", displayName: "TypeScript", codeChecked: true, codeProblems: [] },
      { rootBlock: "embed-postings", language: "python", displayName: "Python", codeChecked: false, codeProblems: [] },
    ]);
  }, 30_000);

  it("lists the blocks still to be written and tested", async () => {
    const report = await checkProject(dir);

    expect(report.unimplemented).toEqual(["embed-postings", "embed-postings/clean-text", "embed-postings/embed-text"]);
    expect(report.untested).toContain("rank-jobs/rank-results");
    expect(report.untested).not.toContain("rank-jobs");
    expect(report.untested).not.toContain("rank-jobs/extract-profile-keywords");
  });

  it("writes nothing on a second check when nothing has changed", async () => {
    await checkProject(dir);
    expect((await checkProject(dir)).generated.written).toEqual([]);
  });

  it("reports a leaf that returns the wrong shape, with its file and line", async () => {
    await writeFile(
      file("rank-jobs", "extract-profile-keywords", "impl.ts"),
      `import type { ExtractProfileKeywordsInput, ExtractProfileKeywordsOutput, ExtractProfileKeywordsCaps } from "./contract.js";

export async function extractProfileKeywords(input: ExtractProfileKeywordsInput, caps: ExtractProfileKeywordsCaps): Promise<ExtractProfileKeywordsOutput> {
  return { keywords: input.profile.skills.length };
}
`,
      "utf8",
    );

    const report = await checkProject(dir);
    expect(report.errorCount).toBe(1);

    const [problem] = report.systems[0]!.codeProblems;
    expect(problem).toMatchObject({ file: "blocks/rank-jobs/extract-profile-keywords/impl.ts", line: 4 });
    expect(problem!.message).toContain("number");
  });

  it("catches a composite handing a child the wrong value", async () => {
    const impl = file("rank-jobs", "impl.ts");
    const source = await readFile(impl, "utf8");
    expect(source).toContain("loadPostings({ path: sourcePath }");
    await writeFile(impl, source.replace("loadPostings({ path: sourcePath }", "loadPostings({ path: profile }"), "utf8");

    const report = await checkProject(dir);
    expect(report.systems[0]!.codeProblems.map((problem) => problem.file)).toEqual(["blocks/rank-jobs/impl.ts"]);
  });

  it("reports an import that would typecheck but could not run", async () => {
    // The schema is a value, so the runner — which compiles each block on its
    // own, with nothing installed — would have to load contract.js and zod.
    await writeFile(
      file("rank-jobs", "extract-profile-keywords", "impl.ts"),
      `import { extractProfileKeywordsInput } from "./contract.js";
import type { ExtractProfileKeywordsInput, ExtractProfileKeywordsOutput, ExtractProfileKeywordsCaps } from "./contract.js";

export async function extractProfileKeywords(input: ExtractProfileKeywordsInput, caps: ExtractProfileKeywordsCaps): Promise<ExtractProfileKeywordsOutput> {
  const { profile } = extractProfileKeywordsInput.parse(input);
  return { keywords: profile.skills.map((skill) => skill.toLowerCase()) };
}
`,
      "utf8",
    );

    const report = await checkProject(dir);
    expect(report.errorCount).toBe(1);
    expect(report.systems[0]!.codeProblems).toEqual([
      expect.objectContaining({
        file: "blocks/rank-jobs/extract-profile-keywords/impl.ts",
        line: 1,
        message: expect.stringContaining('imports values from "./contract.js"'),
      }),
    ]);
  });

  it("reports a wiring problem as an error", async () => {
    const blockFile = file("rank-jobs", "block.json");
    const block = JSON.parse(await readFile(blockFile, "utf8")) as { wires: string[] };
    block.wires = block.wires.filter((wire) => wire !== "extract-profile-keywords.keywords -> score-posting.keywords");
    await writeFile(blockFile, JSON.stringify(block, null, 2), "utf8");

    const report = await checkProject(dir);
    expect(report.errorCount).toBeGreaterThan(0);
    expect(report.problems).toContainEqual({
      severity: "error",
      blockPath: "rank-jobs",
      message: 'Nothing is connected to "score-posting" input "keywords".',
    });
  });

  it("reports a tests file it cannot read, rather than the tests silently vanishing", async () => {
    await writeFile(file("rank-jobs", "rank-results", "cases.json"), "[{ name: oops }]", "utf8");
    await mkdir(file("rank-jobs", "load-postings", "cases.json"));

    const report = await checkProject(dir);
    expect(report.errorCount).toBe(2);
    expect(report.problems).toContainEqual(
      expect.objectContaining({
        severity: "error",
        blockPath: "rank-jobs/rank-results",
        message: expect.stringContaining("cases.json is not valid JSON"),
      }),
    );
    expect(report.problems).toContainEqual(
      expect.objectContaining({
        severity: "error",
        blockPath: "rank-jobs/load-postings",
        message: expect.stringContaining("Its tests could not be read"),
      }),
    );
  });

  it("regenerates contracts from the diagram before checking the code against them", async () => {
    const contract = file("rank-jobs", "load-postings", "contract.ts");
    await writeFile(contract, "// stale\n", "utf8");

    expect((await checkProject(dir)).errorCount).toBe(0);
    expect(await readFile(contract, "utf8")).toContain("export const loadPostingsInput");
  });

  it("passes a project whose blocks are defined but not yet written", async () => {
    const other = await mkdtemp(path.join(tmpdir(), "fragmentor-check-"));
    try {
      await cp(path.join(examples, "contract-generator"), other, { recursive: true });
      const report = await checkProject(other);

      expect(report.errorCount).toBe(0);
      expect(report.unimplemented).toHaveLength(report.blockCount);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });
});
