import { spawnSync } from "node:child_process";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { getPack, knownLanguages } from "./index.js";
import { camelCase, pascalCase, snakeCase } from "./naming.js";
import { blockSchema } from "../model/block.js";
import type { Block } from "../model/block.js";

/**
 * The packs are checked against the same block, because the point of the seam
 * is that one diagram produces idiomatic code in either language.
 */

const scorePosting: Block = blockSchema.parse({
  id: "score-posting",
  name: "Score Posting",
  responsibility: "Score one posting against the profile keywords.",
  kind: "leaf",
  inputs: {
    posting: { type: "{ title: string; salary?: number; mode: \"remote\" | \"onsite\" }" },
    keywords: { type: "string[]" },
  },
  outputs: { score: { type: "number" }, reasons: { type: "string[]" } },
  capabilities: { files: { capability: "FileSystem", description: "Reads the cache." } },
});

function typeScriptErrors(source: string): string[] {
  const result = ts.transpileModule(source, {
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  return (result.diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "));
}

/** Finds a Python that can parse a file, or nothing if the machine has none. */
function pythonCommand(): string | null {
  for (const candidate of ["python", "python3", "py"]) {
    const probe = spawnSync(candidate, ["-c", "print(1)"], { encoding: "utf8" });
    if (probe.status === 0) return candidate;
  }
  return null;
}

const python = pythonCommand();

function pythonErrors(source: string): string {
  if (!python) return "";
  const result = spawnSync(python, ["-c", "import ast,sys; ast.parse(sys.stdin.read())"], {
    input: source,
    encoding: "utf8",
  });
  return result.status === 0 ? "" : result.stderr;
}

describe("naming", () => {
  it("turns a block id into each language's convention", () => {
    expect(camelCase("rank-jobs")).toBe("rankJobs");
    expect(pascalCase("rank-jobs")).toBe("RankJobs");
    expect(snakeCase("rank-jobs")).toBe("rank_jobs");
    expect(camelCase("score")).toBe("score");
    expect(snakeCase("score")).toBe("score");
    expect(pascalCase("find-top-3-matches")).toBe("FindTop3Matches");
  });

  it("breaks camelCase apart when going to snake_case, for method names", () => {
    expect(snakeCase("readFile")).toBe("read_file");
    expect(snakeCase("writeFile")).toBe("write_file");
  });
});

describe("the pack registry", () => {
  it("knows both packs", () => {
    expect(knownLanguages().map((l) => l.id).sort()).toEqual(["python", "typescript"]);
  });

  it("says what it does have when asked for one it does not", () => {
    expect(() => getPack("cobol")).toThrow(/No language pack for "cobol".*python, typescript/s);
  });
});

describe("the TypeScript pack", () => {
  const pack = getPack("typescript");

  it("names things the way TypeScript does", () => {
    expect(pack.functionName("score-posting")).toBe("scorePosting");
    expect(pack.typeName("score-posting", "Input")).toBe("ScorePostingInput");
    expect(pack.implFile).toBe("impl.ts");
  });

  it("writes a contract that compiles", () => {
    const source = pack.contractSource({ block: scorePosting, blockPath: "rank-jobs/score-posting" });

    expect(typeScriptErrors(source)).toEqual([]);
    expect(source).toContain("export const scorePostingInput = z.object({");
    expect(source).toContain("salary: z.number().optional()");
    expect(source).toContain('z.enum(["remote", "onsite"])');
    expect(source).toContain("export interface ScorePostingCaps {");
    expect(source).toContain("  files: FileSystem;");
  });

  it("declares capabilities as interfaces", () => {
    const source = pack.capabilitiesSource();
    expect(typeScriptErrors(source)).toEqual([]);
    expect(source).toContain("export interface FileSystem {");
    expect(source).toContain("readFile(path: string): Promise<string>;");
    expect(source).toContain("writeFile(path: string, contents: string): Promise<void>;");
  });

  it("recognises its own untouched scaffold", () => {
    expect(pack.isUnimplemented(pack.implScaffold(scorePosting))).toBe(true);
    expect(pack.isUnimplemented("export async function scorePosting() { return { score: 1 }; }")).toBe(false);
  });
});

describe("the Python pack", () => {
  const pack = getPack("python");

  it("names things the way Python does", () => {
    expect(pack.functionName("score-posting")).toBe("score_posting");
    expect(pack.typeName("score-posting", "Input")).toBe("ScorePostingInput");
    expect(pack.implFile).toBe("impl.py");
  });

  it("gives every anonymous object a named model, which TypeScript does not need", () => {
    const source = pack.contractSource({ block: scorePosting, blockPath: "rank-jobs/score-posting" });

    expect(source).toContain("class ScorePostingInputPosting(BaseModel):");
    expect(source).toContain("    title: str");
    expect(source).toContain("    salary: float | None = None");
    expect(source).toContain('    mode: Literal["remote", "onsite"]');
    expect(source).toContain("class ScorePostingInput(BaseModel):");
    expect(source).toContain("    posting: ScorePostingInputPosting");
    expect(source).toContain("    keywords: list[str]");
  });

  it("keeps capabilities structural, so a parent can pass its whole caps down", () => {
    const source = pack.contractSource({ block: scorePosting, blockPath: "rank-jobs/score-posting" });
    expect(source).toContain("class ScorePostingCaps(Protocol):");
    expect(source).toContain("    files: FileSystem");
    expect(source).toContain("from capabilities import FileSystem");
  });

  it("declares capabilities as protocols with snake_case methods", () => {
    const source = pack.capabilitiesSource();
    expect(source).toContain("class FileSystem(Protocol):");
    expect(source).toContain("    async def read_file(self, path: str) -> str: ...");
    expect(source).toContain("    async def write_file(self, path: str, contents: str) -> None: ...");
  });

  it.skipIf(!python)("writes Python that actually parses", () => {
    expect(pythonErrors(pack.contractSource({ block: scorePosting, blockPath: "rank-jobs/score-posting" }))).toBe("");
    expect(pythonErrors(pack.implScaffold(scorePosting))).toBe("");
    expect(pythonErrors(pack.capabilitiesSource())).toBe("");
  });

  it("recognises its own untouched scaffold", () => {
    expect(pack.isUnimplemented(pack.implScaffold(scorePosting))).toBe(true);
    expect(pack.isUnimplemented("async def score_posting(value, caps):\n    return {}")).toBe(false);
  });
});

describe("the two packs on the same block", () => {
  it("differ exactly where the languages differ", () => {
    const typescript = getPack("typescript");
    const python = getPack("python");

    expect(typescript.functionName("score-posting")).not.toBe(python.functionName("score-posting"));
    // Type names are the one convention the two share.
    expect(typescript.typeName("score-posting", "Output")).toBe(python.typeName("score-posting", "Output"));

    expect(typescript.typeExpression({ kind: "array", of: { kind: "string" } })).toBe("string[]");
    expect(python.typeExpression({ kind: "array", of: { kind: "string" } })).toBe("list[str]");
  });
});
