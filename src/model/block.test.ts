import { describe, expect, it } from "vitest";
import {
  blockFromFile,
  blockToFileShape,
  formatWire,
  functionNameOf,
  parseBlockFile,
  parseWireText,
  typeStemOf,
} from "./block.js";
import type { Mode } from "./block.js";
import { describeType, typesEqual } from "./types.js";
import { t } from "./testing.js";

const minimal = { responsibility: "Rate how well a posting matches the profile." };

/** What is wrong with a file, as the loader would report it. */
function problemsWith(raw: unknown, mode: Mode = "structured"): string[] {
  const result = parseBlockFile(raw, "score-posting", mode);
  return result.ok ? [] : result.problems;
}

describe("reading a block file", () => {
  it("fills in everything a minimal leaf leaves out, taking its id from its folder", () => {
    expect(blockFromFile(minimal, "score-posting")).toEqual({
      id: "score-posting",
      name: "Score Posting",
      responsibility: minimal.responsibility,
      kind: "leaf",
      inputs: {},
      outputs: {},
      capabilities: {},
      children: [],
      wires: [],
      pinnedAsLeaf: false,
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

  it("says where a port type it cannot read is", () => {
    expect(problemsWith({ ...minimal, inputs: { posting: "Posting[]" } })).toEqual([
      expect.stringMatching(/^inputs\.posting\.type: Unknown type "Posting"/),
    ]);
  });

  it("rejects fields it does not know, including ones the format no longer has", () => {
    expect(problemsWith({ ...minimal, colour: "green" })).not.toEqual([]);
    expect(problemsWith({ ...minimal, id: "score-posting", kind: "leaf" })).not.toEqual([]);
  });

  it("is a composite exactly when it has children", () => {
    expect(blockFromFile({ ...minimal, children: ["child"] }, "rank").kind).toBe("composite");
    expect(blockFromFile(minimal, "rank").kind).toBe("leaf");
  });

  it("will not let a block without children have wires", () => {
    expect(problemsWith({ ...minimal, wires: ["input.a -> output.b"] })).toEqual([
      "wires: a block with no children cannot have wires",
    ]);
  });

  it("reads a child written as its id as running once, and one with `each` as running per item", () => {
    const block = blockFromFile({ ...minimal, children: ["load", { block: "score", each: "posting" }] }, "rank");
    expect(block.children).toEqual([
      { block: "load", mode: "once" },
      { block: "score", mode: "each", eachOver: "posting" },
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

    const composite = {
      responsibility: "Doubles each value.",
      inputs: { values: "number[]" },
      outputs: { doubled: "number[]" },
      children: [{ block: "double", each: "value" }],
      wires: ["input.values -> double.value", "double.result -> output.doubled"],
      pinnedAsLeaf: true,
    };
    expect(blockToFileShape(blockFromFile(composite, "double-all"))).toEqual(composite);
  });

  it("leaves out a name that only repeats the id", () => {
    expect(blockToFileShape(blockFromFile({ ...minimal, name: "Score Posting" }, "score-posting"))).toEqual(minimal);
  });
});

describe("a visual block", () => {
  it("keeps types as the code writes them, without reading them", () => {
    const block = blockFromFile(
      { ...minimal, code: "src/score.ts#score", inputs: { posting: "Posting" }, outputs: { score: "Promise<number>" } },
      "score-posting",
      "visual",
    );

    expect(block.inputs.posting!.type).toEqual({ kind: "text", text: "Posting" });
    expect(describeType(block.outputs.score!.type)).toBe("Promise<number>");
    expect(block.code).toBe("src/score.ts#score");
    expect(blockToFileShape(block)).toMatchObject({ code: "src/score.ts#score", inputs: { posting: "Posting" } });
  });

  it("is the only kind that says where its code is", () => {
    expect(problemsWith({ ...minimal, code: "src/score.ts" })).toEqual([expect.stringContaining("only for visual mode")]);
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
    const block = blockFromFile(
      {
        responsibility: "Wraps a child.",
        inputs: { value: "number" },
        outputs: { doubled: "number" },
        children: ["double"],
        wires: ["input.value -> double.value", "double.result -> output.doubled"],
      },
      "parent",
    );

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
