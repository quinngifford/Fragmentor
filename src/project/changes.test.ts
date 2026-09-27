import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { changesBetween, changesText } from "./changes.js";
import type { ProjectChanges } from "./changes.js";
import { projectSnapshot } from "./snapshot.js";
import type { ProjectSnapshot, SnapshotAccess, SnapshotBlock, SnapshotCode, SnapshotExecution, SnapshotPort } from "./snapshot.js";
import { accessFields, blockFields, codeFields, executionFields, portFields, projectFields } from "./snapshotFields.js";
import type { FieldTable } from "./snapshotFields.js";

/**
 * Changes are compared between snapshots Fragmentor really takes, of projects
 * written for each test, so what is compared is what the window would hold.
 */

const examples = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "examples");

const made: string[] = [];

afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A project's files, by path: text as it is, anything else as JSON. */
type Files = Record<string, unknown>;

async function snapshotOf(files: Files): Promise<ProjectSnapshot> {
  const dir = await mkdtemp(path.join(tmpdir(), "fragmentor-changes-"));
  made.push(dir);
  for (const [file, content] of Object.entries(files)) {
    if (content === undefined) continue;
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), typeof content === "string" ? content : JSON.stringify(content, null, 2), "utf8");
  }
  return projectSnapshot(dir);
}

const checkout = {
  responsibility: "Take an order and write it down.",
  code: "src/checkout.ts#checkout",
  inputs: { cart: "{ items: string[]; total: number }" },
  outputs: { ok: "boolean" },
  access: ["writes shop-db.orders", "calls pricing/price"],
};

/** A small shop: a checkout, two prices in one file, and a database. */
const shop: Files = {
  "fragmentor.json": { name: "Shop", granularity: { level: 3, maxDepth: 6 }, systems: [{ rootBlock: "shop", language: "typescript" }] },
  "blocks/shop/block.json": { role: "component", responsibility: "Sell things." },
  "blocks/shop/api/block.json": { role: "component", responsibility: "Answer the page." },
  "blocks/shop/api/checkout/block.json": checkout,
  "blocks/shop/api/pricing/block.json": { role: "component", responsibility: "Say what things cost." },
  "blocks/shop/api/pricing/price/block.json": { responsibility: "Price an item.", code: "src/pricing.ts#price", inputs: { item: "string" }, outputs: { price: "number" } },
  "blocks/shop/api/pricing/discount/block.json": {
    responsibility: "Take some off.",
    code: "src/pricing.ts#discount",
    inputs: { price: "number" },
    outputs: { price: "number" },
  },
  "blocks/shop/shop-db/block.json": {
    role: "database",
    responsibility: "Every order.",
    exposes: { orders: { type: "{ id: string; total: number }", description: "One row per order." } },
  },
  "src/checkout.ts": "export function checkout() {}\n",
  "src/pricing.ts": "export function price() {}\nexport function discount() {}\n",
  "executions/buy.json": {
    trigger: { at: "shop/api/checkout", kind: "action", description: "Someone buys what is in their cart.", code: "src/checkout.ts#checkout" },
    trace: [
      { from: "shop/api/checkout", to: "shop/api/pricing/price", kind: "call", description: "It prices the cart.", code: "src/checkout.ts#checkout" },
      { from: "shop/api/checkout", to: "shop/shop-db.orders", kind: "write", description: "It writes the order down.", code: "src/checkout.ts#checkout" },
    ],
  },
};

/** The shop with some files changed, moved or taken away. */
function shopWith(changes: Files, moved: Record<string, string> = {}): Files {
  const files: Files = {};
  for (const [file, content] of Object.entries(shop)) {
    const from = Object.keys(moved).find((each) => file === each || file.startsWith(`${each}/`));
    files[from === undefined ? file : `${moved[from]}${file.slice(from.length)}`] = content;
  }
  return { ...files, ...changes };
}

const find = (changes: ProjectChanges, blockPath: string) => changes.blocks.find((each) => each.path === blockPath);
const kinds = (changes: ProjectChanges) => changes.blocks.map((each) => [each.kind, each.path]);

describe("what changed between two snapshots", () => {
  let before: ProjectSnapshot;
  beforeAll(async () => {
    before = await snapshotOf(shop);
  });

  it("is nothing when nothing changed", async () => {
    const changes = changesBetween(before, await snapshotOf(shop));
    expect(changes).toMatchObject({ blocks: [], executions: [] });
    expect(changesText(changes, "since the last commit")).toBe("No changes since the last commit.");
  });

  it("is everything, as new, from before the project existed", async () => {
    const changes = changesBetween(null, before);
    expect(changes.blocks.map((each) => each.kind)).toEqual(Object.keys(before.blocks).map(() => "new"));
    expect(changes.executions).toMatchObject([{ id: "buy", kind: "new" }]);
    expect(changesText(changes, "since before the first commit")).toContain("Changes since before the first commit:\n\nNew\n  shop  Shop");
  });

  it("calls a block renamed with its code a move, saying how it knows", async () => {
    const renamed = shopWith(
      { "blocks/shop/api/checkout/block.json": { ...checkout, access: ["writes shop-db.orders", "calls pricing/cost"] } },
      { "blocks/shop/api/pricing/price": "blocks/shop/api/pricing/cost" },
    );
    const changes = changesBetween(before, await snapshotOf(renamed));

    expect(find(changes, "shop/api/pricing/cost")).toMatchObject({
      kind: "moved",
      from: "shop/api/pricing/price",
      by: "same code: src/pricing.ts#price",
      lines: ['renamed "Cost", was "Price"'],
    });
    // Its caller's words changed; what they reach did not.
    expect(find(changes, "shop/api/checkout")?.lines).toEqual(['access "calls pricing/price" reworded as "calls pricing/cost", same target']);
    expect(changes.pairs["shop/api/pricing/cost"]).toBe("shop/api/pricing/price");
    // The execution still passes through the same block, now called by its new path.
    const execution = (shop["executions/buy.json"] as { trigger: unknown; trace: { to: string }[] });
    const moved = { ...execution, trace: execution.trace.map((step) => ({ ...step, to: step.to.replace("pricing/price", "pricing/cost") })) };
    expect(changesBetween(before, await snapshotOf({ ...renamed, "executions/buy.json": moved })).executions).toEqual([]);
    expect(changes.executions).toMatchObject([{ id: "buy", kind: "changed" }]);
  });

  it("reports a group that moved with its parts once, as the group", async () => {
    const changes = changesBetween(
      before,
      await snapshotOf(
        shopWith(
          { "blocks/shop/api/checkout/block.json": { ...checkout, access: ["writes shop-db.orders", "calls prices/price"] } },
          { "blocks/shop/api/pricing": "blocks/shop/api/prices" },
        ),
      ),
    );
    // The group points at no code, so nothing pairs it but its parts' code:
    // they are moved, the group removed and made new, which is honest.
    expect(kinds(changes)).toEqual([
      ["changed", "shop/api"],
      ["changed", "shop/api/checkout"],
      ["new", "shop/api/prices"],
      ["moved", "shop/api/prices/discount"],
      ["moved", "shop/api/prices/price"],
      ["removed", "shop/api/pricing"],
    ]);
    expect(find(changes, "shop/api")).toMatchObject({ removedParts: 1, lines: ["part removed: Pricing"] });
    expect(find(changes, "shop/api/pricing")).toMatchObject({ removedParts: 0, lines: [] });

    // A group that keeps its name where it moves carries its parts, which are not listed again.
    const carried = changesBetween(
      before,
      await snapshotOf(
        shopWith(
          { "blocks/shop/api/checkout/block.json": { ...checkout, access: ["writes shop-db.orders", "calls shop/pricing/price"] } },
          { "blocks/shop/api/pricing": "blocks/shop/pricing" },
        ),
      ),
    );
    expect(kinds(carried)).toEqual([
      ["changed", "shop/api/checkout"],
      ["moved", "shop/pricing"],
    ]);
    expect(find(carried, "shop/pricing")).toMatchObject({ from: "shop/api/pricing", by: "same name" });
    expect(carried.pairs["shop/pricing/price"]).toBe("shop/api/pricing/price");
  });

  it("knows a system renamed by its parts, and only then", async () => {
    const renamed = shopWith({}, { "blocks/shop": "blocks/store" });
    renamed["fragmentor.json"] = { ...(shop["fragmentor.json"] as object), systems: [{ rootBlock: "store", language: "typescript" }] };
    const execution = shop["executions/buy.json"] as { trigger: { at: string }; trace: { from: string; to: string }[] };
    const store = (address: string) => address.replace(/^shop\//, "store/");
    renamed["executions/buy.json"] = {
      ...execution,
      trigger: { ...execution.trigger, at: store(execution.trigger.at) },
      trace: execution.trace.map((step) => ({ ...step, from: store(step.from), to: store(step.to) })),
    };
    const changes = changesBetween(before, await snapshotOf(renamed));
    expect(changes.blocks).toEqual([
      { path: "store", name: "Store", kind: "moved", built: false, from: "shop", by: "its parts went with it", removedParts: 0, lines: ['renamed "Store", was "Shop"'] },
    ]);
    expect(changes.executions).toEqual([]);

    // A system with nothing of the old one in it is another system.
    const replaced = changesBetween(
      before,
      await snapshotOf({
        "fragmentor.json": { name: "Shop", granularity: { level: 3 }, systems: [{ rootBlock: "store", language: "typescript" }] },
        "blocks/store/block.json": { role: "component", responsibility: "Sell other things." },
      }),
    );
    expect(kinds(replaced)).toEqual([
      ["removed", "shop"],
      ["new", "store"],
    ]);
  });

  it("follows a database into a new group, with its readers reworded and its executions unchanged", async () => {
    const execution = shop["executions/buy.json"] as { trace: { to: string }[] };
    const changes = changesBetween(
      before,
      await snapshotOf(
        shopWith(
          {
            "blocks/shop/infrastructure/block.json": { role: "component", responsibility: "What the shop runs on." },
            "blocks/shop/api/checkout/block.json": { ...checkout, access: ["writes infrastructure/shop-db.orders", "calls pricing/price"] },
            "executions/buy.json": { ...execution, trace: execution.trace.map((step) => ({ ...step, to: step.to.replace("shop/shop-db", "shop/infrastructure/shop-db") })) },
          },
          { "blocks/shop/shop-db": "blocks/shop/infrastructure/shop-db" },
        ),
      ),
    );
    expect(kinds(changes)).toEqual([
      ["changed", "shop/api/checkout"],
      ["new", "shop/infrastructure"],
      ["moved", "shop/infrastructure/shop-db"],
    ]);
    expect(find(changes, "shop/infrastructure/shop-db")).toMatchObject({ by: "same name", lines: [] });
    expect(find(changes, "shop/api/checkout")?.lines).toEqual([
      'access "writes shop-db.orders" reworded as "writes infrastructure/shop-db.orders", same target',
    ]);
    expect(changes.executions).toEqual([]);
  });

  it("leaves blocks unpaired where the evidence fits more than one", async () => {
    // Both prices point at one function, and both moved and were renamed: neither is guessed at.
    const twins = { ...shop };
    twins["blocks/shop/api/pricing/discount/block.json"] = {
      responsibility: "Take some off.",
      code: "src/pricing.ts#price",
      inputs: { price: "number" },
      outputs: { price: "number" },
    };
    const then = await snapshotOf(twins);
    const now = await snapshotOf(
      shopWith(
        { "blocks/shop/api/cost/block.json": twins["blocks/shop/api/pricing/discount/block.json"] },
        { "blocks/shop/api/pricing/price": "blocks/shop/api/value", "blocks/shop/api/pricing/discount": "blocks/shop/api/cost" },
      ),
    );
    const changes = changesBetween(then, now);
    expect(changes.blocks.filter((each) => each.kind === "moved")).toEqual([]);
    expect(kinds(changes)).toEqual(
      expect.arrayContaining([
        ["new", "shop/api/cost"],
        ["new", "shop/api/value"],
        ["changed", "shop/api/pricing"],
        ["removed", "shop/api/pricing/discount"],
        ["removed", "shop/api/pricing/price"],
      ]),
    );
    expect(find(changes, "shop/api/pricing")).toMatchObject({ removedParts: 2, lines: ["2 parts removed: Discount and Price"] });
  });

  it("does not count the order an object's fields are written in, and says a description changed only in words", async () => {
    const reordered = shopWith({
      "blocks/shop/api/checkout/block.json": { ...checkout, inputs: { cart: "{ total: number; items: string[] }" } },
    });
    expect(changesBetween(before, await snapshotOf(reordered)).blocks).toEqual([]);

    const described = shopWith({
      "blocks/shop/api/checkout/block.json": {
        ...checkout,
        inputs: { cart: { type: "{ items: string[]; total: number }", description: "What is being bought." } },
      },
    });
    expect(find(changesBetween(before, await snapshotOf(described)), "shop/api/checkout")?.lines).toEqual(["description of input cart changed"]);
  });

  it("says when a type changed, and when a column was added to a table", async () => {
    const changes = changesBetween(
      before,
      await snapshotOf(
        shopWith({
          "blocks/shop/api/checkout/block.json": { ...checkout, outputs: { ok: "boolean", id: "string" }, inputs: { cart: "{ items: string[]; total: string }" } },
          "blocks/shop/shop-db/block.json": {
            role: "database",
            responsibility: "Every order.",
            exposes: { orders: { type: "{ id: string; total: number; note?: string }", description: "One row per order." } },
          },
        }),
      ),
    );
    expect(find(changes, "shop/api/checkout")?.lines).toEqual([
      "input cart is now { items: string[]; total: string }, was { items: string[]; total: number }",
      "output id added: string",
    ]);
    expect(find(changes, "shop/shop-db")?.lines).toEqual(["orders: field note added: string, optional"]);
  });

  it("tells a block pointed at other code from its code being changed, and names the others sharing a file", async () => {
    const changes = changesBetween(
      before,
      await snapshotOf(
        shopWith({
          "blocks/shop/api/checkout/block.json": { ...checkout, code: "src/buy.ts#checkout" },
          "src/buy.ts": "export function checkout() {}\n",
          "src/pricing.ts": "export function price() { return 1; }\nexport function discount() {}\n",
        }),
      ),
    );
    expect(find(changes, "shop/api/checkout")?.lines).toEqual(["now points at src/buy.ts#checkout, was src/checkout.ts#checkout"]);
    expect(find(changes, "shop/api/pricing/price")?.lines).toEqual(["code changed in src/pricing.ts, which Discount also points at"]);
    expect(find(changes, "shop/api/pricing/discount")?.lines).toEqual(["code changed in src/pricing.ts, which Price also points at"]);

    // A checkout that converts line endings is not a change to the code.
    const crlf = changesBetween(before, await snapshotOf(shopWith({ "src/pricing.ts": "export function price() {}\r\nexport function discount() {}\r\n" })));
    expect(crlf.blocks).toEqual([]);

    const gone = changesBetween(before, await snapshotOf(shopWith({ "src/checkout.ts": undefined })));
    expect(find(gone, "shop/api/checkout")?.lines).toEqual(["its code is not there any more: src/checkout.ts#checkout"]);
  });

  it("reports a group becoming a plan once, and a plan being built", async () => {
    const planned = changesBetween(
      before,
      await snapshotOf(shopWith({ "blocks/shop/api/pricing/block.json": { role: "component", responsibility: "Say what things cost.", planned: true } })),
    );
    // Its parts are planned only because it is, and their code is no longer followed: neither is a change of theirs.
    expect(kinds(planned)).toEqual([["changed", "shop/api/pricing"]]);
    expect(planned.blocks[0]!.lines).toEqual(["now planned, and nothing of it is built or run"]);

    const built = changesBetween(await snapshotOf(shopWith({ "blocks/shop/api/pricing/block.json": { role: "component", responsibility: "Say what things cost.", planned: true } })), before);
    expect(built.blocks).toMatchObject([{ path: "shop/api/pricing", kind: "changed", built: true, lines: [] }]);
    expect(changesText(built, "since then")).toBe("Changes since then:\n\nBuilt\n  shop/api/pricing  Pricing");
  });

  it("says where an execution first differs, and how many steps it has", async () => {
    const execution = shop["executions/buy.json"] as { trace: object[] };
    const inserted = {
      ...execution,
      trace: [{ from: "shop/api/checkout", to: "shop/shop-db.orders", kind: "read", description: "It looks for the order first.", code: "src/checkout.ts#checkout" }, ...execution.trace],
    };
    const changes = changesBetween(before, await snapshotOf(shopWith({ "executions/buy.json": inserted })));
    expect(changes.executions).toEqual([
      { id: "buy", name: "Buy", kind: "changed", trigger: "Someone buys what is in their cart.", lines: ["3 → 4 steps, first different at step 2"] },
    ]);
    expect(changesText(changes, "since then")).toContain("buy  Buy: changed, set going by Someone buys what is in their cart.\n      3 → 4 steps, first different at step 2");

    // What travelled is not what the execution does.
    const payload = { ...execution, trace: execution.trace.map((step) => ({ ...step, payload: { items: ["tea"] } })) };
    expect(changesBetween(before, await snapshotOf(shopWith({ "executions/buy.json": payload }))).executions).toEqual([]);

    const removed = changesBetween(before, await snapshotOf(shopWith({ "executions/buy.json": undefined })));
    expect(removed.executions).toMatchObject([{ id: "buy", kind: "removed" }]);
  });
});

describe("saved tests and what Fragmentor runs", () => {
  let tickets: ProjectSnapshot;
  beforeAll(async () => {
    tickets = await projectSnapshot(path.join(examples, "tickets"));
  });

  const priceSeat = "tickets/booking-api/pricing/price-seat";
  const withBlock = (blockPath: string, change: (block: SnapshotBlock) => void): ProjectSnapshot => {
    const copy = structuredClone(tickets);
    change(copy.blocks[blockPath]!);
    return copy;
  };

  it("lists tests added, changed and removed, by name", () => {
    const then = withBlock(priceSeat, (block) => {
      block.cases = [
        { ...block.cases[0]!, expected: { price: 1 } },
        { name: "an old test", input: {} },
      ];
    });
    const lines = find(changesBetween(then, tickets), priceSeat)?.lines;
    expect(lines).toEqual([`test changed: "${tickets.blocks[priceSeat]!.cases[0]!.name}"`, ...tickets.blocks[priceSeat]!.cases.slice(1).map((each) => `test added: "${each.name}"`), 'test removed: "an old test"']);
  });

  it("says when Fragmentor starts or stops running a block, and why", () => {
    const then = withBlock(priceSeat, (block) => {
      block.runnable = false;
      block.cases = [];
      block.drawnBecause = "it does not import its contract";
    });
    expect(find(changesBetween(then, tickets), priceSeat)?.lines).toEqual(["Fragmentor runs it now"]);
    expect(find(changesBetween(tickets, then), priceSeat)?.lines).toEqual(["Fragmentor no longer runs it: it does not import its contract"]);
  });
});

describe("the fields a change is made of", () => {
  let tickets: ProjectSnapshot;
  beforeAll(async () => {
    tickets = await projectSnapshot(path.join(examples, "tickets"));
  });

  const priceSeat = "tickets/booking-api/pricing/price-seat";
  const findEvent = "tickets/booking-api/find-event";
  const reported = (then: ProjectSnapshot) => {
    const changes = changesBetween(then, tickets);
    return changes.blocks.length + changes.executions.length > 0;
  };
  /** A change to each field of a block, made to the older side, so the table says whether it is a change. */
  const blockEdits: { [K in keyof SnapshotBlock]-?: (then: ProjectSnapshot) => void } = {
    path: (then) => {
      then.blocks[`${priceSeat}-before`] = { ...then.blocks[priceSeat]!, path: `${priceSeat}-before` };
      delete then.blocks[priceSeat];
    },
    id: (then) => (then.blocks[findEvent]!.id = "other"),
    name: (then) => (then.blocks[findEvent]!.name = "Other"),
    responsibility: (then) => (then.blocks[findEvent]!.responsibility = "Something else."),
    role: (then) => (then.blocks[findEvent]!.role = "service"),
    subtype: (then) => (then.blocks[findEvent]!.subtype = "Lambda"),
    roleLabel: (then) => (then.blocks[findEvent]!.roleLabel = "SERVICE"),
    architecture: (then) => (then.blocks[findEvent]!.architecture = true),
    planned: (then) => (then.blocks[findEvent]!.planned = true),
    functionName: (then) => (then.blocks[findEvent]!.functionName = "other"),
    inputs: (then) => (then.blocks[findEvent]!.inputs = []),
    outputs: (then) => (then.blocks[findEvent]!.outputs = []),
    exposes: (then) => (then.blocks["tickets/tickets-db"]!.exposes = []),
    access: (then) => (then.blocks[findEvent]!.access = []),
    capabilities: (then) => (then.blocks[findEvent]!.capabilities = []),
    stores: (then) => (then.blocks[findEvent]!.stores = []),
    children: (then) => (then.blocks["tickets/booking-api"]!.children = []),
    sources: (then) => (then.blocks[priceSeat]!.sources = { code: "other", contract: null }),
    language: (then) => (then.blocks[findEvent]!.language = "python"),
    files: (then) => (then.blocks[findEvent]!.files = { code: "other.ts", contract: "" }),
    implemented: (then) => (then.blocks[priceSeat]!.implemented = false),
    runnable: (then) => (then.blocks[priceSeat]!.runnable = false),
    drawnBecause: (then) => (then.blocks[priceSeat]!.drawnBecause = "some reason"),
    cases: (then) => (then.blocks[priceSeat]!.cases = []),
    code: (then) => (then.blocks[priceSeat]!.code = { ...then.blocks[priceSeat]!.code!, hash: "0" }),
  };
  const codeEdits: { [K in keyof SnapshotCode]-?: (code: SnapshotCode) => void } = {
    pointer: (code) => (code.pointer = "src/other.ts#priceSeat"),
    file: (code) => (code.file = "src/other.ts"),
    line: (code) => (code.line = 99),
    excerpt: (code) => (code.excerpt = "other"),
    excerptStart: (code) => (code.excerptStart = 99),
    hash: (code) => (code.hash = "0"),
  };
  const portEdits: { [K in keyof SnapshotPort]-?: (port: SnapshotPort) => void } = {
    name: (port) => (port.name = "other"),
    type: (port) => (port.type = "other"),
    typeIr: (port) => (port.typeIr = { kind: "boolean" }),
    description: (port) => (port.description = "Something else."),
  };
  const accessEdits: { [K in keyof SnapshotAccess]-?: (access: SnapshotAccess) => void } = {
    text: (access) => (access.text = "events reads the-db.events"),
    from: (access) => (access.from = "other"),
    verb: (access) => (access.verb = "writes"),
    resource: (access) => (access.resource = "other"),
    resourcePath: (access) => (access.resourcePath = "tickets/box-office"),
    resourceName: (access) => (access.resourceName = "Other"),
    entry: (access) => (access.entry = "other"),
  };
  const executionEdits: { [K in keyof SnapshotExecution]-?: (execution: SnapshotExecution) => void } = {
    id: (execution) => (execution.id = "other"),
    name: (execution) => (execution.name = "Other"),
    description: (execution) => (execution.description = "Something else."),
    trigger: (execution) => (execution.trigger = { ...execution.trigger, at: "tickets/booking-api" }),
    declared: (execution) => (execution.declared = null),
    expects: (execution) => (execution.expects = !execution.expects),
  };
  const projectEdits: { [K in keyof ProjectSnapshot]-?: (then: ProjectSnapshot) => void } = {
    dir: (then) => (then.dir = "elsewhere"),
    name: (then) => (then.name = "Other"),
    goal: (then) => (then.goal = "Something else."),
    existingCode: (then) => (then.existingCode = !then.existingCode),
    start: (then) => (then.start = "plan"),
    language: (then) => (then.language = "python"),
    granularity: (then) => (then.granularity = { level: 1, maxDepth: 2 }),
    systems: (then) => (then.systems = []),
    blocks: (then) => delete then.blocks[findEvent],
    executions: (then) => (then.executions = then.executions.slice(1)),
    notes: (then) => (then.notes = []),
    diagnostics: (then) => (then.diagnostics = [{ severity: "error", blockPath: findEvent, message: "Wrong." }]),
  };

  /** Edits to one part of the older side, made to whichever snapshot they are given. */
  function on<T>(part: (then: ProjectSnapshot) => T, edits: { [K in keyof T]-?: (value: T) => void }): { [K in keyof T]-?: (then: ProjectSnapshot) => void } {
    return Object.fromEntries(
      Object.entries(edits).map(([field, edit]) => [field, (then: ProjectSnapshot) => (edit as (value: T) => void)(part(then))]),
    ) as { [K in keyof T]-?: (then: ProjectSnapshot) => void };
  }

  /** Each field the table says is compared is a change, and each it says is ignored is not. */
  function holdsTo<T>(table: FieldTable<T>, edits: { [K in keyof T]-?: (then: ProjectSnapshot) => void }) {
    for (const [field, use] of Object.entries(table) as [keyof T & string, { change: string }][]) {
      const then = structuredClone(tickets);
      edits[field](then);
      expect({ field, reported: reported(then) }).toEqual({ field, reported: use.change === "compared" });
    }
  }

  it("covers every field a snapshot has", () => {
    const block = tickets.blocks[priceSeat]!;
    expect(Object.keys(blockFields).sort()).toEqual(Object.keys(block).sort());
    expect(Object.keys(codeFields).sort()).toEqual(Object.keys(block.code!).sort());
    expect(Object.keys(portFields).sort()).toEqual(Object.keys(block.inputs[0]!).sort());
    expect(Object.keys(accessFields).sort()).toEqual(Object.keys(tickets.blocks[findEvent]!.access[0]!).sort());
    expect(Object.keys(executionFields).sort()).toEqual(Object.keys(tickets.executions[0]!).sort());
    expect(Object.keys(projectFields).sort()).toEqual(Object.keys(tickets).sort());
  });

  it("compares exactly the fields the inventory says it compares", () => {
    holdsTo(projectFields, projectEdits);
    holdsTo(blockFields, blockEdits);
    holdsTo(codeFields, on<SnapshotCode>((then) => then.blocks[priceSeat]!.code!, codeEdits));
    holdsTo(portFields, on<SnapshotPort>((then) => then.blocks[priceSeat]!.inputs[0]!, portEdits));
    holdsTo(accessFields, on<SnapshotAccess>((then) => then.blocks[findEvent]!.access[0]!, accessEdits));
    holdsTo(executionFields, on<SnapshotExecution>((then) => then.executions[0]!, executionEdits));
    // An untouched copy is no change, so each edit above is what was reported.
    expect(reported(structuredClone(tickets))).toBe(false);
  });
});
