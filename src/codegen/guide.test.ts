import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GUIDE_FILE, SKILLS_DIR, agentGuide, architectureExample, compactJson, workedExample } from "./guide.js";
import { COMMANDS, firstStep } from "./commands.js";
import { writeAgentFiles } from "./emit.js";
import { blockFromFile } from "../model/block.js";
import { CAPABILITIES } from "../model/capabilities.js";
import { ARCHITECTURE_ROLES } from "../model/roles.js";
import { blockDir, manifestPath, manifestSchema } from "../project/project.js";
import type { Manifest } from "../project/project.js";
import { loadExecutions } from "../project/executions.js";
import { evaluate } from "../run/expect.js";
import { casesSchema } from "../run/cases.js";
import { runCases } from "../run/run.js";
import { checkProject } from "../check/check.js";
import { checkRecording } from "../model/recorded.js";
import { writeWorkedExample } from "../project/exampleHistory.js";
import { findPython } from "../run/python.js";
import { recordExecution } from "../run/record.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "fragmentor-guide-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const project = (over: Partial<Manifest> = {}): Manifest => ({
  name: "Test",
  goal: "",
  existingCode: false,
  start: "build",
  language: "typescript",
  granularity: { level: 3, maxDepth: 4 },
  systems: [],
  ...over,
});

async function writeBlocks(blocks: Record<string, unknown>): Promise<void> {
  for (const [blockPath, file] of Object.entries(blocks)) {
    await mkdir(blockDir(dir, blockPath), { recursive: true });
    await writeFile(path.join(blockDir(dir, blockPath), "block.json"), JSON.stringify(file, null, 2), "utf8");
  }
}

/** A Python that can parse a file, or nothing if the machine has none. */
const python = ["python", "python3", "py"].find((candidate) => spawnSync(candidate, ["-c", "print(1)"]).status === 0) ?? null;

/** A Python Fragmentor can run (3.11 or later), probed in an empty folder of its own. */
const python311 = (() => {
  const probe = mkdtempSync(path.join(tmpdir(), "fragmentor-guide-gate-"));
  try {
    return findPython(probe).ok;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

/** The slash command Claude Code offers for each command, as the files Fragmentor writes for them. */
const SKILLS = COMMANDS.map((command) => `${SKILLS_DIR}/fragmentor-${command.name}/SKILL.md`);

describe("writeAgentFiles", () => {
  const manifest = project();

  it("prepares a folder for an agent", async () => {
    expect(await writeAgentFiles(dir, manifest)).toEqual({
      written: ["FRAGMENTOR.md", "AGENTS.md", "CLAUDE.md", ...SKILLS],
      kept: [],
      withoutGuide: [],
    });
    expect(await readFile(path.join(dir, GUIDE_FILE), "utf8")).toBe(agentGuide(manifest));
  });

  it("points both Claude Code and Codex at the guide", async () => {
    await writeAgentFiles(dir, manifest);

    // Claude Code follows @-imports in CLAUDE.md; Codex reads AGENTS.md.
    const claude = await readFile(path.join(dir, "CLAUDE.md"), "utf8");
    expect(claude).toContain("@FRAGMENTOR.md");
    expect(claude).toContain("@AGENTS.md");
    expect(await readFile(path.join(dir, "AGENTS.md"), "utf8")).toContain("read `FRAGMENTOR.md`");
  });

  it("refreshes the guide but never touches instructions a person may have edited", async () => {
    await writeAgentFiles(dir, manifest);
    const ours = "# Ours\nRead FRAGMENTOR.md first.\nUse tabs.\n";
    await writeFile(path.join(dir, "AGENTS.md"), ours, "utf8");
    await writeFile(path.join(dir, GUIDE_FILE), "stale", "utf8");

    expect(await writeAgentFiles(dir, manifest)).toEqual({
      written: ["FRAGMENTOR.md"],
      kept: ["AGENTS.md", "CLAUDE.md"],
      withoutGuide: [],
    });
    expect(await readFile(path.join(dir, "AGENTS.md"), "utf8")).toBe(ours);
    expect(await readFile(path.join(dir, GUIDE_FILE), "utf8")).toBe(agentGuide(manifest));
  });

  it("writes nothing when the guide is already current", async () => {
    await writeAgentFiles(dir, manifest);
    expect((await writeAgentFiles(dir, manifest)).written).toEqual([]);
  });

  it("points out instructions that were already there but never mention the guide", async () => {
    await writeFile(path.join(dir, "CLAUDE.md"), "# House rules\nUse tabs.\n", "utf8");

    expect(await writeAgentFiles(dir, manifest)).toEqual({
      written: ["FRAGMENTOR.md", "AGENTS.md", ...SKILLS],
      kept: ["CLAUDE.md"],
      withoutGuide: ["CLAUDE.md"],
    });
  });
});

describe("the guide", () => {
  const guides: Record<string, string> = {
    TypeScript: agentGuide(project()),
    Python: agentGuide(project({ language: "python" })),
    "with the language left open": agentGuide(project({ language: undefined })),
    "in a language there is no pack for": agentGuide(project({ language: "Go", existingCode: true })),
  };

  for (const [label, guide] of Object.entries(guides)) {
    it(`(${label}) has nothing left unfilled, and one kind of line ending`, () => {
      expect(guide).not.toMatch(/\{\{|\}\}/);
      expect(guide).not.toContain("\r");
      // Blank runs in the prose are a section that vanished; inside a code
      // fence they are the code as written, held to exactly.
      expect(guide.replace(/```[\s\S]*?```/g, "```code```")).not.toMatch(/\n\n\n/);
    });
  }

  it("is short enough for an agent to take in at once", () => {
    // The two guides these replaced ran to 213 and 197 lines, and every
    // project now gets one that also teaches executions, which the structured
    // one never did. That section, saying where each block's code is, and what
    // an execution expects — the half of one that makes it a test, which three
    // agents writing executions each reported missing, along with the three
    // matching rules that decide whether an expectation means what it says —
    // and the one line asking for a commit each time a block is finished,
    // because those commits are its versions — and the notes, which are the
    // one way the person asks for work beside the block it is about, and
    // which an agent that has never been told what `fragmentor notes` asks
    // of it cannot answer at all — and a line for each of the commands the
    // person sets the agent going with, since an agent cannot guess what a
    // phrase of Fragmentor's own asks for, with a line asking it to say when
    // it starts on a note, so the person sees what is being worked on, is
    // the whole of what has been allowed to add to these numbers.
    //
    // Then the first real agents to follow it, on real codebases and empty
    // folders, each had to find out the same few things by trial and error:
    // what to write first, where `planned` goes, when executions are written,
    // how a test seeds a store, what tests the code Fragmentor does not run,
    // and, where the folder already held code, how that code is described and
    // held to a contract. Saying so cost the lines and characters below, a
    // little of it paid back by trimming. Lines alone let a guide grow by
    // lengthening them, so the characters are held too. What the second round
    // of them met — how a recorded execution is judged, store steps, refusals,
    // where a store sits, clients, an empty TypeScript folder — was paid for
    // entirely by trimming, with these unchanged.
    const within = (guide: string, lines: number, characters: number) => {
      expect(guide.split("\n").length).toBeLessThan(lines);
      expect(guide.length).toBeLessThan(characters);
    };
    within(guides.TypeScript!, 316, 31_000);
    within(agentGuide(project({ start: "plan" })), 318, 31_300);
    within(agentGuide(project({ existingCode: true })), 323, 32_000);
    // The Python guide carries the worked example in Python and the longer
    // import rules — the venv, the future import and the TYPE_CHECKING guard
    // all have to be taught — which is what its own cap pays for.
    within(guides.Python!, 325, 31_700);
    // Nothing is generated or run without a pack, so contracts and block
    // testing fall away, and so does a note flagging a failed run. What is
    // left still teaches executions, notes and the commands, which is why
    // this is not much smaller than it was.
    expect(guides["in a language there is no pack for"]!.split("\n").length).toBeLessThan(271);
  });

  it("tells an agent about every capability, and how to check and test its work", () => {
    const guide = guides.TypeScript!;
    for (const name of Object.keys(CAPABILITIES)) expect(guide).toContain(`**${name}**`);
    expect(guide).toContain("`fragmentor check`");
    expect(guide).toContain("`fragmentor test`");
    expect(guide).toContain("leads to code held to its contract, and holds what you wrote down to what ran.");
    expect(guide).toContain("readFile(path: string) → string");
  });

  it("asks for a commit each time a block is built, because those commits are its versions", () => {
    for (const guide of Object.values(guides)) expect(guide).toContain("Commit each block you build as soon as it passes");
  });

  it("asks for the versions the person saves to be committed and left alone", () => {
    for (const guide of Object.values(guides)) {
      expect(guide).toContain("kept in `.fragmentor/versions/`: commit them with everything else, and never change or delete them.");
    }
  });

  it("tells every agent what each command the person can give it means", () => {
    for (const guide of Object.values(guides)) {
      expect(guide).toContain("## Commands");
      for (const command of COMMANDS) expect(guide).toContain(`fragmentor ${command.name}`);
      expect(guide).toContain("`/fragmentor-review`");
      // How the person asked for the notes before there were commands.
      expect(guide).not.toContain("review fragmentor");
    }
  });

  it("gives the person no phrase that is word for word a command of the program, but the notes one", () => {
    // The `fragmentor` program's own commands, as cli.ts takes them.
    const program = ["init", "check", "test", "notes", "working", "reply", "note", "diff", "help"];
    expect(COMMANDS.map((command) => command.name).filter((name) => program.includes(name))).toEqual(["notes"]);
  });

  it("has the tests it adds kept only where they pass, so every later `fragmentor test` can pass", () => {
    const cover = COMMANDS.find((command) => command.name === "cover")!;
    expect(cover.steps).toContain("keep only what passes. Change no code");
    expect(cover.steps).toContain("do not keep it with the saved tests, and leave a note on the block with `fragmentor note`");
    expect(cover.steps).toContain("with its input, what it should give and what it gives");
  });

  it("gives a new project the one command its answers call for first", () => {
    // Code already there is drawn from; nothing yet is planned, or made straight away.
    expect(firstStep(true, "build")).toMatchObject({ phrase: "fragmentor rebuild", next: null });
    expect(firstStep(false, "plan")).toMatchObject({ phrase: "fragmentor plan <what you want to build>", next: "fragmentor build" });
    expect(firstStep(false, "build")).toMatchObject({ phrase: "fragmentor make <what you want to build>", next: null });
    // Whatever it names is a command every agent is told the meaning of.
    for (const [existingCode, start] of [[true, "build"], [false, "plan"], [false, "build"]] as const) {
      expect(COMMANDS).toContain(firstStep(existingCode, start).command);
    }
  });

  it("builds what `make` is given straight away, whichever way the project began", () => {
    const make = COMMANDS.find((command) => command.name === "make")!;
    expect(make.takes).toBe("words");
    expect(make.steps).toContain("build it straight away rather than drawing it as a plan to be agreed first, whichever way this project began");
    // The rebuild a project of existing code starts with has no diagram to redraw yet.
    expect(COMMANDS.find((command) => command.name === "rebuild")!.steps).toContain("with no diagram yet, the whole codebase");
  });

  it("says what each command does in words that read the same in Fragmentor and in Claude Code's / menu", () => {
    // A summary is also its slash command's description, read beside the chat rather than in Fragmentor.
    for (const command of COMMANDS) expect(command.summary).not.toMatch(/\bhere\b/);
  });

  it("tells every agent what `fragmentor notes` means, and how to answer the notes it finds", () => {
    for (const guide of Object.values(guides)) {
      expect(guide).toContain("## Notes");
      expect(guide).toContain("**When the person says `fragmentor notes`, run it just as they said it.**");
      expect(guide).toContain("`fragmentor working <id>`");
      expect(guide).toContain('`fragmentor reply <id> "<what you did>"`');
      expect(guide).toContain('A question is answered, not acted on: answer it with `fragmentor reply <id> --no-commit "<your answer>"`');
      expect(guide).toContain("only if it was made since the person wrote and changed the note's block");
      expect(guide).toContain('`fragmentor note <block-path> "<text>"`');
      expect(guide).toContain("`.fragmentor/notes/`");
    }
    // Only a block Fragmentor runs can have a failed run flagged on it.
    expect(guides.TypeScript).toContain("A note flagged from a failed run");
    expect(guides["in a language there is no pack for"]).not.toContain("A note flagged from a failed run");
  });

  it("says that every function block points at its code, and that the layout is the codebase's own", () => {
    for (const guide of Object.values(guides)) {
      expect(guide).toContain("**Every function block has one.**");
      expect(guide).toContain("The code is yours, wherever it belongs in the codebase**");
    }
  });

  it("makes the contract's own file, and what binds code to it, plain", () => {
    const guide = guides.TypeScript!;
    expect(guide).toContain("blocks/<the block>/contract.d.ts");
    expect(guide).toContain("**Importing that contract is what binds your code to it.**");
    expect(guide).toContain('from "../../blocks/price-orders/report-totals/contract.js"');
  });

  it("speaks the language the person chose", () => {
    const guide = guides.Python!;
    expect(guide).toContain("blocks/_contracts/<the block>/contract.py");
    expect(guide).toContain("read_file(path: str) → str");
    // The worked example is the same project, written the way Python writes
    // it — and shown exactly as the tests write and run it, blank lines and all.
    expect(guide).toContain("```python");
    expect(guide).toContain(workedExample.python["src/pricing/report_totals.py"]!.trimEnd());
    expect(guide).toContain("if TYPE_CHECKING:");
    expect(guide).toContain('"code": "src/pricing/report_totals.py#report_totals"');
    expect(guide).not.toContain("contract.ts");
    expect(guide).not.toContain("report-totals.ts");
    // Python runs now, so its blocks have saved tests and recorded executions.
    expect(guide).toContain("cases.json");
    expect(guide).toContain("runs each execution whose trigger leads to code held to its contract");
    expect(guide).toContain("Fragmentor runs the project's `.venv` first, then any Python 3.11 or later");
  });

  it("leaves the language to the agent when the person did, and still teaches contracts", () => {
    const guide = guides["with the language left open"]!;
    expect(guide).toContain('`"typescript"`');
    expect(guide).toContain('`"python"`');
    // An agent about to choose TypeScript would otherwise be given nothing to
    // follow about contracts, running or testing.
    expect(guide).toContain("## Contracts");
    expect(guide).toContain("The rest of this guide is written for TypeScript");
  });

  it("is written for the language the systems name, where the project names none", () => {
    const guide = agentGuide(project({ language: undefined, systems: [{ rootBlock: "price-orders", language: "typescript" }] }));
    expect(guide).toContain("## Contracts");
    expect(guide).toContain("which each system says for itself");
  });

  it("says plainly when it can do nothing with the code but draw it", () => {
    const guide = guides["in a language there is no pack for"]!;
    expect(guide).toContain("It has no language pack for Go");
    expect(guide).not.toContain("## Contracts");
    expect(guide).not.toContain("cases.json");
  });

  it("teaches executions in every project, because what happens is half of what a diagram shows", () => {
    for (const guide of Object.values(guides)) {
      expect(guide).toContain("## Executions");
      expect(guide).toContain("executions/report-totals.json");
    }
  });

  it("describes only the granularity the person chose", () => {
    expect(guides.TypeScript).toContain("## Granularity: level 3");
    expect(guides.TypeScript).toContain("around 30 to 80 lines");
    expect(guides.TypeScript).not.toContain("around 10 to 30 lines");
    // The size is something to aim at, not a rule the agent has to satisfy.
    expect(guides.TypeScript).toContain("aims rather than rules");
    expect(agentGuide(project({ granularity: { level: 2, maxDepth: 5 } }))).toContain("at most 5 levels deep");
  });
});

describe("compactJson", () => {
  it("keeps what fits on one line there, and is still exactly the same JSON", () => {
    const value = workedExample.blocks["price-orders/report-totals"];
    const text = compactJson(value);

    expect(JSON.parse(text)).toEqual(value);
    expect(text).toContain('"outputs": { "totals": "number[]", "grandTotal": "number" }');
    expect(text).toContain('"capabilities": { "files": "FileSystem" }');
  });
});

describe("the worked example", () => {
  it("is a valid project by the same rules the checker applies", () => {
    expect(manifestSchema.safeParse(workedExample.manifest).success).toBe(true);
    for (const [blockPath, file] of Object.entries(workedExample.blocks)) {
      expect(() => blockFromFile(file, blockPath.split("/").at(-1)!), blockPath).not.toThrow();
    }
    for (const cases of Object.values(workedExample.cases)) expect(casesSchema.safeParse(cases).success).toBe(true);
  });

  it("checks cleanly before any code is written, which is where an agent starts", async () => {
    await writeFile(manifestPath(dir), JSON.stringify(workedExample.manifest, null, 2), "utf8");
    await writeBlocks(workedExample.blocks);

    const specified = await checkProject(dir);
    // No code is there yet, which is where an agent starts and is not an error.
    expect(specified.errorCount).toBe(0);
    expect(specified.unimplemented).toEqual([
      "price-orders/load-orders",
      "price-orders/price-order",
      "price-orders/report-totals",
    ]);
  });

  it("checks and passes its tests when an agent follows it to the letter", async () => {
    // The project exactly as the guide shows it, with the code it shows and
    // the two blocks it leaves to the reader, and what happens when it is set
    // going, including the expectations it shows: a trace that did not meet
    // the ones printed beside it would teach an agent to write a file that fails.
    await writeWorkedExample(dir, "typescript");
    const { executions, problems } = await loadExecutions(dir);
    expect(problems).toEqual([]);
    expect(evaluate(executions[0]!.declared!, executions[0]!.expect!).failures).toEqual([]);

    const implemented = await checkProject(dir);
    expect(implemented.systems[0]!.codeProblems).toEqual([]);
    expect(implemented.problems).toEqual([]);
    expect(implemented.errorCount).toBe(0);
    expect(implemented.unimplemented).toEqual([]);
    // Every one of them is held to its contract, so every one can be run.
    expect(implemented.drawnOnly).toEqual([]);
    // The guide shows tests for one of the three, so the other two are asked for.
    expect(implemented.untested).toEqual(["price-orders/load-orders"]);

    expect((await runCases(dir, "price-orders/price-order")).map((r) => [r.status, r.differences])).toEqual([
      ["passed", []],
      ["passed", []],
    ]);
    expect((await runCases(dir, "price-orders/report-totals")).map((r) => [r.status, r.differences])).toEqual([["passed", []]]);
  }, 30_000);

  it("writes down an execution that a recording of its code can be held to", async () => {
    await writeWorkedExample(dir, "typescript");
    const recorded = await recordExecution(dir, "report-totals");
    if (!("trace" in recorded)) throw new Error(JSON.stringify(recorded));
    const found = checkRecording(recorded.execution, recorded.trace, recorded.scope, recorded.complete);

    expect(found.expectations).toEqual({
      met: [
        "Something crosses into price-orders/price-order",
        "A call from price-orders/report-totals to price-orders/load-orders",
        'A "response" effect at price-orders/report-totals',
      ],
      failures: [],
      setAside: [],
    });
    expect(found.unwrittenCount).toBe(0);
    // Every step it writes down is one the recording saw, the order priced
    // included: the code passes the whole order, so that is what it shows.
    expect(found.steps).toEqual([
      { id: "#1", verdict: "seen", reason: null, seenAs: "@2" },
      { id: "#2", verdict: "seen", reason: null, seenAs: "@3" },
      { id: "#3", verdict: "seen", reason: null, seenAs: "trigger.response" },
    ]);
  }, 30_000);

  it.skipIf(!python)("shows a Python project its own contract file", () => {
    const guide = agentGuide(project({ language: "python" }));
    expect(guide).toContain("contract.py");
  });

  it.skipIf(!python311)("checks and passes its tests in Python too, followed to the letter", async () => {
    await writeWorkedExample(dir, "python");
    const { executions, problems } = await loadExecutions(dir);
    expect(problems).toEqual([]);
    expect(evaluate(executions[0]!.declared!, executions[0]!.expect!).failures).toEqual([]);

    const implemented = await checkProject(dir);
    expect(implemented.systems[0]!.codeProblems).toEqual([]);
    expect(implemented.problems).toEqual([]);
    expect(implemented.errorCount).toBe(0);
    expect(implemented.unimplemented).toEqual([]);
    expect(implemented.drawnOnly).toEqual([]);
    expect(implemented.untested).toEqual(["price-orders/load-orders"]);

    expect((await runCases(dir, "price-orders/price-order")).map((r) => [r.status, r.differences])).toEqual([
      ["passed", []],
      ["passed", []],
    ]);
    expect((await runCases(dir, "price-orders/report-totals")).map((r) => [r.status, r.differences])).toEqual([["passed", []]]);

    // A broken variant is caught, so the guide cannot teach code that fails.
    await writeFile(
      path.join(dir, "src", "pricing", "price_order.py"),
      (await readFile(path.join(dir, "src", "pricing", "price_order.py"), "utf8")).replace(
        'line["quantity"] * line["unitPrice"]',
        'line["quantity"] + line["unitPrice"]',
      ),
      "utf8",
    );
    expect((await runCases(dir, "price-orders/price-order")).map((r) => r.status)).toEqual(["failed", "passed"]);
  }, 60_000);

  it.skipIf(!python311)("writes down an execution that a recording of its Python code can be held to", async () => {
    await writeWorkedExample(dir, "python");
    const recorded = await recordExecution(dir, "report-totals");
    if (!("trace" in recorded)) throw new Error(JSON.stringify(recorded));
    const found = checkRecording(recorded.execution, recorded.trace, recorded.scope, recorded.complete);

    expect(found.expectations.failures).toEqual([]);
    expect(found.expectations.setAside).toEqual([]);
    expect(found.unwrittenCount).toBe(0);
    expect(found.steps.map((step) => [step.id, step.verdict])).toEqual([
      ["#1", "seen"],
      ["#2", "seen"],
      ["#3", "seen"],
    ]);
  }, 60_000);
});

describe("the guide says where the project starts", () => {
  it("tells an agent in an empty folder that the program is its own to write", () => {
    const guide = agentGuide(project({ existingCode: false }));
    expect(guide).toContain("**This folder started empty**");
    expect(guide).toContain("Lay the code out however suits it");
    expect(guide).not.toContain("the diagram describes it");
  });

  it("tells an agent in a folder of code that the diagram follows the code", () => {
    const guide = agentGuide(project({ existingCode: true }));
    expect(guide).toContain("**This folder already held code**");
    expect(guide).toContain("Never restructure the program to make the diagram tidier");
  });

  it("asks for the architecture as a plan first when that is what the person chose", () => {
    const planning = agentGuide(project({ start: "plan" }));
    expect(planning).toContain("**This project starts as a plan.**");
    expect(planning).toContain("with `\"planned\": true` on each system's top block");
    // Planning spreads down, so it goes on the top of what is planned, and building has to take it off above.
    expect(planning).toContain("Set it on the top block of what is planned");
    expect(planning).toContain("Building a block takes `planned` off it and off every block holding it");
    expect(planning).toContain("Building a block with no code of ours is only taking `planned` off.");
    expect(agentGuide(project({ start: "build" }))).not.toContain("starts as a plan");
  });

  it("tells an agent building straight away not to stop for agreement", () => {
    const building = agentGuide(project({ start: "build" }));
    expect(building).toContain("Carry straight on to the code.");
    expect(building).toContain("do not stop to ask for agreement");
    expect(building).not.toContain("wait for them to agree");

    const planning = agentGuide(project({ start: "plan" }));
    expect(planning).toContain("wait for them to agree before you write any code");
    // The agent cannot show anyone anything; the person looks in Fragmentor.
    expect(planning).toContain("Tell the person to look at the diagram in Fragmentor");
    expect(planning).not.toContain("Show the person");
    expect(planning).not.toContain("Carry straight on");
  });

  it("has every agent write the top of the tree first, and the blocks before the code", () => {
    for (const guide of [agentGuide(project()), agentGuide(project({ existingCode: true })), agentGuide(project({ start: "plan" }))]) {
      const first = guide.split("\n").find((line) => line.startsWith("1. "))!;
      // The top block comes before the entry in `systems` that names it, which could not be read without it.
      expect(first.indexOf("top `block.json`")).toBeGreaterThan(-1);
      expect(first.indexOf("top `block.json`")).toBeLessThan(first.indexOf("`systems`"));
      expect(first).toContain("before its code, so the person watches the structure arrive");
      // Executions come with what starts them, and a plan has none.
      expect(guide).toContain("each with the block that starts it, once that block exists. A plan has none.");
    }
  });

  it("tells an agent in a folder of code that the code is described, and never to change it by the way", () => {
    const guide = agentGuide(project({ existingCode: true }));
    for (const told of ["Carry straight on to the code", "writing whatever is not there yet", "import it and write the block's tests", "You design the blocks, write the code"]) {
      expect(guide).not.toContain(told);
    }
    expect(guide).toContain("Code that was already here is described, not changed: it is drawn rather than checked or run, and that is the expected outcome");
    expect(guide).toContain("## Code that was already here");
    expect(guide).toContain("`file#Class.method`");
    expect(guide).toContain("the step's `code` is the file alone, and an operation such a handler answers leaves out `block`");
    // Both agents read the unrecorded executions this leaves as a fault.
    expect(guide).toContain("its executions are then not recorded, only held to their own expectations, and that is normal.");
    expect(guide).toContain("its `access` line has no port");
    expect(guide).toContain("is for code being built");
    // New code is held to its contract, and so is old code once the person asks, through a function of its own.
    expect(guide).toContain("New code the person asks for is written against its contract wherever it is a function of its own.");
    expect(guide).toContain("When the person asks you to hold a block to its contract, add to the file its code is in a small exported function");

    // A project written from nothing is still told to write its code, and gets none of this.
    const make = agentGuide(project());
    expect(make).toContain("Point each block at its code, writing whatever is not there yet. Where Fragmentor writes a contract, import it and write the block's tests.");
    expect(make).toContain("You design the blocks, write the code");
    expect(make).not.toContain("## Code that was already here");
    // Where nothing can be held to a contract, there is no contract to hold existing code to.
    expect(agentGuide(project({ language: "Go", existingCode: true }))).not.toContain("hold a block to its contract");
  });

  it("has a rebuild commit once and only Fragmentor's files, and a plan committed once written", () => {
    const rebuild = COMMANDS.find((command) => command.name === "rebuild")!;
    expect(rebuild.summary).toContain("none of your code");
    expect(rebuild.steps).toContain("then commit once, with only Fragmentor's files: `fragmentor.json`, `FRAGMENTOR.md`, `blocks/`, `executions/`, `.fragmentor/`, `.claude/skills/`, and any `CLAUDE.md` or `AGENTS.md` that `fragmentor init` created.");
    expect(COMMANDS.find((command) => command.name === "plan")!.steps).toContain("commit the plan");
    // And the guide says the same, rather than asking for a commit per block of a rebuild.
    for (const guide of Object.values({ make: agentGuide(project()), rebuild: agentGuide(project({ existingCode: true })) })) {
      expect(guide).toContain("A rebuild or a plan commits once, when it is done.");
    }
  });

  it("tells an agent in an empty folder how to set up a TypeScript project, and needs no package for contracts", () => {
    const guide = agentGuide(project());
    expect(guide).toContain(
      'Start it with a `tsconfig.json` and a `package.json` holding `"type": "module"`, `typescript` and `@types/node` as dev dependencies, a `build` script, and a `test` script giving `node --test` a file pattern, not a folder.',
    );
    expect(guide).not.toContain("zod");
    expect(agentGuide(project({ language: "python" }))).not.toContain("tsconfig.json");
    expect(agentGuide(project({ existingCode: true }))).not.toContain("tsconfig.json");
  });

  it("says how saved tests seed stores and compare results, and what tests the rest of the code", () => {
    const guide = agentGuide(project());
    expect(guide).toContain("A test gives the stores rows before it runs under `stores`, keyed by the store entry's full address and then by row key");
    expect(guide).toContain("`expected` is compared whole, so leave it out where the result depends on `Clock` or `Random`");
    // `fragmentor test` was twice read as running them.
    expect(guide).toContain("is covered by the project's own tests and typecheck: run them yourself, since `fragmentor test` does not.");
    expect(guide).not.toContain("beside `fragmentor test`");
    // A refusal thrown is reported as an error, which no test can expect.
    expect(guide).toContain("A block that turns input away returns the refusal as a value, such as an `error` field, so tests and executions can check it.");
  });

  it("says what a recording of an execution can check, and how a store step is written", () => {
    const guide = agentGuide(project());
    expect(guide).toContain(
      "The run starts at the block the trigger is handed to, so the hand-off and anything HTTP-level cannot be checked: pin values at what that block returns, which a `response` at the operation is compared with.",
    );
    expect(guide).toContain("Leave `Clock` and `Random` values out of steps and expectations, as out of tests.");
    // A recording names the row read or removed as `{ key }`, so that is how a written step names it.
    expect(guide).toContain('has as its `payload` the row it wrote, or `{ "key": … }` for the row it read or removed');
    // Nothing is recorded without a pack that runs code, so none of it is said there.
    expect(agentGuide(project({ language: "Go" }))).not.toContain("The run starts at the block");
  });

  it("puts a store beside what uses it, and gives a client's action a direction", () => {
    const guide = agentGuide(project());
    expect(guide).toContain("A store goes beside what uses it: beside a service, not inside it.");
    expect(guide).not.toContain("inside the lowest block that holds all of them");
    expect(guide).toContain("An operation or a client's action writes its two directions apart");
    expect(guide).toContain("may leave out one but not both");
  });

  it("explains planned blocks", () => {
    const guide = agentGuide(project());
    expect(guide).toContain("`planned: true`");
    expect(guide).toContain("greyed out");
  });

  it("shows the person's answers in the example project file, so they are not changed", () => {
    const guide = agentGuide(project({ existingCode: true, start: "plan" }));
    expect(guide).toContain('"existingCode": true');
    expect(guide).toContain('"start": "plan"');
    expect(guide).toContain("Leave `existingCode`, `start` and `granularity` as the person set them.");
    expect(guide).not.toContain('"mode"');
  });
});

describe("the architecture the guide shows", () => {
  it("checks clean exactly as printed, in a service that holds all three", async () => {
    // Everything the guide prints, checked in one place, laid out as the
    // guide says: the store and the payment service beside the service that
    // uses them, and found from the block inside it by looking outward.
    await writeFile(
      manifestPath(dir),
      JSON.stringify({ ...workedExample.manifest, systems: [{ rootBlock: "orders-app" }] }, null, 2),
      "utf8",
    );
    await writeBlocks({
      // The client sits beside the service it calls, not inside it, which is
      // the shape every one of these examples is written for.
      "orders-app": { role: "component", responsibility: "The orders application." },
      "orders-app/orders-page": architectureExample["orders-page"]!,
      "orders-app/orders-api": architectureExample["orders-api"]!,
      "orders-app/orders-db": architectureExample["orders-db"]!,
      "orders-app/billing": architectureExample.billing!,
      "orders-app/orders-api/load-orders": architectureExample["load-orders"]!,
    });

    const report = await checkProject(dir);
    expect(report.errorCount).toBe(0);
    // Neither a database nor someone else's payment service is unfinished work.
    expect([...report.architecture].sort()).toEqual([
      "orders-app",
      "orders-app/billing",
      "orders-app/orders-api",
      "orders-app/orders-db",
      "orders-app/orders-page",
    ]);
    // The one block that is code is the one still to be written, which is
    // reported once, against it, as the warning it is.
    expect(report.unimplemented).toEqual(["orders-app/orders-api/load-orders"]);
    expect(report.problems).toEqual([
      expect.objectContaining({ severity: "warning", blockPath: "orders-app/orders-api/load-orders" }),
    ]);
  });

  it("names every role it offers, and shows both halves of joining one up", () => {
    const guide = agentGuide(project());
    for (const role of ARCHITECTURE_ROLES) expect(guide).toContain(`\`"${role}"\``);
    expect(guide).toContain('"role": "database"');
    // The access names the capability port at this end, which is what makes
    // it the way the code actually gets there rather than only a description.
    expect(guide).toContain('"access": ["orders reads orders-db.orders"]');
    expect(guide).toContain('"capabilities": { "orders": "Store" }');
    // And which block answers an operation, without which the blocks inside
    // a service show inputs arriving from nowhere.
    expect(guide).toContain('"block": "load-orders"');
    // And which of a block's own entries does the reaching, without which
    // two buttons calling two operations would be one line.
    expect(guide).toContain('"showOrders calls orders-api.listOrders"');
  });
});
