import { describe, expect, it } from "vitest";
import ts from "typescript";
import { z } from "zod/v4";
import { generateContractSource, generateImplScaffold, relativeRootPrefix, zodExpression } from "./contract.js";
import { parseType } from "../model/typeExpression.js";
import { makeBlock } from "../model/testing.js";
import { blockSchema } from "../model/block.js";

/** Builds the schema the generator described, so behaviour is tested, not spelling. */
function schemaFor(expression: string): z.ZodType {
  return new Function("z", `return ${expression};`)(z) as z.ZodType;
}

function syntaxErrorsIn(source: string): string[] {
  const result = ts.transpileModule(source, {
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  return (result.diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "));
}

describe("zodExpression", () => {
  const cases: Array<[string, unknown[], unknown[]]> = [
    // type expression,           values it must accept,        values it must reject
    ["string", ["hello", ""], [1, null, {}]],
    ["number", [0, -2.5], ["1", null]],
    ["boolean", [true, false], ["true", 0]],
    ["string[]", [[], ["a"]], ["a", [1]]],
    ['"remote" | "hybrid"', ["remote", "hybrid"], ["onsite", 1]],
    ["string | null", ["a", null], [1, undefined]],
    ["{ title: string; salary?: number }", [{ title: "a" }, { title: "a", salary: 1 }], [{}, { title: 1 }]],
    ["{ tags: string[] }[]", [[{ tags: ["x"] }], []], [[{ tags: 1 }], [{}]]],
    ["(string | number)[]", [["a", 1]], [[true]]],
  ];

  for (const [expression, accepted, rejected] of cases) {
    it(`builds a schema matching ${expression}`, () => {
      const schema = schemaFor(zodExpression(parseType(expression)));
      for (const value of accepted) {
        expect(schema.safeParse(value).success, `${expression} should accept ${JSON.stringify(value)}`).toBe(true);
      }
      for (const value of rejected) {
        expect(schema.safeParse(value).success, `${expression} should reject ${JSON.stringify(value)}`).toBe(false);
      }
    });
  }

  it("keeps an optional field optional rather than nullable", () => {
    const schema = schemaFor(zodExpression(parseType("{ a?: string }")));
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ a: null }).success).toBe(false);
  });
});

describe("generateContractSource", () => {
  const scorePosting = blockSchema.parse({
    id: "score-posting",
    name: "Score Posting",
    responsibility: "Score one posting against the profile keywords.",
    kind: "leaf",
    inputs: {
      posting: { type: "{ title: string; description: string }" },
      keywords: { type: "string[]" },
    },
    outputs: { score: { type: "number" }, reasons: { type: "string[]" } },
  });

  it("produces syntactically valid TypeScript", () => {
    const source = generateContractSource({ block: scorePosting, blockPath: "rank-jobs/score-posting" });
    expect(syntaxErrorsIn(source)).toEqual([]);
  });

  it("exports a schema and a type for each side of the contract", () => {
    const source = generateContractSource({ block: scorePosting, blockPath: "rank-jobs/score-posting" });
    expect(source).toContain("export const scorePostingInput = z.object({");
    expect(source).toContain("export type ScorePostingInput = z.infer<typeof scorePostingInput>;");
    expect(source).toContain("export const scorePostingOutput = z.object({");
    expect(source).toContain("export type ScorePostingOutput = z.infer<typeof scorePostingOutput>;");
  });

  it("says plainly when a block needs no effects", () => {
    const source = generateContractSource({ block: scorePosting, blockPath: "rank-jobs/score-posting" });
    expect(source).toContain("export type ScorePostingCaps = Record<string, never>;");
    expect(source).not.toContain("capabilities.js");
  });

  it("imports only the capability types a block actually uses", () => {
    const loader = makeBlock({
      id: "load-postings",
      name: "Load Postings",
      inputs: { path: { type: parseType("string") } },
      outputs: { postings: { type: parseType("string[]") } },
      capabilities: { files: { capability: "FileSystem", description: "Reads the postings file." } },
    });

    const source = generateContractSource({ block: loader, blockPath: "rank-jobs/load-postings" });
    expect(source).toContain('import type { FileSystem } from "../../capabilities.js";');
    expect(source).toContain("export interface LoadPostingsCaps {");
    expect(source).toContain("  files: FileSystem;");
    expect(source).toContain("/** Reads the postings file. */");
    expect(syntaxErrorsIn(source)).toEqual([]);
  });

  it("reaches the shared module from any depth", () => {
    expect(relativeRootPrefix("rank-jobs")).toBe("../");
    expect(relativeRootPrefix("rank-jobs/score-posting")).toBe("../../");
    expect(relativeRootPrefix("a/b/c/d")).toBe("../../../../");
  });
});

describe("generateImplScaffold", () => {
  it("frames the implementation with the signature the contract fixes", () => {
    const block = makeBlock({
      id: "rank-results",
      name: "Rank Results",
      responsibility: "Order the scored postings best first.",
      inputs: { scores: { type: parseType("number[]") } },
      outputs: { ranked: { type: parseType("string[]") } },
    });

    const source = generateImplScaffold(block);
    expect(source).toContain(
      "export async function rankResults(input: RankResultsInput, caps: RankResultsCaps): Promise<RankResultsOutput>",
    );
    expect(source).toContain('import type { RankResultsInput, RankResultsOutput, RankResultsCaps } from "./contract.js";');
    expect(syntaxErrorsIn(source)).toEqual([]);
  });
});
