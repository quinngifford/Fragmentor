import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { projectSnapshot } from "../../src/project/snapshot.js";
import type { SnapshotExecution } from "../../src/project/snapshot.js";
import { addressesOf, placeEvent } from "../../src/model/trace.js";
import type { Trace } from "../../src/model/trace.js";
import { PROJECT_VIEW, WAY_IN, buildGraph, drawnAt } from "./graph.js";
import { describeStep, diagramFor, overlayOf } from "./execution.js";
import { ui } from "./state.js";

/**
 * An execution as the canvas draws it, without drawing it: which lines, counts
 * and marks one trace becomes on whichever diagram is open. The same trace is
 * read at several resolutions, which is the point of keeping it apart from
 * the architecture.
 */

const messenger = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "examples", "messenger");

let sending: SnapshotExecution;
let trace: Trace;

beforeAll(async () => {
  ui.snapshot = await projectSnapshot(messenger);
  sending = ui.snapshot.executions.find((execution) => execution.id === "send-a-message")!;
  trace = sending.declared!;
});

function drawn(view: string, opened: string[] = [], at: number | null = null) {
  ui.view = view;
  const reached = new Set(trace.events.flatMap((event) => addressesOf(event).map((address) => address.path)));
  const graph = buildGraph(view, { opened: new Set(opened), reached })!;
  return overlayOf(graph, sending, trace, at);
}

const lines = (overlay: ReturnType<typeof drawn>) =>
  Object.fromEntries(overlay.lines.map((line) => [`${line.from?.key ?? "outside"} -> ${line.to.key}${line.to.entry ? `.${line.to.entry}` : ""}`, line.label]));

describe("one execution at every resolution", () => {
  it("gathers the whole message into three lines across the application", () => {
    const overlay = drawn("app");

    expect(lines(overlay)).toEqual({
      "outside -> client": "",
      "client -> api.sendMessage": "call",
      // A read, a write and a send, all from inside the API to inside the infrastructure.
      "api -> infrastructure": "×3",
    });
    // What happened out of sight inside a block is counted on it.
    expect(overlay.inside.get("api")?.count).toBe(4);
    expect(overlay.inside.get("client")?.count).toBe(2);
    expect(overlay.effects.get("infrastructure")?.labels).toEqual(["row changed", "message published"]);
    expect(overlay.effects.get("api")?.labels).toEqual(["response"]);
    // The workers had nothing to do with it, so they are dimmed.
    expect([...overlay.involved].sort()).toEqual(["api", "client", "infrastructure"]);
  });

  it("draws the same trace finer inside the API, with the rest of the system around it", () => {
    const overlay = drawn("app/api");

    expect(lines(overlay)).toEqual({
      "outside -> ctx:app/client": "",
      "ctx:app/client -> (way in).sendMessage": "call",
      "(way in) -> router": "call",
      "router -> auth": "call",
      "auth -> ctx:app/infrastructure": "read",
      "router -> messaging": "×2",
      "messaging -> ctx:app/infrastructure": "×2",
    });
    // The response is sent at the API's own operation.
    expect(overlay.effects.get(WAY_IN)?.labels).toEqual(["response"]);
  });

  it("splits a line into its parts once the tile it reaches is opened", () => {
    const overlay = drawn("app/api", ["app/infrastructure"]);
    const shown = lines(overlay);
    expect(shown["messaging -> ctx:app/infrastructure/database"]).toBe("write");
    expect(shown["messaging -> ctx:app/infrastructure/queue"]).toBe("send");
    expect(overlay.effects.get("ctx:app/infrastructure/queue")?.labels).toEqual(["message published"]);
  });

  it("draws two calls into a block the focus is inside as one line, whichever operation each named", () => {
    // Inside messaging, the API is a frame tile with no rows, so logging in
    // and sending a message are both calls to the same place on screen.
    const calls: Trace = {
      source: "declared",
      execution: "two-calls",
      events: [
        { type: "interaction", id: "in", cause: null, from: { path: "app/client", entry: null }, to: { path: "app/api", entry: "logIn" }, kind: "call" },
        { type: "interaction", id: "send", cause: "in", from: { path: "app/client", entry: null }, to: { path: "app/api", entry: "sendMessage" }, kind: "call" },
      ],
    };
    ui.view = "app/api/messaging";
    const graph = buildGraph("app/api/messaging", { opened: new Set(), reached: new Set(["app/api", "app/client"]) })!;
    const overlay = overlayOf(graph, sending, calls, null);
    expect(overlay.lines.map((line) => [line.id, line.label])).toEqual([["ctx:app/client->ctx:app/api", "×2"]]);
    // And the second call, stepped to, is on that one line.
    expect(overlayOf(graph, sending, calls, 1).lines[0]!.current).toBe("out");
  });

  it("marks what carried something apart from what only set something off", () => {
    const overlay = drawn("app");
    // Every step of sending a message carries the message or a part of it.
    expect(overlay.lines.every((line) => line.data)).toBe(true);

    // A trigger that carries nothing only lights up.
    const bare: Trace = { ...trace, events: [{ ...trace.events[0]!, payload: undefined } as Trace["events"][number]] };
    const graph = buildGraph("app", { opened: new Set(), reached: new Set() })!;
    expect(overlayOf(graph, sending, bare, null).lines[0]!.data).toBe(false);
  });
});

describe("stepping through it", () => {
  it("shows only what has happened so far, and which line the current step is on", () => {
    // Step 2: the state calls the API.
    const overlay = drawn("app", [], 2);
    expect(lines(overlay)).toEqual({ "outside -> client": "", "client -> api.sendMessage": "call" });
    const current = overlay.lines.find((line) => line.current !== null)!;
    expect(current.to).toEqual({ key: "api", entry: "sendMessage" });
    expect(current.current).toBe("out");
    expect([...overlay.current].sort()).toEqual(["api", "client"]);
  });

  it("runs an answer back along the line it came out on", () => {
    // Step 6: the database gives the session back to the check.
    const overlay = drawn("app", [], 6);
    const current = overlay.lines.find((line) => line.current !== null)!;
    expect(current.from?.key).toBe("api");
    expect(current.to.key).toBe("infrastructure");
    expect(current.current).toBe("back");
  });

  it("points a step hidden inside a block at the diagram that shows it", () => {
    // The router calling the session check happens inside the API.
    expect(diagramFor(trace.events[4]!)).toBe("app/api");
    // The state calling the API is between two parts of the application.
    expect(diagramFor(trace.events[2]!)).toBe("app");
    // The button press, and the chat view changing, each happen at one block.
    expect(diagramFor(trace.events[0]!)).toBe("app/client/ui");
    expect(diagramFor(trace.events[18]!)).toBe("app/client/ui");
  });

  it("says each step in words, naming the blocks as the diagram does", () => {
    expect(describeStep(trace.events[0]!, "action")).toBe('Someone uses Send Button: {"to":"bo","text":"hi"}');
    expect(describeStep(trace.events[5]!, "action")).toBe('Check Session reads Database · sessions: {"id":"s-1"}');
    expect(describeStep(trace.events[6]!, "action")).toBe('Database · sessions gives back to Check Session: {"userId":"ada"}');
    expect(describeStep(trace.events[14]!, "action")).toBe("message published at Queue · notifications");
  });
});

describe("wherever the person is looking", () => {
  it("draws every event of every execution somewhere, at every depth, with the tiles closed or open", () => {
    const snapshot = ui.snapshot!;
    const diagrams = [PROJECT_VIEW, ...Object.values(snapshot.blocks).filter((block) => block.children.length > 0).map((block) => block.path)];
    const everything = Object.keys(snapshot.blocks);

    for (const execution of snapshot.executions) {
      const events = execution.declared!.events;
      const reached = new Set(events.flatMap((event) => addressesOf(event).map((address) => address.path)));
      for (const view of diagrams) {
        for (const opened of [[], everything]) {
          ui.view = view;
          const graph = buildGraph(view, { opened: new Set(opened), reached })!;
          for (const event of events) {
            const placed = placeEvent(event, graph.view);
            const ends = placed.on === "edge" ? [placed.from, placed.to] : [placed.at];
            for (const end of ends) {
              if (end === null) continue;
              expect(drawnAt(graph, end), `${execution.id} event ${event.id} at ${end.path} on ${view || "the project"}`).not.toBeNull();
            }
          }
        }
      }
    }
  });
});
