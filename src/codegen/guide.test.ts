import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GUIDE_FILE, agentGuide, architectureExample, compactJson, executionExample, workedExample } from "./guide.js";
import { writeAgentFiles } from "./emit.js";
import { blockFromFile } from "../model/block.js";
import { CAPABILITIES } from "../model/capabilities.js";
import { ARCHITECTURE_ROLES } from "../model/roles.js";
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

const project = (over: Partial<Manifest> = {}): Manifest => ({
  name: "Test",
  goal: "",
  existingCode: false,
  start: "build",
  language: "typescript",
  granularity: { level: 3, maxDepth: 4 },
  systems: [],
  ...over,
});

async function writeBlocks(blocks: Record<string, unknown>): Promise<void> {
  for (const [blockPath, file] of Object.entries(blocks)) {
    await mkdir(blockDir(dir, blockPath), { recursive: true });
    await writeFile(path.join(blockDir(dir, blockPath), "block.json"), JSON.stringify(file, null, 2), "utf8");
  }
}

async function writeSource(file: string, source: string): Promise<void> {
  const target = path.join(dir, ...file.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, source, "utf8");
}

/** A Python that can parse a file, or nothing if the machine has none. */
const python = ["python", "python3", "py"].find((candidate) => spawnSync(candidate, ["-c", "print(1)"]).status === 0) ?? null;

describe("writeAgentFiles", () => {
  const manifest = project();

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
    TypeScript: agentGuide(project()),
    Python: agentGuide(project({ language: "python" })),
    "with the language left open": agentGuide(project({ language: undefined })),
    "in a language there is no pack for": agentGuide(project({ language: "Go", existingCode: true })),
  };

  for (const [label, guide] of Object.entries(guides)) {
    it(`(${label}) has nothing left unfilled, and one kind of line ending`, () => {
      expect(guide).not.toMatch(/\{\{|\}\}/);
      expect(guide).not.toContain("\r");
      expect(guide).not.toMatch(/\n\n\n/);
    });
  }

  it("is short enough for an agent to take in at once", () => {
    // The two guides these replaced ran to 213 and 197 lines, and every
    // project now gets one that also teaches executions, which the structured
    // one never did. That section, and saying where each block's code is, is
    // the whole of what has been allowed to add to these numbers.
    expect(guides.TypeScript!.split("\n").length).toBeLessThan(265);
    // Nothing is generated or run without a pack, so the whole of contracts,
    // running and testing falls away.
    expect(guides["in a language there is no pack for"]!.split("\n").length).toBeLessThan(220);
  });

  it("tells an agent about every capability, and how to check and test its work", () => {
    const guide = guides.TypeScript!;
    for (const name of Object.keys(CAPABILITIES)) expect(guide).toContain(`**${name}**`);
    expect(guide).toContain("`fragmentor check`");
    expect(guide).toContain("`fragmentor test`");
    expect(guide).toContain("readFile(path: string) → string");
  });

  it("says that every function block points at its code, and that the layout is the codebase's own", () => {
    for (const guide of Object.values(guides)) {
      expect(guide).toContain("**Every function block has one.**");
      expect(guide).toContain("The code is yours, wherever it belongs in the codebase**");
    }
  });

  it("makes the contract's own file, and what binds code to it, plain", () => {
    const guide = guides.TypeScript!;
    expect(guide).toContain("blocks/<the block>/contract.ts");
    expect(guide).toContain("**Importing that contract is what binds your code to it.**");
    expect(guide).toContain('from "../../blocks/price-orders/report-totals/contract.js"');
  });

  it("speaks the language the person chose", () => {
    const guide = guides.Python!;
    expect(guide).toContain("contract.py");
    expect(guide).toContain("read_file(path: str) → str");
    expect(guide).toContain("cannot hold Python code to a contract");
    expect(guide).not.toContain("contract.ts");
    // Nothing is run, so nothing is tested either.
    expect(guide).not.toContain("fragmentor test");
    expect(guide).not.toContain("cases.json");
  });

  it("leaves the language to the agent when the person did", () => {
    const guide = guides["with the language left open"]!;
    expect(guide).toContain('`"typescript"`');
    expect(guide).toContain('`"python"`');
  });

  it("says plainly when it can do nothing with the code but draw it", () => {
    const guide = guides["in a language there is no pack for"]!;
    expect(guide).toContain("It has no language pack for Go");
    expect(guide).not.toContain("## Contracts");
    expect(guide).not.toContain("fragmentor test");
  });

  it("teaches executions in every project, because what happens is half of what a diagram shows", () => {
    for (const guide of Object.values(guides)) {
      expect(guide).toContain("## Executions");
      expect(guide).toContain("executions/report-totals.json");
    }
  });

  it("describes only the granularity the person chose", () => {
    expect(guides.TypeScript).toContain("## Granularity: level 3");
    expect(guides.TypeScript).toContain("around 30 to 80 lines");
    expect(guides.TypeScript).not.toContain("around 10 to 30 lines");
    // The size is something to aim at, not a rule the agent has to satisfy.
    expect(guides.TypeScript).toContain("aims rather than rules");
    expect(agentGuide(project({ granularity: { level: 2, maxDepth: 5 } }))).toContain("at most 5 levels deep");
  });
});

describe("compactJson", () => {
  it("keeps what fits on one line there, and is still exactly the same JSON", () => {
    const value = workedExample.blocks["price-orders/report-totals"];
    const text = compactJson(value);

    expect(JSON.parse(text)).toEqual(value);
    expect(text).toContain('"outputs": { "totals": "number[]", "grandTotal": "number" }');
    expect(text).toContain('"capabilities": { "files": "FileSystem" }');
  });
});

describe("the worked example", () => {
  it("is a valid project by the same rules the checker applies", () => {
    expect(manifestSchema.safeParse(workedExample.manifest).success).toBe(true);
    for (const [blockPath, file] of Object.entries(workedExample.blocks)) {
      expect(() => blockFromFile(file, blockPath.split("/").at(-1)!), blockPath).not.toThrow();
    }
    for (const cases of Object.values(workedExample.cases)) expect(casesSchema.safeParse(cases).success).toBe(true);
  });

  it("checks and passes its tests when an agent follows it to the letter", async () => {
    // The project exactly as the guide shows it.
    await writeFile(manifestPath(dir), JSON.stringify(workedExample.manifest, null, 2), "utf8");
    await writeBlocks(workedExample.blocks);

    const specified = await checkProject(dir);
    // No code is there yet, which is where an agent starts and is not an error.
    expect(specified.errorCount).toBe(0);
    expect(specified.unimplemented).toEqual([
      "price-orders/load-orders",
      "price-orders/price-order",
      "price-orders/report-totals",
    ]);

    // The code the guide shows, plus the two blocks it leaves to the reader,
    // each in the file its block points at.
    await writeSource(workedExample.codeFile, workedExample.code);
    await writeSource(
      "src/pricing/price-order.ts",
      `import type { PriceOrderInput, PriceOrderOutput, PriceOrderCaps } from "../../blocks/price-orders/price-order/contract.js";

export async function priceOrder(input: PriceOrderInput, caps: PriceOrderCaps): Promise<PriceOrderOutput> {
  return { total: input.order.lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0) };
}
`,
    );
    await writeSource(
      "src/pricing/load-orders.ts",
      `import type { LoadOrdersInput, LoadOrdersOutput, LoadOrdersCaps } from "../../blocks/price-orders/load-orders/contract.js";

export async function loadOrders(input: LoadOrdersInput, caps: LoadOrdersCaps): Promise<LoadOrdersOutput> {
  return { orders: JSON.parse(await caps.files.readFile(input.path)) };
}
`,
    );

    for (const [blockPath, cases] of Object.entries(workedExample.cases)) {
      await writeFile(path.join(blockDir(dir, blockPath), "cases.json"), JSON.stringify(cases), "utf8");
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
      path.join(blockDir(dir, "price-orders/report-totals"), "cases.json"),
      JSON.stringify([{ name: "prices a file of orders", input: { path: "orders.json" }, expected: { totals: [17, 0], grandTotal: 17 } }]),
      "utf8",
    );
    // And what happens when it is set going, exactly as the guide shows it.
    await mkdir(path.join(dir, "executions"));
    await writeFile(path.join(dir, "executions", "report-totals.json"), JSON.stringify(executionExample), "utf8");

    const implemented = await checkProject(dir);
    expect(implemented.systems[0]!.codeProblems).toEqual([]);
    expect(implemented.problems).toEqual([]);
    expect(implemented.errorCount).toBe(0);
    expect(implemented.unimplemented).toEqual([]);
    // Every one of them is held to its contract, so every one can be run.
    expect(implemented.drawnOnly).toEqual([]);
    // The guide shows tests for one of the three, so the other two are asked for.
    expect(implemented.untested).toEqual(["price-orders/load-orders"]);

    expect((await runCases(dir, "price-orders/price-order")).map((r) => [r.status, r.differences])).toEqual([
      ["passed", []],
      ["passed", []],
    ]);
    expect((await runCases(dir, "price-orders/report-totals")).map((r) => [r.status, r.differences])).toEqual([["passed", []]]);
  }, 30_000);

  it.skipIf(!python)("shows a Python project its own contract file", () => {
    const guide = agentGuide(project({ language: "python" }));
    expect(guide).toContain("contract.py");
  });
});

describe("the guide says where the project starts", () => {
  it("tells an agent in an empty folder that the program is its own to write", () => {
    const guide = agentGuide(project({ existingCode: false }));
    expect(guide).toContain("**This folder started empty**");
    expect(guide).toContain("Lay the code out however suits it");
    expect(guide).not.toContain("the diagram describes it");
  });

  it("tells an agent in a folder of code that the diagram follows the code", () => {
    const guide = agentGuide(project({ existingCode: true }));
    expect(guide).toContain("**This folder already held code**");
    expect(guide).toContain("Never restructure the program to make the diagram tidier");
  });

  it("asks for the architecture as a plan first when that is what the person chose", () => {
    const planning = agentGuide(project({ start: "plan" }));
    expect(planning).toContain("**This project starts as a plan.**");
    expect(planning).toContain('Give every block `"planned": true` to begin with');
    expect(agentGuide(project({ start: "build" }))).not.toContain("starts as a plan");
  });

  it("tells an agent building straight away not to stop for agreement", () => {
    const building = agentGuide(project({ start: "build" }));
    expect(building).toContain("Carry straight on to the code.");
    expect(building).toContain("do not stop to ask for agreement");
    expect(building).not.toContain("wait for them to agree");

    const planning = agentGuide(project({ start: "plan" }));
    expect(planning).toContain("wait for them to agree before you write any code");
    expect(planning).not.toContain("Carry straight on");
  });

  it("explains planned blocks", () => {
    const guide = agentGuide(project());
    expect(guide).toContain("`planned: true`");
    expect(guide).toContain("greyed out");
  });

  it("shows the person's answers in the example project file, so they are not changed", () => {
    const guide = agentGuide(project({ existingCode: true, start: "plan" }));
    expect(guide).toContain('"existingCode": true');
    expect(guide).toContain('"start": "plan"');
    expect(guide).toContain("Leave `existingCode`, `start` and `granularity` as the person set them.");
    expect(guide).not.toContain('"mode"');
  });
});

describe("the architecture the guide shows", () => {
  it("checks clean exactly as printed, in a service that holds all three", async () => {
    // The service is the one the guide prints, given the other two as
    // children so that everything it shows is checked in one place.
    await writeFile(
      manifestPath(dir),
      JSON.stringify({ ...workedExample.manifest, systems: [{ rootBlock: "orders-app" }] }, null, 2),
      "utf8",
    );
    await writeBlocks({
      // The client sits beside the service it calls, not inside it, which is
      // the shape every one of these examples is written for.
      "orders-app": { role: "component", responsibility: "The orders application." },
      "orders-app/orders-page": architectureExample["orders-page"]!,
      "orders-app/orders-api": architectureExample["orders-api"]!,
      "orders-app/orders-api/orders-db": architectureExample["orders-db"]!,
      "orders-app/orders-api/billing": architectureExample.billing!,
      "orders-app/orders-api/load-orders": architectureExample["load-orders"]!,
    });

    const report = await checkProject(dir);
    expect(report.errorCount).toBe(0);
    // Neither a database nor someone else's payment service is unfinished work.
    expect([...report.architecture].sort()).toEqual([
      "orders-app",
      "orders-app/orders-api",
      "orders-app/orders-api/billing",
      "orders-app/orders-api/orders-db",
      "orders-app/orders-page",
    ]);
    // The one block that is code is the one still to be written, which is
    // reported once, against it, as the warning it is.
    expect(report.unimplemented).toEqual(["orders-app/orders-api/load-orders"]);
    expect(report.problems).toEqual([
      expect.objectContaining({ severity: "warning", blockPath: "orders-app/orders-api/load-orders" }),
    ]);
  });

  it("names every role it offers, and shows both halves of joining one up", () => {
    const guide = agentGuide(project());
    for (const role of ARCHITECTURE_ROLES) expect(guide).toContain(`\`"${role}"\``);
    expect(guide).toContain('"role": "database"');
    // The access names the capability port at this end, which is what makes
    // it the way the code actually gets there rather than only a description.
    expect(guide).toContain('"access": ["orders reads orders-db.orders"]');
    expect(guide).toContain('"capabilities": { "orders": "Store" }');
    // And which block answers an operation, without which the blocks inside
    // a service show inputs arriving from nowhere.
    expect(guide).toContain('"block": "load-orders"');
    // And which of a block's own entries does the reaching, without which
    // two buttons calling two operations would be one line.
    expect(guide).toContain('"showOrders calls orders-api.listOrders"');
  });
});
