import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { blockDir, loadProject } from "./project.js";
import { readAllCode } from "./code.js";

/**
 * Where a block's code is, and whether Fragmentor holds it to a contract.
 *
 * Everything that decides what Fragmentor does with a block's code comes from
 * here, so these are the cases the window, the checker and the runner all have
 * to agree about — above all the ones where they could disagree: a pointer that
 * names no function, code inside a plan, and code Fragmentor never read.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "fragmentor-code-"));
  await writeFile(
    path.join(dir, "fragmentor.json"),
    JSON.stringify({ name: "Adder", granularity: { level: 3 }, systems: [{ rootBlock: "app", language: "typescript" }] }),
    "utf8",
  );
  await block("app", { role: "component", responsibility: "Adds." });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function block(blockPath: string, file: Record<string, unknown>): Promise<void> {
  await mkdir(blockDir(dir, blockPath), { recursive: true });
  await writeFile(path.join(blockDir(dir, blockPath), "block.json"), JSON.stringify(file), "utf8");
}

async function source(file: string, text: string): Promise<void> {
  const target = path.join(dir, ...file.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, text, "utf8");
}

const codeOf = async (blockPath: string) => (await readAllCode(await loadProject(dir))).get(blockPath)!;

const ADD = {
  responsibility: "Add two numbers.",
  inputs: { a: "number", b: "number" },
  outputs: { sum: "number" },
};

const BOUND = `import type { AddInput, AddOutput, AddCaps } from "../blocks/app/add/contract.js";

export async function add(input: AddInput, caps: AddCaps): Promise<AddOutput> {
  return { sum: input.a + input.b };
}
`;

describe("what a block's code pointer leads to", () => {
  it("holds code that imports its contract, and says so", async () => {
    await block("app/add", { ...ADD, code: "src/add.ts#add" });
    await source("src/add.ts", BOUND);

    const found = await codeOf("app/add");
    expect(found.problem).toBeNull();
    expect(found.contract).toBe("blocks/app/add/contract.ts");
    expect(found.contractImport).toBe("../blocks/app/add/contract.js");
    expect(found.bound).toBe(true);
    expect(found.drawnBecause).toBeNull();
    expect(found.functionName).toBe("add");
  });

  it("finds the function the language would name, where the pointer names none", async () => {
    await block("app/add", { ...ADD, code: "src/add.ts" });
    await source("src/add.ts", BOUND);

    const found = await codeOf("app/add");
    expect(found.problem).toBeNull();
    expect(found.bound).toBe(true);
    expect(found.functionName).toBe("add");
  });

  it("will not run a block whose file never declares the function, only mentions it", async () => {
    // Otherwise the window would offer to run a block, and the runner would
    // then say the file exports nothing it can call. The name is mentioned here
    // — in the path of the contract import — which is enough to show the code
    // and not enough to call it.
    await block("app/add", { ...ADD, code: "src/add.ts" });
    await source("src/add.ts", BOUND.replace("function add(", "function addUpTwoNumbers("));

    const found = await codeOf("app/add");
    expect(found.bound).toBe(false);
    expect(found.drawnBecause).toContain("does not declare add");
  });

  it("refuses a function block pointing at a folder, because a function is in a file", async () => {
    await block("app/add", { ...ADD, code: "src/maths" });
    await source("src/maths/add.ts", BOUND);

    const found = await codeOf("app/add");
    expect(found.problem).toContain("is a folder");
    expect(found.bound).toBe(false);
  });

  it("says a block whose code does not import its contract is drawn, and what to import", async () => {
    await block("app/add", { ...ADD, code: "src/add.ts#add" });
    await source("src/add.ts", "export async function add(input: { a: number; b: number }) {\n  return { sum: 1 };\n}\n");

    const found = await codeOf("app/add");
    expect(found.bound).toBe(false);
    expect(found.drawnBecause).toBe(
      "src/add.ts does not import ../blocks/app/add/contract.js, so Fragmentor draws this code rather than checking or running it",
    );
  });

  it("says a block whose ports are words has no contract to be held to", async () => {
    await block("app/add", { ...ADD, code: "src/add.ts#add", outputs: { sum: "Promise<number>" } });
    await source("src/add.ts", BOUND);

    const found = await codeOf("app/add");
    expect(found.contract).toBeNull();
    expect(found.bound).toBe(false);
    expect(found.drawnBecause).toContain("written in words");
  });

  it("asks nothing of a block inside a plan, whatever pointer it was written with", async () => {
    // Its parent became a plan after it was written, so its pointer leads
    // nowhere by design. Nothing about a plan is a problem.
    await block("app/later", { role: "component", responsibility: "Not built yet.", planned: true });
    await block("app/later/add", { ...ADD, code: "src/not-written-yet.ts#add" });

    const found = await codeOf("app/later/add");
    expect(found.problem).toBeNull();
    expect(found.location).toBeNull();
    expect(found.contract).toBeNull();
    expect(found.drawnBecause).toBeNull();
  });
});
