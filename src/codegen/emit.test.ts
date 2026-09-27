import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMMANDS } from "./commands.js";
import { emitProject, startProject, writeCommandSkills } from "./emit.js";
import { SKILLS_DIR, commandSkill } from "./guide.js";
import { blockDir, createProject, loadProject, readManifest, writeBlock } from "../project/project.js";
import { gitIn } from "../project/exampleHistory.js";
import type { Manifest } from "../project/project.js";
import { makeBlock } from "../model/testing.js";
import { parseType } from "../model/typeExpression.js";

let dir: string;

const manifest: Manifest = {
  name: "Tiny",
  goal: "Double a number.",
  existingCode: false,
  start: "build",
  granularity: { level: 3, maxDepth: 3 },
  systems: [{ rootBlock: "double-it", language: "typescript" }],
};

/**
 * A function that owns the helper it calls, with the code of both under `src/`.
 *
 * The code says where its contract is, which is what binds the two: nothing
 * about a block's folder decides where its code lives, and Fragmentor writes
 * no code of its own at all.
 */
const root = makeBlock({
  id: "double-it",
  name: "Double It",
  code: "src/double-it.ts#doubleIt",
  inputs: { value: { type: parseType("number") } },
  outputs: { doubled: { type: parseType("number") } },
  capabilities: { log: { capability: "Logger", description: "Records the result." } },
});

const child = makeBlock({
  id: "add-to-self",
  name: "Add To Self",
  code: "src/add-to-self.ts#addToSelf",
  inputs: { value: { type: parseType("number") } },
  outputs: { sum: { type: parseType("number") } },
  capabilities: { log: { capability: "Logger" } },
});

const CODE: Record<string, string> = {
  "src/double-it.ts": `import type { DoubleItInput, DoubleItOutput, DoubleItCaps } from "../blocks/double-it/contract.js";
import { addToSelf } from "./add-to-self.js";

export async function doubleIt(input: DoubleItInput, caps: DoubleItCaps): Promise<DoubleItOutput> {
  const { sum } = await addToSelf({ value: input.value }, caps);
  return { doubled: sum };
}
`,
  "src/add-to-self.ts": `import type { AddToSelfInput, AddToSelfOutput, AddToSelfCaps } from "../blocks/double-it/add-to-self/contract.js";

export async function addToSelf(input: AddToSelfInput, caps: AddToSelfCaps): Promise<AddToSelfOutput> {
  return { sum: input.value + input.value };
}
`,
};

async function writeCode(files: Record<string, string> = CODE): Promise<void> {
  for (const [file, source] of Object.entries(files)) {
    const target = path.join(dir, ...file.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, source, "utf8");
  }
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "fragmentor-emit-"));
  await createProject(dir, manifest, [root]);
  await writeBlock(blockDir(dir, "double-it/add-to-self"), child);
  await writeCode();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const syntaxErrorsIn = (source: string) =>
  (ts.transpileModule(source, {
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "));

const there = async (file: string) => access(file).then(() => true, () => false);

/** The slash command Claude Code offers for each command, as the files Fragmentor writes for them. */
const SKILLS = COMMANDS.map((command) => `${SKILLS_DIR}/fragmentor-${command.name}/SKILL.md`);

describe("emitProject", () => {
  it("writes the contract of each block one can be written for, the shared capabilities, the guide and the slash commands", async () => {
    const result = await emitProject(await loadProject(dir));

    expect(result.problems).toEqual([]);
    expect(result.written).toEqual([
      ...[...SKILLS].sort(),
      "FRAGMENTOR.md",
      "blocks/capabilities.d.ts",
      "blocks/double-it/add-to-self/contract.d.ts",
      "blocks/double-it/contract.d.ts",
    ]);

    // Fragmentor writes no code, so nothing appears beside a block's own file
    // and nothing in the codebase is touched.
    expect(await there(path.join(blockDir(dir, "double-it"), "impl.ts"))).toBe(false);
    expect(await readFile(path.join(dir, "src", "double-it.ts"), "utf8")).toBe(CODE["src/double-it.ts"]);

    // Those are created when a folder is prepared for an agent, and belong to
    // the person after that, so generating never brings them back.
    await expect(readFile(path.join(dir, "AGENTS.md"), "utf8")).rejects.toThrow();
    await expect(readFile(path.join(dir, "CLAUDE.md"), "utf8")).rejects.toThrow();
  });

  it("writes nothing when nothing has changed, so a watching window has nothing to redraw", async () => {
    await emitProject(await loadProject(dir));
    expect((await emitProject(await loadProject(dir))).written).toEqual([]);
  });

  it("generates valid TypeScript", async () => {
    const project = await loadProject(dir);
    await emitProject(project);

    for (const node of project.byPath.values()) {
      const source = await readFile(path.join(node.dir, "contract.d.ts"), "utf8");
      expect(syntaxErrorsIn(source), node.path).toEqual([]);
    }
    expect(syntaxErrorsIn(await readFile(path.join(dir, "blocks", "capabilities.d.ts"), "utf8"))).toEqual([]);
  });

  it("regenerates contracts, because they are derived from the diagram", async () => {
    await emitProject(await loadProject(dir));

    const contractPath = path.join(blockDir(dir, "double-it/add-to-self"), "contract.d.ts");
    await writeFile(contractPath, "// stale\n", "utf8");
    await emitProject(await loadProject(dir));

    expect(await readFile(contractPath, "utf8")).toContain("export type AddToSelfInput");
  });

  it("writes a contract before the code imports it, which is how the code comes to import it", async () => {
    // The same code, describing its own shapes instead of being held to the
    // block's. The contract is still written: an agent cannot import a file
    // that is not there, and the import is what binds the two afterwards.
    await writeFile(
      path.join(dir, "src", "add-to-self.ts"),
      `export async function addToSelf(input: { value: number }) {
  return { sum: input.value + input.value };
}
`,
      "utf8",
    );

    const result = await emitProject(await loadProject(dir));
    expect(result.removed).toEqual([]);
    expect(result.written).toContain("blocks/double-it/add-to-self/contract.d.ts");
  });

  it("takes the shared capabilities away once there is no contract left to import it", async () => {
    await emitProject(await loadProject(dir));
    const capabilities = path.join(dir, "blocks", "capabilities.d.ts");
    expect(await there(capabilities)).toBe(true);

    // Every block becomes a piece of the architecture, so nothing is generated.
    for (const [blockPath, id] of [["double-it", "double-it"], ["double-it/add-to-self", "add-to-self"]] as const) {
      await writeBlock(
        blockDir(dir, blockPath),
        makeBlock({ id, role: "storage", exposes: { rows: { accepts: parseType("{ value: number }"), returns: parseType("{ value: number }") } } }),
      );
    }

    const result = await emitProject(await loadProject(dir));
    expect(result.removed).toContain("blocks/capabilities.d.ts");
    expect(await there(capabilities)).toBe(false);
  });

  it("moves a project over from contracts that were .ts files, taking away only what Fragmentor wrote", async () => {
    const at = (file: string) => path.join(dir, "blocks", ...file.split("/"));
    await writeFile(at("capabilities.ts"), "// Generated by Fragmentor. Do not edit.\n\nexport interface Clock {}\n", "utf8");
    await writeFile(at("double-it/contract.ts"), '// Generated by Fragmentor from block.json. Do not edit.\n\nimport { z } from "zod";\n', "utf8");
    // A file of the same name that someone wrote themselves is theirs.
    await writeFile(at("double-it/add-to-self/contract.ts"), "export type Mine = number;\n", "utf8");

    const result = await emitProject(await loadProject(dir));
    expect(result.removed).toEqual(["blocks/capabilities.ts", "blocks/double-it/contract.ts"]);
    expect(result.written).toContain("blocks/double-it/contract.d.ts");
    expect(result.written).toContain("blocks/capabilities.d.ts");
    expect(await there(at("double-it/add-to-self/contract.ts"))).toBe(true);
  });

  it("leaves a codebase's own build as it was, however much of the folder it compiles", async () => {
    // A build with no `include` and no `rootDir`, as a project that has never
    // heard of Fragmentor has, so it takes in every .ts file under the folder.
    await emitProject(await loadProject(dir));
    const everything = (await readdir(dir, { recursive: true }))
      .map((file) => path.join(dir, file))
      .filter((file) => file.endsWith(".ts"));
    const out = path.join(dir, "lib");
    const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, strict: true, outDir: out, types: [] };
    const program = ts.createProgram(everything, options);

    // No package is needed, zod or any other.
    expect(ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "))).toEqual([]);
    program.emit();
    // The output is laid out from `src/`, exactly as it would be with no blocks at all.
    expect((await readdir(out, { recursive: true })).map((file) => file.split(path.sep).join("/")).sort()).toEqual([
      "add-to-self.js",
      "double-it.js",
    ]);
  });

  it("writes a contract for each block sharing one file, because a file may hold several", async () => {
    await writeFile(
      path.join(dir, "src", "add-to-self.ts"),
      `${CODE["src/add-to-self.ts"]}\nexport async function addToSelfTwice() {}\n`,
      "utf8",
    );
    await writeBlock(
      blockDir(dir, "double-it/add-twice"),
      makeBlock({
        id: "add-twice",
        code: "src/add-to-self.ts#addToSelfTwice",
        inputs: { value: { type: parseType("number") } },
        outputs: { sum: { type: parseType("number") } },
      }),
    );

    // Both blocks point into the one file, and that file imports both
    // contracts, so both are written.
    await writeFile(
      path.join(dir, "src", "add-to-self.ts"),
      `import type { AddTwiceInput } from "../blocks/double-it/add-twice/contract.js";\n${CODE["src/add-to-self.ts"]}\nexport async function addToSelfTwice(input: AddTwiceInput) {\n  return { sum: input.value * 4 };\n}\n`,
      "utf8",
    );

    const result = await emitProject(await loadProject(dir));
    expect(result.written).toContain("blocks/double-it/add-twice/contract.d.ts");
    expect(result.written).toContain("blocks/double-it/add-to-self/contract.d.ts");
  });

  it("refuses a capability kind it does not know how to supply", async () => {
    await writeBlock(
      blockDir(dir, "double-it/add-to-self"),
      makeBlock({
        id: "add-to-self",
        name: "Add To Self",
        code: "src/add-to-self.ts#addToSelf",
        inputs: { value: { type: parseType("number") } },
        outputs: { sum: { type: parseType("number") } },
        capabilities: { quantum: { capability: "QuantumComputer" } },
      }),
    );

    const result = await emitProject(await loadProject(dir));
    expect(result.written.filter((file) => file.startsWith("blocks/"))).toEqual([]);
    expect(result.problems[0]).toContain('unknown kind "QuantumComputer"');
  });

  it("writes nothing but the guide and the slash commands where there is no language pack", async () => {
    await writeFile(
      path.join(dir, "fragmentor.json"),
      JSON.stringify({ ...manifest, systems: [{ rootBlock: "double-it", language: "Fortran" }] }),
      "utf8",
    );

    const result = await emitProject(await loadProject(dir));
    expect(result).toEqual({ written: [...[...SKILLS].sort(), "FRAGMENTOR.md"], removed: [], problems: [] });
  });
});

describe("startProject", () => {
  const settings = { granularity: 3, language: "typescript", existingCode: false, start: "build" } as const;

  it("writes what the person chose and the files an agent reads first, and will not start twice", async () => {
    const fresh = await mkdtemp(path.join(tmpdir(), "fragmentor start "));
    try {
      const started = await startProject(fresh, {
        granularity: 2,
        language: null,
        existingCode: true,
        start: "build",
      });
      expect(started.written).toEqual(["fragmentor.json", "FRAGMENTOR.md", "AGENTS.md", "CLAUDE.md", ...SKILLS, ".gitignore"]);
      // Its blocks' versions will be the commits of the repository it starts,
      // which ignores what the watcher ignores and holds nothing yet.
      expect(await there(path.join(fresh, ".git"))).toBe(true);
      expect(await readFile(path.join(fresh, ".gitignore"), "utf8")).toBe("node_modules/\n__pycache__/\n");
      expect(started.history).toBe("Started a git repository here. Each commit of a block is a version of it; nothing is committed yet.");

      expect(await readManifest(fresh)).toEqual({
        name: path.basename(fresh),
        goal: "",
        existingCode: true,
        start: "build",
        granularity: { level: 2, maxDepth: 4 },
        systems: [],
      });
      expect(await readFile(path.join(fresh, "FRAGMENTOR.md"), "utf8")).toContain("**This folder already held code**");

      await expect(
        startProject(fresh, { granularity: 3, language: "typescript", existingCode: false, start: "build" }),
      ).rejects.toThrow(/already a Fragmentor project/);
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }
  });

  it("takes a language named the way a person writes it", async () => {
    const fresh = await mkdtemp(path.join(tmpdir(), "fragmentor start "));
    try {
      await startProject(fresh, { granularity: 3, language: "TypeScript", existingCode: false, start: "build" });
      expect((await readManifest(fresh)).language).toBe("typescript");
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }
  });

  it("starts no repository inside one, and says which one holds it", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "fragmentor start "));
    try {
      await gitIn(repo)("init", "--quiet");
      const inside = path.join(repo, "my project");

      const started = await startProject(inside, settings);
      expect(started.written).not.toContain(".gitignore");
      expect(await there(path.join(inside, ".git"))).toBe(false);
      expect(await there(path.join(inside, ".gitignore"))).toBe(false);
      expect(started.history).toMatch(/^Its history is kept in the git repository at .+\.$/);
      expect(started.history).toContain(path.basename(repo));
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("keeps a .gitignore that was already there, byte for byte", async () => {
    const fresh = await mkdtemp(path.join(tmpdir(), "fragmentor start "));
    try {
      await writeFile(path.join(fresh, ".gitignore"), "dist/\r\n", "utf8");

      const started = await startProject(fresh, settings);
      expect(await there(path.join(fresh, ".git"))).toBe(true);
      expect(started.written).not.toContain(".gitignore");
      expect(await readFile(path.join(fresh, ".gitignore"), "utf8")).toBe("dist/\r\n");
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }
  });

  it("still starts the project where git is not installed, and says so", async () => {
    const fresh = await mkdtemp(path.join(tmpdir(), "fragmentor start "));
    const nowhere = await mkdtemp(path.join(tmpdir(), "fragmentor no git "));
    const searched = process.env.PATH;
    process.env.PATH = nowhere;
    try {
      const started = await startProject(fresh, settings);
      expect(started.written).toEqual(["fragmentor.json", "FRAGMENTOR.md", "AGENTS.md", "CLAUDE.md", ...SKILLS]);
      expect(started.history).toContain("Git is not installed");
      expect(await there(path.join(fresh, ".git"))).toBe(false);
    } finally {
      process.env.PATH = searched;
      await rm(fresh, { recursive: true, force: true });
      await rm(nowhere, { recursive: true, force: true });
    }
  });
});

describe("blocks nothing is generated for", () => {
  const childContract = () => path.join(blockDir(dir, "double-it/add-to-self"), "contract.d.ts");

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

  it("writes nothing for a planned block, and leaves the block that holds it alone", async () => {
    await planTheChild();
    const result = await emitProject(await loadProject(dir));

    expect(result.problems).toEqual([]);
    expect(await there(childContract())).toBe(false);
    expect(await there(path.join(blockDir(dir, "double-it"), "contract.d.ts"))).toBe(true);
  });

  it("takes back what it wrote once a block becomes planned", async () => {
    await emitProject(await loadProject(dir));
    expect(await there(childContract())).toBe(true);

    await planTheChild();
    const result = await emitProject(await loadProject(dir));

    expect(result.removed).toEqual(["blocks/double-it/add-to-self/contract.d.ts"]);
    expect(result.problems).toEqual([]);
  });

  it("writes nothing for a piece of the architecture, and takes back what it wrote before", async () => {
    await emitProject(await loadProject(dir));
    await access(childContract());

    await writeBlock(
      blockDir(dir, "double-it/add-to-self"),
      makeBlock({
        id: "add-to-self",
        role: "storage",
        exposes: { sums: { accepts: parseType("{ value: number }"), returns: parseType("{ value: number }") } },
      }),
    );
    const result = await emitProject(await loadProject(dir));

    expect(result.removed).toContain("blocks/double-it/add-to-self/contract.d.ts");
    expect(await there(childContract())).toBe(false);
    // A function may own a store only it uses, and is still a function.
    expect(await there(path.join(blockDir(dir, "double-it"), "contract.d.ts"))).toBe(true);
  });

  it("writes nothing for a block whose ports are words, because a contract cannot be made of them", async () => {
    await writeBlock(
      blockDir(dir, "double-it/add-to-self"),
      makeBlock({
        id: "add-to-self",
        code: "src/add-to-self.ts#addToSelf",
        inputs: { value: { type: { kind: "text", text: "Promise<number>" } } },
        outputs: { sum: { type: parseType("number") } },
      }),
    );

    const result = await emitProject(await loadProject(dir));
    expect(result.problems).toEqual([]);
    expect(await there(childContract())).toBe(false);
  });
});

describe("the slash commands", () => {
  const skill = (name: string) => path.join(dir, ".claude", "skills", name, "SKILL.md");

  /**
   * A skill's settings, read as YAML reads these: a key, then a JSON string,
   * which YAML takes as it is, or a bare word. Anything else fails the test.
   */
  function settingsOf(source: string): Record<string, unknown> {
    const lines = source.split("\n");
    // Claude Code reads the settings only where they open the file.
    expect(lines[0]).toBe("---");
    const end = lines.indexOf("---", 1);
    expect(end).toBeGreaterThan(1);
    return Object.fromEntries(
      lines.slice(1, end).map((line) => {
        const [, key, value] = /^([a-z-]+): (.+)$/.exec(line)!;
        return [key, value!.startsWith('"') ? JSON.parse(value!) : value === "true" ? true : value];
      }),
    );
  }

  it("writes one for each command, with its settings first, for the person to give and not the agent", async () => {
    expect(await writeCommandSkills(dir)).toEqual(SKILLS);

    for (const command of COMMANDS) {
      const source = await readFile(skill(`fragmentor-${command.name}`), "utf8");
      expect(source).toBe(commandSkill(command));
      expect(settingsOf(source)).toEqual({
        name: `fragmentor-${command.name}`,
        description: command.summary,
        "argument-hint": command.optional ? "[block path]" : expect.stringMatching(/^<.+>$/),
        "disable-model-invocation": true,
      });
      expect(source).toContain(`The person asked: \`fragmentor ${command.name} $ARGUMENTS\``);
      expect(source).toContain(command.steps);
    }
  });

  it("rewrites only what changed", async () => {
    await writeCommandSkills(dir);
    expect(await writeCommandSkills(dir)).toEqual([]);

    await writeFile(skill("fragmentor-review"), "---\nname: fragmentor-review\n---\n\n<!-- Generated by Fragmentor, long ago. -->\n\nstale\n", "utf8");
    expect(await writeCommandSkills(dir)).toEqual([`${SKILLS_DIR}/fragmentor-review/SKILL.md`]);
    expect(await readFile(skill("fragmentor-review"), "utf8")).toBe(commandSkill(COMMANDS.find((each) => each.name === "review")!));
  });

  it("never changes or takes away anything else in the folder, even a copy of one of its own", async () => {
    const ours = "---\nname: fragmentor-plan\ndescription: Our own way of planning.\n---\n\nPlan it our way.\n";
    await mkdir(path.dirname(skill("fragmentor-plan")), { recursive: true });
    await writeFile(skill("fragmentor-plan"), ours, "utf8");
    await mkdir(path.dirname(skill("fragmentor-deploy")), { recursive: true });
    await writeFile(skill("fragmentor-deploy"), "---\nname: fragmentor-deploy\n---\n\nShip it.\n", "utf8");
    // Made by copying the review skill, so it still says Fragmentor generated it.
    const copied = commandSkill({ ...COMMANDS.find((each) => each.name === "review")!, name: "review-strictly" });
    await mkdir(path.dirname(skill("fragmentor-review-strictly")), { recursive: true });
    await writeFile(skill("fragmentor-review-strictly"), copied, "utf8");

    const written = await writeCommandSkills(dir);
    expect(written).not.toContain(`${SKILLS_DIR}/fragmentor-plan/SKILL.md`);
    expect(await readFile(skill("fragmentor-plan"), "utf8")).toBe(ours);
    expect(await there(skill("fragmentor-deploy"))).toBe(true);
    expect(await readFile(skill("fragmentor-review-strictly"), "utf8")).toBe(copied);

    // And every check leaves them alone too.
    await emitProject(await loadProject(dir));
    expect(await readFile(skill("fragmentor-review-strictly"), "utf8")).toBe(copied);
    expect(await there(skill("fragmentor-deploy"))).toBe(true);
  });

  it("is kept up to date by every check", async () => {
    await emitProject(await loadProject(dir));
    await writeFile(skill("fragmentor-notes"), "---\nname: fragmentor-notes\n---\n\n<!-- Generated by Fragmentor, long ago. -->\n\nstale\n", "utf8");

    const result = await emitProject(await loadProject(dir));
    expect(result.written).toEqual([`${SKILLS_DIR}/fragmentor-notes/SKILL.md`]);
    expect(result.removed).toEqual([]);
  });
});
