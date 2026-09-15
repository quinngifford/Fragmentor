import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emitProject, startProject } from "./emit.js";
import { blockDir, createProject, loadProject, readManifest, writeBlock } from "../project/project.js";
import type { Manifest } from "../project/project.js";
import { makeBlock } from "../model/testing.js";
import { parseType } from "../model/typeExpression.js";

let dir: string;

const manifest: Manifest = {
  name: "Tiny",
  goal: "Double a number.",
  mode: "structured",
  granularity: { level: 3, maxDepth: 3 },
  systems: [{ rootBlock: "double-it", language: "typescript" }],
};

const root = makeBlock({
  id: "double-it",
  name: "Double It",
  kind: "composite",
  inputs: { value: { type: parseType("number") } },
  outputs: { doubled: { type: parseType("number") } },
  capabilities: { log: { capability: "Logger", description: "Records the result." } },
  children: [{ block: "add-to-self", mode: "once" }],
  wires: [
    { source: { from: "input", port: "value" }, target: { to: "block", block: "add-to-self", port: "value" } },
    { source: { from: "block", block: "add-to-self", port: "sum" }, target: { to: "output", port: "doubled" } },
  ],
});

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "fragmentor-emit-"));

  const child = makeBlock({
    id: "add-to-self",
    name: "Add To Self",
    inputs: { value: { type: parseType("number") } },
    outputs: { sum: { type: parseType("number") } },
    capabilities: { log: { capability: "Logger" } },
  });

  await createProject(dir, manifest, [root]);
  await writeBlock(blockDir(dir, "double-it/add-to-self"), child);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const syntaxErrorsIn = (source: string) =>
  (ts.transpileModule(source, {
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "));

const compositeFile = () => path.join(blockDir(dir, "double-it"), "impl.ts");

describe("emitProject", () => {
  it("writes contracts, a leaf's starting point, a composite's code, the shared capabilities, and the guide", async () => {
    const result = await emitProject(await loadProject(dir));

    expect(result.problems).toEqual([]);
    expect(result.written).toEqual([
      "FRAGMENTOR.md",
      "blocks/capabilities.ts",
      "blocks/double-it/add-to-self/contract.ts",
      "blocks/double-it/add-to-self/impl.ts",
      "blocks/double-it/contract.ts",
      "blocks/double-it/impl.ts",
    ]);

    // Those are created when a folder is prepared for an agent, and belong to
    // the person after that, so generating code never brings them back.
    await expect(readFile(path.join(dir, "AGENTS.md"), "utf8")).rejects.toThrow();
    await expect(readFile(path.join(dir, "CLAUDE.md"), "utf8")).rejects.toThrow();
  });

  it("writes a composite's code as its diagram, call by call", async () => {
    await emitProject(await loadProject(dir));

    const source = await readFile(compositeFile(), "utf8");
    expect(source).toContain('import { addToSelf } from "./add-to-self/impl.js";');
    expect(source).toContain("const { value } = input;");
    expect(source).toContain("const { sum } = await addToSelf({ value }, caps);");
    expect(source).toContain("return { doubled: sum };");
  });

  it("writes nothing when nothing has changed, so a watching window has nothing to redraw", async () => {
    await emitProject(await loadProject(dir));
    const second = await emitProject(await loadProject(dir));

    expect(second.written).toEqual([]);
    expect(second.skipped).toEqual(["blocks/double-it/add-to-self/impl.ts"]);
  });

  it("generates valid TypeScript", async () => {
    const project = await loadProject(dir);
    await emitProject(project);

    for (const node of project.byPath.values()) {
      const source = await readFile(path.join(node.dir, "contract.ts"), "utf8");
      expect(syntaxErrorsIn(source), node.path).toEqual([]);
    }
    expect(syntaxErrorsIn(await readFile(compositeFile(), "utf8"))).toEqual([]);
    expect(syntaxErrorsIn(await readFile(path.join(dir, "blocks", "capabilities.ts"), "utf8"))).toEqual([]);
  });

  it("never overwrites a leaf's implementation once it exists", async () => {
    await emitProject(await loadProject(dir));

    const implPath = path.join(blockDir(dir, "double-it/add-to-self"), "impl.ts");
    const written = "// hand written, must survive\nexport const marker = 1;\n";
    await writeFile(implPath, written, "utf8");

    const second = await emitProject(await loadProject(dir));

    expect(await readFile(implPath, "utf8")).toBe(written);
    expect(second.skipped).toContain("blocks/double-it/add-to-self/impl.ts");
    expect(second.written).not.toContain("blocks/double-it/add-to-self/impl.ts");
  });

  it("regenerates contracts and composites, because they are derived from the diagram", async () => {
    await emitProject(await loadProject(dir));
    const generated = await readFile(compositeFile(), "utf8");

    const contractPath = path.join(blockDir(dir, "double-it/add-to-self"), "contract.ts");
    await writeFile(contractPath, "// stale\n", "utf8");
    await writeFile(compositeFile(), `${generated}// edited by hand\n`, "utf8");
    await emitProject(await loadProject(dir));

    expect(await readFile(contractPath, "utf8")).toContain("export const addToSelfInput");
    expect(await readFile(compositeFile(), "utf8")).toBe(generated);
  });

  it("refuses to overwrite code someone wrote in a block that now has children", async () => {
    const written = "// someone's work\nexport async function doubleIt() {}\n";
    await writeFile(compositeFile(), written, "utf8");

    const result = await emitProject(await loadProject(dir));
    expect(result.problems).toEqual([expect.stringContaining('"Double It" has children, so Fragmentor writes its code')]);
    expect(await readFile(compositeFile(), "utf8")).toBe(written);
  });

  it("gives a block that loses its children a fresh starting point", async () => {
    await emitProject(await loadProject(dir));
    await writeBlock(blockDir(dir, "double-it"), { ...root, kind: "leaf", children: [], wires: [] });

    await emitProject(await loadProject(dir));
    expect(await readFile(compositeFile(), "utf8")).toContain("has no implementation yet");
  });

  it("refuses a capability kind it does not know how to supply", async () => {
    await writeBlock(
      blockDir(dir, "double-it/add-to-self"),
      makeBlock({
        id: "add-to-self",
        name: "Add To Self",
        inputs: { value: { type: parseType("number") } },
        outputs: { sum: { type: parseType("number") } },
        capabilities: { quantum: { capability: "QuantumComputer" } },
      }),
    );

    const result = await emitProject(await loadProject(dir));
    expect(result.written.filter((file) => file.startsWith("blocks/"))).toEqual([]);
    expect(result.problems[0]).toContain('unknown kind "QuantumComputer"');
  });

  it("generates nothing but the guide in a visual project, whose code is the person's own", async () => {
    await writeFile(path.join(dir, "fragmentor.json"), JSON.stringify({ ...manifest, mode: "visual" }), "utf8");

    const result = await emitProject(await loadProject(dir));
    expect(result).toEqual({ written: ["FRAGMENTOR.md"], skipped: [], problems: [] });
  });
});

describe("startProject", () => {
  it("writes what the person chose and the files an agent reads first, and will not start twice", async () => {
    const fresh = await mkdtemp(path.join(tmpdir(), "fragmentor-start-"));
    try {
      const started = await startProject(fresh, { mode: "visual", granularity: 2, language: null });
      expect(started.written).toEqual(["fragmentor.json", "FRAGMENTOR.md", "AGENTS.md", "CLAUDE.md"]);

      expect(await readManifest(fresh)).toEqual({
        name: path.basename(fresh),
        goal: "",
        mode: "visual",
        granularity: { level: 2, maxDepth: 4 },
        systems: [],
      });
      expect(await readFile(path.join(fresh, "FRAGMENTOR.md"), "utf8")).toContain("Never change the program's code");

      await expect(startProject(fresh, { mode: "structured", granularity: 3, language: "typescript" })).rejects.toThrow(
        /already a Fragmentor project/,
      );
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }
  });
});
