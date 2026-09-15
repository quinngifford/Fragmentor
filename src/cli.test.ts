import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * The command exactly as an agent runs it: the real launcher, in a separate
 * process, from a folder outside the repository.
 */

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const launcher = path.join(repo, "bin", "fragmentor.js");
const jobRanker = path.join(repo, "examples", "job-ranker");

function fragmentor(args: string[], cwd: string): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [launcher, ...args], { cwd, encoding: "utf8" });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "fragmentor-cli-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("the fragmentor command", () => {
  it("starts a project with the settings a person chose, then says what it still needs", async () => {
    const refused = fragmentor(["init"], dir);
    expect(refused.status).toBe(1);
    expect(refused.output).toContain("--mode");

    const init = fragmentor(["init", "--mode", "structured", "--granularity", "3", "--language", "typescript"], dir);
    expect(init.status).toBe(0);
    expect(init.output).toContain("wrote  fragmentor.json");
    expect(init.output).toContain("wrote  FRAGMENTOR.md");
    expect(JSON.parse(await readFile(path.join(dir, "fragmentor.json"), "utf8"))).toMatchObject({
      mode: "structured",
      language: "typescript",
      granularity: { level: 3 },
      systems: [],
    });

    const check = fragmentor(["check"], dir);
    expect(check.status).toBe(0);
    expect(check.output).toContain("No systems yet");
  }, 30_000);

  it("has nothing to test in a visual project", () => {
    expect(fragmentor(["init", "--mode=visual", "--granularity=2"], dir).status).toBe(0);

    const result = fragmentor(["test"], dir);
    expect(result.status).toBe(0);
    expect(result.output).toContain("visual project");
  }, 30_000);

  it("finds the project from inside a block's folder, and passes the example", async () => {
    await cp(jobRanker, dir, { recursive: true });

    const result = fragmentor(["check"], path.join(dir, "blocks", "rank-jobs", "score-posting"));
    expect(result.output).toContain("rank-jobs: typechecks against its contracts");
    expect(result.output).toContain("Result: no errors");
    expect(result.status).toBe(0);
  }, 30_000);

  it("fails on a wiring problem and says what it is", async () => {
    await cp(jobRanker, dir, { recursive: true });
    const blockFile = path.join(dir, "blocks", "rank-jobs", "block.json");
    const block = JSON.parse(await readFile(blockFile, "utf8")) as { wires: string[] };
    block.wires = block.wires.filter((wire) => wire !== "extract-profile-keywords.keywords -> score-posting.keywords");
    await writeFile(blockFile, JSON.stringify(block, null, 2), "utf8");

    const result = fragmentor(["check", "--project", dir], repo);
    expect(result.status).toBe(1);
    expect(result.output).toContain('ERROR  rank-jobs: Nothing is connected to "score-posting" input "keywords".');
  }, 30_000);

  it("runs the saved tests, and fails when one does", async () => {
    await cp(jobRanker, dir, { recursive: true });

    const passing = fragmentor(["test"], dir);
    expect(passing.output).toContain("PASS   ranks the TypeScript roles above the warehouse job");
    expect(passing.status).toBe(0);

    await writeFile(
      path.join(dir, "blocks", "rank-jobs", "extract-profile-keywords", "cases.json"),
      JSON.stringify([{ name: "wrong on purpose", input: { profile: { skills: ["TypeScript"] } }, expected: { keywords: ["rust"] } }]),
      "utf8",
    );

    const failing = fragmentor(["test", "rank-jobs/extract-profile-keywords"], dir);
    expect(failing.status).toBe(1);
    expect(failing.output).toContain("FAIL   wrong on purpose");
    expect(failing.output).toContain('output.keywords[0] was "typescript", expected "rust".');
  }, 60_000);
});
