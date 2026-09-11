import { readFileSync } from "node:fs";
import { blockSchema } from "../model/block.js";
import { CAPABILITIES } from "../model/capabilities.js";
import { describeType } from "../model/types.js";
import { getPack, knownLanguages } from "../lang/index.js";

/**
 * What a coding agent needs to know to work in a Fragmentor project.
 *
 * Fragmentor does not call a model. An agent such as Claude Code or Codex
 * works in the project folder, and this is how it learns the rules. The guide
 * is general — the same for every project — and kept apart from the
 * project's own architecture, which stays machine-readable in fragmentor.json
 * and the block.json files.
 *
 * It is regenerated like a contract, so it describes the rules the checks
 * actually enforce. The parts that could drift are built from the same
 * catalogue and language packs the checks use, and the worked example is held
 * by test to validate, typecheck and pass its own tests.
 */

export const GUIDE_FILE = "FRAGMENTOR.md";
export const AGENTS_FILE = "AGENTS.md";
export const CLAUDE_FILE = "CLAUDE.md";

const ORDER = "{ id: string; lines: { quantity: number; unitPrice: number }[] }";

/** A small system the guide uses to show every part of a project. */
export const workedExample = {
  manifest: {
    name: "Order Pricer",
    goal: "Read a file of orders and report what each order costs and what they cost altogether.",
    systems: [{ rootBlock: "price-orders", language: "typescript" }],
    granularity: { level: 3, maxDepth: 4 },
  },
  blocks: {
    "price-orders": {
      id: "price-orders",
      name: "Price Orders",
      responsibility: "Read orders from a file and return what each one costs and the grand total.",
      kind: "composite",
      inputs: { path: { type: "string", description: "The JSON file holding the orders." } },
      outputs: {
        totals: { type: "number[]", description: "One total per order, in file order." },
        grandTotal: { type: "number" },
      },
      capabilities: { files: { capability: "FileSystem", description: "Reads the orders file." } },
      children: [
        { block: "load-orders", mode: "once" },
        { block: "price-order", mode: "each", eachOver: "order" },
        { block: "sum-totals", mode: "once" },
      ],
      wires: [
        "input.path -> load-orders.path",
        "load-orders.orders -> price-order.order",
        "price-order.total -> sum-totals.totals",
        "price-order.total -> output.totals",
        "sum-totals.sum -> output.grandTotal",
      ],
      pinnedAsLeaf: false,
    },
    "price-orders/load-orders": {
      id: "load-orders",
      name: "Load Orders",
      responsibility: "Read the orders file and parse it into orders.",
      kind: "leaf",
      inputs: { path: { type: "string" } },
      outputs: { orders: { type: `${ORDER}[]` } },
      capabilities: { files: { capability: "FileSystem" } },
      children: [],
      wires: [],
      pinnedAsLeaf: false,
    },
    "price-orders/price-order": {
      id: "price-order",
      name: "Price Order",
      responsibility: "Add up one order: each line's quantity times its unit price.",
      kind: "leaf",
      inputs: { order: { type: ORDER } },
      outputs: { total: { type: "number" } },
      capabilities: {},
      children: [],
      wires: [],
      pinnedAsLeaf: false,
    },
    "price-orders/sum-totals": {
      id: "sum-totals",
      name: "Sum Totals",
      responsibility: "Add the order totals together.",
      kind: "leaf",
      inputs: { totals: { type: "number[]" } },
      outputs: { sum: { type: "number" } },
      capabilities: {},
      children: [],
      wires: [],
      pinnedAsLeaf: false,
    },
  },
  code: {
    "price-orders": `import type { PriceOrdersInput, PriceOrdersOutput, PriceOrdersCaps } from "./contract.js";
import { loadOrders } from "./load-orders/impl.js";
import { priceOrder } from "./price-order/impl.js";
import { sumTotals } from "./sum-totals/impl.js";

/** Read orders from a file and return what each one costs and the grand total. */
export async function priceOrders(input: PriceOrdersInput, caps: PriceOrdersCaps): Promise<PriceOrdersOutput> {
  const { path } = input;

  const { orders } = await loadOrders({ path }, caps);

  const priceOrderResults = await Promise.all(orders.map((order) => priceOrder({ order }, caps)));
  const total = priceOrderResults.map((result) => result.total);

  const { sum } = await sumTotals({ totals: total }, caps);

  return { totals: total, grandTotal: sum };
}
`,
    "price-orders/price-order": `import type { PriceOrderInput, PriceOrderOutput, PriceOrderCaps } from "./contract.js";

/** Add up one order: each line's quantity times its unit price. */
export async function priceOrder(input: PriceOrderInput, caps: PriceOrderCaps): Promise<PriceOrderOutput> {
  const total = input.order.lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0);
  return { total };
}
`,
  },
  cases: {
    "price-orders/price-order": [
      {
        name: "adds quantity times price across the lines",
        input: { order: { id: "A-1", lines: [{ quantity: 2, unitPrice: 3.5 }, { quantity: 1, unitPrice: 10 }] } },
        expected: { total: 17 },
      },
      {
        name: "an order with no lines costs nothing",
        input: { order: { id: "A-2", lines: [] } },
        expected: { total: 0 },
      },
    ],
  },
};

const GRANULARITY: Record<number, string> = {
  1: "Split only where the block plainly contains separate responsibilities. Prefer 2 or 3 substantial children. Leave real work inside each child.",
  2: "Prefer 2 to 4 children, each a substantial piece of work.",
  3: "Prefer 3 to 5 children, each with one clear responsibility, each roughly 30 to 80 lines of code.",
  4: "Prefer 4 to 6 fairly small children, each roughly 20 to 50 lines of code.",
  5: "Break the work down aggressively into small single-purpose children, each roughly 10 to 30 lines of code. Still do not create a child that is a single expression.",
};

const json = (value: unknown) => JSON.stringify(value, null, 2);

function capabilitiesSection(): string {
  return Object.values(CAPABILITIES)
    .map((capability) => {
      const operations = capability.operations.map((operation) => {
        const parameters = operation.parameters.map((p) => `${p.name}: ${describeType(p.type)}`).join(", ");
        const returns = operation.returns ? `\`${describeType(operation.returns)}\`` : "nothing";
        return `  - \`${operation.name}(${parameters})\` returns ${returns}${operation.async ? ", asynchronously" : ""}. ${operation.description}`;
      });
      return [`- **${capability.name}**: ${capability.description}`, ...operations].join("\n");
    })
    .join("\n");
}

function languagesSection(): string {
  const leaf = blockSchema.parse(workedExample.blocks["price-orders/price-order"]);

  return knownLanguages()
    .map(({ id }) => {
      const pack = getPack(id);
      const abilities = pack.canRun && pack.canCheck
        ? `\`fragmentor check\` checks ${pack.displayName} code and \`fragmentor test\` runs it.`
        : `Fragmentor generates ${pack.displayName} contracts but cannot check or run ${pack.displayName} code yet, so \`fragmentor test\` skips these blocks.`;

      return [
        `**${pack.displayName}** (\`"language": "${id}"\`). Write the code in \`${pack.implFile}\`; \`${pack.contractFile}\` is generated. A block's function is named after its id, so \`price-order\` becomes \`${pack.functionName("price-order")}\`. ${abilities} A new block's \`${pack.implFile}\` starts as:`,
        "",
        "```" + id,
        pack.implScaffold(leaf).trimEnd(),
        "```",
      ].join("\n");
    })
    .join("\n\n");
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`The agent guide refers to {{${name}}}, which nothing fills in.`);
    return value;
  });
}

export function agentGuide(): string {
  // Read on each call, from beside this module, so the compiled application
  // finds its copy the same way the kernel finds the original.
  const template = readFileSync(new URL("./guide.md", import.meta.url), "utf8").replace(/\r\n/g, "\n");

  return fill(template, {
    manifest: json(workedExample.manifest),
    languageIds: knownLanguages().map(({ id }) => `\`"${id}"\``).join(" or "),
    leafBlock: json(workedExample.blocks["price-orders/price-order"]),
    compositeBlock: json(workedExample.blocks["price-orders"]),
    capabilities: capabilitiesSection(),
    languages: languagesSection(),
    leafCode: workedExample.code["price-orders/price-order"].trimEnd(),
    compositeCode: workedExample.code["price-orders"].trimEnd(),
    cases: json(workedExample.cases["price-orders/price-order"]),
    granularity: Object.entries(GRANULARITY).map(([level, text]) => `- **${level}**: ${text}`).join("\n"),
  });
}

/** AGENTS.md as first created. Codex reads this file. */
export const AGENTS_SCAFFOLD = `# Agent instructions

This folder is a Fragmentor project. Before changing anything, read \`FRAGMENTOR.md\`. It explains how the project is laid out, the rules blocks and wires follow, and how to check your work with \`fragmentor check\` and \`fragmentor test\`.

The system's architecture is in \`fragmentor.json\` and the \`block.json\` files under \`blocks/\`.

<!-- Add instructions specific to this project below. Fragmentor never changes this file once it exists. -->
`;

/** CLAUDE.md as first created. Claude Code reads this file and follows its @-imports. */
export const CLAUDE_SCAFFOLD = `@FRAGMENTOR.md
@AGENTS.md
`;
