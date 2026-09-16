import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkProject } from "./check.js";
import { runBlock } from "../run/run.js";

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

const LEAF_HEADER = `import type { ExtractProfileKeywordsInput, ExtractProfileKeywordsOutput, ExtractProfileKeywordsCaps } from "./contract.js";`;
const LEAF_SIGNATURE = `export async function extractProfileKeywords(input: ExtractProfileKeywordsInput, caps: ExtractProfileKeywordsCaps): Promise<ExtractProfileKeywordsOutput>`;

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

  it("lists the blocks still to be written and tested, which never includes a composite's code", async () => {
    const report = await checkProject(dir);

    expect(report.unimplemented).toEqual(["embed-postings/clean-text", "embed-postings/embed-text"]);
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
      `${LEAF_HEADER}

${LEAF_SIGNATURE} {
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

  it("puts back a composite that someone edited, since its code is the diagram's", async () => {
    await checkProject(dir);
    const impl = file("rank-jobs", "impl.ts");
    const generated = await readFile(impl, "utf8");
    expect(generated).toContain("loadPostings({ path: sourcePath }, caps)");

    await writeFile(impl, generated.replace("loadPostings({ path: sourcePath }", "loadPostings({ path: profile }"), "utf8");
    const report = await checkProject(dir);

    expect(report.errorCount).toBe(0);
    expect(await readFile(impl, "utf8")).toBe(generated);
  });

  it("reports code someone wrote in a block with children, rather than overwriting it", async () => {
    const impl = file("rank-jobs", "score-posting", "impl.ts");
    const written = "// someone's own code\nexport async function scorePosting() {}\n";
    await writeFile(impl, written, "utf8");

    const report = await checkProject(dir);
    expect(report.generated.problems).toEqual([expect.stringContaining("holds code someone wrote")]);
    expect(await readFile(impl, "utf8")).toBe(written);
  });

  it("reports an import that would typecheck but could not run", async () => {
    // The schema is a value, so the runner — which compiles each block on its
    // own — would have to load contract.js and zod.
    await writeFile(
      file("rank-jobs", "extract-profile-keywords", "impl.ts"),
      `import { extractProfileKeywordsInput } from "./contract.js";
${LEAF_HEADER}

${LEAF_SIGNATURE} {
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

  it("lets a block use a package installed in the project, when checking it and when running it", async () => {
    const shout = path.join(dir, "node_modules", "shout");
    await mkdir(shout, { recursive: true });
    await writeFile(path.join(shout, "package.json"), JSON.stringify({ name: "shout", version: "1.0.0", main: "index.js", types: "index.d.ts" }), "utf8");
    await writeFile(path.join(shout, "index.js"), "exports.shout = (text) => text.toUpperCase();\n", "utf8");
    await writeFile(path.join(shout, "index.d.ts"), "export declare function shout(text: string): string;\n", "utf8");

    await writeFile(
      file("rank-jobs", "extract-profile-keywords", "impl.ts"),
      `${LEAF_HEADER}
import { shout } from "shout";

${LEAF_SIGNATURE} {
  return { keywords: input.profile.skills.map((skill) => shout(skill)) };
}
`,
      "utf8",
    );

    const report = await checkProject(dir);
    expect(report.systems[0]!.codeProblems).toEqual([]);

    const ran = await runBlock({ projectDir: dir, blockPath: "rank-jobs/extract-profile-keywords", input: { profile: { skills: ["rust"] } } });
    expect(ran.error).toBeUndefined();
    expect(ran.output).toEqual({ keywords: ["RUST"] });
  }, 30_000);

  it("refuses Node's built-in modules, which capabilities are there to replace", async () => {
    await writeFile(
      file("rank-jobs", "extract-profile-keywords", "impl.ts"),
      `import { readFileSync } from "node:fs";
${LEAF_HEADER}

${LEAF_SIGNATURE} {
  return { keywords: [readFileSync("skills.txt", "utf8")] };
}
`,
      "utf8",
    );

    const report = await checkProject(dir);
    expect(report.systems[0]!.codeProblems).toContainEqual(
      expect.objectContaining({ line: 1, message: expect.stringContaining("one of Node's built-in modules") }),
    );
  });

  it("reports a package the project has not installed, which the runner would not find", async () => {
    // zod typechecks, because the checker lends contracts Fragmentor's copy,
    // but a block that uses it itself needs the project to have it.
    await writeFile(
      file("rank-jobs", "extract-profile-keywords", "impl.ts"),
      `${LEAF_HEADER}
import { z } from "zod";

${LEAF_SIGNATURE} {
  return { keywords: z.array(z.string()).parse(input.profile.skills) };
}
`,
      "utf8",
    );

    const report = await checkProject(dir);
    expect(report.systems[0]!.codeProblems).toEqual([
      expect.objectContaining({ line: 2, message: expect.stringContaining('imports "zod", which is not installed in the project') }),
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
      // Every block but the one with children, whose code Fragmentor writes.
      expect(report.unimplemented).toHaveLength(report.blockCount - 1);
      expect(report.unimplemented).not.toContain("generate-contract");
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });
});

describe("a project with a plan in it", () => {
  /** A block the agent has drawn but not built, reading what the ranker produces. */
  async function planAnAuditLog(): Promise<void> {
    await mkdir(file("rank-jobs", "audit-log"), { recursive: true });
    await writeFile(
      path.join(file("rank-jobs", "audit-log"), "block.json"),
      JSON.stringify({
        responsibility: "Record what was ranked, so a later run can be compared against it.",
        planned: true,
        inputs: { entries: "the ranked postings", runId: "some identifier, not decided yet" },
        outputs: { written: "whether it was recorded" },
      }),
      "utf8",
    );

    const rankJobs = path.join(file("rank-jobs"), "block.json");
    const parent = JSON.parse(await readFile(rankJobs, "utf8")) as { children: unknown[]; wires: string[] };
    parent.children.push("audit-log");
    parent.wires.push("rank-results.ranked -> audit-log.entries");
    await writeFile(rankJobs, JSON.stringify(parent), "utf8");
  }

  it("asks nothing of the plan, and counts it apart from unfinished work", async () => {
    await planAnAuditLog();
    const report = await checkProject(dir);

    expect(report.problems).toEqual([]);
    expect(report.errorCount).toBe(0);
    expect(report.planned).toEqual(["rank-jobs/audit-log"]);
    expect(report.unimplemented).not.toContain("rank-jobs/audit-log");
    expect(report.untested).not.toContain("rank-jobs/audit-log");
  }, 30_000);

  it("generates nothing for it, and holds back the code of the block above it", async () => {
    await checkProject(dir);
    await planAnAuditLog();
    const report = await checkProject(dir);

    expect(report.generated.removed).toEqual(["blocks/rank-jobs/impl.ts"]);
    expect(report.generated.written).not.toContain("blocks/rank-jobs/audit-log/contract.ts");
  }, 30_000);
});
