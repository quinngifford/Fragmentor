import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  existingCode: false,
  start: "build",
  granularity: { level: 3, maxDepth: 3 },
  systems: [{ rootBlock: "double-it", language: "typescript" }],
};

/** A function that owns the helper it calls, which is a function like any other. */
const root = makeBlock({
  id: "double-it",
  name: "Double It",
  inputs: { value: { type: parseType("number") } },
  outputs: { doubled: { type: parseType("number") } },
  capabilities: { log: { capability: "Logger", description: "Records the result." } },
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

const parentFile = () => path.join(blockDir(dir, "double-it"), "impl.ts");

describe("emitProject", () => {
  it("writes each function block's contract and a starting point for its code, the shared capabilities, and the guide", async () => {
    const result = await emitProject(await loadProject(dir));

    expect(result.problems).toEqual([]);
    // A block with a part inside it is a function like any other: its code is
    // the agent's, not generated from its parts.
    expect(result.written).toEqual([
      "FRAGMENTOR.md",
      "blocks/capabilities.ts",
      "blocks/double-it/add-to-self/contract.ts",
      "blocks/double-it/add-to-self/impl.ts",
      "blocks/double-it/contract.ts",
      "blocks/double-it/impl.ts",
    ]);
    expect(await readFile(parentFile(), "utf8")).toContain("Double It has no implementation yet.");

    // Those are created when a folder is prepared for an agent, and belong to
    // the person after that, so generating code never brings them back.
    await expect(readFile(path.join(dir, "AGENTS.md"), "utf8")).rejects.toThrow();
    await expect(readFile(path.join(dir, "CLAUDE.md"), "utf8")).rejects.toThrow();
  });

  it("writes nothing when nothing has changed, so a watching window has nothing to redraw", async () => {
    await emitProject(await loadProject(dir));
    const second = await emitProject(await loadProject(dir));

    expect(second.written).toEqual([]);
    expect(second.skipped).toEqual(["blocks/double-it/add-to-self/impl.ts", "blocks/double-it/impl.ts"]);
  });

  it("generates valid TypeScript", async () => {
    const project = await loadProject(dir);
    await emitProject(project);

    for (const node of project.byPath.values()) {
      const source = await readFile(path.join(node.dir, "contract.ts"), "utf8");
      expect(syntaxErrorsIn(source), node.path).toEqual([]);
    }
    expect(syntaxErrorsIn(await readFile(path.join(dir, "blocks", "capabilities.ts"), "utf8"))).toEqual([]);
  });

  it("never overwrites a block's code once it exists, whether or not it has parts", async () => {
    await emitProject(await loadProject(dir));

    const written = "// hand written, must survive\nexport const marker = 1;\n";
    const child = path.join(blockDir(dir, "double-it/add-to-self"), "impl.ts");
    await writeFile(child, written, "utf8");
    await writeFile(parentFile(), written, "utf8");

    const second = await emitProject(await loadProject(dir));

    expect(await readFile(child, "utf8")).toBe(written);
    expect(await readFile(parentFile(), "utf8")).toBe(written);
    expect(second.written).toEqual([]);
  });

  it("regenerates contracts, because they are derived from the diagram", async () => {
    await emitProject(await loadProject(dir));

    const contractPath = path.join(blockDir(dir, "double-it/add-to-self"), "contract.ts");
    await writeFile(contractPath, "// stale\n", "utf8");
    await emitProject(await loadProject(dir));

    expect(await readFile(contractPath, "utf8")).toContain("export const addToSelfInput");
  });

  it("points out code it once generated from wires rather than replacing it", async () => {
    const old = '// Generated by Fragmentor from block.json. Do not edit: change the diagram instead.\nexport async function doubleIt() {}\n';
    await writeFile(parentFile(), old, "utf8");

    const result = await emitProject(await loadProject(dir));
    expect(result.problems).toEqual([expect.stringContaining('"Double It" has code Fragmentor generated from wires')]);
    expect(await readFile(parentFile(), "utf8")).toBe(old);
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

  it("generates nothing for one, and leaves the block that holds it alone", async () => {
    await planTheChild();
    const result = await emitProject(await loadProject(dir));

    expect(result.problems).toEqual([]);
    expect(await there(childFile("contract.ts"))).toBe(false);
    expect(await there(childFile("impl.ts"))).toBe(false);

    // The block that holds it is real, and its code is its own to write.
    expect(await there(path.join(blockDir(dir, "double-it"), "contract.ts"))).toBe(true);
    expect(await there(parentFile())).toBe(true);
  });

  it("takes back what it generated once a block becomes planned, and only that", async () => {
    await emitProject(await loadProject(dir));
    expect(await there(childFile("contract.ts"))).toBe(true);

    await planTheChild();
    const result = await emitProject(await loadProject(dir));

    expect(result.removed).toEqual(["blocks/double-it/add-to-self/contract.ts", "blocks/double-it/add-to-self/impl.ts"]);
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

});

describe("generating around a piece of the architecture", () => {
  /** The same tiny project, with a database beside the block that reads it. */
  async function addDatabase() {
    await writeBlock(
      blockDir(dir, "double-it/numbers-db"),
      makeBlock({
        id: "numbers-db",
        role: "database",
        exposes: { numbers: { accepts: parseType("{ value: number }"), returns: parseType("{ value: number }") } },
      }),
    );
  }

  it("writes neither a contract nor code for it, and leaves the function that holds it alone", async () => {
    await addDatabase();
    const result = await emitProject(await loadProject(dir));

    expect(result.problems).toEqual([]);
    const written = result.written.join(" ");
    expect(written).not.toContain("numbers-db");
    // A function may own a store only it uses, and is still a function.
    expect(written).toContain("double-it/impl.ts");

    await expect(access(path.join(blockDir(dir, "double-it/numbers-db"), "contract.ts"))).rejects.toThrow();
    await expect(access(path.join(blockDir(dir, "double-it/numbers-db"), "impl.ts"))).rejects.toThrow();
  });

  it("still generates the ordinary blocks beside it", async () => {
    await addDatabase();
    await emitProject(await loadProject(dir));

    // The block that reads the database is a function like any other.
    const contract = await readFile(path.join(blockDir(dir, "double-it/add-to-self"), "contract.ts"), "utf8");
    expect(contract).toContain("AddToSelfInput");
    expect(await readFile(path.join(blockDir(dir, "double-it/add-to-self"), "impl.ts"), "utf8")).toContain("addToSelf");
  });

  it("takes back a contract written before the block became a database", async () => {
    await emitProject(await loadProject(dir));
    const contract = path.join(blockDir(dir, "double-it/add-to-self"), "contract.ts");
    await access(contract);

    await writeBlock(
      blockDir(dir, "double-it/add-to-self"),
      makeBlock({ id: "add-to-self", role: "storage", exposes: { sums: { accepts: parseType("{ value: number }"), returns: parseType("{ value: number }") } } }),
    );
    const result = await emitProject(await loadProject(dir));

    expect(result.removed).toContain("blocks/double-it/add-to-self/contract.ts");
    await expect(access(contract)).rejects.toThrow();
  });

  it("reports code left in a block that has become a database, rather than deleting it", async () => {
    await emitProject(await loadProject(dir));
    const impl = path.join(blockDir(dir, "double-it/add-to-self"), "impl.ts");
    await writeFile(impl, "export async function addToSelf() { return { sum: 1 }; }\n", "utf8");

    await writeBlock(
      blockDir(dir, "double-it/add-to-self"),
      makeBlock({ id: "add-to-self", role: "storage", exposes: { sums: { accepts: parseType("{ value: number }"), returns: parseType("{ value: number }") } } }),
    );

    expect((await emitProject(await loadProject(dir))).problems).toEqual([
      expect.stringContaining("is storage rather than a function, so it is not called and has no code of its own"),
    ]);
    await access(impl);
  });
});
