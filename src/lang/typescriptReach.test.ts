import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { outline, typescriptReach } from "./typescriptReach.js";

/**
 * Reading one TypeScript file: what it declares, and which names each part
 * of it uses. The traps are the places a name appears without being used —
 * a parameter that hides an import, a property that shares its spelling, a
 * type — because each would be a connection the code does not make.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "fragmentor-ts-reach-"));
  await writeFile(path.join(dir, "db.ts"), "export const db = 1;\nexport const other = 2;\nexport class Base {}\n", "utf8");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const read = (text: string, file = "a.ts") => typescriptReach.reading(dir)(file, text);
const targetsOf = (text: string, name: string) => read(text).declarations.get(name)?.targets;

describe("which names a function uses", () => {
  it("does not count a parameter, a local or a catch variable that hides an import", () => {
    const text =
      'import { db } from "./db";\n' +
      "export function a(db: number) { return db; }\n" +
      "export function b() { const db = 2; return db; }\n" +
      "export function c() { try { return 1; } catch (db) { return db; } }\n" +
      "export function d() { for (const db of [1]) return db; return db; }\n";

    expect(targetsOf(text, "a")).toEqual([]);
    expect(targetsOf(text, "b")).toEqual([]);
    expect(targetsOf(text, "c")).toEqual([]);
    // The loop's own `db` ends with the loop; the last one is the import.
    expect(targetsOf(text, "d")).toEqual([{ file: "db.ts", name: "db" }]);
  });

  it("does not count a property, a key or a method that shares an import's name", () => {
    const text =
      'import { db } from "./db";\n' +
      "export function a(x: { db: number }) { return x.db; }\n" +
      "export const b = { db: 1 };\n" +
      "export class C { db() { return 1; } }\n" +
      "export const d = { db };\n";

    expect(targetsOf(text, "a")).toEqual([]);
    expect(targetsOf(text, "b")).toEqual([]);
    expect(targetsOf(text, "C")).toEqual([]);
    expect(targetsOf(text, "d")).toEqual([{ file: "db.ts", name: "db" }]);
  });

  it("counts a class extended, but not an interface implemented or a type named", () => {
    const text =
      'import { Base, db, other } from "./db";\n' +
      "export class A extends Base {}\n" +
      "export class B implements Base {}\n" +
      "export function c(x: typeof db): Array<typeof other> { return [x as typeof other]; }\n";

    expect(targetsOf(text, "A")).toEqual([{ file: "db.ts", name: "Base" }]);
    expect(targetsOf(text, "B")).toEqual([]);
    expect(targetsOf(text, "c")).toEqual([]);
  });

  it("sees a var declared in a nested block hide an import for the whole function", () => {
    const text = 'import { db } from "./db";\nexport function a(flag: boolean) { if (flag) { var db = 2; } return db; }\n';
    expect(targetsOf(text, "a")).toEqual([]);
  });

  it("counts a function given type arguments without being called, and a default in a destructuring", () => {
    const text =
      'import { db, other } from "./db";\n' +
      "export function a() { const g = db<string>; return g; }\n" +
      "export function b(o: object) { let x; ({ x = other } = o as { x?: number }); return x; }\n";

    expect(targetsOf(text, "a")).toEqual([{ file: "db.ts", name: "db" }]);
    expect(targetsOf(text, "b")).toEqual([{ file: "db.ts", name: "other" }]);
  });

  it("names the same-file functions a function calls, for following", () => {
    const text = "function helper() { return 1; }\nfunction unused() { return 2; }\nexport function a() { return helper(); }\n";
    expect(read(text).declarations.get("a")?.local).toEqual(["helper"]);
  });

  it("keeps an import that only runs a file, and top-level statements, apart from every function", () => {
    const text = 'import "./db";\nimport { other } from "./db";\nconsole.log(other);\nexport function a() { return 1; }\n';
    const reach = read(text);
    expect(reach.rest.targets).toEqual([
      { file: "db.ts", name: "other" },
      { file: "db.ts", name: null },
    ]);
    expect(reach.declarations.get("a")?.targets).toEqual([]);
  });

  it("records what a file passes on from elsewhere, and under what name", () => {
    const text =
      'import { db } from "./db";\nexport { db as database };\nexport { other as second } from "./db";\nexport * from "./db";\nexport * from "node:os";\n' +
      'export { readFile } from "node:fs";\nfunction local() { return 1; }\nexport default local;\n';
    const reach = read(text);
    expect(reach.exports).toEqual(
      new Map<string, unknown>([
        ["database", { file: "db.ts", name: "db" }],
        ["second", { file: "db.ts", name: "other" }],
        ["readFile", null],
        ["default", { local: "local" }],
      ]),
    );
    expect(reach.exportsAll).toEqual(["db.ts", null]);
  });
});

describe("telling files apart", () => {
  it("knows TypeScript code from its tests and from everything else", () => {
    expect(typescriptReach.fileKind("src/a.ts")).toBe("code");
    expect(typescriptReach.fileKind("src/view.tsx")).toBe("code");
    expect(typescriptReach.fileKind("src/a.mts")).toBe("code");
    expect(typescriptReach.fileKind("src/a.test.ts")).toBe("test");
    expect(typescriptReach.fileKind("src/a.spec.tsx")).toBe("test");
    expect(typescriptReach.fileKind("src/__tests__/a.ts")).toBe("test");
    expect(typescriptReach.fileKind("src/a.d.ts")).toBeNull();
    expect(typescriptReach.fileKind("src/a.js")).toBeNull();
    expect(typescriptReach.fileKind("src/a.py")).toBeNull();
  });
});

describe("the outline", () => {
  it("lists each top-level declaration with where it is, and each import with what it brings in", () => {
    const text =
      'import type { T } from "./types";\nimport def, { a, type B } from "./x";\nimport * as ns from "./y";\nimport "./z";\n\n' +
      "/** Adds. */\nexport function add() {}\nconst handler = async () => {};\nexport { handler };\nclass Cart {}\nexport default 42;\n";
    const found = outline(path.join(dir, "o.ts"), text);

    expect(found.imports).toEqual([
      { specifier: "./types", names: {}, typeOnly: true, sideEffect: false, line: 1 },
      { specifier: "./x", names: { def: "default", a: "a" }, typeOnly: false, sideEffect: false, line: 2 },
      { specifier: "./y", names: { ns: "*" }, typeOnly: false, sideEffect: false, line: 3 },
      { specifier: "./z", names: {}, typeOnly: false, sideEffect: true, line: 4 },
    ]);
    expect(found.declarations.map(({ name, kind, line, exported }) => ({ name, kind, line, exported }))).toEqual([
      { name: "add", kind: "function", line: 7, exported: true },
      { name: "handler", kind: "function", line: 8, exported: true },
      { name: "Cart", kind: "class", line: 10, exported: false },
      { name: "default", kind: "default", line: 11, exported: true },
    ]);
    const add = found.declarations[0]!;
    expect(text.slice(add.start, add.end)).toBe("export function add() {}");
  });

  it("outlines an overloaded function once, from its first signature to its body", () => {
    const text = "export function f(x: string): string;\nexport function f(x: number): number;\nexport function f(x: unknown) { return x; }\nfunction g() {}\n";
    const found = outline(path.join(dir, "o.ts"), text);

    expect(found.declarations.map(({ name, line, exported }) => ({ name, line, exported }))).toEqual([
      { name: "f", line: 1, exported: true },
      { name: "g", line: 4, exported: false },
    ]);
    const f = found.declarations[0]!;
    expect(text.slice(f.start, f.end)).toBe(text.slice(0, text.indexOf("\nfunction g")));
  });

  it("reads the file again when its text changes, and not before", () => {
    const file = path.join(dir, "o.ts");
    const first = outline(file, "export function a() {}\n");
    expect(outline(file, "export function a() {}\n")).toBe(first);
    expect(outline(file, "export function b() {}\n").declarations[0]?.name).toBe("b");
  });

  it("sees a change of tsconfig without being told", async () => {
    await mkdir(path.join(dir, "lib"), { recursive: true });
    await writeFile(path.join(dir, "lib", "db.ts"), "export const db = 1;\n", "utf8");
    const text = 'import { db } from "@lib/db";\nexport function a() { return db; }\n';
    expect(read(text).declarations.get("a")?.targets).toEqual([]);

    await writeFile(path.join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { paths: { "@lib/*": ["./lib/*"] } } }), "utf8");
    expect(read(text).declarations.get("a")?.targets).toEqual([{ file: "lib/db.ts", name: "db" }]);
  });
});
