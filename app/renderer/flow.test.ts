import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { projectSnapshot } from "../../src/project/snapshot.js";
import type { TraceEvent } from "../../src/model/trace.js";
import { buildFlow, boxOfStep } from "./flow.js";
import { ui } from "./state.js";

/**
 * One execution as its own drawing: a run read from beginning to end, with a
 * block drawn again every time the run comes back to it, so nothing on it
 * ever loops backwards.
 */

const messenger = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "examples", "messenger");
const word = (event: TraceEvent) => (event.type === "return" ? "gives back" : event.type === "effect" ? event.kind : event.kind);

beforeAll(async () => {
  ui.snapshot = await projectSnapshot(messenger);
});

const flowOf = (id: string) => {
  const execution = ui.snapshot!.executions.find((each) => each.id === id)!;
  return buildFlow(execution.declared!, word);
};

describe("an execution drawn as a flow", () => {
  it("follows the run from beginning to end, a box at a time", () => {
    const flow = flowOf("clean-up-sessions");

    // The job reads the sessions, removes one, and that is the run.
    expect(flow.boxes.map((box) => [box.path, box.arrow?.label ?? "", box.effects.map((effect) => effect.label).join()])).toEqual([
      [null, "", ""],
      ["app/workers/clean-up-sessions", "trigger", ""],
      ["app/infrastructure/database", "read", ""],
      ["app/workers/clean-up-sessions", "gives back", ""],
      ["app/infrastructure/database", "remove", "row removed"],
    ]);
  });

  it("draws a block again each time the run comes back to it, rather than turning round", () => {
    const flow = flowOf("send-a-message");
    const visits = flow.boxes.filter((box) => box.path === "app/api/router").length;
    expect(visits).toBeGreaterThan(1);

    // Every arrow runs to the box that follows it, so the drawing only ever
    // goes forwards.
    flow.boxes.forEach((box, at) => {
      if (box.arrow) expect(at, `box ${at}`).toBeGreaterThan(0);
    });
  });

  it("wraps onto another row rather than running off the side", () => {
    const flow = flowOf("send-a-message");
    const rows = new Set(flow.boxes.map((box) => box.y));
    expect(rows.size).toBeGreaterThan(1);
    expect(flow.boxes.filter((box) => box.wrapped).length).toBe(rows.size - 1);
    // Each row starts back at the left.
    for (const box of flow.boxes.filter((each) => each.wrapped)) expect(box.x).toBe(0);
  });

  it("knows which box a step of the trace is drawn as", () => {
    const flow = flowOf("send-a-message");
    const trace = ui.snapshot!.executions.find((each) => each.id === "send-a-message")!.declared!;
    trace.events.forEach((_event, at) => {
      expect(boxOfStep(flow, at), `step ${at}`).not.toBeNull();
    });
  });
});
