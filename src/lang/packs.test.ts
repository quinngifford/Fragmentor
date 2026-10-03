import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { getPack, knownLanguages } from "./index.js";
import { camelCase, pascalCase, snakeCase } from "./naming.js";
import { blockFromFile } from "../model/block.js";
import type { Block } from "../model/block.js";
import { parseType } from "../model/typeExpression.js";

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

/** The oldest Python the generated contracts run on, for really importing one. */
function python311Command(): string | null {
  if (!python) return null;
  const probe = spawnSync(python, ["-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)"], {
    encoding: "utf8",
  });
  return probe.status === 0 ? python : null;
}

const python311 = python311Command();

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
    // A declaration file in the block's own folder, which a codebase's own
    // build takes in without ever writing it out.
    expect(pack.contractPath("rank-jobs/score-posting")).toBe("blocks/rank-jobs/score-posting/contract.d.ts");
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

  it("keeps a description that says `*/` inside its comment, where it cannot end it early", () => {
    const described = blockFromFile(
      { responsibility: "Match paths.", inputs: { glob: { type: "string", description: "A pattern such as src/**/*.ts" } }, outputs: {} },
      "match",
    );
    const source = pack.contractSource({ block: described, blockPath: "app/match" });
    expect(typeScriptErrors(source)).toEqual([]);
    expect(source).toContain("/** A pattern such as src/**\\/*.ts */");
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
    expect(pack.contractSpecifier("blocks/rank-jobs/score-posting/contract.d.ts", "src/jobs/score.ts")).toBe(
      "../../blocks/rank-jobs/score-posting/contract.js",
    );
    // Code beside its contract imports it from where they both are.
    expect(pack.contractSpecifier("blocks/rank-jobs/score-posting/contract.d.ts", "blocks/rank-jobs/score-posting/impl.ts")).toBe(
      "./contract.js",
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

  /** A block whose id, an input and a nested field are words Python reserves, which the diagram may well use. */
  const importEvents: Block = blockFromFile(
    {
      responsibility: "Bring event rows in.",
      inputs: { rows: "{ id: string }[]", class: '"standard" | "premium"', flags: "{ class?: boolean; on: boolean }" },
      outputs: { imported: "number" },
      capabilities: { events: { capability: "Store", description: "Holds the events." } },
    },
    "import",
  );

  it("names things the way Python does, mirroring block paths where imports cannot follow them", () => {
    expect(pack.functionName("score-posting")).toBe("score_posting");
    expect(pack.typeName("score-posting", "Input")).toBe("ScorePostingInput");
    // Python cannot import through a hyphen, so contracts live in a mirror it can.
    expect(pack.contractPath("rank-jobs/score-posting")).toBe("blocks/_contracts/rank_jobs/score_posting/contract.py");
    expect(pack.contractPath("app/import")).toBe("blocks/_contracts/app/import_/contract.py");
    expect(pack.capabilitiesFile).toBe("capabilities.py");
  });

  it("writes contracts as plain typed dictionaries, whose keys are the diagram's own names", () => {
    const source = pack.contractSource({ block: scorePosting, blockPath: "rank-jobs/score-posting" });

    expect(source).toContain("class ScorePostingInputPosting(TypedDict):");
    expect(source).toContain("    title: str");
    expect(source).toContain("    salary: NotRequired[float]");
    expect(source).toContain('    mode: Literal["remote", "onsite"]');
    expect(source).toContain("class ScorePostingInput(TypedDict):");
    expect(source).toContain("    posting: ScorePostingInputPosting");
    expect(source).toContain("    keywords: list[str]");
    expect(source).not.toContain("pydantic");
    expect(source).not.toContain("BaseModel");
  });

  it("uses the functional form where a key is a word Python reserves, optional keys included", () => {
    const source = pack.contractSource({ block: importEvents, blockPath: "app/import" });
    expect(source).toContain("class ImportInputRowsItem(TypedDict):");
    expect(source).toContain("ImportInputFlags = TypedDict('ImportInputFlags', {'class': NotRequired[bool], 'on': bool})");
    expect(source).toContain(
      "ImportInput = TypedDict('ImportInput', {'rows': list[ImportInputRowsItem], 'class': Literal[\"standard\", \"premium\"], 'flags': ImportInputFlags})",
    );
  });

  it("keeps capabilities structural and read-only, so a parent can pass its whole caps down", () => {
    const source = pack.contractSource({ block: scorePosting, blockPath: "rank-jobs/score-posting" });
    expect(source).toContain("class ScorePostingCaps(Protocol):");
    expect(source).toContain('    @property\n    def files(self) -> FileSystem:\n        """Reads the cache."""\n        ...');
    expect(source).toContain("from blocks.capabilities import FileSystem");
  });

  it("writes a Store in terms of what it holds, under a Row name no port can collide with", () => {
    const bound = pack.contractSource({
      block: importEvents,
      blockPath: "app/import",
      bound: { events: parseType("{ id: string; name: string }") },
    });
    expect(bound).toContain("class ImportEventsRow(TypedDict):");
    expect(bound).toContain("def events(self) -> Store[ImportEventsRow]:");

    // A port nothing binds falls back to Any, which check reports separately.
    const unbound = pack.contractSource({ block: importEvents, blockPath: "app/import" });
    expect(unbound).toContain("def events(self) -> Store[Any]:");

    // A port called input would otherwise name its row after the block's own
    // Input dictionary, and the contract would declare that name twice.
    const clashing = blockFromFile(
      {
        responsibility: "Keep rows.",
        inputs: { key: "string" },
        outputs: { kept: "boolean" },
        capabilities: { input: { capability: "Store" } },
      },
      "keep-rows",
    );
    const source = pack.contractSource({
      block: clashing,
      blockPath: "app/keep-rows",
      bound: { input: parseType("{ id: string }") },
    });
    expect(source).toContain("class KeepRowsInputRow(TypedDict):");
    expect(source).toContain("class KeepRowsInput(TypedDict):");
    expect(source).toContain("def input(self) -> Store[KeepRowsInputRow]: ...");
  });

  it("keeps a description's backslashes and quotes from breaking the docstring they land in", () => {
    const nasty = blockFromFile(
      {
        responsibility: "Cache things.",
        capabilities: { files: { capability: "FileSystem", description: 'Reads the cache at C:\\Users\\app, the "live" one.' } },
      },
      "cache-things",
    );
    const source = pack.contractSource({ block: nasty, blockPath: "app/cache-things" });
    expect(source).toContain('"""Reads the cache at C:\\\\Users\\\\app, the \\"live\\" one."""');
    expect(pythonErrors(source)).toBe("");

    const named = blockFromFile({ name: 'The "big" cache', responsibility: "Cache things." }, "big-cache");
    const empty = pack.contractSource({ block: named, blockPath: "app/big-cache" });
    expect(empty).toContain('"""The \\"big\\" cache needs no effects supplied from outside."""');
    expect(pythonErrors(empty)).toBe("");
  });

  it("declares capabilities as protocols with snake_case methods, and lets a message narrow", () => {
    const source = pack.capabilitiesSource();
    expect(source).toContain("import builtins");
    expect(source).toContain('Row = TypeVar("Row")');
    // Nothing gives a message back, so a callee may take a wider one — which
    // is what lets a caller hand its whole caps to a callee's narrower queue.
    expect(source).toContain('Message = TypeVar("Message", contravariant=True)');
    expect(source).toContain("class Store(Protocol, Generic[Row]):");
    // `builtins.list`, because Store has a method called `list` of its own.
    expect(source).toContain("    async def list(self) -> builtins.list[Row]: ...");
    expect(source).toContain("class FileSystem(Protocol):");
    expect(source).toContain("    async def read_file(self, path: str) -> str: ...");
    expect(source).toContain("    async def write_file(self, path: str, contents: str) -> None: ...");
  });

  it("gives a block that returns nothing a result of None", () => {
    expect(pack.contractSource({ block: clearCache, blockPath: "app/clear-cache" })).toContain(
      "ClearCacheOutput: TypeAlias = None",
    );
  });

  it("says what a block's code imports to be held to its contract: the contract's own module", () => {
    expect(pack.contractSpecifier("blocks/_contracts/rank_jobs/score_posting/contract.py", "src/jobs/score.py")).toBe(
      "blocks._contracts.rank_jobs.score_posting.contract",
    );
  });

  it("says why a file Python could not import can never be bound", () => {
    expect(pack.codeFileProblem!("src/book-seats.py")).toContain("Python cannot import src/book-seats.py");
    expect(pack.codeFileProblem!("src/import/events.py")).toContain('"import"');
    expect(pack.codeFileProblem!("src/booking/book_seats.py")).toBeNull();
  });

  it("refuses to write a contract whose capability port would shadow a name the contract needs", () => {
    const reserved = blockFromFile({ responsibility: "Log.", capabilities: { class: "Logger" } }, "log-it");
    expect(pack.contractProblem!(reserved)).toContain('capability port "class"');
    expect(pack.contractProblem!(reserved)).toContain("rename the port");
    // Not a keyword, but the name every array annotation in the contract uses.
    const shadowing = blockFromFile({ responsibility: "List.", capabilities: { list: "Logger" } }, "list-it");
    expect(pack.contractProblem!(shadowing)).toContain('capability port "list"');
    expect(pack.contractProblem!(clearCache)).toBeNull();
  });

  it.skipIf(!python)("writes Python that actually parses", () => {
    expect(pythonErrors(pack.contractSource({ block: scorePosting, blockPath: "rank-jobs/score-posting" }))).toBe("");
    expect(pythonErrors(pack.contractSource({ block: importEvents, blockPath: "app/import" }))).toBe("");
    expect(pythonErrors(pack.capabilitiesSource())).toBe("");
    expect(pythonErrors(pack.contractSource({ block: clearCache, blockPath: "app/clear-cache" }))).toBe("");
  });

  it.skipIf(!python311)("generates contracts a 3.11 interpreter imports, keys exactly as written", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "fragmentor-packs-"));
    try {
      const write = async (relative: string, contents: string) => {
        const target = path.join(dir, ...relative.split("/"));
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, contents, "utf8");
      };
      await write("blocks/capabilities.py", pack.capabilitiesSource());
      await write(pack.contractPath("rank-jobs/score-posting"), pack.contractSource({ block: scorePosting, blockPath: "rank-jobs/score-posting" }));
      await write(pack.contractPath("app/import"), pack.contractSource({ block: importEvents, blockPath: "app/import" }));

      const result = spawnSync(
        python311!,
        [
          "-I",
          "-c",
          [
            "import json, sys",
            "sys.path.insert(0, '')",
            "from blocks._contracts.rank_jobs.score_posting.contract import ScorePostingInput, ScorePostingInputPosting",
            "from blocks._contracts.app.import_.contract import ImportInput, ImportInputFlags",
            "print(json.dumps({",
            "  'input': sorted(ScorePostingInput.__required_keys__),",
            "  'optional': sorted(ScorePostingInputPosting.__optional_keys__),",
            "  'keyword': sorted(ImportInput.__required_keys__),",
            "  'keywordOptional': sorted(ImportInputFlags.__optional_keys__),",
            "}))",
          ].join("\n"),
        ],
        { cwd: dir, encoding: "utf8" },
      );

      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({
        input: ["keywords", "posting"],
        optional: ["salary"],
        keyword: ["class", "flags", "rows"],
        keywordOptional: ["class"],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
