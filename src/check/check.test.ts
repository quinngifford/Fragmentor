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
  await cp(path.join(examples, "tickets"), dir, { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A block's folder, which holds what it is rather than what it does. */
const file = (...parts: string[]) => path.join(dir, "blocks", "tickets", "booking-api", ...parts);
/** Where the example keeps its code, which is wherever it likes. */
const code = (...parts: string[]) => path.join(dir, "src", "booking", ...parts);
const PRICE_SEAT = "src/booking/price-seat.ts";

const CONTRACT = "../../blocks/tickets/booking-api/pricing/price-seat/contract.js";
const HEADER = `import type { PriceSeatInput, PriceSeatOutput, PriceSeatCaps } from "${CONTRACT}";`;
const SIGNATURE = `export async function priceSeat(input: PriceSeatInput, caps: PriceSeatCaps): Promise<PriceSeatOutput>`;

describe("checkProject", () => {
  it("passes the example, checking its TypeScript system", async () => {
    const report = await checkProject(dir);

    expect(report.problems).toEqual([]);
    expect(report.errorCount).toBe(0);
    expect(report.systems).toEqual([
      { rootBlock: "tickets", language: "typescript", displayName: "TypeScript", codeChecked: true, codeHeld: 6, codeProblems: [] },
    ]);
    expect(report.unimplemented).toEqual([]);
    expect(report.untested).toEqual([]);
    // Every function in it is held to its contract, so nothing is merely drawn.
    expect(report.drawnOnly).toEqual([]);
  }, 30_000);

  it("lists a function still to be written, and never a block that is not called", async () => {
    await mkdir(file("list-events"), { recursive: true });
    await writeFile(
      file("list-events", "block.json"),
      JSON.stringify({
        responsibility: "List every event still on sale.",
        code: "src/booking/list-events.ts#listEvents",
        outputs: { names: "string[]" },
      }),
      "utf8",
    );

    const report = await checkProject(dir);
    // Code that is not there yet is not an error: the block says where it will
    // be, and whoever is working on it knows whether it is unwritten or moved.
    expect(report.errorCount).toBe(0);
    expect(report.problems).toEqual([
      expect.objectContaining({ severity: "warning", blockPath: "tickets/booking-api/list-events" }),
    ]);
    expect(report.unimplemented).toEqual(["tickets/booking-api/list-events"]);
    expect(report.architecture).toContain("tickets/booking-api/pricing");
  }, 30_000);

  it("reports a function block that does not say where its code is", async () => {
    await mkdir(file("list-events"), { recursive: true });
    await writeFile(
      file("list-events", "block.json"),
      JSON.stringify({ responsibility: "List every event still on sale.", outputs: { names: "string[]" } }),
      "utf8",
    );

    const report = await checkProject(dir);
    expect(report.errorCount).toBe(1);
    expect(report.problems[0]!.message).toContain("does not say where its code is");
  }, 30_000);

  it("draws a block whose code is not held to a contract, and says why", async () => {
    // The same function, describing its own shapes rather than importing the
    // contract. Nothing then holds the two together. Nothing else calls this
    // one, so unbinding it says nothing about anything but itself.
    await writeFile(
      code("cancel-booking.ts"),
      `export async function cancelBooking(input: { bookingId: string }) {
  return { cancelled: false, message: "no such booking", refund: 0 };
}
`,
      "utf8",
    );

    const report = await checkProject(dir);
    expect(report.errorCount).toBe(0);
    expect(report.drawnOnly).toEqual([
      {
        blockPath: "tickets/booking-api/cancel-booking",
        reason: expect.stringContaining("src/booking/cancel-booking.ts does not import"),
      },
    ]);
    // Its tests are not run, and it is not counted as untested either: there is
    // nothing for Fragmentor to run them against.
    expect(report.untested).toEqual([]);
    expect(report.systems[0]!.codeHeld).toBe(5);
  }, 30_000);

  it("writes nothing on a second check when nothing has changed", async () => {
    await checkProject(dir);
    expect((await checkProject(dir)).generated.written).toEqual([]);
  }, 30_000);

  it("reports a block that returns the wrong shape, with its file and line", async () => {
    await writeFile(code("price-seat.ts"), `${HEADER}\n\n${SIGNATURE} {\n  return { price: String(input.fullPrice) };\n}\n`, "utf8");

    const report = await checkProject(dir);
    expect(report.errorCount).toBe(1);

    const [problem] = report.systems[0]!.codeProblems;
    expect(problem).toMatchObject({ file: PRICE_SEAT, line: 4 });
    expect(problem!.message).toContain("string");
  }, 30_000);

  it("holds a call to another block to what that block accepts, wherever the two sit", async () => {
    const bookSeats = code("book-seats.ts");
    const source = await readFile(bookSeats, "utf8");
    await writeFile(bookSeats, source.replace("priceSeat({ fullPrice: event.price,", "priceSeat({ fullPrice: event.name,"), "utf8");

    const report = await checkProject(dir);
    expect(report.systems[0]!.codeProblems).toEqual([
      expect.objectContaining({ file: "src/booking/book-seats.ts", message: expect.stringContaining("number") }),
    ]);
  }, 30_000);

  it("reports an import that would typecheck but could not run", async () => {
    // The schema is a value, so the runner would have to load contract.js and zod.
    await writeFile(
      code("price-seat.ts"),
      `import { priceSeatInput } from "${CONTRACT}";\n${HEADER}\n\n${SIGNATURE} {\n  return { price: priceSeatInput.parse(input).fullPrice };\n}\n`,
      "utf8",
    );

    const report = await checkProject(dir);
    expect(report.errorCount).toBe(1);
    expect(report.systems[0]!.codeProblems).toEqual([
      expect.objectContaining({
        file: PRICE_SEAT,
        line: 1,
        message: expect.stringContaining(`imports values from "${CONTRACT}"`),
      }),
    ]);
  }, 30_000);

  it("refuses a helper file that is not a block, which is what a block is for", async () => {
    await writeFile(code("helpers.ts"), "export const half = (value: number) => value / 2;\n", "utf8");
    await writeFile(
      code("price-seat.ts"),
      `import { half } from "./helpers.js";\n${HEADER}\n\n${SIGNATURE} {\n  return { price: half(input.fullPrice) };\n}\n`,
      "utf8",
    );

    expect((await checkProject(dir)).systems[0]!.codeProblems).toEqual([
      expect.objectContaining({ line: 1, message: expect.stringContaining('imports values from "./helpers.js"') }),
    ]);
  }, 30_000);

  it("refuses the code of anything that is not a block of this system held to a contract", async () => {
    // A planned block has no code yet, a group of parts never has any, and
    // another system's code is compiled and run apart from this one.
    await mkdir(file("pricing", "discount"), { recursive: true });
    await writeFile(file("pricing", "discount", "block.json"), JSON.stringify({ responsibility: "Discounts.", planned: true }), "utf8");

    const manifest = path.join(dir, "fragmentor.json");
    const settings = JSON.parse(await readFile(manifest, "utf8")) as { systems: unknown[] };
    settings.systems.push({ rootBlock: "other", language: "typescript" });
    await writeFile(manifest, JSON.stringify(settings), "utf8");
    await mkdir(path.join(dir, "blocks", "other", "shout"), { recursive: true });
    await writeFile(path.join(dir, "blocks", "other", "block.json"), JSON.stringify({ role: "component", responsibility: "Another program." }), "utf8");
    await writeFile(
      path.join(dir, "blocks", "other", "shout", "block.json"),
      JSON.stringify({ responsibility: "Shout.", code: "src/other/shout.ts#shout" }),
      "utf8",
    );
    await mkdir(path.join(dir, "src", "other"), { recursive: true });
    await writeFile(
      path.join(dir, "src", "other", "shout.ts"),
      `import type { ShoutCaps } from "../../blocks/other/shout/contract.js";\n\nexport async function shout(input: unknown, caps: ShoutCaps) {}\n`,
      "utf8",
    );

    await writeFile(
      code("price-seat.ts"),
      [
        `import { discount } from "./discount.js";`,
        `import { pricing } from "./group.js";`,
        `import { shout } from "../other/shout.js";`,
        HEADER,
        ``,
        `${SIGNATURE} {`,
        `  return { price: input.fullPrice };`,
        `}`,
        ``,
      ].join("\n"),
      "utf8",
    );

    const refused = (await checkProject(dir)).systems[0]!.codeProblems
      .filter((problem) => problem.message.includes("imports values from"))
      .map((problem) => problem.line);
    expect(refused).toEqual([1, 2, 3]);
  }, 30_000);

  it("lets a block use a package installed in the project, when checking it and when running it", async () => {
    const shout = path.join(dir, "node_modules", "round");
    await mkdir(shout, { recursive: true });
    await writeFile(path.join(shout, "package.json"), JSON.stringify({ name: "round", version: "1.0.0", main: "index.js", types: "index.d.ts" }), "utf8");
    await writeFile(path.join(shout, "index.js"), "exports.round = (value) => Math.round(value);\n", "utf8");
    await writeFile(path.join(shout, "index.d.ts"), "export declare function round(value: number): number;\n", "utf8");

    await writeFile(
      code("price-seat.ts"),
      `${HEADER}\nimport { round } from "round";\n\n${SIGNATURE} {\n  return { price: round(input.fullPrice * 0.9) };\n}\n`,
      "utf8",
    );

    const report = await checkProject(dir);
    expect(report.systems[0]!.codeProblems).toEqual([]);

    const ran = await runBlock({ projectDir: dir, blockPath: "tickets/booking-api/pricing/price-seat", input: { fullPrice: 25, seat: 1 } });
    expect(ran.error).toBeUndefined();
    expect(ran.output).toEqual({ price: 23 });
  }, 30_000);

  it("refuses Node's built-in modules, which capabilities are there to replace", async () => {
    await writeFile(
      code("price-seat.ts"),
      `import { readFileSync } from "node:fs";\n${HEADER}\n\n${SIGNATURE} {\n  return { price: Number(readFileSync("price.txt", "utf8")) };\n}\n`,
      "utf8",
    );

    const report = await checkProject(dir);
    expect(report.systems[0]!.codeProblems).toContainEqual(
      expect.objectContaining({ line: 1, message: expect.stringContaining("one of Node's built-in modules") }),
    );
  }, 30_000);

  it("reports a package the project has not installed, which the runner would not find", async () => {
    // zod typechecks, because the checker lends contracts Fragmentor's copy,
    // but a block that uses it itself needs the project to have it.
    await writeFile(
      code("price-seat.ts"),
      `${HEADER}\nimport { z } from "zod";\n\n${SIGNATURE} {\n  return { price: z.number().parse(input.fullPrice) };\n}\n`,
      "utf8",
    );

    const report = await checkProject(dir);
    expect(report.systems[0]!.codeProblems).toEqual([
      expect.objectContaining({ line: 2, message: expect.stringContaining('imports "zod", which is not installed in the project') }),
    ]);
  }, 30_000);

  it("reports a tests file it cannot read, rather than the tests silently vanishing", async () => {
    await writeFile(file("pricing", "price-seat", "cases.json"), "[{ name: oops }]", "utf8");
    await rm(file("pricing", "refund-for", "cases.json"));
    await mkdir(file("pricing", "refund-for", "cases.json"));

    const report = await checkProject(dir);
    expect(report.errorCount).toBe(2);
    expect(report.problems).toContainEqual(
      expect.objectContaining({
        severity: "error",
        blockPath: "tickets/booking-api/pricing/price-seat",
        message: expect.stringContaining("cases.json is not valid JSON"),
      }),
    );
    expect(report.problems).toContainEqual(
      expect.objectContaining({
        severity: "error",
        blockPath: "tickets/booking-api/pricing/refund-for",
        message: expect.stringContaining("Its tests could not be read"),
      }),
    );
  }, 30_000);

  it("regenerates contracts from the diagram before checking the code against them", async () => {
    const contract = file("find-event", "contract.ts");
    await writeFile(contract, "// stale\n", "utf8");

    expect((await checkProject(dir)).errorCount).toBe(0);
    expect(await readFile(contract, "utf8")).toContain("export const findEventInput");
  }, 30_000);

  it("passes a project whose blocks say where their code will be, before any of it is written", async () => {
    // The executions go with it: every step of one names a function, so a
    // project with no code yet has nothing written down about it either.
    await rm(path.join(dir, "src"), { recursive: true });
    await rm(path.join(dir, "executions"), { recursive: true });

    const report = await checkProject(dir);
    expect(report.errorCount).toBe(0);
    expect(report.unimplemented).toHaveLength(6);
    // Every one of them is the same fact, reported once each.
    expect(report.problems.every((problem) => problem.severity === "warning")).toBe(true);
  }, 30_000);
});

describe("a project with a plan in it", () => {
  /** A block the agent has drawn but not built. */
  async function planAnAuditLog(): Promise<void> {
    await mkdir(file("audit-log"), { recursive: true });
    await writeFile(
      file("audit-log", "block.json"),
      JSON.stringify({
        responsibility: "Record every booking made, so a later day can be compared against it.",
        planned: true,
        inputs: { booking: "the booking just made", runId: "some identifier, not decided yet" },
      }),
      "utf8",
    );
  }

  it("asks nothing of the plan, and counts it apart from unfinished work", async () => {
    await planAnAuditLog();
    const report = await checkProject(dir);

    expect(report.problems).toEqual([]);
    expect(report.errorCount).toBe(0);
    expect(report.planned).toEqual(["tickets/booking-api/audit-log", "tickets/reminders"]);
    expect(report.unimplemented).not.toContain("tickets/booking-api/audit-log");
    expect(report.untested).not.toContain("tickets/booking-api/audit-log");
  }, 30_000);

  it("generates nothing for it, and leaves the blocks around it alone", async () => {
    await checkProject(dir);
    await planAnAuditLog();
    const report = await checkProject(dir);

    expect(report.generated.removed).toEqual([]);
    expect(report.generated.written).toEqual([]);
  }, 30_000);
});
