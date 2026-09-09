import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emitProject } from "./emit.js";
import { blockDir, createProject, loadProject, writeBlock } from "../project/project.js";
import type { Manifest } from "../project/project.js";
import { makeBlock } from "../model/testing.js";
import { parseType } from "../model/typeExpression.js";

let dir: string;

const manifest: Manifest = {
  name: "Tiny",
  goal: "Double a number.",
  rootBlock: "double-it",
  granularity: { level: 3, maxDepth: 3 },
};

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "fragmentor-emit-"));

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

  const child = makeBlock({
    id: "add-to-self",
    name: "Add To Self",
    inputs: { value: { type: parseType("number") } },
    outputs: { sum: { type: parseType("number") } },
    capabilities: { log: { capability: "Logger" } },
  });

  await createProject(dir, manifest, root);
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

describe("emitProject", () => {
  it("writes a contract and a scaffold for every block, plus the shared capabilities", async () => {
    const result = await emitProject(await loadProject(dir));

    expect(result.problems).toEqual([]);
    expect(result.written).toEqual([
      "blocks/capabilities.ts",
      "blocks/double-it/add-to-self/contract.ts",
      "blocks/double-it/add-to-self/impl.ts",
      "blocks/double-it/contract.ts",
      "blocks/double-it/impl.ts",
    ]);
  });

  it("generates contracts that are valid TypeScript", async () => {
    const project = await loadProject(dir);
    await emitProject(project);

    for (const node of project.byPath.values()) {
      const source = await readFile(path.join(node.dir, "contract.ts"), "utf8");
      expect(syntaxErrorsIn(source), node.path).toEqual([]);
    }
    expect(syntaxErrorsIn(await readFile(path.join(dir, "blocks", "capabilities.ts"), "utf8"))).toEqual([]);
  });

  it("never overwrites an implementation that already exists", async () => {
    const project = await loadProject(dir);
    await emitProject(project);

    const implPath = path.join(blockDir(dir, "double-it/add-to-self"), "impl.ts");
    const written = "// hand written, must survive\nexport const marker = 1;\n";
    await writeFile(implPath, written, "utf8");

    const second = await emitProject(await loadProject(dir));

    expect(await readFile(implPath, "utf8")).toBe(written);
    expect(second.skipped).toContain("blocks/double-it/add-to-self/impl.ts");
    expect(second.written).not.toContain("blocks/double-it/add-to-self/impl.ts");
  });

  it("regenerates contracts, because they are derived from the diagram", async () => {
    const project = await loadProject(dir);
    await emitProject(project);

    const contractPath = path.join(blockDir(dir, "double-it/add-to-self"), "contract.ts");
    await writeFile(contractPath, "// stale\n", "utf8");
    await emitProject(await loadProject(dir));

    expect(await readFile(contractPath, "utf8")).toContain("export const addToSelfInput");
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
    expect(result.written).toEqual([]);
    expect(result.problems[0]).toContain('unknown kind "QuantumComputer"');
  });
});
