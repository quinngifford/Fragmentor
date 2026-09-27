import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readAllCode } from "./code.js";
import { blockDir, loadProject } from "./project.js";
import { readProjectReach } from "./reach.js";
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

  it("resolves a tsconfig paths alias and a baseUrl import, which look like packages and are not", async () => {
    await withDatabase();
    await source("tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } }));
    await block("app/a", fn("src/deep/a.ts#a"));
    await block("app/b", fn("src/deep/b.ts#b"));
    await source("src/deep/a.ts", 'import { db } from "@/db";\nexport function a() { return db; }\n');
    await source("src/deep/b.ts", 'import { open } from "src/db";\nexport function b() { return open(); }\n');

    expect(pairs(await reachOf())).toEqual(["app/a -> app/db", "app/b -> app/db"]);
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

  it("leaves out Fragmentor's own contracts under blocks/", async () => {
    await withDatabase();
    await block("app/a", fn("src/a.ts#a"));
    await source("blocks/app/a/contract.ts", '// Generated by Fragmentor from block.json. Do not edit.\nexport const aInput = 1;\n');
    await source("src/a.ts", 'import { aInput } from "../blocks/app/a/contract.js";\nexport function a() { return aInput; }\n');

    expect(await reachOf()).toEqual({ edges: [], notChecked: {}, unpointed: [], systemsRead: { app: true } });
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

    expect(await reachOf()).toEqual({ edges: [], notChecked: {}, unpointed: [], systemsRead: { app: true } });
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

  it("lists an import of the project's own code that leads nowhere", async () => {
    await block("app/a", fn("src/a.ts#a"));
    await source("src/a.ts", 'import { gone } from "./gone";\nexport function a() { return gone; }\n');

    expect((await reachOf()).notChecked).toEqual({ "app/a": ['an import of "./gone" in src/a.ts that could not be found'] });
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

    expect((await reachOf()).edges).toEqual([{ from: "app/a", to: "app/db", evidence: "db from src/db.ts", approximate: true }]);
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
