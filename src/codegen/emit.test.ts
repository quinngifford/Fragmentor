import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emitProject, startProject } from "./emit.js";
import { getPack } from "../lang/index.js";
import { blockDir, createProject, loadProject, readManifest, writeBlock } from "../project/project.js";
import type { Manifest } from "../project/project.js";
import { makeBlock } from "../model/testing.js";
import { parseType } from "../model/typeExpression.js";

let dir: string;

const manifest: Manifest = {
  name: "Tiny",
  goal: "Double a number.",
  mode: "structured",
  existingCode: false,
  start: "build",
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

  it("does not mistake half-finished code for an untouched starting point", async () => {
    const halfDone = [
      "export async function doubleIt(input: { value: number }) {",
      '  if (input.value > 10) throw new Error("Double It has no implementation yet.");',
      "  return { doubled: input.value * 2 };",
      "}",
      "",
    ].join("\n");
    await writeFile(compositeFile(), halfDone, "utf8");

    const result = await emitProject(await loadProject(dir));
    expect(result.problems).toEqual([expect.stringContaining("holds code someone wrote")]);
    expect(await readFile(compositeFile(), "utf8")).toBe(halfDone);
  });

  it("replaces an untouched starting point once the block has children", async () => {
    await writeFile(compositeFile(), getPack("typescript").implScaffold(root), "utf8");

    expect((await emitProject(await loadProject(dir))).problems).toEqual([]);
    expect(await readFile(compositeFile(), "utf8")).toContain("Generated by Fragmentor");
  });

  it("leaves generated code in a block that has lost its children for the agent to replace, and says so", async () => {
    await emitProject(await loadProject(dir));
    const generated = await readFile(compositeFile(), "utf8");
    await writeBlock(blockDir(dir, "double-it"), { ...root, kind: "leaf", children: [], wires: [] });

    const result = await emitProject(await loadProject(dir));
    expect(result.problems).toEqual([expect.stringContaining('"Double It" has no children now')]);
    expect(await readFile(compositeFile(), "utf8")).toBe(generated);
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
    expect(result).toEqual({ written: ["FRAGMENTOR.md"], skipped: [], removed: [], problems: [] });
  });
});

describe("startProject", () => {
  it("writes what the person chose and the files an agent reads first, and will not start twice", async () => {
    const fresh = await mkdtemp(path.join(tmpdir(), "fragmentor-start-"));
    try {
      const started = await startProject(fresh, {
        mode: "visual",
        granularity: 2,
        language: null,
        existingCode: true,
        start: "build",
      });
      expect(started.written).toEqual(["fragmentor.json", "FRAGMENTOR.md", "AGENTS.md", "CLAUDE.md"]);

      expect(await readManifest(fresh)).toEqual({
        name: path.basename(fresh),
        goal: "",
        mode: "visual",
        existingCode: true,
        start: "build",
        granularity: { level: 2, maxDepth: 4 },
        systems: [],
      });
      expect(await readFile(path.join(fresh, "FRAGMENTOR.md"), "utf8")).toContain("Never change the program's code");

      await expect(
        startProject(fresh, {
          mode: "structured",
          granularity: 3,
          language: "typescript",
          existingCode: false,
          start: "build",
        }),
      ).rejects.toThrow(/already a Fragmentor project/);
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }
  });
});

describe("planned blocks", () => {
  const there = async (file: string) => access(file).then(() => true, () => false);
  const childFile = (name: string) => path.join(blockDir(dir, "double-it/add-to-self"), name);

  /** The leaf becomes a drawing of something nobody has written. */
  const planTheChild = () =>
    writeBlock(
      blockDir(dir, "double-it/add-to-self"),
      makeBlock({
        id: "add-to-self",
        name: "Add To Self",
        planned: true,
        inputs: { value: { type: parseType("number") } },
        outputs: { sum: { type: parseType("number") } },
      }),
    );

  it("generates nothing for one, and holds back the code of the block above it", async () => {
    await planTheChild();
    const result = await emitProject(await loadProject(dir));

    expect(result.problems).toEqual([]);
    expect(await there(childFile("contract.ts"))).toBe(false);
    expect(await there(childFile("impl.ts"))).toBe(false);

    // The block above is real, so its contract is real. Its code would call
    // a function nobody has written, so that waits.
    expect(await there(path.join(blockDir(dir, "double-it"), "contract.ts"))).toBe(true);
    expect(await there(compositeFile())).toBe(false);
  });

  it("takes back the code it generated once a block becomes planned", async () => {
    await emitProject(await loadProject(dir));
    expect(await there(childFile("contract.ts"))).toBe(true);
    expect(await there(compositeFile())).toBe(true);

    await planTheChild();
    const result = await emitProject(await loadProject(dir));

    expect(result.removed).toEqual([
      "blocks/double-it/add-to-self/contract.ts",
      "blocks/double-it/add-to-self/impl.ts",
      "blocks/double-it/impl.ts",
    ]);
    expect(result.problems).toEqual([]);
  });

  it("never takes back code someone wrote, and says it is there", async () => {
    await emitProject(await loadProject(dir));
    // Real code that happens to keep the starting point's wording in a branch
    // nobody has finished. What decides this is whether the file is the
    // starting point, not whether that phrase appears somewhere in it.
    const written = `export async function addToSelf(input: { value: number }) {
  if (input.value < 0) throw new Error("Add To Self has no implementation yet.");
  return { sum: input.value + input.value };
}
`;
    await writeFile(childFile("impl.ts"), written, "utf8");

    await planTheChild();
    const result = await emitProject(await loadProject(dir));

    expect(result.problems.join(" ")).toMatch(/is planned, so it is only a drawing/);
    expect(await readFile(childFile("impl.ts"), "utf8")).toBe(written);
    expect(result.removed).not.toContain("blocks/double-it/add-to-self/impl.ts");
  });

  it("reports a hand-written composite above a plan rather than quietly leaving it to be run", async () => {
    await emitProject(await loadProject(dir));
    const byHand = `export async function doubleIt(input: { value: number }) {
  return { doubled: input.value * 2 };
}
`;
    await writeFile(compositeFile(), byHand, "utf8");

    await planTheChild();
    const result = await emitProject(await loadProject(dir));

    // Without this it would sit there being typechecked and run as though it
    // were the block, which is the drift generated code exists to prevent.
    expect(result.problems.join(" ")).toMatch(/holds code someone wrote/);
    expect(await readFile(compositeFile(), "utf8")).toBe(byHand);
  });
});
