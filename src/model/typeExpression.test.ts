import { describe, expect, it } from "vitest";
import { parseType, tryParseType } from "./typeExpression.js";
import { describeType } from "./types.js";

describe("parseType", () => {
  it("reads the primitive types", () => {
    expect(parseType("string")).toEqual({ kind: "string" });
    expect(parseType("number")).toEqual({ kind: "number" });
    expect(parseType("boolean")).toEqual({ kind: "boolean" });
    expect(parseType("null")).toEqual({ kind: "null" });
    expect(parseType("unknown")).toEqual({ kind: "unknown" });
  });

  it("reads literals", () => {
    expect(parseType('"remote"')).toEqual({ kind: "literal", value: "remote" });
    expect(parseType("42")).toEqual({ kind: "literal", value: 42 });
    expect(parseType("true")).toEqual({ kind: "literal", value: true });
  });

  it("collapses a union of string literals into an enum", () => {
    expect(parseType('"remote" | "hybrid" | "onsite"')).toEqual({
      kind: "enum",
      values: ["remote", "hybrid", "onsite"],
    });
  });

  it("keeps a mixed union as a union", () => {
    expect(parseType("string | null")).toEqual({
      kind: "union",
      of: [{ kind: "string" }, { kind: "null" }],
    });
  });

  it("reads arrays, including arrays of arrays", () => {
    expect(parseType("string[]")).toEqual({ kind: "array", of: { kind: "string" } });
    expect(parseType("number[][]")).toEqual({
      kind: "array",
      of: { kind: "array", of: { kind: "number" } },
    });
  });

  it("reads objects with optional fields", () => {
    expect(parseType("{ title: string; salary?: number }")).toEqual({
      kind: "object",
      fields: {
        title: { type: { kind: "string" } },
        salary: { type: { kind: "number" }, optional: true },
      },
    });
  });

  it("accepts commas as field separators, because models write them", () => {
    expect(parseType("{ a: string, b: number }")).toEqual(parseType("{ a: string; b: number }"));
  });

  it("accepts a trailing separator and an empty object", () => {
    expect(parseType("{ a: string; }")).toEqual(parseType("{ a: string }"));
    expect(parseType("{}")).toEqual({ kind: "object", fields: {} });
  });

  it("uses parentheses to group unions inside arrays", () => {
    expect(parseType("(string | number)[]")).toEqual({
      kind: "array",
      of: { kind: "union", of: [{ kind: "string" }, { kind: "number" }] },
    });
  });

  it("reads a deeply nested shape", () => {
    expect(parseType("{ postings: { title: string; tags: string[] }[]; total: number }")).toEqual({
      kind: "object",
      fields: {
        postings: {
          type: {
            kind: "array",
            of: {
              kind: "object",
              fields: {
                title: { type: { kind: "string" } },
                tags: { type: { kind: "array", of: { kind: "string" } } },
              },
            },
          },
        },
        total: { type: { kind: "number" } },
      },
    });
  });
});

describe("parse errors", () => {
  it("names the unknown type rather than failing vaguely", () => {
    const result = tryParseType("Posting");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('Unknown type "Posting"');
  });

  it("rejects field names that could not be variables", () => {
    expect(tryParseType('{ "not-valid": string }').ok).toBe(false);
  });

  it("rejects a duplicate field", () => {
    const result = tryParseType("{ a: string; a: number }");
    expect(result.ok === false && result.error).toContain('Duplicate field "a"');
  });

  it("rejects trailing text", () => {
    expect(tryParseType("string number").ok).toBe(false);
  });

  it("rejects an unclosed object", () => {
    expect(tryParseType("{ a: string").ok).toBe(false);
  });

  it("rejects an empty type", () => {
    expect(tryParseType("").ok).toBe(false);
  });
});

describe("describeType and parseType are inverses", () => {
  const samples = [
    "string",
    "number[]",
    "{ title: string; salary?: number }",
    "{ postings: { title: string; tags: string[] }[]; total: number }",
    '"remote" | "hybrid" | "onsite"',
    "string | null",
    "{}",
    "{ nested: { deep: { deeper: boolean } } }",
    "(string | number)[]",
  ];

  for (const sample of samples) {
    it(`round trips ${sample}`, () => {
      const parsed = parseType(sample);
      expect(describeType(parsed)).toBe(sample);
      expect(parseType(describeType(parsed))).toEqual(parsed);
    });
  }
});

describe("union precedence inside arrays", () => {
  it("keeps an array of a union distinct from a union ending in an array", () => {
    const arrayOfUnion = parseType("(string | number)[]");
    const unionWithArray = parseType("string | number[]");

    expect(arrayOfUnion).not.toEqual(unionWithArray);
    expect(describeType(arrayOfUnion)).toBe("(string | number)[]");
    expect(describeType(unionWithArray)).toBe("string | number[]");
  });

  it("brackets an array of an enum", () => {
    const type = parseType('("a" | "b")[]');
    expect(describeType(type)).toBe('("a" | "b")[]');
    expect(parseType(describeType(type))).toEqual(type);
  });
});
