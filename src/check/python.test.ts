import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkProject } from "./check.js";
import { findPython } from "../run/python.js";

/**
 * Checking Python code for real: each project here is written to a temp
 * folder, checked with the machine's own Python and the bundled pyright, and
 * held to what the report says. Skipped where no Python 3.11 is installed,
 * because the rules pass runs with the project's interpreter.
 */

const python = (() => {
  // An empty folder of its own, so nothing lying around the temp root — a
  // stray .venv, say — can decide whether this suite runs.
  const probe = mkdtempSync(path.join(tmpdir(), "fragmentor-pygate-"));
  try {
    return findPython(probe);
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

let dir: string;

beforeEach(async () => {
  // A non-ASCII folder name, because an accented Windows user name is common
  // and every hand-off here — the stdin spec, pyright's report — must carry it.
  dir = await mkdtemp(path.join(tmpdir(), "fragmentor-pychèck-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function write(relative: string, text: string): Promise<void> {
  const target = path.join(dir, ...relative.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, text, "utf8");
}

const manifest = () =>
  write(
    "fragmentor.json",
    JSON.stringify({ name: "PyCheck", granularity: { level: 3 }, systems: [{ rootBlock: "app", language: "python" }] }),
  );

const block = (blockPath: string, spec: Record<string, unknown>) =>
  write(`blocks/${blockPath}/block.json`, JSON.stringify(spec));

const pascal = (id: string) =>
  id.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("");

/** A file bound the way the guide will teach it, with `body` as the function's body. */
function boundSource(id: string, body: string, moduleImports = "", guardedImports = ""): string {
  const p = pascal(id);
  const segment = id.replace(/-/g, "_");
  return [
    "from __future__ import annotations",
    "",
    "from typing import TYPE_CHECKING",
    ...(moduleImports ? ["", moduleImports] : []),
    "",
    "if TYPE_CHECKING:",
    `    from blocks._contracts.app.${segment}.contract import ${p}Caps, ${p}Input, ${p}Output`,
    ...(guardedImports ? guardedImports.split("\n").map((line) => `    ${line}`) : []),
    "",
    "",
    `async def ${segment}(input: ${p}Input, caps: ${p}Caps) -> ${p}Output:`,
    ...body.split("\n").map((line) => `    ${line}`),
    "",
  ].join("\n");
}

/** One block whose code is bound: block.json under app/, code under `file`. */
async function boundBlock(
  id: string,
  ports: Record<string, unknown>,
  file: string,
  body: string,
  moduleImports = "",
  guardedImports = "",
): Promise<void> {
  await block(`app/${id}`, { responsibility: `${id}.`, code: `${file}#${id.replace(/-/g, "_")}`, ...ports });
  await write(file, boundSource(id, body, moduleImports, guardedImports));
}

describe.skipIf(!python.ok)("checking Python code", () => {
  it("typechecks bound code against its contracts, and nothing the project plants can weaken it", async () => {
    await manifest();
    await block("app", { role: "component", responsibility: "The app." });
    await boundBlock("add", { inputs: { a: "number", b: "number" }, outputs: { sum: "number" } }, "src/maths/add.py", 'return {"sum": input["a"] + input["b"]}');
    await boundBlock("need-clock", { outputs: { at: "number" }, capabilities: { clock: "Clock" } }, "src/maths/need_clock.py", 'return {"at": caps.clock.now()}');
    // The planted mistakes, each with a suppression that must change nothing.
    await boundBlock("wrong-return", { outputs: { sum: "number" } }, "src/planted/wrong_return.py", 'return {"sum": "seven"}  # type: ignore');
    await boundBlock("missing-key", { outputs: { sum: "number", count: "number" } }, "src/planted/missing_key.py", 'return {"sum": 1}');
    await boundBlock("extra-key", { outputs: { sum: "number" } }, "src/planted/extra_key.py", 'return {"sum": 1, "extra": 2}');
    await boundBlock(
      "bad-callee",
      { outputs: { sum: "number" } },
      "src/planted/bad_callee.py",
      'priced = await add({"a": "x", "b": 2}, caps)\nreturn {"sum": priced["sum"]}',
      "from src.maths.add import add",
    );
    await boundBlock(
      "no-cap",
      { outputs: { at: "number" }, capabilities: { log: "Logger" } },
      "src/planted/no_cap.py",
      'got = await need_clock({}, caps)\nreturn {"at": got["at"]}',
      "from src.maths.need_clock import need_clock",
    );
    // A project cannot turn its own checking down.
    await write("pyproject.toml", '[tool.pyright]\ntypeCheckingMode = "off"\n');

    const report = await checkProject(dir);
    const system = report.systems[0]!;
    expect(system.codeChecked).toBe(true);
    expect(system.codeHeld).toBe(7);
    expect(system.interpreter).toBeTruthy();

    const at = (file: string) => system.codeProblems.filter((problem) => problem.file === file);
    expect(at("src/planted/wrong_return.py")).toContainEqual(
      expect.objectContaining({ line: 10, message: expect.stringContaining('is not assignable to "float"') }),
    );
    expect(at("src/planted/missing_key.py")).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining('"count"') }),
    );
    expect(at("src/planted/extra_key.py")).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining('"extra"') }),
    );
    expect(at("src/planted/bad_callee.py")).toContainEqual(expect.objectContaining({ line: 12 }));
    expect(at("src/planted/no_cap.py")).toContainEqual(expect.objectContaining({ line: 12 }));
    // The sound blocks have nothing against them.
    expect(at("src/maths/add.py")).toEqual([]);
    expect(at("src/maths/need_clock.py")).toEqual([]);
    expect(report.errorCount).toBe(system.codeProblems.length);
  }, 120_000);

  it("holds each bound file to the form the harness and the checker rely on", async () => {
    await manifest();
    await block("app", { role: "component", responsibility: "The app." });
    await boundBlock("clean", { outputs: { ok: "boolean" } }, "src/app/clean.py", 'return {"ok": True}');

    // Each of these binds its contract, and each breaks one form rule.
    await boundBlock("prints", { outputs: { ok: "boolean" } }, "src/app/prints.py", 'print("hi")\nreturn {"ok": True}');
    await boundBlock("reaches", { outputs: { ok: "boolean" } }, "src/app/reaches.py", 'return {"ok": True}', "import subprocess");
    await boundBlock("pragma", { outputs: { ok: "boolean" } }, "src/app/pragma.py", 'return {"ok": True}  # pyright: ignore');
    await boundBlock(
      "loose",
      { outputs: { ok: "boolean" } },
      "src/app/loose.py",
      'return {"ok": bool(helper())}',
      "from src.app.helper import helper",
    );
    await write("src/app/helper.py", "def helper():\n    return 1\n");
    await boundBlock("shadow", { outputs: { ok: "boolean" } }, "src/app/shadow.py", 'return {"ok": bool(thing())}', "from code.thing import thing");
    await boundBlock("thing", { outputs: { ok: "boolean" } }, "code/thing.py", 'return {"ok": True}');
    await boundBlock(
      "walks",
      { outputs: { ok: "boolean" } },
      "src/app2/walks.py",
      'return {"ok": other is not None}',
      "from src.app2.other import other",
    );
    await boundBlock("other", { outputs: { ok: "boolean" } }, "src/app2/other.py", 'return {"ok": True}');
    await write("src/app2/__init__.py", "x = 1\n");

    // A contract imported for real, a missing future import, and a sync def.
    await block("app/outside", { responsibility: "outside.", code: "src/app/outside.py#outside", outputs: { ok: "boolean" } });
    await write(
      "src/app/outside.py",
      "from blocks._contracts.app.outside.contract import OutsideCaps, OutsideInput, OutsideOutput\n\n\nasync def outside(input: OutsideInput, caps: OutsideCaps) -> OutsideOutput:\n    return {\"ok\": True}\n",
    );
    await block("app/no-future", { responsibility: "no future.", code: "src/app/no_future.py#no_future", outputs: { ok: "boolean" } });
    await write(
      "src/app/no_future.py",
      'from typing import TYPE_CHECKING\n\nif TYPE_CHECKING:\n    from blocks._contracts.app.no_future.contract import NoFutureCaps, NoFutureInput, NoFutureOutput\n\n\nasync def no_future(input: NoFutureInput, caps: NoFutureCaps) -> NoFutureOutput:\n    return {"ok": True}\n',
    );
    await block("app/sync-def", { responsibility: "sync.", code: "src/app/sync_def.py#sync_def", outputs: { ok: "boolean" } });
    await write(
      "src/app/sync_def.py",
      'from __future__ import annotations\n\nfrom typing import TYPE_CHECKING\n\nif TYPE_CHECKING:\n    from blocks._contracts.app.sync_def.contract import SyncDefCaps, SyncDefInput, SyncDefOutput\n\n\ndef sync_def(input: SyncDefInput, caps: SyncDefCaps) -> SyncDefOutput:\n    return {"ok": True}\n',
    );
    // A relative import, a whole folder imported, and a package that is not there.
    await boundBlock("rel", { outputs: { ok: "boolean" } }, "src/app/rel.py", 'return {"ok": bool(helper())}', "from .helper import helper");
    await boundBlock("bare", { outputs: { ok: "boolean" } }, "src/app/bare.py", 'return {"ok": True}', "from src.app import helper");
    await boundBlock("missing", { outputs: { ok: "boolean" } }, "src/app/missing.py", 'return {"ok": True}', "import surely_not_installed_xyz");
    // A decorated function, a wrong annotation, and a missing caps parameter.
    await block("app/dressed", { responsibility: "dressed.", code: "src/app/dressed.py#dressed", outputs: { ok: "boolean" } });
    await write(
      "src/app/dressed.py",
      'from __future__ import annotations\n\nfrom typing import TYPE_CHECKING\n\nif TYPE_CHECKING:\n    from blocks._contracts.app.dressed.contract import DressedCaps, DressedInput, DressedOutput\n\n\ndef keep(f):\n    return f\n\n\n@keep\nasync def dressed(input: DressedInput, caps: DressedCaps) -> DressedOutput:\n    return {"ok": True}\n',
    );
    await block("app/mislabeled", { responsibility: "mislabeled.", code: "src/app/mislabeled.py#mislabeled", outputs: { ok: "boolean" } });
    await write(
      "src/app/mislabeled.py",
      'from __future__ import annotations\n\nfrom typing import TYPE_CHECKING\n\nif TYPE_CHECKING:\n    from blocks._contracts.app.mislabeled.contract import MislabeledCaps, MislabeledInput, MislabeledOutput\n\n\nasync def mislabeled(input: dict, caps: MislabeledCaps) -> MislabeledOutput:\n    return {"ok": True}\n',
    );
    await block("app/solo", { responsibility: "solo.", code: "src/app/solo.py#solo", outputs: { ok: "boolean" } });
    await write(
      "src/app/solo.py",
      'from __future__ import annotations\n\nfrom typing import TYPE_CHECKING\n\nif TYPE_CHECKING:\n    from blocks._contracts.app.solo.contract import SoloCaps, SoloInput, SoloOutput\n\n\nasync def solo(input: SoloInput) -> SoloOutput:\n    return {"ok": True}\n',
    );

    const report = await checkProject(dir);
    const messages = report.systems[0]!.codeProblems.map((problem) => `${problem.file}: ${problem.message}`);
    const said = (file: string, part: string) =>
      expect(messages.filter((message) => message.startsWith(`${file}:`)).join("\n")).toContain(part);

    said("src/app/prints.py", "uses `print`");
    said("src/app/reaches.py", "imports `subprocess`, which reaches outside the block");
    said("src/app/pragma.py", "`# pyright:` comment");
    said("src/app/loose.py", "imports src/app/helper.py, which is not the code of a block held to its contract");
    said("src/app/shadow.py", "also the name of something installed");
    said("src/app2/walks.py", "src/app2/__init__.py, which holds code that would run outside any block");
    said("src/app/outside.py", "outside `if TYPE_CHECKING:`");
    said("src/app/no_future.py", "`from __future__ import annotations`");
    said("src/app/sync_def.py", "must be `async def`");
    said("src/app/rel.py", "imports relatively");
    said("src/app/bare.py", "imports the folder src.app");
    said("src/app/missing.py", "imports `surely_not_installed_xyz`, which is not installed");
    said("src/app/dressed.py", "must not be decorated");
    said("src/app/mislabeled.py", "`input` must be annotated MislabeledInput");
    said("src/app/solo.py", "must take exactly a value and `caps`");
    // The parameter named input is the form itself, never a problem, and a
    // TYPE_CHECKING import is exempt from the import rules.
    expect(messages.filter((message) => message.startsWith("src/app/clean.py:"))).toEqual([]);
  }, 120_000);

  it("says where it looked when there is no Python, and only where something is bound", async () => {
    await manifest();
    await block("app", { role: "component", responsibility: "The app." });
    await boundBlock("add", { inputs: { a: "number" }, outputs: { sum: "number" } }, "src/add.py", 'return {"sum": input["a"]}');

    const searched = process.env.PATH;
    process.env.PATH = dir;
    try {
      const report = await checkProject(dir);
      expect(report.systems[0]!.codeProblems).toEqual([
        expect.objectContaining({ message: expect.stringContaining("found no Python 3.11 or later") }),
      ]);
      expect(report.systems[0]!.interpreter).toBeUndefined();
      expect(report.errorCount).toBe(1);
    } finally {
      process.env.PATH = searched;
    }

    // Drawn-only Python asks for no interpreter at all, so a machine without
    // Python still checks a described project clean.
    await write("src/add.py", 'async def add(input, caps):\n    return {"sum": input["a"]}\n');
    process.env.PATH = dir;
    try {
      const clean = await checkProject(dir);
      expect(clean.systems[0]!.codeProblems).toEqual([]);
      expect(clean.errorCount).toBe(0);
    } finally {
      process.env.PATH = searched;
    }
  }, 120_000);

  it("finds a sound system clean, generated contracts included, and names the interpreter", async () => {
    await manifest();
    await block("app", { role: "component", responsibility: "The app." });
    // Enum ports and a nested row shape, so the generated TypedDicts are
    // themselves under the typechecker here; the allowed standard library
    // and a type-only import of something otherwise refused stay clean.
    await boundBlock(
      "import-rows",
      { inputs: { rows: "{ id: string; kind: \"a\" | \"b\" }[]" }, outputs: { imported: "number" } },
      "src/app/import_rows.py",
      'return {"imported": float(len(input["rows"]))}',
    );
    await boundBlock(
      "report",
      { inputs: { rows: "{ id: string; kind: \"a\" | \"b\" }[]" }, outputs: { total: "number" }, capabilities: { log: "Logger" } },
      "src/app/report.py",
      'count = await import_rows({"rows": input["rows"]}, caps)\ncaps.log.log(json.dumps({"n": math.floor(count["imported"])}))\nreturn {"total": count["imported"]}',
      "import json\nimport math\nfrom src.app.import_rows import import_rows",
      "import subprocess",
    );
    // A block whose id is a word Python reserves, whose input holds a
    // reserved-word optional key, so the mirror's import_ segment and the
    // functional-form TypedDict are both really typechecked here.
    await block("app/import", {
      responsibility: "Bring rows in.",
      code: "src/app/bring.py#bring_in",
      inputs: { rows: "{ id: string }[]", flags: "{ class?: boolean; on: boolean }" },
      outputs: { imported: "number" },
    });
    await write(
      "src/app/bring.py",
      'from __future__ import annotations\n\nfrom typing import TYPE_CHECKING\n\nif TYPE_CHECKING:\n    from blocks._contracts.app.import_.contract import ImportCaps, ImportInput, ImportOutput\n\n\nasync def bring_in(input: ImportInput, caps: ImportCaps) -> ImportOutput:\n    return {"imported": float(len(input["rows"]))}\n',
    );
    // A block that returns nothing, whose Output is a TypeAlias for None.
    await boundBlock("log-note", { inputs: { note: "string" }, capabilities: { log: "Logger" } }, "src/app/log_note.py", 'caps.log.log(input["note"])\nreturn None');

    const report = await checkProject(dir);
    expect(report.systems[0]!.codeProblems).toEqual([]);
    expect(report.systems[0]!.codeHeld).toBe(4);
    expect(report.systems[0]!.interpreter).toBeTruthy();
    expect(report.errorCount).toBe(0);
  }, 120_000);
});
