import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GUIDE_FILE, agentGuide, workedExample } from "./guide.js";
import { writeAgentFiles } from "./emit.js";
import { blockSchema } from "../model/block.js";
import { CAPABILITIES } from "../model/capabilities.js";
import { validateComposite } from "../model/validate.js";
import { getPack, knownLanguages } from "../lang/index.js";
import { blockDir, manifestPath, manifestSchema } from "../project/project.js";
import { casesSchema } from "../run/cases.js";
import { runCases } from "../run/run.js";
import { checkProject } from "../check/check.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "fragmentor-guide-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("writeAgentFiles", () => {
  it("prepares an empty folder for an agent", async () => {
    expect(await writeAgentFiles(dir)).toEqual({
      written: ["FRAGMENTOR.md", "AGENTS.md", "CLAUDE.md"],
      kept: [],
      withoutGuide: [],
    });
    expect(await readFile(path.join(dir, GUIDE_FILE), "utf8")).toBe(agentGuide());
  });

  it("points both Claude Code and Codex at the guide", async () => {
    await writeAgentFiles(dir);

    // Claude Code follows @-imports in CLAUDE.md; Codex reads AGENTS.md.
    const claude = await readFile(path.join(dir, "CLAUDE.md"), "utf8");
    expect(claude).toContain("@FRAGMENTOR.md");
    expect(claude).toContain("@AGENTS.md");
    expect(await readFile(path.join(dir, "AGENTS.md"), "utf8")).toContain("read `FRAGMENTOR.md`");
  });

  it("refreshes the guide but never touches instructions a person may have edited", async () => {
    await writeAgentFiles(dir);
    const ours = "# Ours\nRead FRAGMENTOR.md first.\nUse tabs.\n";
    await writeFile(path.join(dir, "AGENTS.md"), ours, "utf8");
    await writeFile(path.join(dir, GUIDE_FILE), "stale", "utf8");

    expect(await writeAgentFiles(dir)).toEqual({
      written: ["FRAGMENTOR.md"],
      kept: ["AGENTS.md", "CLAUDE.md"],
      withoutGuide: [],
    });
    expect(await readFile(path.join(dir, "AGENTS.md"), "utf8")).toBe(ours);
    expect(await readFile(path.join(dir, GUIDE_FILE), "utf8")).toBe(agentGuide());
  });

  it("writes nothing when the guide is already current", async () => {
    await writeAgentFiles(dir);
    expect((await writeAgentFiles(dir)).written).toEqual([]);
  });

  it("points out instructions that were already there but never mention the guide", async () => {
    await writeFile(path.join(dir, "CLAUDE.md"), "# House rules\nUse tabs.\n", "utf8");

    expect(await writeAgentFiles(dir)).toEqual({
      written: ["FRAGMENTOR.md", "AGENTS.md"],
      kept: ["CLAUDE.md"],
      withoutGuide: ["CLAUDE.md"],
    });
  });
});

describe("the guide", () => {
  const guide = agentGuide();

  it("has nothing left unfilled", () => {
    expect(guide).not.toMatch(/\{\{|\}\}/);
  });

  it("describes every capability and every language Fragmentor knows", () => {
    for (const name of Object.keys(CAPABILITIES)) expect(guide).toContain(`**${name}**`);
    for (const { id } of knownLanguages()) {
      expect(guide).toContain(`"language": "${id}"`);
      expect(guide).toContain(getPack(id).implFile);
    }
  });

  it("tells the agent how to check its work", () => {
    expect(guide).toContain("`fragmentor check`");
    expect(guide).toContain("`fragmentor test`");
  });

  it("uses one kind of line ending, whatever the checkout did to the template", () => {
    expect(guide).not.toContain("\r");
  });
});

describe("the guide's worked example", () => {
  it("is a valid project by the same rules the checker applies", () => {
    expect(manifestSchema.safeParse(workedExample.manifest).success).toBe(true);

    const blocks = Object.entries(workedExample.blocks).map(([blockPath, file]) => [blockPath, blockSchema.parse(file)] as const);
    const root = blocks.find(([blockPath]) => blockPath === "price-orders")![1];
    const children = new Map(blocks.filter(([blockPath]) => blockPath !== "price-orders").map(([, block]) => [block.id, block]));
    expect(validateComposite(root, children)).toEqual([]);

    for (const cases of Object.values(workedExample.cases)) expect(casesSchema.safeParse(cases).success).toBe(true);
  });

  it("checks and passes its tests when an agent follows it to the letter", async () => {
    // The project exactly as the guide shows it.
    await writeFile(manifestPath(dir), JSON.stringify(workedExample.manifest, null, 2), "utf8");
    for (const [blockPath, file] of Object.entries(workedExample.blocks)) {
      await mkdir(blockDir(dir, blockPath), { recursive: true });
      await writeFile(path.join(blockDir(dir, blockPath), "block.json"), JSON.stringify(file, null, 2), "utf8");
    }

    const structured = await checkProject(dir);
    expect(structured.errorCount).toBe(0);
    expect(structured.unimplemented).toEqual([
      "price-orders",
      "price-orders/load-orders",
      "price-orders/price-order",
      "price-orders/sum-totals",
    ]);

    // The code the guide shows, plus the two leaves it leaves to the reader.
    const code: Record<string, string> = {
      ...workedExample.code,
      "price-orders/load-orders": `import type { LoadOrdersInput, LoadOrdersOutput, LoadOrdersCaps } from "./contract.js";

export async function loadOrders(input: LoadOrdersInput, caps: LoadOrdersCaps): Promise<LoadOrdersOutput> {
  return { orders: JSON.parse(await caps.files.readFile(input.path)) };
}
`,
      "price-orders/sum-totals": `import type { SumTotalsInput, SumTotalsOutput, SumTotalsCaps } from "./contract.js";

export async function sumTotals(input: SumTotalsInput, caps: SumTotalsCaps): Promise<SumTotalsOutput> {
  return { sum: input.totals.reduce((total, value) => total + value, 0) };
}
`,
    };
    for (const [blockPath, source] of Object.entries(code)) {
      await writeFile(path.join(blockDir(dir, blockPath), "impl.ts"), source, "utf8");
    }

    for (const [blockPath, cases] of Object.entries(workedExample.cases)) {
      await writeFile(path.join(blockDir(dir, blockPath), "cases.json"), JSON.stringify(cases, null, 2), "utf8");
    }
    await writeFile(
      path.join(dir, "orders.json"),
      JSON.stringify([
        { id: "A-1", lines: [{ quantity: 2, unitPrice: 3.5 }, { quantity: 1, unitPrice: 10 }] },
        { id: "A-2", lines: [] },
      ]),
      "utf8",
    );
    await writeFile(
      path.join(blockDir(dir, "price-orders"), "cases.json"),
      JSON.stringify([{ name: "prices a file of orders", input: { path: "orders.json" }, expected: { totals: [17, 0], grandTotal: 17 } }]),
      "utf8",
    );

    const implemented = await checkProject(dir);
    expect(implemented.systems[0]!.codeProblems).toEqual([]);
    expect(implemented.errorCount).toBe(0);
    expect(implemented.unimplemented).toEqual([]);

    expect((await runCases(dir, "price-orders/price-order")).map((r) => [r.status, r.differences])).toEqual([
      ["passed", []],
      ["passed", []],
    ]);
    expect((await runCases(dir, "price-orders")).map((r) => [r.status, r.differences])).toEqual([["passed", []]]);
  }, 30_000);
});
