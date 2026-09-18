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
const tickets = path.join(repo, "examples", "tickets");

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

  it("records where the project starts and whether it starts as a plan", async () => {
    expect(fragmentor(["init", "--mode=structured", "--granularity=3", "--language=typescript", "--start=plan"], dir).status).toBe(0);
    expect(JSON.parse(await readFile(path.join(dir, "fragmentor.json"), "utf8"))).toMatchObject({
      existingCode: false,
      start: "plan",
    });
    expect(await readFile(path.join(dir, "FRAGMENTOR.md"), "utf8")).toContain("**This project starts as a plan.**");
  }, 30_000);

  it("refuses to both rebuild existing code and plan it from nothing", () => {
    const refused = fragmentor(["init", "--mode=structured", "--granularity=3", "--existing-code", "--start=plan"], dir);
    expect(refused.status).toBe(1);
    expect(refused.output).toContain("cannot go together");
  }, 30_000);

  it("has nothing to test in a visual project", () => {
    expect(fragmentor(["init", "--mode=visual", "--granularity=2"], dir).status).toBe(0);

    const result = fragmentor(["test"], dir);
    expect(result.status).toBe(0);
    expect(result.output).toContain("visual project");
  }, 30_000);

  it("finds the project from inside a block's folder, and passes the example", async () => {
    await cp(tickets, dir, { recursive: true });

    const result = fragmentor(["check"], path.join(dir, "blocks", "tickets", "booking-api", "pricing"));
    expect(result.output).toContain("tickets: typechecks against its contracts");
    expect(result.output).toContain("Result: no errors");
    expect(result.status).toBe(0);
  }, 30_000);

  it("fails on a problem with the diagram and says what it is", async () => {
    await cp(tickets, dir, { recursive: true });
    const blockFile = path.join(dir, "blocks", "tickets", "booking-api", "find-event", "block.json");
    const block = JSON.parse(await readFile(blockFile, "utf8")) as { access: string[] };
    block.access = ["events reads tickets-db.venues"];
    await writeFile(blockFile, JSON.stringify(block, null, 2), "utf8");

    const result = fragmentor(["check", "--project", dir], repo);
    expect(result.status).toBe(1);
    expect(result.output).toContain('ERROR  tickets/booking-api/find-event: "Find Event" declares "events reads tickets-db.venues"');
  }, 30_000);

  it("runs the saved tests, and fails when one does", async () => {
    await cp(tickets, dir, { recursive: true });

    const passing = fragmentor(["test"], dir);
    expect(passing.output).toContain("PASS   turns someone away when there are not enough seats left");
    expect(passing.status).toBe(0);

    await writeFile(
      path.join(dir, "blocks", "tickets", "booking-api", "pricing", "price-seat", "cases.json"),
      JSON.stringify([{ name: "wrong on purpose", input: { fullPrice: 25, seat: 1 }, expected: { price: 20 } }]),
      "utf8",
    );

    const failing = fragmentor(["test", "tickets/booking-api/pricing/price-seat"], dir);
    expect(failing.status).toBe(1);
    expect(failing.output).toContain("FAIL   wrong on purpose");
    expect(failing.output).toContain("output.price was 25, expected 20.");
  }, 60_000);
});
