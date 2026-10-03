import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadCases, saveCases, storeKeyProblems } from "./cases.js";
import type { BoundStore } from "../project/stores.js";
import { compareValues } from "./compare.js";
import { runCases } from "./run.js";

const example = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "examples", "tickets");
const block = "tickets/booking-api/pricing/price-seat";

let dir: string;

beforeEach(async () => {
  // A copy, so running tests never writes into the example in the repository,
  // and without the tests the example ships with, so each test starts bare.
  dir = await mkdtemp(path.join(tmpdir(), "fragmentor-cases-"));
  await cp(example, dir, { recursive: true });
  await rm(path.join(dir, "blocks", ...block.split("/"), "cases.json"));
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
    expect(await loadCases(dir, block)).toEqual([]);
  });

  it("round trips a case with an expectation", async () => {
    const cases = [{ name: "full price", input: { fullPrice: 10, seat: 1 }, expected: { price: 10 } }];
    await saveCases(dir, block, cases);
    expect(await loadCases(dir, block)).toEqual(cases);
  });

  it("keeps a case with no expectation distinguishable from one expecting nothing", async () => {
    await saveCases(dir, block, [{ name: "just an input", input: { fullPrice: 10, seat: 1 } }]);

    const [loaded] = await loadCases(dir, block);
    expect(loaded).toBeDefined();
    expect("expected" in loaded!).toBe(false);
  });
});

describe("running saved tests", () => {
  it("passes a case whose output matches", async () => {
    await saveCases(dir, block, [{ name: "the fifth is cheaper", input: { fullPrice: 10, seat: 5 }, expected: { price: 9 } }]);

    const [result] = await runCases(dir, block);
    expect(result?.status).toBe("passed");
    expect(result?.differences).toEqual([]);
  });

  it("fails a case whose output differs, and says how", async () => {
    await saveCases(dir, block, [{ name: "wrong on purpose", input: { fullPrice: 10, seat: 1 }, expected: { price: 12 } }]);

    const [result] = await runCases(dir, block);
    expect(result?.status).toBe("failed");
    expect(result?.differences).toEqual(["output.price was 10, expected 12."]);
  });

  it("runs a case with no expectation and reports what came back", async () => {
    await saveCases(dir, block, [{ name: "just look", input: { fullPrice: 10, seat: 1 } }]);

    const [result] = await runCases(dir, block);
    expect(result?.status).toBe("unchecked");
    expect(result?.output).toEqual({ price: 10 });
  });

  it("reports a case whose input the block will not accept", async () => {
    await saveCases(dir, block, [{ name: "bad input", input: { fullPrice: "ten", seat: 1 } }]);

    const [result] = await runCases(dir, block);
    expect(result?.status).toBe("error");
    expect(result?.inputProblems.join(" ")).toContain("input.fullPrice");
  });

  it("runs several cases against one compilation", async () => {
    await saveCases(dir, block, [
      { name: "one", input: { fullPrice: 10, seat: 1 }, expected: { price: 10 } },
      { name: "two", input: { fullPrice: 10, seat: 5 }, expected: { price: 9 } },
      { name: "three", input: { fullPrice: 10, seat: 2 }, expected: { price: 0 } },
    ]);

    const results = await runCases(dir, block);
    expect(results.map((result) => result.status)).toEqual(["passed", "passed", "failed"]);
  }, 30_000);

  it("has nothing to run when a block has no tests", async () => {
    expect(await runCases(dir, block)).toEqual([]);
  });
});

describe("storeKeyProblems", () => {
  const store = (port: string, target: string, seedable = true): BoundStore => ({
    port,
    target,
    resourceName: "Shop Database",
    entry: target.split(".").at(-1)!,
    shape: null,
    seedable,
  });
  const orders = store("orders", "shop/shop-db.orders");
  const customers = store("customers", "shop/shop-db.customers");
  const entries = ["shop/shop-db.orders", "shop/shop-db.customers", "shop/archive.orders"];

  it("says nothing of rows given to a store entry of the project, or of a test with none", () => {
    const cases = [{ name: "a", input: {}, stores: { "shop/shop-db.orders": {}, "shop/archive.orders": {} } }, { name: "b", input: {} }];
    expect(storeKeyProblems(cases, entries, [orders])).toEqual([]);
  });

  it("names the entry a key most looks like, the block's own first, or every one the block reads", () => {
    const problems = storeKeyProblems(
      [{ name: "a", input: {}, stores: { orders: {}, "archive.orders": {}, "shop/elsewhere.rows": {} } }],
      entries,
      [orders, customers],
    );
    expect(problems).toEqual([
      expect.stringMatching(/^The test "a" gives rows for "orders", which is not a store entry in this project.*"shop\/shop-db.orders"\.$/),
      expect.stringMatching(/"archive.orders".*entry, "shop\/archive.orders"\.$/),
      expect.stringMatching(/"shop\/elsewhere.rows".*"shop\/shop-db.orders" or "shop\/shop-db.customers"\.$/),
    ]);
  });

  it("says so when the project draws no store at all", () => {
    expect(storeKeyProblems([{ name: "a", input: {}, stores: { orders: {} } }], [], [])).toEqual([
      expect.stringContaining("This project draws no store, so there is nowhere for rows to go."),
    ]);
  });
});
