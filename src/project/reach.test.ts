import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readAllCode } from "./code.js";
import { blockDir, loadProject } from "./project.js";
import type { ProjectDiagnostic } from "./project.js";
import { readProjectReach, undeclaredReach } from "./reach.js";
import type { ProjectReach } from "./reach.js";

/**
 * Reading which blocks each block's code reaches.
 *
 * Every fixture here is a small project in a temporary folder, because what
 * is being tested is the whole of it: pointers, the compiler's resolver, the
 * files on disk. The cases are the ones a wrong answer would come from — a
 * file shared by several blocks, glue no block owns, imports that look like
 * packages and are not, and the places the code cannot be followed at all.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "fragmentor-reach-"));
  await manifest([{ rootBlock: "app", language: "typescript" }]);
  await block("app", { role: "component", responsibility: "The app." });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function manifest(systems: { rootBlock: string; language: string }[]): Promise<void> {
  await writeFile(path.join(dir, "fragmentor.json"), JSON.stringify({ name: "Reach", granularity: { level: 3, maxDepth: 6 }, systems }), "utf8");
}

async function block(blockPath: string, file: Record<string, unknown>): Promise<void> {
  await mkdir(blockDir(dir, blockPath), { recursive: true });
  await writeFile(path.join(blockDir(dir, blockPath), "block.json"), JSON.stringify(file), "utf8");
}

const fn = (code: string) => ({ responsibility: "Does its part.", code });
const part = (role: string, code?: string) => ({ role, responsibility: "Holds its part.", ...(code ? { code } : {}) });

async function source(file: string, text: string): Promise<void> {
  const target = path.join(dir, ...file.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, text, "utf8");
}

async function reachOf(projectDir = dir): Promise<ProjectReach> {
  const project = await loadProject(projectDir);
  return readProjectReach(project, await readAllCode(project));
}

/** Each edge as `from -> to`, the way the expectations below are written. */
const pairs = (reach: ProjectReach) => [...new Set(reach.edges.map((edge) => `${edge.from} -> ${edge.to}`))].sort();

/** A database block over one file, which most fixtures reach into. */
async function withDatabase(): Promise<void> {
  await block("app/db", part("database", "src/db.ts"));
  await source("src/db.ts", "export const db = { rows: new Map<string, string>() };\nexport function open() { return db; }\n");
}

describe("the forms of import it follows", () => {
  it("follows named, default and namespace imports, and a namespace's member by name", async () => {
    await withDatabase();
    await block("app/client", part("client", "src/client.ts"));
    await source("src/client.ts", "export default function render() { return 1; }\nexport function paint() { return 2; }\n");
    await block("app/a", fn("src/a.ts#a"));
    await block("app/b", fn("src/b.ts#b"));
    await block("app/c", fn("src/c.ts#c"));
    await source("src/a.ts", 'import { db } from "./db";\nexport function a() { return db.rows.size; }\n');
    await source("src/b.ts", 'import render from "./client";\nexport function b() { return render(); }\n');
    await source("src/c.ts", 'import * as client from "./client";\nexport function c() { return client.paint(); }\n');

    const reach = await reachOf();
    expect(pairs(reach)).toEqual(["app/a -> app/db", "app/b -> app/client", "app/c -> app/client"]);
    expect(reach.edges.find((edge) => edge.from === "app/c")).toEqual({
      from: "app/c",
      to: "app/client",
      evidence: "paint from src/client.ts",
      approximate: false,
    });
    expect(reach.edges.every((edge) => !edge.approximate)).toBe(true);
    expect(reach.notChecked).toEqual({});
  });

  it("follows a name through a barrel's re-exports to the block that declares it", async () => {
    await withDatabase();
    await block("app/a", fn("src/a.ts#a"));
    await block("app/b", fn("src/b.ts#b"));
    await source("src/lib/index.ts", 'export { open as openDb } from "../db";\nexport * from "./more";\n');
    await source("src/lib/more.ts", 'import { db } from "../db";\nexport function count() { return db.rows.size; }\n');
    await source("src/a.ts", 'import { openDb } from "./lib";\nexport function a() { return openDb(); }\n');
    await source("src/b.ts", 'import { count } from "./lib/index";\nexport function b() { return count(); }\n');

    const reach = await reachOf();
    expect(reach.edges).toEqual([
      { from: "app/a", to: "app/db", evidence: "open from src/db.ts", approximate: false },
      { from: "app/b", to: "app/db", evidence: "db from src/db.ts", approximate: false },
    ]);
  });

  it("finds a name a barrel passes on whole in a file it reads before one it cannot, such as a generated client", async () => {
    await block("app/db", part("database", "src/db"));
    await source("src/db/generated/index.d.ts", "export declare class Client { constructor(); }\n");
    await source("src/db/generated/index.js", "exports.Client = class {};\n");
    await source("src/lib/index.ts", 'export * from "../db/generated";\nexport * from "./format";\n');
    await source("src/lib/format.ts", "export function formatMoney(cents: number) { return (cents / 100).toFixed(2); }\n");
    await block("app/a", fn("src/a.ts#a"));
    await block("app/b", fn("src/b.ts#b"));
    await source("src/a.ts", 'import { formatMoney } from "./lib";\nexport function a() { return formatMoney(1); }\n');
    await source("src/b.ts", 'import { Client } from "./lib";\nexport function b() { return new Client(); }\n');

    // Only the name no file it reads declares is the generated file's, the one place left it can come from.
    expect((await reachOf()).edges).toEqual([
      { from: "app/b", to: "app/db", evidence: "Client from src/db/generated/index.d.ts", approximate: false },
    ]);
  });

  it("resolves a tsconfig paths alias and a baseUrl import, which look like packages and are not", async () => {
    await withDatabase();
    await source("tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } }));
    await block("app/a", fn("src/deep/a.ts#a"));
    await block("app/b", fn("src/deep/b.ts#b"));
    await source("src/deep/a.ts", 'import { db } from "@/db";\nexport function a() { return db; }\n');
    await source("src/deep/b.ts", 'import { open } from "src/db";\nexport function b() { return open(); }\n');

    expect(pairs(await reachOf())).toEqual(["app/a -> app/db", "app/b -> app/db"]);
  });

  it("finds a paths alias kept in a config the project's tsconfig only refers to, as Vite sets one up", async () => {
    await block("app/db", part("database", "src/lib/db.ts"));
    await source("src/lib/db.ts", "export const db = 1;\n");
    await source("tsconfig.json", JSON.stringify({ files: [], references: [{ path: "./tsconfig.app.json" }, { path: "./tsconfig.node.json" }] }));
    await source("tsconfig.app.json", JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "bundler", paths: { "@/*": ["./src/*"] } }, include: ["src"] }));
    await source("tsconfig.node.json", JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "bundler" }, include: ["vite.config.ts"] }));
    await block("app/a", fn("src/a.ts#a"));
    await source("src/a.ts", 'import { db } from "@/lib/db";\nimport { nope } from "@/lib/missing";\nexport function a() { return db + nope; }\n');

    const reach = await reachOf();
    expect(reach.edges).toEqual([{ from: "app/a", to: "app/db", evidence: "db from src/lib/db.ts", approximate: false }]);
    expect(reach.notChecked).toEqual({ "app/a": ['an import of "@/lib/missing" in src/a.ts that could not be found'] });
  });

  it("reads the same reach when the project is opened through a link to its folder", async () => {
    await withDatabase();
    await source("tsconfig.json", JSON.stringify({ compilerOptions: { paths: { "@/*": ["./src/*"] } } }));
    await block("app/a", fn("src/a.ts#a"));
    await block("app/b", fn("src/b.ts#b"));
    await source("src/a.ts", 'import { db } from "./db";\nexport function a() { return db; }\n');
    await source("src/b.ts", 'import { open } from "@/db";\nexport function b() { return open(); }\n');
    const link = `${dir}-link`;
    await symlink(dir, link, "junction");
    try {
      const reach = await reachOf(link);
      expect(pairs(reach)).toEqual(["app/a -> app/db", "app/b -> app/db"]);
      expect(reach).toEqual(await reachOf());
    } finally {
      await rm(link, { recursive: true, force: true });
    }
  });

  it("follows a name through the index file a block points at to the block, though no block owns the file declaring it", async () => {
    await block("app/client", part("client", "src/client/index.ts"));
    await source("src/client/index.ts", 'export { dispatch } from "./state";\nexport * from "./view";\n');
    await source("src/client/state.ts", "export function dispatch() { return 1; }\n");
    await source("src/client/view.ts", "export function paint() { return 1; }\n");
    await block("app/a", fn("src/a.ts#a"));
    await source("src/a.ts", 'import { dispatch, paint } from "./client/index";\nexport function a() { return dispatch() + paint(); }\n');

    const reach = await reachOf();
    expect(reach.edges).toEqual([
      { from: "app/a", to: "app/client", evidence: "dispatch from src/client/state.ts", approximate: false },
      { from: "app/a", to: "app/client", evidence: "paint from src/client/view.ts", approximate: false },
    ]);
    expect(reach.notChecked).toEqual({});
  });

  it("follows a workspace package linked into node_modules to the project's own source", async () => {
    await withDatabase();
    await source("packages/shared/package.json", JSON.stringify({ name: "@acme/shared", main: "index.ts", types: "index.ts" }));
    await source("packages/shared/index.ts", 'import { db } from "../../src/db";\nexport function save() { return db; }\n');
    await mkdir(path.join(dir, "node_modules", "@acme"), { recursive: true });
    await symlink(path.join(dir, "packages", "shared"), path.join(dir, "node_modules", "@acme", "shared"), "junction");
    await block("app/a", fn("src/a.ts#a"));
    await source("src/a.ts", 'import { save } from "@acme/shared";\nexport function a() { return save(); }\n');

    expect((await reachOf()).edges).toEqual([{ from: "app/a", to: "app/db", evidence: "db from src/db.ts", approximate: false }]);
  });

  it("finds a .ts file from its .js name, a folder's index.ts, and a .tsx file", async () => {
    await withDatabase();
    await block("app/ui", part("client", "src/ui"));
    await source("src/ui/index.ts", 'export { Page } from "./Page.js";\n');
    await source("src/ui/Page.tsx", "export function Page() { return <div>hello</div>; }\n");
    await block("app/a", fn("src/a.ts#a"));
    await source("src/a.ts", 'import { db } from "./db.js";\nimport { Page } from "./ui";\nexport function a() { return [db, Page()]; }\n');

    const reach = await reachOf();
    expect(reach.edges).toEqual([
      { from: "app/a", to: "app/db", evidence: "db from src/db.ts", approximate: false },
      { from: "app/a", to: "app/ui", evidence: "Page from src/ui/Page.tsx", approximate: false },
    ]);
  });
});

describe("what it leaves out", () => {
  it("leaves out type-only imports and value imports used only as types", async () => {
    await withDatabase();
    await block("app/a", fn("src/a.ts#a"));
    await source(
      "src/a.ts",
      'import type { Row } from "./db";\nimport { db } from "./db";\nexport function a(rows: typeof db): Row | undefined { return undefined; }\ntype Row = string;\n',
    );

    expect((await reachOf()).edges).toEqual([]);
  });

  it("never counts a test file, which reaches everything it tests", async () => {
    await withDatabase();
    await block("app/api", part("service", "src/api"));
    await source("src/api/handler.ts", "export function handle() { return 1; }\n");
    await source("src/api/handler.test.ts", 'import { db } from "../db";\ndb.rows.clear();\n');
    await source("src/api/__tests__/more.ts", 'import { db } from "../../db";\ndb.rows.clear();\n');

    const reach = await reachOf();
    expect(reach.edges).toEqual([]);
    expect(reach.unpointed).toEqual([]);
  });

  it("says nothing about Node's built-ins or installed packages, even imported dynamically", async () => {
    await source("node_modules/left-pad/package.json", JSON.stringify({ name: "left-pad", main: "index.js" }));
    await source("node_modules/left-pad/index.js", "module.exports = (s) => s;\n");
    await block("app/a", fn("src/a.ts#a"));
    await source(
      "src/a.ts",
      'import { readFile } from "node:fs/promises";\nimport path from "path";\nimport pad from "left-pad";\nimport missing from "not-installed";\n' +
        'export async function a() { await import("left-pad"); require("fs"); return [readFile, path, pad, missing]; }\n',
    );

    const reach = await reachOf();
    expect(reach.edges).toEqual([]);
    expect(reach.notChecked).toEqual({});
  });

  it("says nothing about stylesheets, images and data a component imports, which are not code", async () => {
    await withDatabase();
    await source("tsconfig.json", JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "bundler", resolveJsonModule: true, jsx: "react-jsx" } }));
    await block("app/ui", part("client", "src/ui"));
    await block("app/page", fn("src/page/Page.tsx#Page"));
    const imports =
      'import "./App.css";\nimport styles from "./App.module.css";\nimport logo from "./logo.svg";\nimport icon from "./icon.png?url";\nimport data from "../data.json";\nimport { db } from "../db";\n';
    await source("src/ui/App.tsx", `${imports}export function App() { return <img src={logo + icon} className={styles.a} data-x={data.a + db.rows.size} />; }\n`);
    await source("src/page/Page.tsx", `${imports}export function Page() { return <img src={logo + icon} className={styles.a} data-x={data.a + db.rows.size} />; }\n`);
    await source("src/ui/App.css", "body {}\n");
    await source("src/ui/App.module.css", ".a {}\n");
    await source("src/ui/logo.svg", "<svg/>\n");
    await source("src/data.json", '{ "a": 1 }\n');

    expect(await reachOf()).toEqual({
      functions: expect.any(Object),
      edges: [
        { from: "app/page", to: "app/db", evidence: "db from src/db.ts", approximate: false },
        { from: "app/ui", to: "app/db", evidence: "db from src/db.ts", approximate: false },
      ],
      notChecked: {},
      unpointed: [],
      systemsRead: { app: true },
    });
  });

  it("says nothing about a name a barrel passes on from a package", async () => {
    await withDatabase();
    await source("src/index.ts", 'export * from "node:path";\nexport * from "./db";\n');
    await block("app/a", fn("src/a.ts#a"));
    await source("src/a.ts", 'import { join, db } from "./index";\nexport function a() { return join("a") + db; }\n');

    const reach = await reachOf();
    expect(reach.edges).toEqual([{ from: "app/a", to: "app/db", evidence: "db from src/db.ts", approximate: false }]);
    expect(reach.notChecked).toEqual({});
  });

  it("leaves out Fragmentor's own contracts under blocks/", async () => {
    await withDatabase();
    await block("app/a", fn("src/a.ts#a"));
    await source("blocks/app/a/contract.ts", '// Generated by Fragmentor from block.json. Do not edit.\nexport const aInput = 1;\n');
    await source("src/a.ts", 'import { aInput } from "../blocks/app/a/contract.js";\nexport function a() { return aInput; }\n');

    expect(await reachOf()).toEqual({ edges: [], notChecked: {}, unpointed: [], systemsRead: { app: true }, functions: expect.any(Object) });
  });
});

describe("which block the reach belongs to", () => {
  it("gives three blocks in one file only their own reach, following a shared helper once", async () => {
    await withDatabase();
    await block("app/queue", part("queue", "src/queue.ts"));
    await source("src/queue.ts", "export function publish(x: string) { return x; }\n");
    await block("app/auth", part("component", "src/auth.ts"));
    await block("app/auth/check", fn("src/auth.ts#check"));
    await block("app/auth/log-in", fn("src/auth.ts#logIn"));
    await block("app/auth/hash", fn("src/auth.ts#hashIt"));
    await source(
      "src/auth.ts",
      'import { db } from "./db";\nimport { publish } from "./queue";\n' +
        "function tell(x: string) { return publish(x); }\n" +
        "export function check() { return db.rows.size; }\n" +
        "export function logIn() { tell('a'); tell('b'); return check(); }\n" +
        "export function hashIt(text: string) { return text; }\n",
    );

    const reach = await reachOf();
    expect(reach.edges).toEqual([
      // The helper no block points at is also the file's, so its owner reaches what it reaches.
      { from: "app/auth", to: "app/queue", evidence: "publish from src/queue.ts", approximate: false },
      { from: "app/auth/check", to: "app/db", evidence: "db from src/db.ts", approximate: false },
      { from: "app/auth/log-in", to: "app/auth/check", evidence: "check from src/auth.ts", approximate: false },
      { from: "app/auth/log-in", to: "app/queue", evidence: "publish from src/queue.ts", approximate: false },
    ]);
  });

  it("follows a utils file by name, so only the caller of the function that reaches the client reaches it", async () => {
    await block("app/client", part("client", "src/client.ts"));
    await source("src/client.ts", "export function push(x: string) { return x; }\n");
    await block("app/a", fn("src/a.ts#a"));
    await block("app/b", fn("src/b.ts#b"));
    await source("src/utils.ts", 'import { push } from "./client";\nexport function shout(x: string) { return push(x); }\nexport function trim(x: string) { return x.trim(); }\n');
    await source("src/a.ts", 'import { shout } from "./utils";\nexport function a() { return shout("hi"); }\n');
    await source("src/b.ts", 'import { trim } from "./utils";\nexport function b() { return trim(" hi "); }\n');

    expect(pairs(await reachOf())).toEqual(["app/a -> app/client"]);
  });

  it("gives an import that only runs a file, and a top-level statement, to the folder that holds them", async () => {
    await withDatabase();
    await block("app/queue", part("queue", "src/queue.ts"));
    await source("src/queue.ts", "export function subscribe(handle: () => void) { handle(); }\n");
    await block("app/workers", part("service", "src/workers"));
    await block("app/workers/deliver", fn("src/workers/deliver.ts#deliver"));
    await source(
      "src/workers/deliver.ts",
      'import "../db";\nimport { subscribe } from "../queue";\nexport function deliver() { return 1; }\nsubscribe(deliver);\n',
    );

    const reach = await reachOf();
    expect(reach.edges).toEqual([
      { from: "app/workers", to: "app/db", evidence: "an import that runs src/db.ts", approximate: false },
      { from: "app/workers", to: "app/queue", evidence: "subscribe from src/queue.ts", approximate: false },
    ]);
  });

  it("finds nothing in a root that points at the whole project, since everything it reaches is its own", async () => {
    await block("app", { ...part("component", "."), responsibility: "The whole app." });
    await withDatabase();
    await source("src/main.ts", 'import { db } from "./db";\nconsole.log(db);\n');
    await source("vitest.config.ts", "export default {};\n");

    expect(await reachOf()).toEqual({ edges: [], notChecked: {}, unpointed: [], systemsRead: { app: true }, functions: expect.any(Object) });
  });

  it.runIf(process.platform === "win32" || process.platform === "darwin")(
    "keeps a pointer written in another case than the file on disk",
    async () => {
      await block("app/db", part("database", "SRC/DB.ts"));
      await source("src/db.ts", "export const db = 1;\n");
      await block("app/api", part("service", "Src/Api"));
      await source("src/api/handle.ts", 'import { db } from "../db";\nexport const handled = db;\n');

      expect(pairs(await reachOf())).toEqual(["app/api -> app/db"]);
    },
  );

  it("counts a file several blocks point at whole as the block holding them all, and says so on each", async () => {
    // One router file holding the routes of two services, as real Express apps keep them.
    await block("app/api", part("service", "src/main.ts"));
    await source("src/main.ts", 'import { router } from "./routes";\nexport const app = router;\n');
    await block("app/api/articles", part("service", "src/routes.ts"));
    await block("app/api/articles/create", fn("src/articles.ts#create"));
    await block("app/api/comments", part("service", "src/routes.ts"));
    await block("app/api/comments/add", fn("src/comments.ts#add"));
    await source("src/articles.ts", "export function create() { return 1; }\n");
    await source("src/comments.ts", "export function add() { return 2; }\n");
    await source("src/routes.ts", 'import { create } from "./articles";\nimport { add } from "./comments";\nexport const router = [create, add];\n');

    const reach = await reachOf();
    // Neither service reaches into the other: the routes are theirs together, which is the API's.
    expect(reach.edges).toEqual([]);
    expect(reach.notChecked).toEqual({
      "app/api/articles": ["src/routes.ts is also the code of app/api/comments, so what it reaches is counted as app/api's"],
      "app/api/comments": ["src/routes.ts is also the code of app/api/articles, so what it reaches is counted as app/api's"],
    });
  });

  it("gives a function block the helpers in its own file, and a file's rest to the block around its functions when the folder holding it does not hold them", async () => {
    // A command's file inside a server's folder, the way a CLI often sits beside the code it starts.
    await block("app/api", part("service", "src"));
    await block("app/cli", part("client"));
    await block("app/cli/run", fn("src/bin.ts#run"));
    await source(
      "src/bin.ts",
      'function parseArgs(argv: string[]) { return Number(argv[2]); }\nconst usage = "usage: tool [port]";\n' +
        "export function run(argv: string[]) { return parseArgs(argv) || usage; }\nrun(process.argv);\n",
    );
    // A file some other part points at whole, one function of which is the command's.
    await block("app/web", part("client", "src/web.ts"));
    await block("app/cli/serve", fn("src/web.ts#serve"));
    await source("src/web.ts", "function port() { return 3000; }\nexport function serve() { return port(); }\n");

    expect((await reachOf()).edges).toEqual([]);
  });

  it("lists code under no pointer that reaches something no block's code led into", async () => {
    await withDatabase();
    await block("app/a", fn("src/a.ts#a"));
    await source("src/a.ts", 'import { handle } from "./server";\nexport function a() { return handle(); }\n');
    await source("src/server.ts", 'import { db } from "./db";\nexport function handle() { return db; }\n');
    await source("src/cron.ts", 'import { open } from "./db";\nexport function nightly() { return open(); }\n');
    await source("src/constants.ts", "export const DAY = 1;\n");

    const reach = await reachOf();
    expect(reach.edges).toEqual([{ from: "app/a", to: "app/db", evidence: "db from src/db.ts", approximate: false }]);
    expect(reach.unpointed).toEqual(["src/cron.ts"]);
  });
});

describe("what it says it could not read", () => {
  it("lists a dynamic import and a require of the project's own code", async () => {
    await block("app/a", fn("src/a.ts#a"));
    await source("src/a.ts", 'export async function a(name: string) { await import("./plugins/" + name); require("./legacy"); await import("./gone"); }\n');

    expect((await reachOf()).notChecked).toEqual({
      "app/a": ['a dynamic import in src/a.ts', 'a dynamic import of "./gone" in src/a.ts', 'a require of "./legacy" in src/a.ts'],
    });
  });

  it("lists an import of the project's own code that leads nowhere, even through an alias no tsconfig declares", async () => {
    await block("app/a", fn("src/a.ts#a"));
    await source(
      "src/a.ts",
      'import { gone } from "./gone";\nimport { lost } from "@/lost";\nimport { away } from "~/away";\nexport function a() { return [gone, lost, away]; }\n',
    );

    expect((await reachOf()).notChecked).toEqual({
      "app/a": [
        'an import of "./gone" in src/a.ts that could not be found',
        'an import of "@/lost" in src/a.ts that could not be found',
        'an import of "~/away" in src/a.ts that could not be found',
      ],
    });
  });

  it("counts the whole file for a method pointer, marked approximate, and says why", async () => {
    await withDatabase();
    await block("app/cart", fn("src/cart.ts#Cart.total"));
    await source("src/cart.ts", 'import { db } from "./db";\nexport class Cart { total() { return db.rows.size; } }\n');

    const reach = await reachOf();
    expect(reach.edges).toEqual([{ from: "app/cart", to: "app/db", evidence: "db from src/db.ts", approximate: true }]);
    expect(reach.notChecked).toEqual({
      "app/cart": ['"Cart.total" in src/cart.ts could not be found by reading the code, so all of src/cart.ts is counted'],
    });
  });

  it("counts a namespace handed on whole as all of its file, marked approximate", async () => {
    await withDatabase();
    await block("app/a", fn("src/a.ts#a"));
    await source("src/glue.ts", 'import { db } from "./db";\nexport function helper() { return db; }\n');
    await source("src/a.ts", 'import * as glue from "./glue";\nexport function a() { return Object.keys(glue); }\n');

    const reach = await reachOf();
    expect(reach.edges).toEqual([{ from: "app/a", to: "app/db", evidence: "db from src/db.ts", approximate: true }]);
    expect(reach.notChecked).toEqual({ "app/a": ["src/glue.ts is used whole, so all of it is counted"] });
  });

  it("counts a file imported only to run it as all of it, marked approximate, and says so only where it reaches something", async () => {
    await withDatabase();
    await block("app/workers", part("service", "src/workers"));
    await block("app/workers/deliver", fn("src/workers/deliver.ts#deliver"));
    await source("src/glue.ts", 'import { open } from "./db";\nopen();\n');
    await source("src/polyfill.ts", "export const ready = true;\n");
    await source("src/workers/deliver.ts", 'import "../glue";\nimport "../polyfill";\nexport function deliver() { return 1; }\n');

    const reach = await reachOf();
    expect(reach.edges).toEqual([{ from: "app/workers", to: "app/db", evidence: "open from src/db.ts", approximate: true }]);
    expect(reach.notChecked).toEqual({ "app/workers": ["src/glue.ts is imported only to run it, so all of it is counted"] });
  });

  it("counts a value no block points at as all of it, so an object bundling several parts is not taken as reaching each from every use", async () => {
    await withDatabase();
    await block("app/mailer", part("external", "src/mailer.ts"));
    await source("src/mailer.ts", "export class Mailer { send(to: string) { return to; } }\n");
    await source("src/container.ts", 'import { db } from "./db";\nimport { Mailer } from "./mailer";\nexport const container = { db, mailer: new Mailer() };\n');
    await block("app/a", fn("src/a.ts#a"));
    await source("src/a.ts", 'import { container } from "./container";\nexport function a() { return container.db.rows.size; }\n');

    const reach = await reachOf();
    expect(reach.edges).toEqual([
      { from: "app/a", to: "app/db", evidence: "db from src/db.ts", approximate: true },
      { from: "app/a", to: "app/mailer", evidence: "Mailer from src/mailer.ts", approximate: true },
    ]);
    expect(reach.notChecked).toEqual({ "app/a": ["container in src/container.ts is a value that may hold several things, so all of it is counted"] });
  });

  it("counts a namespace handed on whole as reaching every block in its file, the ones pointing at functions approximately", async () => {
    await block("app/lib", part("component", "src/lib.ts"));
    await block("app/other", fn("src/lib.ts#other"));
    await source("src/lib.ts", "export function one() { return 1; }\nexport function other() { return 2; }\n");
    await block("app/a", fn("src/a.ts#a"));
    await source("src/a.ts", 'import * as lib from "./lib";\nexport function a() { return Object.keys(lib); }\n');

    expect((await reachOf()).edges).toEqual([
      { from: "app/a", to: "app/lib", evidence: "all of src/lib.ts", approximate: false },
      { from: "app/a", to: "app/other", evidence: "all of src/lib.ts", approximate: true },
    ]);
  });

  it("says a file it cannot read could not be read, rather than failing", async () => {
    // A part pointing at a file that is not code reaches nothing worth a word.
    await block("app/notes", part("component", "src/notes.md"));
    await source("src/notes.md", "# Notes\n");
    await block("app/legacy", fn("src/legacy.js#run"));
    await source("src/legacy.js", "export function run() { return 1; }\n");
    await block("app/big", part("component", "src/big.ts"));
    await source("src/big.ts", `export const big = "${"x".repeat(2_000_001)}";\n`);

    expect((await reachOf()).notChecked).toEqual({
      "app/big": ["src/big.ts is too large to read"],
      "app/legacy": ["src/legacy.js is not code Fragmentor can read for what it reaches"],
    });
  });

  it("says a chain of calls too long to follow could not be followed, rather than failing", async () => {
    const chain = Array.from({ length: 20_000 }, (_, i) => `export function f${i}() { return f${i + 1}(); }\n`).join("");
    await source("src/chain.ts", `${chain}export function f20000() { return 1; }\n`);
    await block("app/a", fn("src/a.ts#a"));
    await source("src/a.ts", 'import { f0 } from "./chain";\nexport function a() { return f0(); }\n');

    expect((await reachOf()).notChecked).toEqual({ "app/a": ["what the code in src/a.ts reaches could not be followed to the end"] });
  });

  it("says a system in a language it cannot read was not read", async () => {
    await manifest([
      { rootBlock: "app", language: "typescript" },
      { rootBlock: "model", language: "python" },
    ]);
    await block("model", part("component", "model"));
    await source("model/train.py", "import os\n");

    const reach = await reachOf();
    expect(reach.systemsRead).toEqual({ app: true, model: false });
    expect(reach.edges).toEqual([]);
  });
});

describe("reach the diagram does not declare", () => {
  async function warningsOf(): Promise<ProjectDiagnostic[]> {
    const project = await loadProject(dir);
    return undeclaredReach(project, await readProjectReach(project, await readAllCode(project)));
  }

  /** A client whose state is reached from a worker, the way Messenger's is. */
  async function withClient(): Promise<void> {
    await block("app/client", part("client", "src/client"));
    await block("app/client/state", fn("src/client/state.ts#dispatch"));
    await source("src/client/state.ts", "export function dispatch(x: string) { return x; }\nexport function reset() { return 0; }\n");
    await block("app/workers", part("service", "src/workers"));
    await block("app/workers/deliver", fn("src/workers/deliver.ts#deliver"));
  }

  it("warns once for each block and each part it reaches into, with what it uses there sorted, and says how to declare it", async () => {
    await withClient();
    await source(
      "src/workers/deliver.ts",
      'import { reset, dispatch } from "../client/state";\nexport function deliver() { reset(); return dispatch("hi"); }\n',
    );

    expect(await warningsOf()).toEqual([
      {
        severity: "warning",
        blockPath: "app/workers/deliver",
        message:
          '"Deliver"\'s code reaches "Client" (app/client), but no access on it, inside it or above it names that: ' +
          "dispatch from src/client/state.ts; reset from src/client/state.ts. " +
          'Add an access naming "client" to the block that makes the call, or stop reaching it.',
      },
    ]);
  });

  it("takes an access on the block, on one of its parts or around it, naming the part, something in it or something around it", async () => {
    await withClient();
    await source("src/workers/deliver.ts", 'import { dispatch } from "../client/state";\nexport function deliver() { return dispatch("hi"); }\n');
    const declaring = async (blockPath: string, access: string) => {
      const file = path.join(blockDir(dir, blockPath), "block.json");
      const before = JSON.parse(await readFile(file, "utf8"));
      await writeFile(file, JSON.stringify({ ...before, access: [access] }), "utf8");
      const warned = (await warningsOf()).length;
      await writeFile(file, JSON.stringify(before), "utf8");
      return warned;
    };

    expect(await declaring("app/workers/deliver", "writes client")).toBe(0);
    expect(await declaring("app/workers/deliver", "calls client/state")).toBe(0);
    expect(await declaring("app/workers", "writes client")).toBe(0);
    // An access leading anywhere else says nothing about crossing into the client.
    await block("app/infra", part("component"));
    await block("app/infra/queue", part("queue"));
    expect(await declaring("app/workers/deliver", "reads infra/queue")).toBe(1);
  });

  it("needs nothing for calls inside one part, or into a group of parts that is none of those kinds", async () => {
    await block("app/api", part("service", "src/api"));
    await block("app/api/router", fn("src/api/router.ts#route"));
    await block("app/api/save", fn("src/api/save.ts#save"));
    await block("app/lib", part("component", "src/lib"));
    await block("app/lib/format", fn("src/lib/format.ts#format"));
    await source("src/api/save.ts", "export function save() { return 1; }\n");
    await source("src/lib/format.ts", "export function format() { return 2; }\n");
    await source(
      "src/api/router.ts",
      'import { save } from "./save";\nimport { format } from "../lib/format";\nexport function route() { return [save(), format()]; }\n',
    );

    expect(pairs(await reachOf())).toEqual(["app/api/router -> app/api/save", "app/api/router -> app/lib/format"]);
    expect(await warningsOf()).toEqual([]);
  });

  it("judges only reach read exactly", async () => {
    await withDatabase();
    await block("app/cart", fn("src/cart.ts#Cart.total"));
    await source("src/cart.ts", 'import { db } from "./db";\nexport class Cart { total() { return db.rows.size; } }\n');

    expect(pairs(await reachOf())).toEqual(["app/cart -> app/db"]);
    expect(await warningsOf()).toEqual([]);
  });

  it("warns of reach into another system, which nothing can declare", async () => {
    await manifest([
      { rootBlock: "app", language: "typescript" },
      { rootBlock: "admin", language: "typescript" },
    ]);
    await block("admin", part("component", "admin"));
    await withDatabase();
    await source("admin/report.ts", 'import { db } from "../src/db";\nexport const rows = db.rows;\n');

    expect(await warningsOf()).toEqual([
      {
        severity: "warning",
        blockPath: "admin",
        message:
          '"Admin"\'s code reaches into the system "App" (app): db from src/db.ts. Systems in one project are separate programs that never reach each other, so the diagram cannot say this: stop reaching it, or make the two one system.',
      },
    ]);
  });
});

describe("the examples", () => {
  const examples = fileURLToPath(new URL("../../examples/", import.meta.url));

  it("reads Messenger's reach exactly, with nothing approximate or unread", async () => {
    const reach = await reachOf(path.join(examples, "messenger"));
    expect(pairs(reach)).toEqual([
      "app/api/auth/check-session -> app/infrastructure/database",
      "app/api/auth/log-in -> app/infrastructure/database",
      "app/api/auth/log-out -> app/infrastructure/database",
      "app/api/messaging/notify-recipient -> app/infrastructure/queue",
      "app/api/messaging/save-message -> app/infrastructure/database",
      "app/api/router -> app/api/auth/check-session",
      "app/api/router -> app/api/auth/log-in",
      "app/api/router -> app/api/auth/log-out",
      "app/api/router -> app/api/messaging/notify-recipient",
      "app/api/router -> app/api/messaging/save-message",
      "app/client/state -> app/api/router",
      "app/client/state -> app/client/ui/chat-view",
      "app/client/ui/login-form -> app/client/state",
      "app/client/ui/send-button -> app/client/state",
      // The top-level `subscribe(deliverNotification)`, which is the folder's.
      "app/workers -> app/infrastructure/queue",
      "app/workers/clean-up-sessions -> app/infrastructure/database",
      "app/workers/deliver-notification -> app/client/state",
      "app/workers/deliver-notification -> app/infrastructure/database",
    ]);
    expect(reach.edges.find((edge) => edge.from === "app/workers/deliver-notification" && edge.to === "app/client/state")?.evidence).toBe(
      "dispatch from src/client/state.ts",
    );
    expect(reach.edges.some((edge) => edge.approximate)).toBe(false);
    expect(reach.notChecked).toEqual({});
    expect(reach.unpointed).toEqual([]);
  });

  it("reads Tickets' reach, following the box office through the server no block owns", async () => {
    const reach = await reachOf(path.join(examples, "tickets"));
    expect(pairs(reach)).toEqual([
      // Reserve is book-seats' own part, so it is not listed.
      "tickets/booking-api/book-seats -> tickets/booking-api/find-event",
      "tickets/booking-api/book-seats -> tickets/booking-api/pricing/price-seat",
      "tickets/booking-api/cancel-booking -> tickets/booking-api/find-event",
      "tickets/booking-api/cancel-booking -> tickets/booking-api/pricing/refund-for",
      "tickets/box-office -> tickets/booking-api/book-seats",
      "tickets/box-office -> tickets/booking-api/cancel-booking",
    ]);
    expect(reach.edges.some((edge) => edge.approximate)).toBe(false);
    expect(reach.notChecked).toEqual({});
  });

  it("reads the same thing twice, word for word", async () => {
    const first = await reachOf(path.join(examples, "messenger"));
    expect(await reachOf(path.join(examples, "messenger"))).toEqual(first);
  });
});

describe("the shape of every function, credited once", () => {
  it("credits a function to the block pointing at it, its own-file helpers to that block, the rest to the file's owner, and the remainder to no block", async () => {
    await block("app/api", part("service", "src/api"));
    await block("app/api/list", fn("src/api/list.ts#list"));
    await source(
      "src/api/list.ts",
      "function shape(x: number) { return x > 1 ? x : 1; }\nfunction unused() { return 0; }\nexport function list(n: number) { return shape(n); }\nexport const other = () => 2;\n",
    );
    await block("app/cli", part("client"));
    await block("app/cli/run", fn("src/bin.ts#run"));
    await source("src/bin.ts", "function parseArgs(argv: string[]) { return Number(argv[2]); }\nexport function run(argv: string[]) { return parseArgs(argv) || 0; }\n");
    await source("src/glue.ts", "export function table(a: number) { return a; }\nconst x = () => 1;\n");

    const reach = await reachOf();
    expect(Object.fromEntries(Object.entries(reach.functions).map(([owner, credited]) => [owner, credited.paths]))).toEqual({
      "app/api/list": [1, 2],
      "app/api": [1, 1],
      "app/cli/run": [1, 2],
      "": [1, 1],
    });
    expect(Object.values(reach.functions).reduce((count, credited) => count + credited.paths.length, 0)).toBe(8);
    expect(reach.functions[""]!.files).toEqual(["src/glue.ts"]);
    expect(reach.functions["app/api/list"]!.statements).toBe(2);
    // Only the functions worth naming are named: over the limit, the longest and the biggest.
    expect(reach.functions["app/api/list"]!.named.map((each) => [each.name, each.paths, each.line])).toEqual([["shape", 2, 1]]);
    expect(reach.functions["app/cli/run"]!.named.map((each) => each.name)).toEqual(["run", "parseArgs"]);
  });

  it("reads no function for a test file, and none at all where the language has no reader", async () => {
    await block("app/one", fn("src/one.ts#one"));
    await source("src/one.ts", "export function one() { return 1; }\n");
    await source("src/one.test.ts", "export function test() { if (1) { return 1; } return 2; }\n");
    const reach = await reachOf();
    expect(Object.keys(reach.functions)).toEqual(["app/one"]);
    expect(reach.functions["app/one"]!.paths).toEqual([1]);
  });
});
