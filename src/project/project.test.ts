import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  blockDir,
  createProject,
  loadProject,
  locateCode,
  resolveAccess,
  validateProject,
  writeBlock,
} from "./project.js";
import type { Manifest } from "./project.js";
import type { Block } from "../model/block.js";
import { makeBlock, t } from "../model/testing.js";

let dir: string;

const manifest: Manifest = {
  name: "Job Ranker",
  goal: "Rank job postings against a profile.",
  existingCode: false,
  start: "build",
  granularity: { level: 3, maxDepth: 4 },
  systems: [{ rootBlock: "rank-jobs", language: "typescript" }],
};

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "fragmentor-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const writeManifestJson = (value: unknown) => writeFile(path.join(dir, "fragmentor.json"), JSON.stringify(value), "utf8");

/** A component holding one function that scores a posting. */
async function writeSmallProject() {
  const root = makeBlock({ id: "rank-jobs", name: "Rank Jobs", role: "component" });

  const child = makeBlock({
    id: "score-posting",
    code: "src/score-posting.ts#scorePosting",
    inputs: { posting: { type: t.object({ title: t.string }) } },
    outputs: { score: { type: t.number } },
  });

  await createProject(dir, manifest, [root]);
  await writeBlock(blockDir(dir, "rank-jobs/score-posting"), child);
}

describe("project round trip", () => {
  it("writes a project and reads back the same hierarchy", async () => {
    await writeSmallProject();
    const project = await loadProject(dir);

    expect(project.manifest).toEqual(manifest);
    expect(project.systems[0]!.root.block.id).toBe("rank-jobs");
    expect(project.systems[0]!.root.children.map((c) => c.path)).toEqual(["rank-jobs/score-posting"]);
    expect([...project.byPath.keys()].sort()).toEqual(["rank-jobs", "rank-jobs/score-posting"]);
  });

  it("finds no problems with a consistent project", async () => {
    await writeSmallProject();
    expect(validateProject(await loadProject(dir))).toEqual([]);
  });

  it("reports a block pinned as a leaf that has been given parts", async () => {
    await writeSmallProject();
    await writeBlock(blockDir(dir, "rank-jobs"), makeBlock({ id: "rank-jobs", name: "Rank Jobs", role: "component", pinnedAsLeaf: true }));

    expect(validateProject(await loadProject(dir)).map((d) => d.message)).toEqual([
      expect.stringContaining('"Rank Jobs" is pinned as a leaf, but it has been given parts inside it.'),
    ]);
  });

  it("ignores folders that are not blocks, so build artefacts do not break it", async () => {
    await writeSmallProject();

    // Exactly what `python -m compileall` leaves next to a generated file.
    await mkdir(path.join(blockDir(dir, "rank-jobs/score-posting"), "__pycache__"), { recursive: true });
    await writeFile(
      path.join(blockDir(dir, "rank-jobs/score-posting"), "__pycache__", "block.json"),
      "not a block at all",
      "utf8",
    );
    // A directory named like a block but holding none is not one either.
    await mkdir(path.join(blockDir(dir, "rank-jobs"), "notes"), { recursive: true });

    const project = await loadProject(dir);
    expect([...project.byPath.keys()].sort()).toEqual(["rank-jobs", "rank-jobs/score-posting"]);
    expect(validateProject(project)).toEqual([]);
  });

  it("gives a block the id of its folder, and a name made from it unless the file gives one", async () => {
    await writeSmallProject();
    await mkdir(blockDir(dir, "rank-jobs/extra-step"), { recursive: true });
    await writeFile(path.join(blockDir(dir, "rank-jobs/extra-step"), "block.json"), JSON.stringify({ responsibility: "x" }), "utf8");

    const block = (await loadProject(dir)).byPath.get("rank-jobs/extra-step")!.block;
    expect(block.id).toBe("extra-step");
    expect(block.name).toBe("Extra Step");
  });

  it("warns about a block deeper than the project allows", async () => {
    await writeSmallProject();
    await writeManifestJson({ ...manifest, granularity: { level: 3, maxDepth: 1 } });

    expect(validateProject(await loadProject(dir))).toEqual([
      {
        severity: "warning",
        blockPath: "rank-jobs/score-posting",
        message: '"score-posting" is 2 levels deep, but the project allows at most 1 (granularity.maxDepth in fragmentor.json).',
      },
    ]);
  });

  it("says why a block file could not be read", async () => {
    await writeSmallProject();
    await writeFile(path.join(blockDir(dir, "rank-jobs/score-posting"), "block.json"), "{ not json", "utf8");

    await expect(loadProject(dir)).rejects.toThrow(/Could not read the block definition at .*block\.json: .*JSON/s);
  });

  it("explains what is wrong with an invalid block file", async () => {
    await writeSmallProject();
    await writeFile(path.join(blockDir(dir, "rank-jobs/score-posting"), "block.json"), JSON.stringify({ name: "Score" }), "utf8");

    await expect(loadProject(dir)).rejects.toThrow(/responsibility/);
  });
});

describe("block paths", () => {
  it("refuse anything that could lead outside the blocks folder", () => {
    expect(() => blockDir(dir, "rank-jobs/../../../elsewhere")).toThrow(/is not a block path/);
    expect(() => blockDir(dir, "rank-jobs/..")).toThrow(/is not a block path/);
    expect(blockDir(dir, "rank-jobs/score-posting")).toBe(path.join(dir, "blocks", "rank-jobs", "score-posting"));
  });
});

describe("project settings", () => {
  it("may have no systems yet, while it waits for the agent to define them", async () => {
    await writeManifestJson({ name: "Waiting", granularity: { level: 2 } });

    const project = await loadProject(dir);
    expect(project.systems).toEqual([]);
    expect(project.manifest).toEqual({
      name: "Waiting",
      goal: "",
      existingCode: false,
      start: "build",
      granularity: { level: 2, maxDepth: 4 },
      systems: [],
    });
  });

  it("says what the person has to decide that a project file leaves out", async () => {
    await writeManifestJson({ name: "Undecided", systems: [] });

    await expect(loadProject(dir)).rejects.toThrow(/granularity: must say how finely/);
  });

  it("says what became of the mode a project used to be in", async () => {
    await writeSmallProject();
    await writeManifestJson({ ...manifest, mode: "visual" });

    await expect(loadProject(dir)).rejects.toThrow(/There are no modes any more.*Remove "mode"/s);
  });

  it("explains how to fix a project still using the old single-system manifest", async () => {
    await writeSmallProject();
    await writeManifestJson({ name: "Old", goal: "Old shape.", rootBlock: "rank-jobs" });

    await expect(loadProject(dir)).rejects.toThrow(/uses the old single-system manifest.*"language": "typescript"/s);
  });

  it("refuses two systems sharing a root block", async () => {
    await writeSmallProject();
    await writeManifestJson({
      ...manifest,
      systems: [
        { rootBlock: "rank-jobs", language: "typescript" },
        { rootBlock: "rank-jobs", language: "python" },
      ],
    });

    await expect(loadProject(dir)).rejects.toThrow(/two systems cannot share a root block/);
  });

  it("gives each system the project's language unless it names its own", async () => {
    await writeSmallProject();
    await writeManifestJson({ ...manifest, language: "typescript", systems: [{ rootBlock: "rank-jobs" }] });

    expect((await loadProject(dir)).systems[0]!.language).toBe("typescript");
  });

  it("reads a system that names no language at all, which is drawn and nothing more", async () => {
    await writeSmallProject();
    await writeManifestJson({ ...manifest, systems: [{ rootBlock: "rank-jobs" }] });

    expect((await loadProject(dir)).systems[0]!.language).toBe("");
  });

  it("takes a language written the way a person writes it", async () => {
    await writeSmallProject();
    await writeManifestJson({ ...manifest, systems: [{ rootBlock: "rank-jobs", language: "TypeScript" }] });

    expect((await loadProject(dir)).systems[0]!.language).toBe("typescript");
  });

  it("reports a system in another language than the one the person chose", async () => {
    await writeSmallProject();
    await writeManifestJson({ ...manifest, language: "python" });

    expect(validateProject(await loadProject(dir)).map((d) => d.message)).toContain(
      'The system "rank-jobs" is written in typescript, but this project is set to python, so every system in it uses python.',
    );
  });
});

describe("a block describing code that already exists", () => {
  it("keeps a type the parser cannot read as the words it was written in", async () => {
    await writeManifestJson({ name: "Seen", granularity: { level: 3 }, systems: [{ rootBlock: "serve" }] });
    await mkdir(blockDir(dir, "serve"), { recursive: true });
    await writeFile(
      path.join(blockDir(dir, "serve"), "block.json"),
      JSON.stringify({ responsibility: "Serves requests.", code: "src/server.ts#serve", inputs: { port: "Port" } }),
      "utf8",
    );

    const project = await loadProject(dir);
    expect(project.systems[0]!.language).toBe("");
    expect(project.byPath.get("serve")!.block.inputs.port!.type).toEqual({ kind: "text", text: "Port" });
  });
});

describe("locateCode", () => {
  const source = [
    'import { priceOrder } from "./order.js";',
    "",
    "export function priceOrders(orders) { return orders.map(priceOrder); }",
    "export function priceOrder(order) { return 1; }",
    "",
    "class Cart {",
    "  items = [];",
    "  total() { return 0; }",
    "}",
  ].join("\n");

  beforeEach(async () => {
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "src", "pricing.ts"), source, "utf8");
  });

  it("finds where a name is declared, not where it is first mentioned", async () => {
    const found = await locateCode(dir, "src/pricing.ts#priceOrder");
    expect(found).toMatchObject({ ok: true, location: { file: "src/pricing.ts", symbol: "priceOrder", line: 4 } });
  });

  it("finds a method inside its class", async () => {
    expect(await locateCode(dir, "src/pricing.ts#Cart.total")).toMatchObject({ ok: true, location: { line: 8 } });
  });

  it("accepts a file or a folder on its own", async () => {
    expect(await locateCode(dir, "src/pricing.ts")).toMatchObject({ ok: true, location: { line: null, text: source } });
    expect(await locateCode(dir, "src")).toMatchObject({ ok: true, location: { file: "src", text: null } });
  });

  it("says what is wrong with a pointer that leads nowhere", async () => {
    expect(await locateCode(dir, "src/missing.ts")).toEqual({ ok: false, problem: '"src/missing.ts" does not exist.' });
    expect(await locateCode(dir, "src/pricing.ts#discount")).toEqual({
      ok: false,
      problem: '"src/pricing.ts" has nothing called "discount".',
    });
    expect(await locateCode(dir, "../elsewhere.ts")).toEqual({
      ok: false,
      problem: '"../elsewhere.ts" points outside the project folder.',
    });
  });
});

describe("planned blocks", () => {
  it("spread downward, and stop at the block above them", async () => {
    await writeSmallProject();

    // Only the middle block says it is planned. The one inside it says
    // nothing, and the one above it is real.
    await writeBlock(
      blockDir(dir, "rank-jobs/score-posting"),
      makeBlock({
        id: "score-posting",
        planned: true,
        inputs: { posting: { type: t.object({ title: t.string }) } },
        outputs: { score: { type: t.number } },
      }),
    );
    await writeBlock(blockDir(dir, "rank-jobs/score-posting/weigh-keywords"), makeBlock({ id: "weigh-keywords" }));

    const project = await loadProject(dir);
    expect(project.byPath.get("rank-jobs/score-posting")!.block.planned).toBe(true);
    expect(project.byPath.get("rank-jobs/score-posting/weigh-keywords")!.block.planned).toBe(true);

    expect(project.byPath.get("rank-jobs")!.block.planned).toBe(false);
  });
});

describe("a block inside a plan", () => {
  it("may write its types as words without repeating the flag", async () => {
    await writeSmallProject();
    await writeBlock(
      blockDir(dir, "rank-jobs/score-posting"),
      makeBlock({
        id: "score-posting",
        planned: true,
        inputs: { posting: { type: t.object({ title: t.string }) } },
        outputs: { score: { type: t.number } },
      }),
    );

    // Written as the file itself, because this is about how the file is read:
    // a prose type is only legal once the block is known to be planned, and
    // this one is planned by the block above it rather than by itself.
    await mkdir(blockDir(dir, "rank-jobs/score-posting/weigh-keywords"), { recursive: true });
    await writeFile(
      path.join(blockDir(dir, "rank-jobs/score-posting/weigh-keywords"), "block.json"),
      JSON.stringify({ responsibility: "Weigh them somehow.", inputs: { terms: "the keywords it will weigh" } }),
      "utf8",
    );

    const project = await loadProject(dir);
    const inside = project.byPath.get("rank-jobs/score-posting/weigh-keywords")!.block;
    expect(inside.planned).toBe(true);
    expect(inside.inputs.terms!.type).toEqual({ kind: "text", text: "the keywords it will weigh" });
  });
});

describe("a project file written before the questions were asked", () => {
  it("reads as one started from nothing and built as it went", async () => {
    await writeManifestJson({
      name: "Older",
      goal: "",
      language: "typescript",
      granularity: { level: 3, maxDepth: 4 },
      systems: [],
    });
    const project = await loadProject(dir);
    expect(project.manifest.existingCode).toBe(false);
    expect(project.manifest.start).toBe("build");
  });
});

describe("blocks that are pieces of the architecture", () => {
  /**
   * A shape a real application has: an application holding a client, a
   * service and a database, with the handlers that do the work one level
   * further in, inside the service.
   */
  async function writeApplication() {
    const application = makeBlock({ id: "orders-app", name: "Orders", role: "component" });

    const api = makeBlock({
      id: "orders-api",
      role: "service",
      exposes: { listOrders: { accepts: t.object({ owner: t.string }), returns: null } },
    });

    const database = makeBlock({
      id: "orders-db",
      role: "database",
      exposes: { orders: { accepts: t.object({ id: t.string }), returns: t.object({ id: t.string }) } },
    });

    const handler = makeBlock({
      id: "load-orders",
      inputs: { owner: { type: t.string } },
      outputs: { orders: { type: t.array(t.object({ id: t.string })) } },
      access: [{ from: null, verb: "reads", resource: "orders-db", entry: "orders" }],
    });

    await createProject(dir, { ...manifest, systems: [{ rootBlock: "orders-app", language: "typescript" }] }, [
      application,
    ]);
    await writeBlock(blockDir(dir, "orders-app/orders-api"), api);
    await writeBlock(blockDir(dir, "orders-app/orders-db"), database);
    await writeBlock(blockDir(dir, "orders-app/orders-api/load-orders"), handler);
  }

  it("finds a database the handler's own parent does not hold", async () => {
    await writeApplication();
    const project = await loadProject(dir);

    // `orders-db` sits beside the service, not inside it, so it is found by
    // looking outward from the handler that named it.
    expect(resolveAccess(project, "orders-app/orders-api/load-orders", "orders-db")?.path).toBe("orders-app/orders-db");
    expect(validateProject(project)).toEqual([]);
  });

  it("finds a block kept inside a group by its path from the group", async () => {
    await writeApplication();
    await writeBlock(blockDir(dir, "orders-app/infrastructure"), makeBlock({ id: "infrastructure", role: "component" }));
    await writeBlock(
      blockDir(dir, "orders-app/infrastructure/archive-db"),
      makeBlock({
        id: "archive-db",
        role: "database",
        exposes: { orders: { accepts: t.object({ id: t.string }), returns: t.object({ id: t.string }) } },
      }),
    );
    const project = await loadProject(dir);

    expect(resolveAccess(project, "orders-app/orders-api/load-orders", "infrastructure/archive-db")?.path).toBe(
      "orders-app/infrastructure/archive-db",
    );
    expect(resolveAccess(project, "orders-app/orders-api/load-orders", "infrastructure/nothing")).toBeUndefined();
  });

  it("finds something a block owns inside itself", async () => {
    await writeApplication();
    await writeBlock(
      blockDir(dir, "orders-app/orders-api/load-orders/recent"),
      makeBlock({
        id: "recent",
        role: "structure",
        exposes: { orders: { accepts: t.object({ id: t.string }), returns: t.object({ id: t.string }) } },
      }),
    );
    const project = await loadProject(dir);

    expect(resolveAccess(project, "orders-app/orders-api/load-orders", "recent")?.path).toBe(
      "orders-app/orders-api/load-orders/recent",
    );
  });

  it("says so when an access names something that is not there", async () => {
    await writeApplication();
    await writeBlock(
      blockDir(dir, "orders-app/orders-api/load-orders"),
      makeBlock({
        id: "load-orders",
        inputs: { owner: { type: t.string } },
        access: [
          { from: null, verb: "reads", resource: "billing", entry: null },
          { from: null, verb: "reads", resource: "orders-db", entry: "invoices" },
          { from: null, verb: "writes", resource: "orders-db", entry: "orders" },
        ],
      }),
    );

    await writeBlock(
      blockDir(dir, "orders-app/orders-db"),
      makeBlock({
        id: "orders-db",
        role: "database",
        // Written to, never read back, which the second access contradicts.
        exposes: { orders: { accepts: t.object({ id: t.string }), returns: null } },
      }),
    );

    expect(validateProject(await loadProject(dir)).map((d) => d.message)).toEqual([
      expect.stringContaining('there is no block called "billing" among its own parts, beside it, or anywhere above it'),
      expect.stringContaining('exposes no table called "invoices". It exposes: orders.'),
    ]);
  });

  it("refuses an access that names the block itself, or the one it sits inside", async () => {
    await writeApplication();
    await writeBlock(
      blockDir(dir, "orders-app/orders-api/load-orders"),
      makeBlock({
        id: "load-orders",
        inputs: { owner: { type: t.string } },
        access: [
          { from: null, verb: "reads", resource: "load-orders", entry: null },
          { from: null, verb: "calls", resource: "orders-api", entry: "listOrders" },
        ],
      }),
    );

    // Looking outward passes through the block and then everything it sits
    // inside, so both are reachable by name and neither means anything.
    expect(validateProject(await loadProject(dir)).map((d) => d.message)).toEqual([
      expect.stringContaining("but that is the block itself"),
      expect.stringContaining("is the block it sits inside"),
    ]);
  });

  it("refuses an access that starts from an entry the block does not expose", async () => {
    await writeApplication();
    await writeBlock(
      blockDir(dir, "orders-app/orders-api"),
      makeBlock({
        id: "orders-api",
        role: "service",
        exposes: { listOrders: { accepts: t.object({ owner: t.string }), returns: null } },
        access: [{ from: "listInvoices", verb: "reads", resource: "orders-db", entry: "orders" }],
      }),
    );

    expect(validateProject(await loadProject(dir)).map((d) => d.message)).toContainEqual(
      expect.stringContaining('exposes nothing called "listInvoices". It exposes: listOrders.'),
    );
  });

  it("refuses an access to an ordinary function block beside it", async () => {
    await writeSmallProject();
    await writeBlock(
      blockDir(dir, "rank-jobs/label-score"),
      makeBlock({ id: "label-score", inputs: { score: { type: t.number } } }),
    );
    await writeBlock(
      blockDir(dir, "rank-jobs/score-posting"),
      makeBlock({
        id: "score-posting",
        inputs: { posting: { type: t.object({ title: t.string }) } },
        outputs: { score: { type: t.number } },
        access: [{ from: null, verb: "reads", resource: "label-score", entry: null }],
      }),
    );

    expect(validateProject(await loadProject(dir)).map((d) => d.message)).toContainEqual(
      expect.stringContaining("is an ordinary function block"),
    );
  });

  it("asks nothing of an access to a resource that is only planned", async () => {
    await writeApplication();
    await writeBlock(
      blockDir(dir, "orders-app/orders-db"),
      makeBlock({ id: "orders-db", role: "database", planned: true }),
    );
    await writeBlock(
      blockDir(dir, "orders-app/orders-api/load-orders"),
      makeBlock({
        id: "load-orders",
        inputs: { owner: { type: t.string } },
        access: [{ from: null, verb: "reads", resource: "orders-db", entry: "orders" }],
      }),
    );

    // The table it names is exactly what has not been decided yet, so writing
    // the handler against it early is not a fault in either of them.
    const found = validateProject(await loadProject(dir));
    expect(found.filter((d) => d.severity === "error")).toEqual([]);
    expect(found.map((d) => d.message)).toContainEqual(expect.stringContaining("exposes nothing at all yet"));
  });
});

describe("a capability port that is a way into a store", () => {
  /** An application whose database offers two tables, so a port can be pointed at the wrong one. */
  async function writeApplicationForStores() {
    await createProject(dir, { ...manifest, systems: [{ rootBlock: "orders-app", language: "typescript" }] }, [
      makeBlock({ id: "orders-app", role: "component" }),
    ]);
    await writeBlock(
      blockDir(dir, "orders-app/orders-api"),
      makeBlock({
        id: "orders-api",
        role: "service",
        exposes: { listOrders: { accepts: t.object({ owner: t.string }), returns: null } },
      }),
    );
    await writeBlock(
      blockDir(dir, "orders-app/orders-db"),
      makeBlock({
        id: "orders-db",
        role: "database",
        exposes: {
          orders: { accepts: t.object({ id: t.string }), returns: t.object({ id: t.string }) },
          customers: { accepts: t.object({ id: t.string }), returns: t.object({ id: t.string }) },
        },
      }),
    );
  }

  /** The handler, with whatever capabilities and accesses the test is about. */
  async function writeHandler(over: Partial<Pick<Block, "capabilities" | "access">>) {
    await writeApplicationForStores();
    await writeBlock(
      blockDir(dir, "orders-app/orders-api/load-orders"),
      makeBlock({
        id: "load-orders",
        inputs: { owner: { type: t.string } },
        outputs: { orders: { type: t.array(t.object({ id: t.string })) } },
        capabilities: { orders: { capability: "Store" } },
        access: [{ from: "orders", verb: "reads", resource: "orders-db", entry: "orders" }],
        ...over,
      }),
    );
    return validateProject(await loadProject(dir)).map((d) => d.message);
  }

  it("takes a port bound to an entry of the right kind of block", async () => {
    const found = await writeHandler({});
    expect(found.filter((message) => message.includes("Store"))).toEqual([]);
  });

  it("reports a store port that nothing says what it is a way into", async () => {
    const found = await writeHandler({ access: [] });
    expect(found).toContainEqual(expect.stringContaining('nothing says what it is a way into'));
  });

  it("reports an access naming a port the block never asked for", async () => {
    const found = await writeHandler({
      access: [{ from: "customers", verb: "reads", resource: "orders-db", entry: "orders" }],
    });
    expect(found).toContainEqual(expect.stringContaining('no capability port called "customers"'));
  });

  it("reports a port that would be a way into two different things at once", async () => {
    const found = await writeHandler({
      access: [
        { from: "orders", verb: "reads", resource: "orders-db", entry: "orders" },
        { from: "orders", verb: "reads", resource: "orders-db", entry: "customers" },
      ],
    });
    expect(found).toContainEqual(expect.stringContaining("2 different things"));
  });

  it("insists a bound port name the entry, not just the block", async () => {
    const found = await writeHandler({
      access: [{ from: "orders", verb: "reads", resource: "orders-db", entry: null }],
    });
    expect(found).toContainEqual(expect.stringContaining("is a way into one table rather than into"));
  });

  it("reports a Store pointed at something that is not a store", async () => {
    const found = await writeHandler({
      capabilities: { orders: { capability: "Queue" } },
      access: [{ from: "orders", verb: "reads", resource: "orders-db", entry: "orders" }],
    });
    expect(found).toContainEqual(expect.stringContaining("is a Queue port and"));
  });
});

describe("an operation and the block that answers it", () => {
  /** A service whose one operation is answered by a handler of whatever shape the test gives it. */
  async function writeService(operation: object, handler: object) {
    await createProject(dir, { ...manifest, systems: [{ rootBlock: "orders-app", language: "typescript" }] }, [
      makeBlock({ id: "orders-app", role: "component" }),
    ]);
    await writeBlock(
      blockDir(dir, "orders-app/orders-api"),
      makeBlock({ id: "orders-api", role: "service", exposes: { listOrders: operation as never } }),
    );
    await writeBlock(blockDir(dir, "orders-app/orders-api/load-orders"), makeBlock({ id: "load-orders", ...handler }));
    return validateProject(await loadProject(dir)).map((d) => d.message);
  }

  const owner = { accepts: t.object({ owner: t.string }), returns: t.object({ found: t.number }), block: "load-orders" };
  const handler = { inputs: { owner: { type: t.string } }, outputs: { found: { type: t.number } } };

  it("says nothing when the two are the same shape", async () => {
    const found = await writeService(owner, handler);
    expect(found.filter((message) => message.includes("answers it"))).toEqual([]);
  });

  it("reports a request the block does not take", async () => {
    const found = await writeService({ ...owner, accepts: t.object({ customer: t.string }) }, handler);
    expect(found).toContainEqual(expect.stringContaining("give the two the same shape"));
  });

  it("lets a block that needs nothing from the request answer it", async () => {
    const found = await writeService(owner, { outputs: handler.outputs });
    expect(found.filter((message) => message.includes("answers it") || message.includes("accepts"))).toEqual([]);
  });

  it("reports a response the block does not produce", async () => {
    const found = await writeService({ ...owner, returns: t.object({ found: t.string }) }, handler);
    expect(found).toContainEqual(expect.stringContaining('"listOrders" returns { found: string }'));
  });

  it("reports an operation that says it takes nothing while the block wants something", async () => {
    const found = await writeService({ accepts: null, returns: t.object({ found: t.number }), block: "load-orders" }, handler);
    expect(found).toContainEqual(expect.stringContaining("accepts nothing, but"));
  });

  it("leaves a shape written in words alone, having no way to compare it", async () => {
    const found = await writeService({ ...owner, accepts: { kind: "text", text: "an order request" } }, handler);
    expect(found.filter((message) => message.includes("accepts"))).toEqual([]);
  });

  it("says nothing where the block's own ports are words, as under a plan", async () => {
    // A planned block's ports say what is meant to flow rather than what
    // does, so there is no shape to hold the operation to.
    const found = await writeService(owner, {
      planned: true,
      inputs: { owner: { type: { kind: "text", text: "the owner" } } },
      outputs: { found: { type: { kind: "text", text: "how many" } } },
    });
    expect(found.filter((message) => message.includes("answers it"))).toEqual([]);
  });
});
