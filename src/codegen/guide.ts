import { readFileSync } from "node:fs";
import { CAPABILITIES } from "../model/capabilities.js";
import { ARCHITECTURE_ROLES, ROLES } from "../model/roles.js";
import { getPack, isKnownLanguage, knownLanguages } from "../lang/index.js";
import { snakeCase } from "../lang/naming.js";
import type { LanguagePack } from "../lang/index.js";
import type { Manifest } from "../project/project.js";
import { COMMANDS, usageOf } from "./commands.js";
import type { AgentCommand } from "./commands.js";

/**
 * What a coding agent needs to know to work in a Fragmentor project.
 *
 * Fragmentor does not call a model. An agent such as Claude Code or Codex
 * works in the project folder, and this is how it learns the rules. It is
 * written for the one project it sits in — where it starts from, its language
 * and its granularity — so it says only what applies there. It is kept apart
 * from the project's own architecture, which stays machine-readable in
 * fragmentor.json and the block.json files.
 *
 * There is one guide, because there is one way to work: blocks say what the
 * system is made of, each function block says where its code is, and
 * Fragmentor writes a contract for, checks and runs whichever blocks it can.
 * What differs between projects is how much of that last part applies, so it
 * is one section that says when it does.
 *
 * It is regenerated like a contract, so it describes the rules the checks
 * actually enforce. The parts that could drift are built from the same
 * catalogue and language packs the checks use, and the worked examples are
 * held by test to pass the checks exactly as the guide shows them.
 */

export const GUIDE_FILE = "FRAGMENTOR.md";
export const AGENTS_FILE = "AGENTS.md";
export const CLAUDE_FILE = "CLAUDE.md";

const ORDER = "{ id: string; lines: { quantity: number; unitPrice: number }[] }";

/**
 * A small system, as the files an agent writes to build it.
 *
 * Its code sits under `src/`, in a folder of its own, because that is the
 * point the guide has to make: a block says where its code is, and nothing
 * requires the codebase to mirror the diagram.
 */
export const workedExample = {
  manifest: {
    name: "Order Pricer",
    goal: "Read a file of orders and report what each order costs and what they cost altogether.",
    existingCode: false,
    start: "build",
    language: "typescript",
    granularity: { level: 3, maxDepth: 4 },
    systems: [{ rootBlock: "price-orders" }],
  },
  blocks: {
    "price-orders": {
      role: "component",
      responsibility: "Everything to do with pricing a file of orders.",
    },
    "price-orders/report-totals": {
      responsibility: "Read a file of orders and report what each one costs and the grand total.",
      code: "src/pricing/report-totals.ts#reportTotals",
      inputs: { path: { type: "string", description: "The JSON file holding the orders." } },
      outputs: { totals: "number[]", grandTotal: "number" },
      capabilities: { files: "FileSystem" },
    },
    "price-orders/load-orders": {
      responsibility: "Read the orders file and parse it into orders.",
      code: "src/pricing/load-orders.ts#loadOrders",
      inputs: { path: "string" },
      outputs: { orders: `${ORDER}[]` },
      capabilities: { files: "FileSystem" },
    },
    "price-orders/price-order": {
      responsibility: "Add up one order: each line's quantity times its unit price.",
      code: "src/pricing/price-order.ts#priceOrder",
      inputs: { order: ORDER },
      outputs: { total: "number" },
    },
  } as Record<string, Record<string, unknown>>,
  /**
   * The code the guide shows written: the block that calls two others, because
   * importing a contract and calling another block are the two things a reader
   * cannot guess.
   */
  code: `import type { ReportTotalsInput, ReportTotalsOutput, ReportTotalsCaps } from "../../blocks/price-orders/report-totals/contract.js";
import { loadOrders } from "./load-orders.js";
import { priceOrder } from "./price-order.js";

/** Read a file of orders and report what each one costs and the grand total. */
export async function reportTotals(input: ReportTotalsInput, caps: ReportTotalsCaps): Promise<ReportTotalsOutput> {
  const { orders } = await loadOrders({ path: input.path }, caps);
  if (orders.length === 0) return { totals: [], grandTotal: 0 };

  const totals = await Promise.all(orders.map(async (order) => (await priceOrder({ order }, caps)).total));
  return { totals, grandTotal: totals.reduce((sum, total) => sum + total, 0) };
}
`,
  /** The block that code is, and the file it is in. */
  codeBlock: "price-orders/report-totals",
  codeFile: "src/pricing/report-totals.ts",
  /**
   * The same three blocks' code as Python writes it: the shown file first,
   * held by test to check and pass exactly as the TypeScript one is. The
   * guide shows only the first; the others are what an agent following it
   * would write, and what the tests write for it.
   */
  python: {
    "src/pricing/report_totals.py": `from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

from src.pricing.load_orders import load_orders
from src.pricing.price_order import price_order

if TYPE_CHECKING:
    from blocks._contracts.price_orders.report_totals.contract import ReportTotalsCaps, ReportTotalsInput, ReportTotalsOutput


async def report_totals(input: ReportTotalsInput, caps: ReportTotalsCaps) -> ReportTotalsOutput:
    """Read a file of orders and report what each one costs and the grand total."""
    loaded = await load_orders({"path": input["path"]}, caps)
    if not loaded["orders"]:
        return {"totals": [], "grandTotal": 0}

    priced = await asyncio.gather(*(price_order({"order": order}, caps) for order in loaded["orders"]))
    totals = [each["total"] for each in priced]
    return {"totals": totals, "grandTotal": sum(totals)}
`,
    "src/pricing/load_orders.py": `from __future__ import annotations

import json
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from blocks._contracts.price_orders.load_orders.contract import LoadOrdersCaps, LoadOrdersInput, LoadOrdersOutput


async def load_orders(input: LoadOrdersInput, caps: LoadOrdersCaps) -> LoadOrdersOutput:
    return {"orders": json.loads(await caps.files.read_file(input["path"]))}
`,
    "src/pricing/price_order.py": `from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from blocks._contracts.price_orders.price_order.contract import PriceOrderCaps, PriceOrderInput, PriceOrderOutput


async def price_order(input: PriceOrderInput, caps: PriceOrderCaps) -> PriceOrderOutput:
    return {"total": sum(line["quantity"] * line["unitPrice"] for line in input["order"]["lines"])}
`,
  } as Record<string, string>,
  cases: {
    "price-orders/price-order": [
      {
        name: "adds quantity times price across the lines",
        input: { order: { id: "A-1", lines: [{ quantity: 2, unitPrice: 3.5 }] } },
        expected: { total: 7 },
      },
      {
        name: "an order with no lines costs nothing",
        input: { order: { id: "A-2", lines: [] } },
        expected: { total: 0 },
      },
    ],
  } as Record<string, unknown[]>,
};

/**
 * The parts of a system that are not functions, as the files an agent writes
 * to draw them: a database with its schema, and a block joined to it.
 *
 * The same domain as the worked example above, so the two read as one project
 * rather than two. Held by test to pass the checks exactly as shown.
 */
export const architectureExample: Record<string, Record<string, unknown>> = {
  "orders-db": {
    name: "Orders Database",
    role: "database",
    subtype: "PostgreSQL",
    responsibility: "Holds every order and who placed it.",
    exposes: { orders: { type: "{ id: string; owner: string }", description: "One per order." } },
  },
  billing: {
    role: "external",
    subtype: "payment provider",
    responsibility: "Someone else's payment service. We cannot see inside it.",
    exposes: { charge: { accepts: "{ orderId: string; amount: number }", returns: "{ receipt: string }" } },
  },
  "orders-api": {
    role: "service",
    subtype: "REST API",
    responsibility: "Answers for one owner's orders.",
    exposes: {
      listOrders: { accepts: "{ owner: string }", returns: "{ orders: { id: string; total: number }[] }", block: "load-orders" },
    },
  },
  "load-orders": {
    responsibility: "Read one owner's orders.",
    code: "src/orders/list.ts#listOrders",
    inputs: { owner: "string" },
    outputs: { orders: "{ id: string; total: number }[]" },
    capabilities: { orders: "Store" },
    access: ["orders reads orders-db.orders"],
  },
  "orders-page": {
    role: "client",
    subtype: "browser",
    responsibility: "Where someone asks to see their orders.",
    exposes: { showOrders: { accepts: "{ owner: string }", returns: "{ orders: { id: string; total: number }[] }" } },
    access: ["showOrders calls orders-api.listOrders"],
  },
};

/**
 * What happens when something sets the worked example going, written down the
 * way the guide asks an agent to. Held by test to read and check cleanly
 * against that example's blocks, and to agree with a recording of its code,
 * since `fragmentor test` holds an agent's own executions to one.
 */
export const executionExample = {
  description: "Someone asks for the totals of a file of orders.",
  trigger: {
    at: "price-orders/report-totals",
    kind: "action",
    description: "Someone asks for the totals of a file of orders.",
    code: "src/pricing/report-totals.ts#reportTotals",
    payload: { path: "orders.json" },
  },
  trace: [
    {
      from: "price-orders/report-totals",
      to: "price-orders/load-orders",
      kind: "call",
      description: "The orders are read off disk before anything can be priced.",
      code: "src/pricing/report-totals.ts#reportTotals",
      payload: { path: "orders.json" },
    },
    {
      from: "price-orders/report-totals",
      to: "price-orders/price-order",
      kind: "call",
      description: "Each order is priced in turn, and the totals added up.",
      code: "src/pricing/report-totals.ts#reportTotals",
      payload: { order: { id: "A-1", lines: [{ quantity: 2, unitPrice: 3.5 }] } },
      response: { total: 7 },
    },
    {
      effect: "response",
      at: "price-orders/report-totals",
      description: "The caller is given the total of every order in the file.",
      code: "src/pricing/report-totals.ts#reportTotals",
    },
  ],
  expect: {
    entered: ["price-orders/price-order"],
    interactions: [
      { from: "price-orders/report-totals", to: "price-orders/load-orders", kind: "call", payload: { path: "orders.json" } },
    ],
    effects: [{ kind: "response", at: "price-orders/report-totals" }],
  },
};

/**
 * The size of block to reach for, at each level.
 *
 * Every one of these is written as something to aim at rather than something
 * to meet. A rule an agent cannot satisfy without writing worse code is a rule
 * it will either break quietly or contort the design around, and neither is
 * what the person choosing a granularity wanted. Nothing here is checked.
 */
const GRANULARITY: Record<number, string> = {
  1: "Try to divide the system only where it plainly holds separate responsibilities, into two or three substantial parts per block, with real work left inside each.",
  2: "Try for two to four parts per block, each a substantial piece of work.",
  3: "Try for three to five parts per block, each with one clear responsibility, down to functions of somewhere around 30 to 80 lines.",
  4: "Try for four to six fairly small parts per block, down to functions of somewhere around 20 to 50 lines.",
  5: "Try to divide the work into small single-purpose functions of somewhere around 10 to 30 lines, though never one that is a single expression.",
};

/** What a block's code may import, which differs by language. */
const IMPORT_RULES: Record<string, string> = {
  typescript:
    "A block with no outputs returns nothing, and one with no inputs is still called with a value and `caps`. Its code may import its own contract's types with `import type`, the code of another block in the same system that is held to its contract, and packages installed in the project folder. Call another block with a value and your `caps`, when and as often as you need it. It may not import a shared helper file or one of Node's built-in modules such as `fs`: make the helper a block, or use a capability. `fragmentor check` reports any such import anywhere in the file, so keep anything else out of a file you write for a block.",
  python:
    "A block with no outputs returns `None`, and one with no inputs is still called with a value and `caps`. A block is a top-level `async def` imported at module level; its file starts with `from __future__ import annotations` and imports its contract's types under `if TYPE_CHECKING:`, as shown. It may import the code of another block in the same system that is held to its contract — from that block's own file, by its path from the project root — packages installed in the project, and the standard library that only computes, such as `json`, `math`, `re` and `asyncio`. Call another block with a value and your `caps`, when and as often as you need it. No `open`, `print` or `input`, and no module that reaches files, processes or the network, such as `os` or `subprocess`: use a capability. Fragmentor runs the project's `.venv` first, then any Python 3.11 or later; create the `.venv` yourself when the project needs packages, and ask the person before installing any. `fragmentor check` reports any break of these rules anywhere in the file, so keep anything else out of a file you write for a block.",
};

const WIDTH = 100;

function oneLine(value: unknown): string {
  if (Array.isArray(value)) return value.length === 0 ? "[]" : `[${value.map(oneLine).join(", ")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return "{}";
    return `{ ${entries.map(([key, item]) => `${JSON.stringify(key)}: ${oneLine(item)}`).join(", ")} }`;
  }
  return JSON.stringify(value);
}

function layout(value: unknown, indent: string, used: number): string {
  const flat = oneLine(value);
  if (used + flat.length < WIDTH || value === null || typeof value !== "object") return flat;

  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    return `[\n${value.map((item) => inner + layout(item, inner, inner.length)).join(",\n")}\n${indent}]`;
  }
  const lines = Object.entries(value).map(([key, item]) => {
    const head = `${inner}${JSON.stringify(key)}: `;
    return head + layout(item, inner, head.length);
  });
  return `{\n${lines.join(",\n")}\n${indent}}`;
}

/**
 * JSON laid out the way a person would write it: anything short enough stays
 * on one line, so an example reads as its shape rather than a column of
 * brackets. It is still exactly valid JSON.
 */
export function compactJson(value: unknown): string {
  return layout(value, "", 0);
}

/** A code pointer as Python writes it: the file and name renamed the way Python names them. */
function pythonPointer(pointer: string): string {
  const [file, symbol] = pointer.split("#") as [string, string?];
  const parts = file.replace(/[.]ts$/, "").split("/");
  const renamed = `${[...parts.slice(0, -1), snakeCase(parts.at(-1)!)].join("/")}.py`;
  return symbol === undefined ? renamed : `${renamed}#${snakeCase(symbol)}`;
}

/**
 * An example as this language's agent would write it: every `code` pointer
 * renamed to that language's file and function names, so the guide's examples
 * and the files its tests write are the same project in either language.
 */
export function exampleIn<T>(pack: LanguagePack | null, value: T): T {
  if (pack?.id !== "python") return value;
  const walk = (each: unknown): unknown => {
    if (Array.isArray(each)) return each.map(walk);
    if (each !== null && typeof each === "object") {
      return Object.fromEntries(
        Object.entries(each).map(([key, item]) => [key, key === "code" && typeof item === "string" ? pythonPointer(item) : walk(item)]),
      );
    }
    return each;
  };
  return walk(value) as T;
}

function rolesSection(): string {
  return ARCHITECTURE_ROLES.map((role) => {
    const examples = ROLES[role].subtypes;
    const like = examples.length > 0 ? ` Subtypes: ${examples.map((each) => `\`${each}\``).join(", ")}.` : "";
    return `- **\`"${role}"\`** — ${ROLES[role].description}${like}`;
  }).join("\n");
}

function capabilitiesSection(pack: LanguagePack | null): string {
  if (pack === null) {
    return Object.values(CAPABILITIES)
      .map((capability) => `- **${capability.name}**: ${capability.description}`)
      .join("\n");
  }
  return Object.values(CAPABILITIES)
    .map((capability) => {
      const operations = capability.operations.map((operation) => {
        const parameters = operation.parameters
          .map((parameter) => `${pack.functionName(parameter.name)}: ${pack.typeExpression(parameter.type)}`)
          .join(", ");
        const returns = operation.returns ? ` → ${pack.typeExpression(operation.returns)}` : "";
        return `\`${pack.functionName(operation.name)}(${parameters})${returns}\`${operation.async ? " (async)" : ""}`;
      });
      return `- **${capability.name}**: ${capability.description} ${operations.join(", ")}`;
    })
    .join("\n");
}

/** The example project file, set up the way this project is. */
function exampleManifest(manifest: Manifest): unknown {
  const suggestLanguage = manifest.language === undefined;
  return {
    name: workedExample.manifest.name,
    goal: workedExample.manifest.goal,
    existingCode: manifest.existingCode,
    start: manifest.start,
    ...(manifest.language === undefined ? {} : { language: manifest.language }),
    granularity: manifest.granularity,
    systems: [{ rootBlock: "price-orders", ...(suggestLanguage ? { language: "typescript" } : {}) }],
  };
}

/** The table of files, aligned however many rows this project's language adds. */
function filesSection(pack: LanguagePack | null): string {
  const rows: [string, string, string][] = [
    ["fragmentor.json", "the project", "you fill in goal and systems"],
    ["blocks/<system>/", "a system's top block", "a block's parts are the folders inside it"],
    ["  block.json", "the block", "you write"],
  ];
  // A contract sits beside the block.json it is made from, or in a mirror
  // where the language cannot import the block's own folder; the row reads
  // whichever way the pack writes it.
  if (pack) {
    const contract = pack.contractPath("<the block>");
    rows.push(
      contract.startsWith("blocks/<the block>/")
        ? [`  ${contract.split("/").at(-1)}`, "its types", "generated"]
        : [contract, "its types", "generated"],
    );
  }
  if (pack?.canRun) rows.push(["  cases.json", "its tests", "you write, for a block Fragmentor runs"]);
  if (pack) rows.push([`blocks/${pack.capabilitiesFile}`, "the capability interfaces", "generated"]);
  rows.push(
    ["src/…", "the code", "you write, wherever it belongs"],
    ["executions/<name>.json", "one thing that sets the system going", "you write"],
  );

  const first = Math.max(...rows.map(([name]) => name.length)) + 2;
  const second = Math.max(...rows.map(([, what]) => what.length)) + 2;
  return rows.map(([name, what, who]) => `${name.padEnd(first)}${what.padEnd(second)}${who}`).join("\n");
}

/**
 * The language the guide is written for.
 *
 * The person may name it on the project, or leave each system to name its own,
 * so both are looked at. Where nothing names one at all, the guide is written
 * for TypeScript and says the choice is the agent's: a guide with no contracts
 * in it would leave an agent that then chose TypeScript with nothing to follow.
 */
function guideLanguage(manifest: Manifest): {
  pack: LanguagePack | null;
  unnamed: boolean;
  named: string | null;
  /** True where the systems name more than one language, so the guide can only be written for one. */
  mixed: boolean;
} {
  const named = [manifest.language, ...manifest.systems.map((system) => system.language)].filter(
    (each): each is string => each !== undefined,
  );
  if (named.length === 0) return { pack: getPack("typescript"), unnamed: true, named: null, mixed: false };

  const known = named.find((each) => isKnownLanguage(each));
  return {
    pack: known === undefined ? null : getPack(known),
    unnamed: false,
    named: known ?? named[0]!,
    mixed: new Set(named).size > 1,
  };
}

/**
 * What Fragmentor does with this project's code, in the opening paragraph.
 *
 * It is the first thing an agent reads, and the one thing that differs most
 * between projects, so it is stated rather than left to be worked out from the
 * sections below.
 */
function fragmentorRole(pack: LanguagePack | null, named: string | null): string {
  if (pack === null) {
    return `Fragmentor draws the diagram and checks that it holds together. It has no language pack for ${named ?? "this project's language"}, so it writes nothing, checks no code and runs nothing here.`;
  }
  if (!pack.canRun) {
    return `Fragmentor draws the diagram, checks that it holds together, and writes each function block's types. It cannot check or run ${pack.displayName} code yet.`;
  }
  return "Fragmentor draws the diagram, checks that it holds together, writes each function block's types, checks the code against them, and runs the block and its tests.";
}

/**
 * The one section that says when generation applies, and what to do about it.
 *
 * Everything here follows from the same fact: a contract is only worth writing
 * where the ports are types and the language has a pack, and it only binds
 * code that imports it. The rest of the guide is the same for every project.
 */
function contractsSection(pack: LanguagePack | null): string {
  if (pack === null) return "";

  const contractOf = (blockPath: string) => pack.contractPath(blockPath);
  const besideItsBlock = contractOf("<the block>").startsWith("blocks/<the block>/");
  const lines: string[] = ["## Contracts", ""];

  lines.push(
    `Where a function block's inputs and outputs are written as types, Fragmentor writes them into \`${contractOf("<the block>")}\`${besideItsBlock ? ", beside its \`block.json\`," : ","} along with the capabilities it asks for. A block whose ports are words gets none, and is drawn rather than checked or run.`,
  );

  if (!pack.canRun) {
    lines.push(
      "",
      `Read it, and write each block as a function taking a value and \`caps\`, so the code says the same thing the diagram does. Fragmentor cannot hold ${pack.displayName} code to a contract, run a block or run tests yet, so every block here is drawn and read.`,
    );
    return lines.join("\n");
  }

  const codeFile = pack.id === "python" ? pythonPointer(workedExample.codeFile) : workedExample.codeFile;
  const shown = pack.id === "python" ? workedExample.python[codeFile]! : workedExample.code;
  lines.push(
    "",
    `**Importing that contract is what binds your code to it.** Code that imports it is typechecked against it, can be run from the window with values you type, and can have saved tests; code that does not is drawn and read. This is \`${workedExample.codeBlock.split("/").at(-1)}\`, in \`${codeFile}\`:`,
    "",
    `\`\`\`${pack.id}`,
    shown.trimEnd(),
    "```",
    "",
    IMPORT_RULES[pack.id] ?? "",
    "",
    "### Tests",
    "",
    "Every block Fragmentor runs has tests, in a `cases.json` beside its `block.json`:",
    "",
    "```json",
    compactJson(workedExample.cases["price-orders/price-order"]),
    "```",
    "",
    "`expected` is compared whole, so leave it out where the result depends on `Clock` or `Random`: the test then records what the block returns without checking it. A block that turns input away returns the refusal as a value, such as an `error` field, so tests and executions can check it; a port is never optional, so type what either leaves empty `T | null`. A test gives the stores rows before it runs under `stores`, keyed by the store entry's full address and then by row key: `\"stores\": { \"shop/orders-db.orders\": { \"A-1\": {…} } }`. A block's test runs everything it calls. During tests, `FileSystem` paths are relative to the project folder, `Http` is unavailable, and `Clock` and `Random` are real.",
    "",
    "Code Fragmentor does not run — a block it draws, or code outside the blocks such as a server — is covered by the project's own tests and checks: run them after changing it, since `fragmentor test` does not.",
  );

  return lines.join("\n");
}

const ENTRY_POINTS =
  "Entry points such as a `main` function, a server or framework setup stay outside the blocks: they create the real capabilities and call the blocks that answer them.";

/**
 * Where this project starts, and whether it starts as a plan.
 *
 * The person answered both when they created it, so the guide states them
 * rather than asking the agent to work out which case it is in. An agent
 * follows an instruction better than a condition.
 */
function startingPoint(manifest: Manifest, pack: LanguagePack | null): string {
  const parts: string[] = [];

  // An empty folder has nothing to build, run or test TypeScript with until
  // the agent sets it up, which agents starting from nothing had to work out,
  // down to `node --test` wanting files rather than a folder.
  const setUp =
    pack?.id === "typescript"
      ? ' Start it with a `tsconfig.json` and a `package.json` holding `"type": "module"`, `typescript` and `@types/node` as dev dependencies, a `build` script, and a `test` script giving `node --test` a file pattern, not a folder. Tell the person how to run the entry point.'
      : pack?.id === "python"
        ? " Tell the person how to run the entry point."
        : "";
  parts.push(
    manifest.existingCode
      ? "**This folder already held code**, and the diagram describes it. Map what is there into blocks, each pointing at the code it stands for. Code that was already here is described, not changed: it is drawn rather than checked or run, and that is the expected outcome. Never restructure the program to make the diagram tidier; the diagram follows the code, and the person will say when they want the code changed."
      : `**This folder started empty**, so the program is yours to write. Lay the code out however suits it — a layout that echoes the architecture helps whoever reads both, but nothing requires it — and point each block at the code you wrote. ${ENTRY_POINTS}${setUp}`,
  );

  if (manifest.start === "plan") {
    parts.push(
      '**This project starts as a plan.** Draw the whole architecture first, with `"planned": true` on each system\'s top block, so it can be seen and argued with before any of it is built. Once the person agrees, build one block at a time rather than starting all of them at once.',
    );
  }

  return parts.join("\n\n");
}

/**
 * How code that was already in the folder is drawn, which is not how code is
 * written for Fragmentor: every agent describing an existing codebase met the
 * same questions, and answered them by trial and error. Only a project that
 * started from code has it.
 */
function existingCodeSection(manifest: Manifest, pack: LanguagePack | null): string {
  if (!manifest.existingCode) return "";
  const lines = [
    "## Code that was already here",
    "",
    "- A function block's inputs are named after the function's parameters, and its one output is what the function returns. Where the code reaches a store directly, such as through an ORM client or a file, its `access` line has no port. Giving an operation and its block the same shape, field for field, is for code being built.",
    "- Point at a method as `file#Class.method`. Where no named function makes a step, such as top-level script code or an anonymous route handler, the step's `code` is the file alone, and an operation such a handler answers leaves out `block`: its executions are then not recorded, only held to their own expectations, and that is normal.",
  ];
  if (pack?.canRun) {
    lines.push(
      "- New code the person asks for is written against its contract wherever it is a function of its own. A small addition inside existing code follows the code around it, and stays drawn.",
      "- When the person asks you to hold a block to its contract, add to the file its code is in a small exported function that takes a value and `caps`, imports the contract and calls that code, and point the block at it. The existing code and whatever calls it stay as they are. The file is then held to the import rules above; where it cannot be, tell the person rather than change the code.",
    );
  }
  return lines.join("\n");
}

/**
 * What the agent does once the diagram is first drawn.
 *
 * The person already answered this when they created the project, so the
 * guide tells the agent which it is rather than leaving it a judgement call.
 * Waiting for agreement is what plan-first is for; a person who chose to
 * build does not want the agent stopping to ask.
 */
function reviewStep(manifest: Manifest): string {
  if (manifest.start === "plan") {
    return "Tell the person to look at the diagram in Fragmentor, and wait for them to agree before you write any code. This project starts as a plan, so the architecture is theirs to settle first.";
  }
  return manifest.existingCode
    ? "Do not stop to ask for agreement: the person will say if they want the shape changed."
    : "Carry straight on to the code. They can watch the diagram fill in as you work, and will say if they want the shape changed, so do not stop to ask for agreement.";
}

/** Where the code comes from: the folder, or the agent. */
function codeStep(manifest: Manifest, pack: LanguagePack | null): string {
  if (manifest.existingCode) return "Point each block at the code it stands for, as **Code that was already here** below says.";
  return `Point each block at its code, writing whatever is not there yet.${pack?.canRun ? " Where Fragmentor writes a contract, import it and write the block's tests." : ""}`;
}

function languageRule(manifest: Manifest, chosen: ReturnType<typeof guideLanguage>): string {
  if (chosen.unnamed) {
    const choices = knownLanguages()
      .map(({ id, displayName }) => {
        const each = getPack(id);
        return `\`"${id}"\` (${each.canRun ? "Fragmentor checks and runs it" : `Fragmentor writes its types but cannot check or run ${displayName} yet`})`;
      })
      .join(" or ");
    return `The person left the language to you: give each system a \`"language"\`, ${choices}, or the name of whatever else its code is written in, which Fragmentor will draw and nothing more. The rest of this guide is written for TypeScript; in another language the file names and naming conventions follow that language.`;
  }
  if (chosen.pack === null) {
    return `The code is written in ${chosen.named}, which Fragmentor has no pack for, so it draws the diagram and checks nothing about the code.`;
  }
  if (manifest.language !== undefined) return `The person chose ${chosen.pack.displayName}, so every system is written in it.`;
  return chosen.mixed
    ? `Each system says what it is written in, and this project's are not all the same. The rest of this guide is written for ${chosen.pack.displayName}; a system in another language follows that language's own file names and conventions, and one in a language Fragmentor has no pack for is drawn and nothing more.`
    : `This project's code is written in ${chosen.pack.displayName}, which each system says for itself.`;
}

function fill(template: string, values: Record<string, string>): string {
  const filled = template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`The agent guide refers to {{${name}}}, which nothing fills in.`);
    return value;
  });
  // A section that does not apply to this project leaves its blank lines
  // behind — but inside a code fence, blank lines are the code as written,
  // which the tests hold the guide to showing exactly.
  return filled
    .split(/(```[\s\S]*?```)/)
    .map((part, index) => (index % 2 === 1 ? part : part.replace(/\n{3,}/g, "\n\n")))
    .join("");
}

function template(): string {
  // Read on each call, from beside this module, so the compiled application
  // finds its copy the same way the kernel finds the original.
  return readFileSync(new URL("./guide.md", import.meta.url), "utf8").replace(/\r\n/g, "\n");
}

export function agentGuide(manifest: Manifest): string {
  const chosen = guideLanguage(manifest);
  const pack = chosen.pack;

  return fill(template(), {
    yourPart: manifest.existingCode
      ? "You draw the blocks from the code that is here, keep them true as it changes, and write whatever new code the person asks for."
      : "You design the blocks, write the code, and keep the two saying the same thing.",
    fragmentorRole: fragmentorRole(pack, chosen.named),
    startingPoint: startingPoint(manifest, pack),
    reviewStep: reviewStep(manifest),
    codeStep: codeStep(manifest, pack),
    existingCode: existingCodeSection(manifest, pack),
    testCommand: " and `fragmentor test`",
    commands: COMMANDS.map((command) => `- **\`${usageOf(command)}\`** — ${command.steps}`).join("\n"),
    // Only a block Fragmentor runs can have a run go wrong for the person to flag.
    flaggedRuns: pack?.canRun
      ? "\n- A note flagged from a failed run carries its input, what was expected and what came back. Make that run pass, and add it as a saved test if it is not one."
      : "",
    // Only code Fragmentor runs can be recorded, so where none is, an
    // execution is held to what its own file says must happen and no more.
    // Where it is, agents pinned values the run could never see, and wrote
    // random codes a rerun could never match, until told where a run starts.
    executionTest: pack?.canRun
      ? "runs each execution whose trigger leads to code held to its contract, and holds what you wrote down to what ran. The run starts at the block the trigger is handed to, so the hand-off and anything HTTP-level cannot be checked: pin values at what that block returns, which a `response` at the operation is compared with. Leave `Clock` and `Random` values out of steps and expectations, as out of tests."
      : "holds each execution to its own expectations, which catches a file that contradicts itself and cannot catch one that is wrong about the code, since both halves are your reading of it.",
    files: filesSection(pack),
    manifest: compactJson(exampleManifest(manifest)),
    languageRule: languageRule(manifest, chosen),
    componentBlock: compactJson(workedExample.blocks["price-orders"]),
    functionBlock: compactJson(exampleIn(pack, workedExample.blocks["price-orders/report-totals"])),
    roles: rolesSection(),
    architectureBlock: compactJson(architectureExample["orders-db"]),
    serviceBlock: compactJson(architectureExample["orders-api"]),
    operationEntry: compactJson((architectureExample.billing!.exposes as Record<string, unknown>).charge),
    accessBlock: compactJson(exampleIn(pack, architectureExample["load-orders"])),
    capabilities: capabilitiesSection(pack),
    contracts: contractsSection(pack),
    execution: compactJson(exampleIn(pack, executionExample)),
    level: String(manifest.granularity.level),
    granularity: GRANULARITY[manifest.granularity.level]!,
    maxDepth: String(manifest.granularity.maxDepth),
  });
}

/** AGENTS.md as first created. Codex reads this file. */
export const AGENTS_SCAFFOLD = `# Agent instructions

This folder is a Fragmentor project. Before changing anything, read \`FRAGMENTOR.md\`: it explains how the project is laid out, the rules it follows, and how to check your work with \`fragmentor check\`.

<!-- Add instructions specific to this project below. Fragmentor never changes this file once it exists. -->
`;

/** CLAUDE.md as first created. Claude Code reads this file and follows its @-imports. */
export const CLAUDE_SCAFFOLD = `@FRAGMENTOR.md
@AGENTS.md
`;

/** Where Claude Code finds a project's own slash commands: a folder for each, named as the command, holding its SKILL.md. */
export const SKILLS_DIR = ".claude/skills";

/**
 * Whether a skill's file is one Fragmentor wrote. Its settings have to come
 * first in the file, so the line saying so is the first after them rather
 * than the first of all. The person keeps skills of their own in the same
 * folder, and one without this line is never changed or taken away.
 */
export function isGeneratedSkill(source: string): boolean {
  return /^<!-- Generated by Fragmentor/m.test(source);
}

/** The folder holding a command's skill, which is also the slash command's name: `fragmentor-review`. */
export function skillName(command: AgentCommand): string {
  return `fragmentor-${command.name}`;
}

/**
 * A command as a Claude Code slash command, so the person can pick it from
 * the `/` menu instead of typing the phrase. It is theirs to give, so the
 * agent is told not to use it by itself. It says what the guide says the
 * phrase means, and hands the rest to the guide.
 */
export function commandSkill(command: AgentCommand): string {
  const what = command.takes === "block" ? "block path" : "what, in your own words";
  // Written as JSON strings, which YAML reads as they are, so a colon or a bracket in one means nothing to it.
  return [
    "---",
    `name: ${skillName(command)}`,
    `description: ${JSON.stringify(command.summary)}`,
    `argument-hint: ${JSON.stringify(command.optional ? `[${what}]` : `<${what}>`)}`,
    "disable-model-invocation: true",
    "---",
    "",
    "<!-- Generated by Fragmentor from its list of commands. `fragmentor check` rewrites this file. -->",
    "",
    `The person asked: \`fragmentor ${command.name} $ARGUMENTS\``,
    "",
    command.steps,
    "",
    `${GUIDE_FILE} says how this project is worked on; follow it.`,
    "",
  ].join("\n");
}
