import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GUIDE_FILE, agentGuide, architectureExample, compactJson, visualExample, workedExample } from "./guide.js";
import { writeAgentFiles } from "./emit.js";
import { blockFromFile } from "../model/block.js";
import { CAPABILITIES } from "../model/capabilities.js";
import { ARCHITECTURE_ROLES } from "../model/roles.js";
import { validateComposite } from "../model/validate.js";
import { blockDir, manifestPath, manifestSchema } from "../project/project.js";
import type { Manifest } from "../project/project.js";
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

const structured = (language?: string): Manifest => ({
  name: "Test",
  goal: "",
  mode: "structured",
  existingCode: false,
  start: "build",
  ...(language ? { language } : {}),
  granularity: { level: 3, maxDepth: 4 },
  systems: [],
});

const visual: Manifest = {
  name: "Test",
  goal: "",
  mode: "visual",
  existingCode: true,
  start: "build",
  granularity: { level: 2, maxDepth: 5 },
  systems: [],
};

async function writeBlocks(blocks: Record<string, unknown>): Promise<void> {
  for (const [blockPath, file] of Object.entries(blocks)) {
    await mkdir(blockDir(dir, blockPath), { recursive: true });
    await writeFile(path.join(blockDir(dir, blockPath), "block.json"), JSON.stringify(file, null, 2), "utf8");
  }
}

/** A Python that can parse a file, or nothing if the machine has none. */
const python = ["python", "python3", "py"].find((candidate) => spawnSync(candidate, ["-c", "print(1)"]).status === 0) ?? null;

describe("writeAgentFiles", () => {
  const manifest = structured("typescript");

  it("prepares a folder for an agent", async () => {
    expect(await writeAgentFiles(dir, manifest)).toEqual({
      written: ["FRAGMENTOR.md", "AGENTS.md", "CLAUDE.md"],
      kept: [],
      withoutGuide: [],
    });
    expect(await readFile(path.join(dir, GUIDE_FILE), "utf8")).toBe(agentGuide(manifest));
  });

  it("points both Claude Code and Codex at the guide", async () => {
    await writeAgentFiles(dir, manifest);

    // Claude Code follows @-imports in CLAUDE.md; Codex reads AGENTS.md.
    const claude = await readFile(path.join(dir, "CLAUDE.md"), "utf8");
    expect(claude).toContain("@FRAGMENTOR.md");
    expect(claude).toContain("@AGENTS.md");
    expect(await readFile(path.join(dir, "AGENTS.md"), "utf8")).toContain("read `FRAGMENTOR.md`");
  });

  it("refreshes the guide but never touches instructions a person may have edited", async () => {
    await writeAgentFiles(dir, manifest);
    const ours = "# Ours\nRead FRAGMENTOR.md first.\nUse tabs.\n";
    await writeFile(path.join(dir, "AGENTS.md"), ours, "utf8");
    await writeFile(path.join(dir, GUIDE_FILE), "stale", "utf8");

    expect(await writeAgentFiles(dir, manifest)).toEqual({
      written: ["FRAGMENTOR.md"],
      kept: ["AGENTS.md", "CLAUDE.md"],
      withoutGuide: [],
    });
    expect(await readFile(path.join(dir, "AGENTS.md"), "utf8")).toBe(ours);
    expect(await readFile(path.join(dir, GUIDE_FILE), "utf8")).toBe(agentGuide(manifest));
  });

  it("writes nothing when the guide is already current", async () => {
    await writeAgentFiles(dir, manifest);
    expect((await writeAgentFiles(dir, manifest)).written).toEqual([]);
  });

  it("points out instructions that were already there but never mention the guide", async () => {
    await writeFile(path.join(dir, "CLAUDE.md"), "# House rules\nUse tabs.\n", "utf8");

    expect(await writeAgentFiles(dir, manifest)).toEqual({
      written: ["FRAGMENTOR.md", "AGENTS.md"],
      kept: ["CLAUDE.md"],
      withoutGuide: ["CLAUDE.md"],
    });
  });
});

describe("the guide", () => {
  const guides: Record<string, string> = {
    "structured TypeScript": agentGuide(structured("typescript")),
    "structured Python": agentGuide(structured("python")),
    "structured with the language left open": agentGuide(structured()),
    visual: agentGuide(visual),
  };

  for (const [label, guide] of Object.entries(guides)) {
    it(`(${label}) has nothing left unfilled, and one kind of line ending`, () => {
      expect(guide).not.toMatch(/\{\{|\}\}/);
      expect(guide).not.toContain("\r");
    });
  }

  it("is short enough for an agent to take in at once", () => {
    // The guide these replaced ran to 375 lines. Keep it from growing back.
    // The room above what they first measured is the section on the rest of
    // the system: what the roles are, what a block exposes, what it reaches,
    // and which block answers an operation. A guide cannot do without any of
    // that once a diagram can hold a database, and that section is the only
    // thing that has been allowed to add to these numbers.
    expect(guides["structured TypeScript"]!.split("\n").length).toBeLessThan(225);
    expect(guides.visual!.split("\n").length).toBeLessThan(165);
  });

  it("tells a structured agent about every capability, and how to check and test its work", () => {
    const guide = guides["structured TypeScript"]!;
    for (const name of Object.keys(CAPABILITIES)) expect(guide).toContain(`**${name}**`);
    expect(guide).toContain("`fragmentor check`");
    expect(guide).toContain("`fragmentor test`");
    expect(guide).toContain("readFile(path: string) → string");
  });

  it("speaks the language the person chose", () => {
    const guide = guides["structured Python"]!;
    expect(guide).toContain("impl.py");
    expect(guide).toContain("async def price_order");
    expect(guide).toContain("read_file(path: str) → str");
    expect(guide).toContain("cannot run Python yet");
    expect(guide).not.toContain("impl.ts");
  });

  it("leaves the language to the agent when the person did", () => {
    const guide = guides["structured with the language left open"]!;
    expect(guide).toContain('`"typescript"`');
    expect(guide).toContain('`"python"`');
  });

  it("describes only the granularity the person chose", () => {
    expect(guides["structured TypeScript"]).toContain("## Granularity: level 3");
    expect(guides["structured TypeScript"]).toContain("around 30 to 80 lines");
    expect(guides["structured TypeScript"]).not.toContain("around 10 to 30 lines");
    // The size is something to aim at, not a rule the agent has to satisfy.
    expect(guides["structured TypeScript"]).toContain("aims rather than rules");
    expect(guides.visual).toContain("## Granularity: level 2");
    expect(guides.visual).toContain("at most 5 levels deep");
  });

  it("tells a visual agent to leave the code alone, and never mentions tests", () => {
    expect(guides.visual).toContain("Never change the program's code");
    expect(guides.visual).toContain("`fragmentor check`");
    expect(guides.visual).not.toContain("fragmentor test");
    expect(guides.visual).not.toContain("cases.json");
  });
});

describe("compactJson", () => {
  it("keeps what fits on one line there, and is still exactly the same JSON", () => {
    const value = workedExample.blocks["price-orders"];
    const text = compactJson(value);

    expect(JSON.parse(text)).toEqual(value);
    expect(text).toContain('"outputs": { "totals": "number[]", "grandTotal": "number" }');
    expect(text).toContain('"children": ["load-orders", { "block": "price-order", "each": "order" }, "sum-totals"]');
  });
});

describe("the structured worked example", () => {
  it("is a valid project by the same rules the checker applies", () => {
    expect(manifestSchema.safeParse(workedExample.manifest).success).toBe(true);

    const root = blockFromFile(workedExample.blocks["price-orders"], "price-orders");
    const children = new Map(
      Object.entries(workedExample.blocks)
        .filter(([blockPath]) => blockPath !== "price-orders")
        .map(([blockPath, file]) => {
          const id = blockPath.split("/").at(-1)!;
          return [id, blockFromFile(file, id)] as const;
        }),
    );
    expect(validateComposite(root, children)).toEqual([]);

    for (const cases of Object.values(workedExample.cases)) expect(casesSchema.safeParse(cases).success).toBe(true);
  });

  it("checks and passes its tests when an agent follows it to the letter", async () => {
    // The project exactly as the guide shows it.
    await writeFile(manifestPath(dir), JSON.stringify(workedExample.manifest, null, 2), "utf8");
    await writeBlocks(workedExample.blocks);

    const specified = await checkProject(dir);
    expect(specified.errorCount).toBe(0);
    // The composite's code is generated; the three blocks without children are the agent's.
    expect(specified.unimplemented).toEqual([
      "price-orders/load-orders",
      "price-orders/price-order",
      "price-orders/sum-totals",
    ]);

    // The code the guide shows, plus the two leaves it leaves to the reader.
    const code: Record<string, string> = {
      "price-orders/price-order": workedExample.leafCode.typescript!,
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

  it.skipIf(!python)("shows Python that parses", () => {
    const parsed = spawnSync(python!, ["-c", "import ast,sys; ast.parse(sys.stdin.read())"], {
      input: workedExample.leafCode.python,
      encoding: "utf8",
    });
    expect(parsed.stderr).toBe("");
  });
});

describe("the visual worked example", () => {
  it("passes the check over code that matches it", async () => {
    await writeFile(
      manifestPath(dir),
      JSON.stringify({ name: "Order Pricer", mode: "visual", granularity: { level: 3 }, systems: [{ rootBlock: "price-orders" }] }),
      "utf8",
    );
    // The guide shows two of the blocks; the other two are written the same way.
    await writeBlocks({
      ...visualExample,
      "price-orders/load-orders": {
        responsibility: "Read and parse the orders file.",
        code: "src/pricing.ts#loadOrders",
        inputs: { path: "string" },
        outputs: { orders: "Order[]" },
        capabilities: { files: "FileSystem" },
      },
      "price-orders/sum-totals": {
        responsibility: "Add the totals together.",
        code: "src/pricing.ts#sumTotals",
        inputs: { totals: "number[]" },
        outputs: { sum: "number" },
      },
    });

    await mkdir(path.join(dir, "src"));
    await writeFile(
      path.join(dir, "src", "pricing.ts"),
      [
        "export async function loadOrders(path: string, files: FileSystem): Promise<Order[]> { return []; }",
        "export function priceOrder(order: Order): number { return 0; }",
        "export function sumTotals(totals: number[]): number { return 0; }",
        "export async function priceOrders(path: string, files: FileSystem) { return {}; }",
      ].join("\n"),
      "utf8",
    );

    const report = await checkProject(dir);
    expect(report.problems).toEqual([]);
    expect(report.errorCount).toBe(0);
    expect(report.unimplemented).toEqual([]);
    expect(report.generated.written).toEqual(["FRAGMENTOR.md"]);
  });
});

describe("the guide says where the project starts", () => {
  const withAnswers = (over: Partial<Manifest>): Manifest => ({ ...structured("typescript"), ...over });

  it("tells an agent in an empty folder that the program is its own to write", () => {
    const guide = agentGuide(withAnswers({ existingCode: false }));
    expect(guide).toContain("**This folder started empty**");
    expect(guide).not.toContain("rebuilding it as blocks");
  });

  it("tells an agent in a folder of code to commit it and rebuild it", () => {
    const guide = agentGuide(withAnswers({ existingCode: true }));
    expect(guide).toContain("**This folder already held code**");
    expect(guide).toContain("committed to version control");
  });

  it("asks for the architecture as a plan first when that is what the person chose", () => {
    const planning = agentGuide(withAnswers({ start: "plan" }));
    expect(planning).toContain("**This project starts as a plan.**");
    expect(planning).toContain('Give every block `"planned": true` to begin with');
    expect(agentGuide(withAnswers({ start: "build" }))).not.toContain("starts as a plan");
  });

  it("tells an agent building straight away not to stop for agreement", () => {
    const building = agentGuide(withAnswers({ start: "build" }));
    expect(building).toContain("Carry straight on to the code.");
    expect(building).toContain("do not stop to ask for agreement");
    expect(building).not.toContain("wait for them to agree");

    const planning = agentGuide(withAnswers({ start: "plan" }));
    expect(planning).toContain("wait for them to agree before you write any code");
    expect(planning).not.toContain("Carry straight on");
  });

  it("says the same to a visual agent, in its own terms", () => {
    const drawing = agentGuide({ ...visual, existingCode: false, start: "plan" });
    expect(drawing).toContain("**This folder started empty.**");
    expect(drawing).toContain("**This project starts as a plan.**");
    expect(drawing).not.toContain("committed to version control");
  });

  it("explains planned blocks in both modes", () => {
    for (const guide of [agentGuide(structured("typescript")), agentGuide(visual)]) {
      expect(guide).toContain("`planned: true`");
      expect(guide).toContain("greyed out");
    }
  });

  it("shows the person's answers in the example project file, so they are not changed", () => {
    const guide = agentGuide(withAnswers({ existingCode: true, start: "plan" }));
    expect(guide).toContain('"existingCode": true');
    expect(guide).toContain('"start": "plan"');
    expect(guide).toContain("Leave `mode`, `existingCode`, `start` and `granularity` as the person set them.");
  });
});

describe("the architecture the guide shows", () => {
  it("checks clean exactly as printed, in a service that holds all three", async () => {
    // The service is the one the guide prints, given the other two as
    // children so that everything it shows is checked in one place.
    await writeFile(
      manifestPath(dir),
      JSON.stringify({ ...workedExample.manifest, systems: [{ rootBlock: "price-orders" }] }, null, 2),
      "utf8",
    );
    await writeBlocks({
      "price-orders": {
        ...architectureExample["orders-api"]!,
        children: ["orders-db", "billing", "load-orders"],
      },
      "price-orders/orders-db": architectureExample["orders-db"]!,
      "price-orders/billing": architectureExample.billing!,
      "price-orders/load-orders": architectureExample["load-orders"]!,
    });

    const report = await checkProject(dir);
    expect(report.problems).toEqual([]);
    expect(report.errorCount).toBe(0);
    // Neither a database nor someone else's payment service is unfinished work.
    expect([...report.architecture].sort()).toEqual([
      "price-orders",
      "price-orders/billing",
      "price-orders/orders-db",
    ]);
    // The one block that is code is the one still to be written.
    expect(report.unimplemented).toEqual(["price-orders/load-orders"]);
  });

  it("names every role it offers, and shows both halves of joining one up", () => {
    for (const guide of [agentGuide(structured("typescript")), agentGuide(visual)]) {
      for (const role of ARCHITECTURE_ROLES) expect(guide).toContain(`\`"${role}"\``);
      expect(guide).toContain('"role": "database"');
      expect(guide).toContain('"access": ["reads orders-db.orders"]');
      // And which block answers an operation, without which the blocks inside
      // a service show inputs arriving from nowhere.
      expect(guide).toContain('"block": "load-orders"');
    }
  });
});
