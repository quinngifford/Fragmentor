import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { compareWithVersion } from "./versions.js";
import type { ComparedBlock, VersionComparison } from "./versions.js";
import type { CaseResult } from "./run.js";
import { commitExampleHistory, filesOf, gitIn } from "../project/exampleHistory.js";
import { saveVersion, swapToVersion, undoLastSwap } from "../project/history.js";

/**
 * Comparing pricing with its older version, in which a part of its own took a
 * fifth off from the third seat: the same history the application's
 * self-check builds, in a repository with spaces in its name.
 */

const tickets = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "examples", "tickets");
const pricing = "tickets/booking-api/pricing";

const made: string[] = [];

afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "fragmentor versions "));
  made.push(root);
  return root;
}

async function ticketsHistory() {
  const root = await scratch();
  const repo = path.join(root, "work space");
  const dir = path.join(repo, "tickets app");
  await cp(tickets, dir, { recursive: true });
  await gitIn(repo)("init", "--quiet");
  await gitIn(repo)("config", "core.autocrlf", "true");
  return { root, dir, git: gitIn(dir), ...(await commitExampleHistory(dir)) };
}

/** Writes a project's files, each given as text or as JSON. */
async function write(dir: string, files: Record<string, unknown>): Promise<void> {
  for (const [file, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), typeof contents === "string" ? contents : JSON.stringify(contents, null, 2), "utf8");
  }
}

/** The copies Compare makes, which it has to take away again. */
const copies = async () => (await readdir(tmpdir())).filter((name) => name.startsWith("fragmentor-compare-"));

const word = (result: CaseResult | null) =>
  result === null ? "absent" : result.status === "error" && result.inputProblems.length > 0 ? "does not fit" : result.status;

/** Each test of a block as `now / then`. */
const outcomes = (block: ComparedBlock | undefined) =>
  Object.fromEntries((block?.tests ?? []).map((test) => [test.name, `${word(test.now)} / ${word(test.then)}`]));

describe("comparing a block with a version", () => {
  it("runs the tests of both versions against both, and every other test in its system", async () => {
    const { dir, older } = await ticketsHistory();
    const before = await copies();
    const project = await filesOf(dir);

    const compared = await compareWithVersion(dir, pricing, { commit: older });
    const inside = (id: string) => compared.inside.find((block) => block.blockPath === `${pricing}/${id}`);

    expect(compared.system).toBe("Tickets");
    expect(compared.inside.map((block) => block.blockPath)).toEqual([`${pricing}/price-seat`, `${pricing}/refund-for`, `${pricing}/seat-discount`]);
    expect(outcomes(inside("price-seat"))).toEqual({
      "the first four seats are full price": "passed / failed",
      "the fifth is ten percent off": "passed / failed",
      "the first two seats are full price": "passed / passed",
      "the third is a fifth off": "failed / passed",
    });
    expect(Object.values(outcomes(inside("refund-for")))).toEqual(["passed / passed", "passed / passed"]);
    expect(outcomes(inside("seat-discount"))).toEqual({ "the third seat is a fifth off": "absent / passed" });

    const saved = compared.inside.flatMap((block) => block.tests.map((test) => test.saved));
    expect(saved.filter((each) => each === "now")).toHaveLength(2);
    expect(saved.filter((each) => each === "then")).toHaveLength(3);
    expect(compared.inside.flatMap((block) => block.tests).filter((test) => test.differs)).toHaveLength(4);

    // A block outside it that uses its code, and comes out differently.
    expect(compared.othersRun).toBe(9);
    expect(compared.outside.map((block) => [block.blockPath, outcomes(block)])).toEqual([
      ["tickets/booking-api/book-seats", { "the fifth seat onwards is ten percent off": "passed / failed" }],
    ]);

    expect(await copies()).toEqual(before);
    expect(await filesOf(dir)).toEqual(project);
  }, 60_000);

  it("compares with a saved version just as with the commit it was saved from", async () => {
    const { dir, older } = await ticketsHistory();
    await swapToVersion(dir, pricing, { commit: older });
    const saved = await saveVersion(dir, pricing, "A fifth off from the third seat", "");
    await undoLastSwap(dir, pricing);
    const project = await filesOf(dir);

    const bySaved = await compareWithVersion(dir, pricing, { saved: saved.id });
    const byCommit = await compareWithVersion(dir, pricing, { commit: older });
    const verdicts = (compared: VersionComparison) => [...compared.inside, ...compared.outside].map((block) => [block.blockPath, outcomes(block)]);
    expect(verdicts(bySaved)).toEqual(verdicts(byCommit));
    expect(outcomes(bySaved.inside.find((block) => block.blockPath === `${pricing}/seat-discount`))).toEqual({
      "the third seat is a fifth off": "absent / passed",
    });
    expect(bySaved.othersRun).toBe(byCommit.othersRun);
    expect(await filesOf(dir)).toEqual(project);
  }, 120_000);

  it("runs each version in a copy of its own, reading the project's other files and never writing them", async () => {
    const dir = path.join(await scratch(), "rates app");
    const git = gitIn(dir);
    // Price reads the rate kept beside its code, and a note it expects no
    // other run to have touched, and then leaves a note of its own.
    await write(dir, {
      "fragmentor.json": {
        name: "Rates",
        goal: "",
        existingCode: false,
        start: "build",
        granularity: { level: 3, maxDepth: 4 },
        systems: [{ rootBlock: "rates", language: "typescript" }],
      },
      "blocks/rates/block.json": { role: "component", responsibility: "Price amounts by the rate kept with its code.", code: "src/rates" },
      "blocks/rates/price/block.json": {
        responsibility: "Price an amount by the rate, and note what was priced.",
        code: "src/rates/price.ts#price",
        inputs: { amount: "number" },
        outputs: { price: "number" },
        capabilities: { files: "FileSystem" },
      },
      "blocks/rates/price/cases.json": [{ name: "doubles", input: { amount: 5 }, expected: { price: 10 } }],
      "src/rates/price.ts": `import type { PriceCaps } from "../../blocks/rates/price/contract.js";

export async function price(input: { amount: number }, caps: any) {
  const note = await caps.files.readFile("notes/last.txt");
  if (note !== "nothing priced yet") throw new Error(\`Another run left a note: \${note}\`);
  const { rate } = JSON.parse(await caps.files.readFile("src/rates/rate.json"));
  await caps.files.writeFile("notes/last.txt", \`priced \${input.amount}\`);
  return { price: input.amount * rate };
}
`,
      "src/rates/rate.json": { rate: 3 },
      "notes/last.txt": "nothing priced yet",
    });
    await git("init", "--quiet");
    await git("add", "--all");
    await git("commit", "--quiet", "-m", "Triple");
    const tripled = (await git("rev-parse", "HEAD")).trim();
    await write(dir, { "src/rates/rate.json": { rate: 2 } });
    await git("commit", "--quiet", "-am", "Double");
    const before = await copies();
    const project = await filesOf(dir);

    const compared = await compareWithVersion(dir, "rates", { commit: tripled });

    // The version reads the rate a swap would put back, not today's.
    expect(outcomes(compared.inside[0])).toEqual({ doubles: "passed / failed" });
    expect(compared.inside[0]?.tests[0]?.then?.differences).toEqual(["output.price was 15, expected 10."]);
    expect(await filesOf(dir)).toEqual(project);
    expect(await copies()).toEqual(before);
  }, 60_000);

  it("says when a version's saved tests could not be read, and calls none of the others new", async () => {
    const { dir, git } = await ticketsHistory();
    const cases = path.join(dir, "blocks", ...pricing.split("/"), "price-seat", "cases.json");
    const shipped = await readFile(cases, "utf8");
    await writeFile(cases, shipped.replace(/\}\s*\]\s*$/, "},\n]\n"));
    await git("commit", "--quiet", "-am", "Leave a comma behind");
    const broken = (await git("rev-parse", "HEAD")).trim();
    await writeFile(cases, shipped);
    await git("commit", "--quiet", "-am", "Take the comma away");

    const compared = await compareWithVersion(dir, pricing, { commit: broken });
    const priceSeat = compared.inside.find((block) => block.blockPath === `${pricing}/price-seat`);
    expect(priceSeat?.unreadable).toEqual({ now: null, then: expect.stringMatching(/^cases\.json is not valid JSON/) });
    expect(priceSeat?.tests.map((test) => test.saved)).toEqual(["both", "both"]);
  }, 60_000);

  it("is refused where the block's folder holds a link, which is never gone through", async () => {
    const { root, dir, git } = await ticketsHistory();
    const samples = path.join(dir, "blocks", ...pricing.split("/"), "price-seat", "samples");
    await write(samples, { "a.txt": "then\n" });
    await git("add", "--all", "--", ".");
    await git("commit", "--quiet", "-m", "Keep samples with the seat's price");
    const then = (await git("rev-parse", "HEAD")).trim();
    // Now the samples are kept elsewhere, with one never committed.
    const shared = path.join(root, "shared samples");
    await write(shared, { "a.txt": "now\n", "b.txt": "never committed\n" });
    await rm(samples, { recursive: true });
    await symlink(shared, samples, "junction");

    await expect(compareWithVersion(dir, pricing, { commit: then })).rejects.toThrow(
      `Swapping Pricing would go through a link at blocks/${pricing}/price-seat/samples, and Fragmentor never writes through one, so it cannot be compared or swapped.`,
    );
    expect(await readdir(shared)).toEqual(["a.txt", "b.txt"]);
    expect(await readFile(path.join(shared, "a.txt"), "utf8")).toBe("now\n");
  }, 60_000);

  it("runs a test the version's inputs no longer fit, and says it does not fit", async () => {
    const { dir, newer } = await ticketsHistory();
    const before = await copies();

    // Price Seat takes one more input now than it did then, and its tests give it.
    const folder = path.join(dir, "blocks", "tickets", "booking-api", "pricing", "price-seat");
    const block = JSON.parse(await readFile(path.join(folder, "block.json"), "utf8"));
    await writeFile(path.join(folder, "block.json"), JSON.stringify({ ...block, inputs: { ...block.inputs, currency: "string" } }, null, 2));
    const cases = JSON.parse(await readFile(path.join(folder, "cases.json"), "utf8")) as { input: Record<string, unknown> }[];
    await writeFile(path.join(folder, "cases.json"), JSON.stringify(cases.map((each) => ({ ...each, input: { ...each.input, currency: "GBP" } }))));

    const compared = await compareWithVersion(dir, pricing, { commit: newer });
    const fifth = compared.inside
      .find((each) => each.blockPath === `${pricing}/price-seat`)
      ?.tests.find((test) => test.name === "the fifth is ten percent off");

    expect(fifth).toMatchObject({ saved: "both", redefined: true, differs: true, now: { status: "passed" } });
    expect(fifth?.then).toMatchObject({ status: "error", inputProblems: ["input.currency is not part of this type."] });

    expect(await copies()).toEqual(before);
  }, 60_000);
});
