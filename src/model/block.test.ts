import { describe, expect, it } from "vitest";
import { blockFromFile, blockToFileShape, parseAccessText, parseBlockFile } from "./block.js";
import { describeType } from "./types.js";
import { typesEqual } from "./typesEqual.js";
import { t } from "./testing.js";

const minimal = { responsibility: "Rate how well a posting matches the profile." };

/** What is wrong with a file, as the loader would report it. */
function problemsWith(raw: unknown): string[] {
  const result = parseBlockFile(raw, "score-posting");
  return result.ok ? [] : result.problems;
}

describe("reading a block file", () => {
  it("fills in everything a minimal leaf leaves out, taking its id from its folder", () => {
    expect(blockFromFile(minimal, "score-posting")).toEqual({
      id: "score-posting",
      name: "Score Posting",
      responsibility: minimal.responsibility,
      role: "function",
      inputs: {},
      outputs: {},
      exposes: {},
      access: [],
      capabilities: {},
      pinnedAsLeaf: false,
      planned: false,
    });
  });

  it("requires a stated responsibility", () => {
    expect(problemsWith({})).toEqual([expect.stringMatching(/^responsibility: /)]);
    expect(problemsWith({ responsibility: "" })).toEqual([
      "responsibility: every block must state what it is responsible for",
    ]);
  });

  it("refuses a folder name that is not kebab-case", () => {
    for (const id of ["ScorePosting", "score_posting", "score--posting", "-score", "1score"]) {
      expect(parseBlockFile(minimal, id).ok, id).toBe(false);
    }
  });

  it("rejects port names that could not be variables", () => {
    expect(problemsWith({ ...minimal, inputs: { "not-an-identifier": "string" } })).not.toEqual([]);
  });

  it("keeps a port type it cannot read as the words it was written in", () => {
    // Refusing it would cost a correct diagram to gain a check nothing can
    // rely on. What it costs the block is its contract, which the check says.
    const block = blockFromFile({ ...minimal, inputs: { posting: "Posting[]" } }, "score-posting");
    expect(block.inputs.posting!.type).toEqual({ kind: "text", text: "Posting[]" });
  });

  it("rejects fields it does not know, including ones the format no longer has", () => {
    expect(problemsWith({ ...minimal, colour: "green" })).not.toEqual([]);
    expect(problemsWith({ ...minimal, id: "score-posting", kind: "leaf" })).not.toEqual([]);
  });

  it("says plainly that a block's parts are no longer listed, and that nothing is wired", () => {
    expect(problemsWith({ ...minimal, children: ["load"] })).toEqual([
      expect.stringMatching(/^children: a block's parts are the block folders inside its folder/),
    ]);
    expect(problemsWith({ ...minimal, wires: ["input.a -> b.a"] })).toEqual([
      expect.stringMatching(/^wires: blocks are not wired together\. Code calls the blocks it needs directly/),
    ]);
  });

  it("reads ports and capabilities written as just their type, or in full with a description", () => {
    const block = blockFromFile(
      {
        ...minimal,
        inputs: { title: "string", salary: { type: "number", description: "Per year." } },
        capabilities: { files: "FileSystem", log: { capability: "Logger", description: "Progress." } },
      },
      "score-posting",
    );

    expect(block.inputs).toEqual({ title: { type: t.string }, salary: { type: t.number, description: "Per year." } });
    expect(block.capabilities).toEqual({
      files: { capability: "FileSystem" },
      log: { capability: "Logger", description: "Progress." },
    });
  });

  it("reads a nested port type written as an expression", () => {
    const block = blockFromFile({ ...minimal, inputs: { postings: "{ title: string; salary?: number }[]" } }, "score-posting");

    expect(block.inputs.postings!.type).toEqual({
      kind: "array",
      of: {
        kind: "object",
        fields: {
          title: { type: { kind: "string" } },
          salary: { type: { kind: "number" }, optional: true },
        },
      },
    });
    expect(describeType(block.inputs.postings!.type)).toBe("{ title: string; salary?: number }[]");
  });

  it("writes back exactly what it read, in the smallest form", () => {
    const leaf = {
      name: "Scorer",
      responsibility: minimal.responsibility,
      inputs: {
        postings: { type: "{ title: string; salary?: number }[]", description: "Postings to score." },
        weight: "number",
      },
      outputs: { score: "number" },
      capabilities: { files: "FileSystem" },
    };
    expect(blockToFileShape(blockFromFile(leaf, "score-posting"))).toEqual(leaf);

    const pinned = { responsibility: "Doubles each value.", inputs: { values: "number[]" }, pinnedAsLeaf: true };
    expect(blockToFileShape(blockFromFile(pinned, "double-all"))).toEqual(pinned);
  });

  it("leaves out a name that only repeats the id", () => {
    expect(blockToFileShape(blockFromFile({ ...minimal, name: "Score Posting" }, "score-posting"))).toEqual(minimal);
  });
});

describe("a block describing code that already exists", () => {
  it("says where its code is, and keeps types as that code writes them", () => {
    const block = blockFromFile(
      { ...minimal, code: "src/score.ts#score", inputs: { posting: "Posting" }, outputs: { score: "Promise<number>" } },
      "score-posting",
    );

    expect(block.inputs.posting!.type).toEqual({ kind: "text", text: "Posting" });
    expect(describeType(block.outputs.score!.type)).toBe("Promise<number>");
    expect(block.code).toBe("src/score.ts#score");
    expect(blockToFileShape(block)).toMatchObject({ code: "src/score.ts#score", inputs: { posting: "Posting" } });
  });
});

describe("typesEqual", () => {
  it("ignores the order fields were written in", () => {
    expect(typesEqual(t.object({ a: t.string, b: t.number }), t.object({ b: t.number, a: t.string }))).toBe(true);
  });

  it("separates types that differ in shape", () => {
    expect(typesEqual(t.string, t.number)).toBe(false);
    expect(typesEqual(t.array(t.string), t.string)).toBe(false);
    expect(typesEqual(t.object({ a: t.string }), t.object({ a: t.string, b: t.string }))).toBe(false);
  });

  it("treats an optional field as a different contract", () => {
    const required = { kind: "object" as const, fields: { a: { type: t.string } } };
    const optional = { kind: "object" as const, fields: { a: { type: t.string, optional: true } } };
    expect(typesEqual(required, optional)).toBe(false);
  });
});

describe("planned blocks", () => {
  const auditLog = {
    responsibility: "Record what was ranked, so a later run can be compared against it.",
    planned: true,
    inputs: { entries: "the ranked postings" },
    outputs: { written: "whether it was recorded" },
  };

  it("write their types as words, which is usually what has not been decided", () => {
    const block = blockFromFile(auditLog, "audit-log");
    expect(block.planned).toBe(true);
    expect(block.inputs.entries!.type).toEqual({ kind: "text", text: "the ranked postings" });
    // What was written is what reads back: the file is the whole record.
    expect(blockToFileShape(block)).toEqual(auditLog);
  });

  it("are not planned unless they say so", () => {
    expect(blockFromFile({ responsibility: "Score a posting." }, "score-posting").planned).toBe(false);
  });

  it("cannot point at code, because there is none to point at", () => {
    const result = parseBlockFile({ ...auditLog, code: "src/audit.ts" }, "audit-log");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.join(" ")).toMatch(/code that does not exist yet/);
  });
});

describe("blocks that are not functions", () => {
  const database = {
    role: "database",
    responsibility: "Holds the orders.",
    exposes: {
      orders: { type: "{ id: string; total: number }", description: "One row per order." },
      audit: { accepts: "{ at: number; what: string }" },
    },
  };

  it("reads a role, and an entry written as the one shape it holds", () => {
    const block = blockFromFile(database, "orders-db");

    expect(block.role).toBe("database");
    // A store gives back what it was given, so one shape covers both ways.
    expect(describeType(block.exposes.orders!.accepts!)).toBe("{ id: string; total: number }");
    expect(describeType(block.exposes.orders!.returns!)).toBe("{ id: string; total: number }");
    expect(block.exposes.orders!.description).toBe("One row per order.");
    // Something only written to says so by having nothing come back.
    expect(block.exposes.audit!.returns).toBeNull();
  });

  it("writes the same file back, in the short form it was written in", () => {
    expect(blockToFileShape(blockFromFile(database, "orders-db"))).toEqual({
      role: "database",
      responsibility: "Holds the orders.",
      exposes: {
        orders: { type: "{ id: string; total: number }", description: "One row per order." },
        audit: { accepts: "{ at: number; what: string }" },
      },
    });
  });

  it("keeps a shape it cannot parse as the words it was written in", () => {
    // A database column has types the port language has never heard of, and
    // losing the diagram over one would be a poor trade.
    const block = blockFromFile(
      { role: "database", responsibility: "Holds sessions.", exposes: { sessions: "jsonb" } },
      "sessions-db",
    );
    expect(block.exposes.sessions!.returns).toEqual({ kind: "text", text: "jsonb" });
  });

  it("refuses a shape written both ways at once, rather than dropping one", () => {
    expect(
      problemsWith({
        role: "database",
        responsibility: "Holds the orders.",
        exposes: { orders: { type: "{ id: string }", returns: "{ id: string; total: number }" } },
      }),
    ).toEqual([
      expect.stringContaining(`"type" is short for both directions at once`),
    ]);
  });

  it("refuses an entry that describes nothing", () => {
    expect(
      problemsWith({ role: "queue", responsibility: "Carries clicks.", exposes: { clicks: { description: "a click" } } }),
    ).toEqual([expect.stringContaining("nothing at all describes nothing")]);
  });

  it("refuses ports and capabilities on a block that is not called", () => {
    expect(problemsWith({ role: "queue", responsibility: "Carries clicks.", inputs: { click: "string" } })).toEqual([
      expect.stringContaining("is not called, so it has no inputs or outputs"),
    ]);
    expect(
      problemsWith({ role: "queue", responsibility: "Carries clicks.", capabilities: { log: "Logger" } }),
    ).toEqual([expect.stringContaining("An architecture block is not code Fragmentor runs")]);
  });

  it("refuses exposed entries on an ordinary function block", () => {
    expect(problemsWith({ responsibility: "Scores a posting.", exposes: { rows: "string" } })).toEqual([
      expect.stringContaining("A function block's interface is its inputs and outputs"),
    ]);
  });

  it("keeps a subtype beside the role, and refuses one without a role", () => {
    const block = blockFromFile(
      { role: "structure", subtype: "Dictionary", responsibility: "Holds the open sessions." },
      "sessions",
    );
    expect(block.subtype).toBe("Dictionary");
    expect(blockToFileShape(block).subtype).toBe("Dictionary");

    // Without a role there is no general kind for it to be a kind of.
    expect(problemsWith({ responsibility: "Scores a posting.", subtype: "Dictionary" })).toEqual([
      expect.stringContaining('only means something once it has a "role"'),
    ]);
  });

  it("names an unknown role and says what the roles are", () => {
    expect(problemsWith({ role: "lambda", responsibility: "Runs." })).toEqual([
      expect.stringContaining("must be one of function, component, service, external, database, storage, queue, structure, client"),
    ]);
  });
});

describe("what a block reaches", () => {
  const reaching = (access: unknown) => ({ responsibility: "Reads orders.", access });

  it("reads an access, with or without an entry", () => {
    const block = blockFromFile(reaching(["reads orders-db.orders", "calls billing"]), "load-orders");

    expect(block.access).toEqual([
      { from: null, verb: "reads", resource: "orders-db", entry: "orders" },
      { from: null, verb: "calls", resource: "billing", entry: null },
    ]);
    expect(blockToFileShape(block).access).toEqual(["reads orders-db.orders", "calls billing"]);
  });

  it("reads which of the block's own entries does the reaching", () => {
    // Without this a client with two buttons calling two operations would say
    // only that the two blocks are connected.
    const block = blockFromFile(
      {
        role: "client",
        responsibility: "Where a person starts.",
        exposes: { shorten: "{ url: string }", follow: "{ code: string }" },
        access: ["shorten calls api.createLink", "follow calls api.followLink"],
      },
      "browser",
    );

    expect(block.access).toEqual([
      { from: "shorten", verb: "calls", resource: "api", entry: "createLink" },
      { from: "follow", verb: "calls", resource: "api", entry: "followLink" },
    ]);
    expect(blockToFileShape(block).access).toEqual(["shorten calls api.createLink", "follow calls api.followLink"]);
  });

  it("reads a path to a block kept inside a group of them", () => {
    expect(parseAccessText("orders reads infrastructure/orders-db.orders")).toEqual({
      ok: true,
      access: { from: "orders", verb: "reads", resource: "infrastructure/orders-db", entry: "orders" },
    });
    expect(parseAccessText("reads infrastructure//orders-db").ok).toBe(false);
  });

  it("says what is wrong with one that is not written as an access", () => {
    expect(problemsWith(reaching(["orders-db.orders"]))).toEqual([
      expect.stringContaining('An access must be written as "reads app-db.users"'),
    ]);
    expect(problemsWith(reaching(["peeks orders-db.orders"]))).toEqual([
      expect.stringContaining('"peeks" is not one of reads, writes, calls'),
    ]);
    expect(problemsWith(reaching(["reads OrdersDb.orders"]))).toEqual([
      expect.stringContaining('"OrdersDb" is not a block id'),
    ]);
    expect(problemsWith(reaching(["a b reads orders-db.orders"]))).toEqual([
      expect.stringContaining("An access must be written as"),
    ]);
  });
});
