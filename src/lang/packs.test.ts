import { spawnSync } from "node:child_process";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { getPack, knownLanguages } from "./index.js";
import { camelCase, pascalCase, snakeCase } from "./naming.js";
import { blockFromFile } from "../model/block.js";
import type { Block } from "../model/block.js";

/**
 * The packs are checked against the same blocks, because the point of the
 * seam is that one diagram produces idiomatic code in either language.
 */

const scorePosting: Block = blockFromFile(
  {
    responsibility: "Score one posting against the profile keywords.",
    inputs: {
      posting: "{ title: string; salary?: number; mode: \"remote\" | \"onsite\" }",
      keywords: "string[]",
    },
    outputs: { score: "number", reasons: "string[]" },
    capabilities: { files: { capability: "FileSystem", description: "Reads the cache." } },
  },
  "score-posting",
);

/** A block that takes nothing and returns nothing, which is a block like any other. */
const clearCache: Block = blockFromFile(
  { responsibility: "Empty the cache.", capabilities: { log: "Logger" } },
  "clear-cache",
);

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

  /** What is left of a file once its types are taken out: nothing, for a contract. */
  const valuesIn = (source: string) =>
    ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, removeComments: true } })
      .outputText.replace("export {};", "")
      .trim();

  it("names things the way TypeScript does", () => {
    expect(pack.functionName("score-posting")).toBe("scorePosting");
    expect(pack.typeName("score-posting", "Input")).toBe("ScorePostingInput");
    // A declaration file, which a codebase's own build takes in without ever writing it out.
    expect(pack.contractFile).toBe("contract.d.ts");
    expect(pack.capabilitiesFile).toBe("capabilities.d.ts");
  });

  it("writes a contract of types only, which needs no package and compiles to nothing", () => {
    const source = pack.contractSource({ block: scorePosting, blockPath: "rank-jobs/score-posting" });

    expect(typeScriptErrors(source)).toEqual([]);
    expect(source).toContain('export type ScorePostingInput = {\n  posting: { title: string; salary?: number; mode: "remote" | "onsite" };\n  keywords: string[];\n};');
    expect(source).toContain("export type ScorePostingOutput = {\n  score: number;\n  reasons: string[];\n};");
    expect(source).toContain('import type { FileSystem } from "../../capabilities.js";');
    expect(source).toContain("export interface ScorePostingCaps {\n  /** Reads the cache. */\n  files: FileSystem;\n}");
    expect(source).not.toContain("zod");
    expect(valuesIn(source)).toBe("");
  });

  it("carries a port's description, where an editor shows it", () => {
    const described = blockFromFile(
      { responsibility: "Say hello.", inputs: { name: { type: "string", description: "Who to greet." } }, outputs: { greeting: "string" } },
      "greet",
    );
    expect(pack.contractSource({ block: described, blockPath: "app/greet" })).toContain(
      "export type GreetInput = {\n  /** Who to greet. */\n  name: string;\n};",
    );
  });

  it("declares capabilities as interfaces", () => {
    const source = pack.capabilitiesSource();
    expect(typeScriptErrors(source)).toEqual([]);
    expect(source).toContain("export interface FileSystem {");
    expect(source).toContain("readFile(path: string): Promise<string>;");
    expect(source).toContain("writeFile(path: string, contents: string): Promise<void>;");
    expect(valuesIn(source)).toBe("");
  });

  it("says what a block's code imports to be held to its contract", () => {
    // What is compiled and run is JavaScript, so that is what an import names,
    // and TypeScript finds the declaration file behind it.
    expect(pack.contractSpecifier("../../blocks/rank-jobs/score-posting/contract.d.ts")).toBe(
      "../../blocks/rank-jobs/score-posting/contract.js",
    );
  });

  it("gives a block that returns nothing a result of void, not an empty object", () => {
    const source = pack.contractSource({ block: clearCache, blockPath: "app/clear-cache" });

    expect(typeScriptErrors(source)).toEqual([]);
    expect(source).toContain("export type ClearCacheInput = {};");
    expect(source).toContain("export type ClearCacheOutput = void;");
  });
});

describe("the Python pack", () => {
  const pack = getPack("python");

  it("names things the way Python does", () => {
    expect(pack.functionName("score-posting")).toBe("score_posting");
    expect(pack.typeName("score-posting", "Input")).toBe("ScorePostingInput");
    expect(pack.contractFile).toBe("contract.py");
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

  it("gives a block that returns nothing a result of None", () => {
    expect(pack.contractSource({ block: clearCache, blockPath: "app/clear-cache" })).toContain("ClearCacheOutput = None");
  });

  it.skipIf(!python)("writes Python that actually parses", () => {
    expect(pythonErrors(pack.contractSource({ block: scorePosting, blockPath: "rank-jobs/score-posting" }))).toBe("");
    expect(pythonErrors(pack.capabilitiesSource())).toBe("");
    expect(pythonErrors(pack.contractSource({ block: clearCache, blockPath: "app/clear-cache" }))).toBe("");
  });

  it("holds no Python block to its contract, because how one file reaches another is unsettled", () => {
    expect(pack.contractSpecifier("../../blocks/rank-jobs/score-posting/contract.py")).toBeNull();
    expect(pack.canCheck).toBe(false);
    expect(pack.canRun).toBe(false);
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
