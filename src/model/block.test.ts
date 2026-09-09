import { describe, expect, it } from "vitest";
import { blockSchema, blockToFileShape, formatWire, functionNameOf, parseWireText, typeStemOf } from "./block.js";
import { describeType, typesEqual } from "./types.js";
import { t } from "./testing.js";

const minimal = {
  id: "score-posting",
  name: "Score Posting",
  responsibility: "Rate how well a posting matches the profile.",
  kind: "leaf",
};

describe("blockSchema", () => {
  it("fills in the empty parts of a minimal leaf", () => {
    const block = blockSchema.parse(minimal);
    expect(block).toMatchObject({
      inputs: {},
      outputs: {},
      capabilities: {},
      children: [],
      wires: [],
      pinnedAsLeaf: false,
    });
  });

  it("requires a stated responsibility", () => {
    const result = blockSchema.safeParse({ ...minimal, responsibility: "" });
    expect(result.success).toBe(false);
  });

  it("rejects block ids that are not kebab-case", () => {
    for (const id of ["ScorePosting", "score_posting", "score--posting", "-score", "1score"]) {
      expect(blockSchema.safeParse({ ...minimal, id }).success, id).toBe(false);
    }
  });

  it("rejects port names that could not be variables", () => {
    const result = blockSchema.safeParse({
      ...minimal,
      inputs: { "not-an-identifier": { type: "string" } },
    });
    expect(result.success).toBe(false);
  });

  it("explains a port type it cannot read", () => {
    const result = blockSchema.safeParse({ ...minimal, inputs: { posting: { type: "Posting[]" } } });
    expect(result.success).toBe(false);
    expect(result.success === false && JSON.stringify(result.error.issues)).toContain("Unknown type");
  });

  it("rejects unknown fields rather than silently ignoring them", () => {
    const result = blockSchema.safeParse({ ...minimal, colour: "green" });
    expect(result.success).toBe(false);
  });

  it("will not let a leaf declare children", () => {
    const result = blockSchema.safeParse({ ...minimal, children: [{ block: "child" }] });
    expect(result.success).toBe(false);
  });

  it("requires an iterated child to say what it iterates over", () => {
    const composite = { ...minimal, kind: "composite" };
    expect(blockSchema.safeParse({ ...composite, children: [{ block: "child", mode: "each" }] }).success).toBe(false);
    expect(
      blockSchema.safeParse({ ...composite, children: [{ block: "child", mode: "each", eachOver: "item" }] }).success,
    ).toBe(true);
  });

  it("defaults a child invocation to running once", () => {
    const block = blockSchema.parse({ ...minimal, kind: "composite", children: [{ block: "child" }] });
    expect(block.children[0]).toEqual({ block: "child", mode: "once" });
  });

  it("reads a nested port type written as an expression", () => {
    const block = blockSchema.parse({
      ...minimal,
      inputs: { postings: { type: "{ title: string; salary?: number }[]" } },
    });

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

  it("writes back exactly what it read", () => {
    const source = {
      ...minimal,
      kind: "leaf",
      inputs: { postings: { type: "{ title: string; salary?: number }[]", description: "Postings to score." } },
      outputs: { score: { type: "number" } },
      capabilities: {},
      children: [],
      wires: [],
      pinnedAsLeaf: false,
    };

    const written = blockToFileShape(blockSchema.parse(source)) as typeof source;
    expect(written.inputs).toEqual(source.inputs);
    expect(written.outputs).toEqual(source.outputs);
  });
});

describe("name derivation", () => {
  it("turns block ids into function and type names", () => {
    expect(functionNameOf("rank-jobs")).toBe("rankJobs");
    expect(functionNameOf("score")).toBe("score");
    expect(functionNameOf("find-top-3-matches")).toBe("findTop3Matches");
    expect(typeStemOf("rank-jobs")).toBe("RankJobs");
    expect(typeStemOf("score")).toBe("Score");
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

describe("wire syntax", () => {
  const samples = [
    "input.sourcePath -> load-postings.path",
    "load-postings.postings -> score-posting.posting",
    "rank-results.ranked -> output.ranked",
  ];

  for (const sample of samples) {
    it(`round trips ${sample}`, () => {
      const parsed = parseWireText(sample);
      expect(parsed.ok).toBe(true);
      expect(parsed.ok && formatWire(parsed.wire)).toBe(sample);
    });
  }

  it("reads a wire off a composite block file", () => {
    const block = blockSchema.parse({
      id: "parent",
      name: "Parent",
      responsibility: "Wraps a child.",
      kind: "composite",
      inputs: { value: { type: "number" } },
      outputs: { doubled: { type: "number" } },
      children: [{ block: "double" }],
      wires: ["input.value -> double.value", "double.result -> output.doubled"],
    });

    expect(block.wires[0]).toEqual({
      source: { from: "input", port: "value" },
      target: { to: "block", block: "double", port: "value" },
    });
  });

  it("rejects a wire with no arrow", () => {
    const result = parseWireText("input.value double.value");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('must be written as "source -> destination"');
  });

  it("rejects a wire that runs out of an output", () => {
    const result = parseWireText("output.done -> child.value");
    expect(result.ok === false && result.error).toContain("outputs are destinations, not sources");
  });

  it("rejects an endpoint that is not a real block id", () => {
    expect(parseWireText("Not_A_Block.value -> child.value").ok).toBe(false);
  });
});
