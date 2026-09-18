import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadProject, validateProject } from "../project/project.js";
import { emitProject } from "../codegen/emit.js";
import { runBlock } from "./run.js";

/**
 * Reaching a store, for real.
 *
 * Until now an access said where data came from and the code got it some
 * other way, so the two could disagree without anything noticing. These build
 * a small project in a throwaway folder and run it, which is the only way to
 * show that the line on the diagram is the line the code runs along.
 */

let dir = "";

const ACCOUNT = "{ id: string; name: string; owing: number }";

async function block(blockPath: string, contents: object, impl?: string): Promise<void> {
  const folder = path.join(dir, "blocks", ...blockPath.split("/"));
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, "block.json"), JSON.stringify(contents, null, 2), "utf8");
  if (impl) await writeFile(path.join(folder, "impl.ts"), impl, "utf8");
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "fragmentor-stores-"));

  await writeFile(
    path.join(dir, "fragmentor.json"),
    JSON.stringify({
      name: "Ledger",
      goal: "Prove a block can reach a store.",
      mode: "structured",
      granularity: { level: 3, maxDepth: 4 },
      systems: [{ rootBlock: "ledger", language: "typescript" }],
    }),
    "utf8",
  );

  await block("ledger", { role: "component", responsibility: "Settle one account and say so." });

  await block("ledger/accounts-db", {
    role: "database",
    subtype: "PostgreSQL",
    responsibility: "Every account and what it owes.",
    exposes: { accounts: ACCOUNT },
  });

  await block("ledger/receipts", {
    role: "queue",
    subtype: "topic",
    responsibility: "Carries a receipt away once an account is settled.",
    exposes: { settled: { accepts: "{ id: string; paid: number }" } },
  });

  await block(
    "ledger/settle",
    {
      responsibility: "Clear what an account owes, and put a receipt out about it.",
      inputs: { accountId: "string" },
      outputs: { paid: "number" },
      capabilities: { accounts: "Store", receipts: "Queue" },
      access: ["accounts reads accounts-db.accounts", "accounts writes accounts-db.accounts", "receipts writes receipts.settled"],
    },
    [
      `import type { SettleInput, SettleOutput, SettleCaps } from "./contract.js";`,
      ``,
      `export async function settle(input: SettleInput, caps: SettleCaps): Promise<SettleOutput> {`,
      `  const account = await caps.accounts.read(input.accountId);`,
      `  if (!account) throw new Error(\`There is no account "\${input.accountId}".\`);`,
      `  await caps.accounts.write(account.id, { ...account, owing: 0 });`,
      `  await caps.receipts.send({ id: account.id, paid: account.owing });`,
      `  return { paid: account.owing };`,
      `}`,
      ``,
    ].join("\n"),
  );

  const emitted = await emitProject(await loadProject(dir));
  expect(emitted.problems).toEqual([]);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const seeded = {
  "ledger/accounts-db.accounts": {
    "acc-1": { id: "acc-1", name: "Northwind", owing: 40 },
    "acc-2": { id: "acc-2", name: "Kite", owing: 0 },
  },
};

describe("a block reaching a store", () => {
  it("accepts a diagram where a port says what it is a way into", async () => {
    // Warnings are expected: nothing wires `settle` here, because the block
    // holding the architecture has no generated code that would call it.
    const errors = validateProject(await loadProject(dir)).filter((each) => each.severity === "error");
    expect(errors).toEqual([]);
  });

  it("reads the rows a test put there", async () => {
    const result = await runBlock({
      projectDir: dir,
      blockPath: "ledger/settle",
      input: { accountId: "acc-1" },
      stores: seeded,
    });

    expect(result.error).toBeUndefined();
    expect(result.output).toEqual({ paid: 40 });
  });

  it("reads an empty store when nothing was put there", async () => {
    const result = await runBlock({ projectDir: dir, blockPath: "ledger/settle", input: { accountId: "acc-1" } });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('There is no account "acc-1"');
  });

  it("hands back what the run left in the store", async () => {
    const result = await runBlock({
      projectDir: dir,
      blockPath: "ledger/settle",
      input: { accountId: "acc-1" },
      stores: seeded,
    });

    expect(result.stores["ledger/accounts-db.accounts"]).toEqual({
      kind: "store",
      rows: {
        "acc-1": { id: "acc-1", name: "Northwind", owing: 0 },
        "acc-2": { id: "acc-2", name: "Kite", owing: 0 },
      },
    });
  });

  it("hands back what the run put on a channel", async () => {
    const result = await runBlock({
      projectDir: dir,
      blockPath: "ledger/settle",
      input: { accountId: "acc-1" },
      stores: seeded,
    });

    expect(result.stores["ledger/receipts.settled"]).toEqual({ kind: "queue", sent: [{ id: "acc-1", paid: 40 }] });
  });

  it("does not let one run's rows reach the next", async () => {
    await runBlock({ projectDir: dir, blockPath: "ledger/settle", input: { accountId: "acc-1" }, stores: seeded });
    const again = await runBlock({ projectDir: dir, blockPath: "ledger/settle", input: { accountId: "acc-1" }, stores: seeded });

    // The second run reads 40 again, not the 0 the first one wrote.
    expect(again.output).toEqual({ paid: 40 });
  });

  it("refuses a row that is not the shape the store says it holds", async () => {
    const result = await runBlock({
      projectDir: dir,
      blockPath: "ledger/settle",
      input: { accountId: "acc-1" },
      stores: { "ledger/accounts-db.accounts": { "acc-1": { id: "acc-1", name: "Northwind", owing: "lots" } } },
    });

    expect(result.ok).toBe(false);
    expect(result.inputProblems).toEqual([expect.stringContaining("owing should be a number")]);
    expect(result.durationMs).toBe(0);
  });

  it("writes a store the block's code can be typed against", async () => {
    const project = await loadProject(dir);
    const contract = project.byPath.get("ledger/settle")!;
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(path.join(contract.dir, "contract.ts"), "utf8");

    expect(source).toContain(`accounts: Store<{ id: string; name: string; owing: number }>;`);
    expect(source).toContain(`receipts: Queue<{ id: string; paid: number }>;`);
  });
});
