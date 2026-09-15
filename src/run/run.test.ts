import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runBlock, startRun } from "./run.js";
import type { RunEvent } from "./run.js";

type Call = Extract<RunEvent, { type: "call" }>;
const callsIn = (events: RunEvent[]) => events.filter((event): event is Call => event.type === "call");
const blockOf = (events: RunEvent[], id: number) => callsIn(events).find((call) => call.id === id)?.block ?? null;

/**
 * These run the example project's real code in a real subprocess. They are the
 * only tests that prove a block can actually be executed rather than only
 * generated.
 */

const projectDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "examples", "job-ranker");

const profile = { skills: ["TypeScript", "Node.js", "testing"] };

describe("running a leaf", () => {
  it("returns what the block computed", async () => {
    const result = await runBlock({
      projectDir,
      blockPath: "rank-jobs/extract-profile-keywords",
      input: { profile },
    });

    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ keywords: ["node.js", "testing", "typescript"] });
    expect(result.outputProblems).toEqual([]);
  });

  it("gives a capability that reads from the project", async () => {
    const result = await runBlock({
      projectDir,
      blockPath: "rank-jobs/load-postings",
      input: { path: "postings.json" },
    });

    expect(result.ok).toBe(true);
    const output = result.output as { postings: { title: string }[] };
    expect(output.postings).toHaveLength(4);
    expect(output.postings[0]!.title).toBe("Senior TypeScript Engineer");
  });

  it("refuses to read outside the project", async () => {
    const result = await runBlock({
      projectDir,
      blockPath: "rank-jobs/load-postings",
      input: { path: "../../package.json" },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("outside the project");
  });

  it("reports what a block threw, rather than swallowing it", async () => {
    const result = await runBlock({
      projectDir,
      blockPath: "rank-jobs/load-postings",
      input: { path: "does-not-exist.json" },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe("checking the contract on both sides", () => {
  it("refuses input that does not match, without running anything", async () => {
    const result = await runBlock({
      projectDir,
      blockPath: "rank-jobs/extract-profile-keywords",
      input: { profile: { skills: "TypeScript" } },
    });

    expect(result.ok).toBe(false);
    expect(result.inputProblems).toEqual([expect.stringContaining("input.profile.skills should be a list")]);
    expect(result.durationMs).toBe(0);
  });

  it("names a missing input", async () => {
    const result = await runBlock({ projectDir, blockPath: "rank-jobs/extract-profile-keywords", input: {} });
    expect(result.inputProblems).toEqual(["input.profile is missing."]);
  });
});

describe("running a composite", () => {
  it("runs the whole system, calling every block underneath", async () => {
    const result = await runBlock({
      projectDir,
      blockPath: "rank-jobs",
      input: { sourcePath: "postings.json", profile },
    });

    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.outputProblems).toEqual([]);

    const output = result.output as { ranked: { title: string; score: number; reasons: string[] }[] };
    expect(output.ranked).toHaveLength(4);

    // The TypeScript roles should beat the warehouse job on this profile.
    expect(output.ranked[0]!.title).toBe("Senior TypeScript Engineer");
    expect(output.ranked.at(-1)!.title).toBe("Warehouse Supervisor");
    expect(output.ranked.at(-1)!.score).toBe(0);
    expect(output.ranked[0]!.reasons.join(" ")).toContain("typescript");

    // Ordering is by score, best first.
    const scores = output.ranked.map((entry) => entry.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  }, 30_000);
});

describe("a language that cannot run yet", () => {
  it("says so plainly instead of failing oddly", async () => {
    const result = await runBlock({
      projectDir,
      blockPath: "embed-postings/clean-text",
      input: { posting: { title: "x", description: "y" } },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("cannot run Python blocks yet");
  });
});

describe("watching a run", () => {
  const input = { sourcePath: "postings.json", profile };

  it("reports every block call beneath a composite, each with the call it came from", async () => {
    const events: RunEvent[] = [];
    const result = await runBlock({ projectDir, blockPath: "rank-jobs", input, onEvent: (event) => events.push(event) });
    expect(result.ok).toBe(true);

    const of = (block: string) => callsIn(events).filter((call) => call.block === block);
    const root = of("rank-jobs")[0]!;
    expect(root).toMatchObject({ parent: null, input });
    expect(of("rank-jobs/load-postings")).toHaveLength(1);
    expect(of("rank-jobs/score-posting")).toHaveLength(4);
    expect(of("rank-jobs/score-posting").every((call) => call.parent === root.id)).toBe(true);

    // Each posting's scorer is the parent of the normaliser that ran for it.
    const scorers = new Set(of("rank-jobs/score-posting").map((call) => call.id));
    expect(of("rank-jobs/score-posting/normalize-text").map((call) => scorers.has(call.parent!))).toEqual([true, true, true, true]);

    // What load-postings returned is exactly what went down the wire to the scorers, one posting each.
    const loaded = of("rank-jobs/load-postings")[0]!;
    const returned = events.find((event) => event.type === "return" && event.id === loaded.id) as Extract<RunEvent, { type: "return" }>;
    const postings = (returned.output as { postings: unknown[] }).postings;
    expect(of("rank-jobs/score-posting").map((call) => (call.input as { posting: unknown }).posting)).toEqual(postings);
  }, 30_000);

  it("records nothing, and pauses nowhere, when nobody is watching", async () => {
    const result = await runBlock({ projectDir, blockPath: "rank-jobs", input, breakpoints: ["rank-jobs/load-postings"] });
    expect(result.ok).toBe(true);
  }, 30_000);

  it("holds a run at a breakpoint until it is told to go on", async () => {
    const events: RunEvent[] = [];
    let returnedWhileHeld: boolean | null = null;
    const { control, outcome } = startRun({
      projectDir,
      blockPath: "rank-jobs",
      input,
      breakpoints: ["rank-jobs/rank-results"],
      onEvent: (event) => {
        events.push(event);
        if (event.type !== "paused") return;
        returnedWhileHeld = events.some((each) => each.type === "return" && each.id === event.id);
        setTimeout(() => control.resume("continue"), 50);
      },
    });

    expect((await outcome).ok).toBe(true);
    const held = events.filter((event) => event.type === "paused").map((event) => blockOf(events, event.id));
    expect(held).toEqual(["rank-jobs/rank-results"]);
    expect(returnedWhileHeld).toBe(false);
  }, 30_000);

  it("steps from a block to the next one that starts", async () => {
    const events: RunEvent[] = [];
    const heldAt: (string | null)[] = [];
    const { control, outcome } = startRun({
      projectDir,
      blockPath: "rank-jobs",
      input,
      breakpoints: ["rank-jobs"],
      onEvent: (event) => {
        events.push(event);
        if (event.type !== "paused") return;
        heldAt.push(blockOf(events, event.id));
        control.resume(heldAt.length === 1 ? "step" : "continue");
      },
    });

    expect((await outcome).ok).toBe(true);
    expect(heldAt).toEqual(["rank-jobs", "rank-jobs/load-postings"]);
  }, 30_000);

  it("holds every call of a block run once per item, one at a time", async () => {
    const events: RunEvent[] = [];
    const { control, outcome } = startRun({
      projectDir,
      blockPath: "rank-jobs",
      input,
      breakpoints: ["rank-jobs/score-posting"],
      onEvent: (event) => {
        events.push(event);
        if (event.type === "paused") setTimeout(() => control.resume("continue"), 10);
      },
    });

    expect((await outcome).ok).toBe(true);
    const held = events.filter((event) => event.type === "paused").map((event) => event.id);
    expect(held).toHaveLength(4);
    expect(new Set(held).size).toBe(4);
  }, 30_000);

  it("stops a held run, and says it was stopped", async () => {
    const { control, outcome } = startRun({
      projectDir,
      blockPath: "rank-jobs",
      input,
      breakpoints: ["rank-jobs/load-postings"],
      onEvent: (event) => {
        if (event.type === "paused") control.stop();
      },
    });

    expect(await outcome).toMatchObject({ ok: false, stopped: true });
  }, 30_000);

  it("does not count time held at a breakpoint against the time limit", async () => {
    const { control, outcome } = startRun({
      projectDir,
      blockPath: "rank-jobs/extract-profile-keywords",
      input: { profile },
      timeoutMs: 3000,
      breakpoints: ["rank-jobs/extract-profile-keywords"],
      onEvent: (event) => {
        if (event.type === "paused") setTimeout(() => control.resume("continue"), 3500);
      },
    });

    const result = await outcome;
    expect(result.ok).toBe(true);
    // Nor is it part of how long the run took.
    expect(result.durationMs).toBeLessThan(3000);
  }, 30_000);

  it("lets calls go on once their breakpoint is taken away", async () => {
    const events: RunEvent[] = [];
    const { control, outcome } = startRun({
      projectDir,
      blockPath: "rank-jobs",
      input,
      breakpoints: ["rank-jobs/score-posting"],
      onEvent: (event) => {
        events.push(event);
        if (event.type !== "paused") return;
        // All four postings are waiting at the breakpoint by now.
        control.setBreakpoints([]);
        control.resume("continue");
      },
    });

    expect((await outcome).ok).toBe(true);
    expect(events.filter((event) => event.type === "paused")).toHaveLength(1);
  }, 30_000);

  it("steps into the call it lets go, ahead of the calls still waiting", async () => {
    const events: RunEvent[] = [];
    const heldAt: (string | null)[] = [];
    let stepped = false;
    const { control, outcome } = startRun({
      projectDir,
      blockPath: "rank-jobs",
      input,
      breakpoints: ["rank-jobs/score-posting"],
      onEvent: (event) => {
        events.push(event);
        if (event.type !== "paused") return;
        const block = blockOf(events, event.id);
        heldAt.push(block);
        if (!stepped) {
          stepped = true;
          control.resume("step");
        } else if (block === "rank-jobs/score-posting/normalize-text") {
          control.setBreakpoints([]);
          control.resume("continue");
        }
      },
    });

    expect((await outcome).ok).toBe(true);
    expect(heldAt.at(-1)).toBe("rank-jobs/score-posting/normalize-text");

    // It went into the posting that was let go, not another one still waiting.
    const firstScorer = callsIn(events).find((call) => call.block === "rank-jobs/score-posting")!;
    const heldNormaliser = callsIn(events).find((call) => call.block === "rank-jobs/score-posting/normalize-text")!;
    expect(heldNormaliser.parent).toBe(firstScorer.id);
  }, 30_000);
});
