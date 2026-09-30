import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readAllCode } from "./code.js";
import { blockDir, loadProject } from "./project.js";
import { readProjectReach } from "./reach.js";
import type { ProjectReach } from "./reach.js";
import { RULES_FILE, addRule, evaluateRules, isRulesPath, loadRules, removeRule } from "./rules.js";

/**
 * The person's rules: the file only the application writes, and every rule
 * held to the diagram and the code. The fixture is a small project in a
 * temporary folder; what matters in it is only the shape of the tree, since
 * the reach a rule is held to is passed in as the snapshot would pass it.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "fragmentor-rules-"));
  await writeFile(
    path.join(dir, "fragmentor.json"),
    JSON.stringify({ name: "Rules", granularity: { level: 3, maxDepth: 6 }, systems: [{ rootBlock: "app", language: "typescript" }] }),
    "utf8",
  );
  await block("app", { role: "component", responsibility: "The app." });
  await block("app/db", { role: "database", responsibility: "Holds the rows." });
  await block("app/api", { role: "service", responsibility: "Answers requests.", access: ["reads db"] });
  await block("app/web", { role: "client", responsibility: "The page." });
  await block("app/workers", { role: "component", responsibility: "Works in the background." });
  await block("app/reports", { role: "service", planned: true, responsibility: "Not built yet.", access: ["reads db"] });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function block(blockPath: string, file: Record<string, unknown>): Promise<void> {
  await mkdir(blockDir(dir, blockPath), { recursive: true });
  await writeFile(path.join(blockDir(dir, blockPath), "block.json"), JSON.stringify(file), "utf8");
}

/** Reach as the snapshot would pass it, with only the edges a case is about. */
const seen = (...edges: { from: string; to: string; evidence?: string; approximate?: boolean }[]): ProjectReach => ({
  edges: edges.map((edge) => ({ from: edge.from, to: edge.to, evidence: edge.evidence ?? "open from src/db.ts", approximate: edge.approximate ?? false })),
  notChecked: {},
  unpointed: [],
  systemsRead: { app: true },
});

async function evaluated(reach: ProjectReach | null, ...rules: { rule: string; why?: string }[]) {
  return evaluateRules(await loadProject(dir), reach, rules);
}

describe("how a rule breaks", () => {
  it("holds a never rule to the code, block by block, with the evidence in the message", async () => {
    const held = await evaluated(
      seen({ from: "app/workers", to: "app/db" }, { from: "app/api", to: "app/db" }),
      { rule: "app/workers must never reach app/db", why: "Workers go through the API." },
    );
    expect(held.rules[0]?.brokenBy).toEqual(["app/workers"]);
    expect(held.diagnostics).toEqual([
      {
        severity: "error",
        blockPath: "app/workers",
        message: 'Breaks the rule "app/workers must never reach app/db" (“Workers go through the API.”): open from src/db.ts.',
      },
    ]);
  });

  it("holds an only rule against everything but the block it lets through and the protected block itself", async () => {
    const held = await evaluated(
      seen({ from: "app/api", to: "app/db" }, { from: "app/web", to: "app/db" }, { from: "app/db/inner", to: "app/db" }),
      { rule: "only app/api may reach app/db" },
    );
    // app/reports is the planned block, whose declared "reads db" breaks it too.
    expect(held.rules[0]?.brokenBy).toEqual(["app/reports", "app/web"]);
    expect(held.rules[0]?.guessed).toEqual(["app/reports"]);
    expect(held.diagnostics.map((each) => [each.blockPath, each.severity])).toEqual([
      ["app/reports", "warning"],
      ["app/web", "error"],
    ]);
  });

  it("counts what the diagram declares as reach, so a rule cannot be dodged by never writing the code", async () => {
    // app/api declares "reads db" in its block.json; there is no code at all.
    const held = await evaluated(seen(), { rule: "app/api must never reach app/db" });
    expect(held.rules[0]?.brokenBy).toEqual(["app/api"]);
    expect(held.diagnostics[0]).toMatchObject({ severity: "error", blockPath: "app/api" });
    expect(held.diagnostics[0]?.message).toContain('declares "reads db"');
  });

  it("only warns where Fragmentor had to count a file whole, and stops warning once it is sure", async () => {
    const guessed = await evaluated(
      seen({ from: "app/web", to: "app/db", approximate: true }),
      { rule: "app/web must never reach app/db" },
    );
    expect(guessed.diagnostics[0]?.severity).toBe("warning");
    // A guess says it is one, why, and that it stops nothing.
    expect(guessed.diagnostics[0]?.message).toBe(
      'May break the rule "app/web must never reach app/db": open from src/db.ts. A guess — its file was counted whole — so it does not stop your agent.',
    );
    expect(guessed.rules[0]?.guessed).toEqual(["app/web"]);

    const sure = await evaluated(
      seen({ from: "app/web", to: "app/db", approximate: true }, { from: "app/web", to: "app/db", evidence: "rows from src/db.ts" }),
      { rule: "app/web must never reach app/db" },
    );
    expect(sure.diagnostics[0]?.severity).toBe("error");
  });

  it("only warns about a planned block, whose declared access is a plan rather than code", async () => {
    const held = await evaluated(seen(), { rule: "only app/api may reach app/db" });
    expect(held.rules[0]?.brokenBy).toEqual(["app/reports"]);
    expect(held.diagnostics[0]?.severity).toBe("warning");
  });

  it("fails on a rule naming a block that is gone, telling the agent to re-point it or leave a note", async () => {
    const held = await evaluated(seen(), { rule: "app/gone must never reach app/db" });
    expect(held.rules[0]?.problem).toContain("app/gone, which is not in the diagram");
    expect(held.diagnostics).toEqual([
      {
        severity: "error",
        blockPath: RULES_FILE,
        message: "This rule names app/gone, which is not in the diagram. If the block moved or was renamed, change the rule's path here to follow it; if it is gone, leave the person a note.",
      },
    ]);
  });

  it("says a sentence that is not a rule was edited by hand", async () => {
    const held = await evaluated(seen(), { rule: "workers should not touch the db" });
    expect(held.rules).toEqual([]);
    expect(held.diagnostics[0]).toMatchObject({ severity: "error", blockPath: RULES_FILE });
    expect(held.diagnostics[0]?.message).toContain("not a rule Fragmentor knows");
  });

  it("falls back to declared access alone where no code was read, and says so", async () => {
    const held = await evaluated(null, { rule: "app/api must never reach app/db" });
    expect(held.rules[0]?.declaredOnly).toBe(true);
    expect(held.rules[0]?.brokenBy).toEqual(["app/api"]);
  });

  it("says the same words twice, so a flagged problem is recognised again", async () => {
    const reach = seen({ from: "app/workers", to: "app/db" }, { from: "app/workers", to: "app/db", evidence: "rows from src/db.ts" });
    const rule = { rule: "app/workers must never reach app/db", why: "Workers go through the API." };
    expect(await evaluated(reach, rule)).toEqual(await evaluated(reach, rule));
  });
});

describe("the file the application writes", () => {
  it("adds a rule with its reason, and lets git carry the file", async () => {
    await addRule(dir, "app/workers must never reach app/db", "Workers go through the API.");
    await addRule(dir, "only app/api may reach app/db");
    expect(await loadRules(dir)).toEqual({
      rules: [{ rule: "app/workers must never reach app/db", why: "Workers go through the API." }, { rule: "only app/api may reach app/db" }],
      problem: null,
    });
    // Committed like notes: the allowlist lets the rules through.
    expect(await readFile(path.join(dir, ".fragmentor", ".gitignore"), "utf8")).toContain("!rules.json");
  });

  it("refuses what could never be a rule, and touches nothing when it does", async () => {
    await expect(addRule(dir, "workers should not touch the db")).rejects.toThrow(/is not a rule/);
    await expect(addRule(dir, "app/gone must never reach app/db")).rejects.toThrow(/no block at app\/gone/);
    await expect(addRule(dir, "app/db must never reach app/api")).rejects.toThrow(/never reaches anything itself/);
    await addRule(dir, "app/workers must never reach app/db");
    await expect(addRule(dir, "app/workers must never reach app/db")).rejects.toThrow(/already a rule/);
    expect((await loadRules(dir)).rules).toHaveLength(1);
  });

  it("removes a rule by its sentence, and the file with the last one", async () => {
    await addRule(dir, "app/workers must never reach app/db");
    await addRule(dir, "only app/api may reach app/db");
    await removeRule(dir, "app/workers must never reach app/db");
    expect((await loadRules(dir)).rules).toEqual([{ rule: "only app/api may reach app/db" }]);
    await expect(removeRule(dir, "app/workers must never reach app/db")).rejects.toThrow(/not there any more/);
    await removeRule(dir, "only app/api may reach app/db");
    await expect(readFile(path.join(dir, ".fragmentor", "rules.json"), "utf8")).rejects.toThrow();
  });

  it("reports a file it cannot read as a problem, never as a throw", async () => {
    await mkdir(path.join(dir, ".fragmentor"), { recursive: true });
    await writeFile(path.join(dir, ".fragmentor", "rules.json"), "{ not json", "utf8");
    expect((await loadRules(dir)).problem).toContain("not valid JSON");
    await writeFile(path.join(dir, ".fragmentor", "rules.json"), JSON.stringify({ rules: [{ why: "no sentence" }] }), "utf8");
    expect((await loadRules(dir)).problem).not.toBeNull();
    await expect(addRule(dir, "app/workers must never reach app/db")).rejects.toThrow(/cannot be read/);
  });

  it("knows its own path with either kind of slash, for the file watcher", () => {
    expect(isRulesPath(".fragmentor/rules.json")).toBe(true);
    expect(isRulesPath(".fragmentor\\rules.json")).toBe(true);
    expect(isRulesPath(".fragmentor/notes/a.json")).toBe(false);
  });
});

describe("the examples", () => {
  const examples = fileURLToPath(new URL("../../examples/", import.meta.url));

  async function onExample(name: string, ...rules: { rule: string }[]) {
    const project = await loadProject(path.join(examples, name));
    const reach = await readProjectReach(project, await readAllCode(project));
    return evaluateRules(project, reach, rules);
  }

  it("keeps a rule Messenger honours and breaks one it does not, as an error the check stops on", async () => {
    const held = await onExample(
      "messenger",
      { rule: "app/client must never reach app/infrastructure" },
      { rule: "app/workers must never reach app/client" },
    );
    expect(held.rules.map((rule) => rule.brokenBy)).toEqual([[], ["app/workers/deliver-notification"]]);
    expect(held.rules.map((rule) => rule.declaredOnly)).toEqual([false, false]);
    expect(held.diagnostics).toHaveLength(1);
    expect(held.diagnostics[0]).toMatchObject({ severity: "error", blockPath: "app/workers/deliver-notification" });
    expect(held.diagnostics[0]?.message).toContain("dispatch from src/client/state.ts");
  });

  it("only warns where Tickets' planned reminders would break an only rule", async () => {
    const held = await onExample("tickets", { rule: "only tickets/booking-api may reach tickets/tickets-db" });
    expect(held.rules[0]?.brokenBy).toEqual(["tickets/reminders"]);
    expect(held.diagnostics).toEqual([
      {
        severity: "warning",
        blockPath: "tickets/reminders",
        message:
          'May break the rule "only tickets/booking-api may reach tickets/tickets-db": declares "reads tickets-db.bookings". A guess — this block is planned, so only its declared access could be checked — so it does not stop your agent.',
      },
    ]);
  });
});
