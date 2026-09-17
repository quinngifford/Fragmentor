import { readFileSync } from "node:fs";
import type { Mode } from "../model/block.js";
import { CAPABILITIES } from "../model/capabilities.js";
import { ARCHITECTURE_ROLES, ROLES } from "../model/roles.js";
import { getPack, isKnownLanguage, knownLanguages } from "../lang/index.js";
import type { LanguagePack } from "../lang/index.js";
import type { Manifest } from "../project/project.js";

/**
 * What a coding agent needs to know to work in a Fragmentor project.
 *
 * Fragmentor does not call a model. An agent such as Claude Code or Codex
 * works in the project folder, and this is how it learns the rules. It is
 * written for the one project it sits in — its mode, its language and its
 * granularity — so it says only what applies there. It is kept apart from the
 * project's own architecture, which stays machine-readable in fragmentor.json
 * and the block.json files.
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

const PRICE_ORDERS_WIRES = [
  "input.path -> load-orders.path",
  "load-orders.orders -> price-order.order",
  "price-order.total -> sum-totals.totals",
  "price-order.total -> output.totals",
  "sum-totals.sum -> output.grandTotal",
];

/** A small structured system, as the files an agent writes to build it. */
export const workedExample = {
  manifest: {
    name: "Order Pricer",
    goal: "Read a file of orders and report what each order costs and what they cost altogether.",
    mode: "structured",
    existingCode: false,
    start: "build",
    language: "typescript",
    granularity: { level: 3, maxDepth: 4 },
    systems: [{ rootBlock: "price-orders" }],
  },
  blocks: {
    "price-orders": {
      responsibility: "Read orders from a file and return what each one costs and the grand total.",
      inputs: { path: { type: "string", description: "The JSON file holding the orders." } },
      outputs: { totals: "number[]", grandTotal: "number" },
      capabilities: { files: "FileSystem" },
      children: ["load-orders", { block: "price-order", each: "order" }, "sum-totals"],
      wires: PRICE_ORDERS_WIRES,
    },
    "price-orders/load-orders": {
      responsibility: "Read the orders file and parse it into orders.",
      inputs: { path: "string" },
      outputs: { orders: `${ORDER}[]` },
      capabilities: { files: "FileSystem" },
    },
    "price-orders/price-order": {
      responsibility: "Add up one order: each line's quantity times its unit price.",
      inputs: { order: ORDER },
      outputs: { total: "number" },
    },
    "price-orders/sum-totals": {
      responsibility: "Add the order totals together.",
      inputs: { totals: "number[]" },
      outputs: { sum: "number" },
    },
  } as Record<string, Record<string, unknown>>,
  /** The one leaf the guide shows written, in each language. */
  leafCode: {
    typescript: `import type { PriceOrderInput, PriceOrderOutput, PriceOrderCaps } from "./contract.js";

/** Add up one order: each line's quantity times its unit price. */
export async function priceOrder(input: PriceOrderInput, caps: PriceOrderCaps): Promise<PriceOrderOutput> {
  const total = input.order.lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0);
  return { total };
}
`,
    python: `from contract import PriceOrderInput, PriceOrderOutput, PriceOrderCaps


async def price_order(value: PriceOrderInput, caps: PriceOrderCaps) -> PriceOrderOutput:
    """Add up one order: each line's quantity times its unit price."""
    total = sum(line.quantity * line.unit_price for line in value.order.lines)
    return PriceOrderOutput(total=total)
`,
  } as Record<string, string>,
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
    exposes: {
      orders: { type: "{ id: string; owner: string; total: number }", description: "One row per order." },
      owners: "{ id: string; email: string }",
    },
  },
  billing: {
    role: "external",
    subtype: "payment provider",
    responsibility: "Someone else's payment service. We cannot see inside it.",
    exposes: { charge: { accepts: "{ orderId: string; amount: number }", returns: "{ receipt: string }" } },
  },
  "load-orders": {
    responsibility: "Read one owner's orders.",
    inputs: { owner: "string" },
    outputs: { orders: "{ id: string; total: number }[]" },
    access: ["reads orders-db.orders"],
  },
};

/** The same program in a visual project, drawn over code that already exists in `src/pricing.ts`. */
export const visualExample: Record<string, Record<string, unknown>> = {
  "price-orders": {
    responsibility: "Read orders from a file and report what each one costs and the grand total.",
    code: "src/pricing.ts#priceOrders",
    inputs: { path: "string" },
    outputs: { totals: "number[]", grandTotal: "number" },
    capabilities: { files: "FileSystem" },
    children: ["load-orders", { block: "price-order", each: "order" }, "sum-totals"],
    wires: PRICE_ORDERS_WIRES,
  },
  "price-orders/price-order": {
    responsibility: "Add up one order: each line's quantity times its unit price.",
    code: "src/pricing.ts#priceOrder",
    inputs: { order: "Order" },
    outputs: { total: "number" },
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
const GRANULARITY: Record<Mode, Record<number, string>> = {
  structured: {
    1: "Try to split a block only where it plainly holds separate responsibilities, into two or three substantial children, with real work left inside each.",
    2: "Try for two to four children per block, each a substantial piece of work.",
    3: "Try for three to five children per block, each with one clear responsibility and somewhere around 30 to 80 lines of code.",
    4: "Try for four to six fairly small children per block, of somewhere around 20 to 50 lines of code each.",
    5: "Try to break the work into small single-purpose children of somewhere around 10 to 30 lines, though never one that is a single expression.",
  },
  visual: {
    1: "Try to show only the program's major parts: two or three children per block.",
    2: "Try for two to four children per block, each a substantial part of the program.",
    3: "Try for three to five children per block, each with one clear job, down to functions of somewhere around 30 to 80 lines.",
    4: "Try for four to six children per block, down to functions of somewhere around 20 to 50 lines.",
    5: "Try to show the code in fine detail, down to small single-purpose functions.",
  },
};

/** What a block may import, which differs by language. */
const IMPORT_RULES: Record<string, string> = {
  typescript:
    "A block may import types with `import type`, and packages installed in the project folder. It may not import another block's code, a shared helper file, or one of Node's built-in modules such as `fs`: use a capability, or add a block. `fragmentor check` reports any such import.",
  python: "A block may import its contract and packages installed for the project. It reaches files and the network only through its capabilities.",
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

function rolesSection(): string {
  return ARCHITECTURE_ROLES.map((role) => {
    const examples = ROLES[role].subtypes;
    const like = examples.length > 0 ? ` Subtypes: ${examples.map((each) => `\`${each}\``).join(", ")}.` : "";
    return `- **\`"${role}"\`** — ${ROLES[role].description}${like}`;
  }).join("\n");
}

function capabilitiesSection(pack: LanguagePack): string {
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
  const suggestLanguage = manifest.language === undefined && manifest.mode === "structured";
  return {
    name: workedExample.manifest.name,
    goal: workedExample.manifest.goal,
    mode: manifest.mode,
    existingCode: manifest.existingCode,
    start: manifest.start,
    ...(manifest.language === undefined ? {} : { language: manifest.language }),
    granularity: manifest.granularity,
    systems: [{ rootBlock: "price-orders", ...(suggestLanguage ? { language: "typescript" } : {}) }],
  };
}

const ENTRY_POINTS =
  "Entry points such as a `main` function, a server or framework setup stay outside `blocks/`: they create the real capabilities and call a system's top block.";

/**
 * Where this project starts, and whether it starts as a plan.
 *
 * The person answered both when they created it, so the guide states them
 * rather than asking the agent to work out which case it is in. An agent
 * follows an instruction better than a condition.
 */
function startingPoint(manifest: Manifest): string {
  const visual = manifest.mode === "visual";
  const parts: string[] = [];

  if (visual) {
    parts.push(
      manifest.existingCode
        ? "**This folder already held code**, and the diagram describes it."
        : "**This folder started empty.** Write the program however suits it best, laid out however you like, and keep the diagram describing what you actually wrote.",
    );
  } else {
    parts.push(
      manifest.existingCode
        ? `**This folder already held code**, and you are rebuilding it as blocks. First make sure it is committed to version control, and ask the person if it is not. Describe the program's existing structure as blocks, move its logic into them from the bottom up, and delete the old code once the blocks pass their tests. ${ENTRY_POINTS}`
        : `**This folder started empty**, so the program is yours to write from nothing. ${ENTRY_POINTS}`,
    );
  }

  if (manifest.start === "plan") {
    parts.push(
      visual
        ? '**This project starts as a plan.** Draw the architecture you mean to write as blocks with `"planned": true`, and show the person before you write any of it. Take `"planned"` off a block once its code exists and the block points at it.'
        : '**This project starts as a plan.** Give every block `"planned": true` to begin with, so the whole architecture can be seen and argued with before any of it is built. Once the person agrees, take `"planned"` off one block at a time and build that block, rather than starting all of them at once.',
    );
  }

  return parts.join("\n\n");
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
  return manifest.start === "plan"
    ? "Show the person the diagram and wait for them to agree before you write any code. This project starts as a plan, so the architecture is theirs to settle first."
    : "Carry straight on to the code. They can watch the diagram fill in as you work, and will say if they want the shape changed, so do not stop to ask for agreement.";
}

function structuredLanguageRule(manifest: Manifest, pack: LanguagePack): string {
  if (manifest.language === undefined) {
    const choices = knownLanguages()
      .map(({ id, displayName }) => {
        const each = getPack(id);
        return `\`"${id}"\` (${each.canRun ? "Fragmentor checks and runs it" : `Fragmentor generates its types but cannot run ${displayName} yet`})`;
      })
      .join(" or ");
    return `The person left the language to you: give each system a \`"language"\`, ${choices}. The examples below are ${pack.displayName}; in another language the file names and naming conventions follow that language.`;
  }
  if (!isKnownLanguage(manifest.language)) {
    return `The project is set to \`${manifest.language}\`, which Fragmentor cannot generate code for. Ask the person to choose one of ${knownLanguages().map(({ id }) => `\`${id}\``).join(" or ")}.`;
  }
  return `The person chose ${pack.displayName}, so every system is written in it.`;
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`The agent guide refers to {{${name}}}, which nothing fills in.`);
    return value;
  });
}

function template(mode: Mode): string {
  // Read on each call, from beside this module, so the compiled application
  // finds its copy the same way the kernel finds the original.
  return readFileSync(new URL(`./guide-${mode}.md`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
}

export function agentGuide(manifest: Manifest): string {
  const common = {
    manifest: compactJson(exampleManifest(manifest)),
    level: String(manifest.granularity.level),
    granularity: GRANULARITY[manifest.mode][manifest.granularity.level]!,
    maxDepth: String(manifest.granularity.maxDepth),
    roles: rolesSection(),
    architectureBlock: compactJson(architectureExample["orders-db"]),
    operationEntry: compactJson((architectureExample.billing!.exposes as Record<string, unknown>).charge),
    accessBlock: compactJson(architectureExample["load-orders"]),
  };

  if (manifest.mode === "visual") {
    return fill(template("visual"), {
      ...common,
      languageRule: manifest.language === undefined
        ? " A system may say what its code is written in with `\"language\"`."
        : ` The code is written in ${manifest.language}.`,
      startingPoint: startingPoint(manifest),
      compositeBlock: compactJson(visualExample["price-orders"]),
      leafBlock: compactJson(visualExample["price-orders/price-order"]),
    });
  }

  const pack = getPack(manifest.language !== undefined && isKnownLanguage(manifest.language) ? manifest.language : "typescript");
  return fill(template("structured"), {
    ...common,
    languageRule: structuredLanguageRule(manifest, pack),
    reviewStep: reviewStep(manifest),
    startingPoint: startingPoint(manifest),
    implFile: pack.implFile,
    contractFile: pack.contractFile,
    capabilitiesFile: pack.capabilitiesFile,
    compositeBlock: compactJson(workedExample.blocks["price-orders"]),
    leafBlock: compactJson(workedExample.blocks["price-orders/price-order"]),
    capabilities: capabilitiesSection(pack),
    codeLanguage: pack.id,
    leafCode: (workedExample.leafCode[pack.id] ?? "").trimEnd(),
    importRule: IMPORT_RULES[pack.id] ?? "",
    cases: compactJson(workedExample.cases["price-orders/price-order"]),
    testNote: pack.canRun ? "" : ` Fragmentor cannot run ${pack.displayName} yet, so \`fragmentor test\` skips these blocks.`,
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
