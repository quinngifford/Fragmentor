import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evaluate } from "../run/expect.js";
import { architectureOf, checkExecution, loadExecutions, parseExecutionFile } from "./executions.js";
import type { Architecture, Execution } from "./executions.js";
import { loadProject } from "./project.js";

const examples = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "examples");

function parsed(raw: unknown, id = "send-a-message"): Execution {
  const result = parseExecutionFile(raw, id);
  if (!result.ok) throw new Error(result.problems.join("\n"));
  return result.execution;
}

function problemsOf(raw: unknown, id = "send-a-message"): string[] {
  const result = parseExecutionFile(raw, id);
  return result.ok ? [] : result.problems;
}

/** What every step says of itself. The words are the agent's; only that they are there is checked. */
const said = { description: "One step of sending a message.", code: "src/api/router.ts#route" };

/** What sets a run going says the same two things of itself. */
const setOff = { description: "Someone presses send.", code: "src/client/ui/button.ts#onSendPressed" };

/** The chat example, written down the way an agent would after reading the code. */
const sendAMessage = {
  description: "Someone sends a chat message; it is saved, and the recipient is told.",
  trigger: { at: "app/client/ui/button", kind: "action", ...setOff },
  trace: [
    { ...said, from: "app/client/ui/button", to: "app/client/state", kind: "call", payload: { text: "hi" } },
    { ...said, from: "app/client/state", to: "app/api/router", kind: "call", payload: { text: "hi", to: "bo" } },
    { ...said, from: "app/api/router", to: "app/api/messaging/save-message", kind: "call", response: { id: "m1" } },
    { ...said, from: "app/api/messaging/save-message", to: "app/infrastructure/database.messages", kind: "write" },
    { effect: "row-changed", at: "app/infrastructure/database.messages" },
    { ...said, from: "app/api/router", to: "app/api/messaging/notify-recipient", kind: "call" },
    { ...said, from: "app/api/messaging/notify-recipient", to: "app/infrastructure/queue.publish", kind: "send" },
    { effect: "message-published", at: "app/infrastructure/queue.publish" },
  ],
  expect: {
    entered: ["app/api/messaging"],
    interactions: [{ to: "app/infrastructure/queue.publish", kind: "send" }],
    effects: [{ at: "app/infrastructure/database", kind: "row-changed" }],
    never: ["app/api/auth"],
  },
};

const chatArchitecture: Architecture = new Map<string, string[]>([
  ["app", []],
  ["app/client", []],
  ["app/client/ui", []],
  ["app/client/ui/button", []],
  ["app/client/state", []],
  ["app/api", []],
  ["app/api/router", []],
  ["app/api/auth", []],
  ["app/api/messaging", []],
  ["app/api/messaging/save-message", []],
  ["app/api/messaging/notify-recipient", []],
  ["app/infrastructure", []],
  ["app/infrastructure/database", ["messages"]],
  ["app/infrastructure/queue", ["publish"]],
]);

describe("reading an execution", () => {
  it("names it after its file, and starts its trace with the trigger, from outside", () => {
    const execution = parsed(sendAMessage);
    expect(execution.name).toBe("Send A Message");
    expect(execution.declared?.events[0]).toEqual({
      type: "interaction",
      id: "trigger",
      cause: null,
      from: null,
      to: { path: "app/client/ui/button", entry: null },
      kind: "trigger",
      ...setOff,
    });
  });

  it("keeps a written-down trace as declared, never as recorded", () => {
    expect(parsed(sendAMessage).declared?.source).toBe("declared");
  });

  it("has no trace when none was written down, for one that is only ever run", () => {
    const { trace: _, ...toBeRun } = sendAMessage;
    expect(parsed(toBeRun).declared).toBeNull();
  });

  it("reads a list of steps as a graph, following each from whatever reached where it starts", () => {
    const events = parsed(sendAMessage).declared!.events;
    const causes = Object.fromEntries(events.filter((event) => event.type !== "return").map((event) => [event.id, event.cause]));
    expect(causes).toEqual({
      trigger: null,
      "#1": "trigger",
      "#2": "#1",
      "#3": "#2",
      "#4": "#3",
      "#5": "#4",
      // The second branch leaves the router, so it follows from what reached
      // the router, not from the database written just before it.
      "#6": "#2",
      "#7": "#6",
      "#8": "#7",
    });
  });

  it("brings a response back once everything it set off is done", () => {
    const order = parsed(sendAMessage).declared!.events.map((event) => event.id);
    expect(order).toEqual(["trigger", "#1", "#2", "#3", "#4", "#5", "#3.returned", "#6", "#7", "#8"]);
  });

  it("brings the innermost response back first", () => {
    const events = parsed({
      trigger: { at: "app/a", kind: "request" },
      trace: [
        { from: "app/a", to: "app/b", kind: "call", response: 1 },
        { from: "app/b", to: "app/c", kind: "call", response: 2 },
      ],
    }).declared!.events;
    expect(events.map((event) => event.id)).toEqual(["trigger", "#1", "#2", "#2.returned", "#1.returned"]);
  });

  it("lets a step name its own id and its cause when the list does not say it", () => {
    const events = parsed({
      trigger: { at: "app/a", kind: "schedule" },
      trace: [
        { id: "fan-out", from: "app/a", to: "app/b", kind: "send" },
        { from: "app/c", to: "app/d", kind: "deliver", cause: "fan-out" },
      ],
    }).declared!.events;
    expect(events.map((event) => [event.id, event.type === "return" ? null : event.cause])).toEqual([
      ["trigger", null],
      ["fan-out", "trigger"],
      ["#2", "fan-out"],
    ]);
  });

  it("carries the trigger's payload on the first event", () => {
    const execution = parsed({ trigger: { at: "app/api.createLink", kind: "request", payload: { url: "https://x" } }, trace: [] });
    expect(execution.declared?.events[0]).toMatchObject({ payload: { url: "https://x" } });
    expect(execution.trigger.payload).toEqual({ url: "https://x" });
  });

  it("says where each problem is", () => {
    expect(
      problemsOf({
        trigger: { at: "app/a", kind: "click" },
      }),
    ).toEqual(["trigger.kind: must be one of action, request, schedule, message, webhook"]);

    expect(
      problemsOf({
        trigger: { at: "app/a", kind: "action" },
        trace: [{ from: "app/a", to: "app/B", kind: "call" }],
      })[0],
    ).toMatch(/^trace\.0\.to: "app\/B" is not an address/);

    expect(
      problemsOf({
        trigger: { at: "app/a", kind: "action" },
        trace: [{ from: "app/a", to: "app/b", kind: "trigger" }],
      })[0],
    ).toMatch(/^trace\.0\.kind: must be one of call, read, write, remove, send, deliver/);

    expect(problemsOf({ trigger: { at: "app/a", kind: "action" }, trace: [{ effect: "x", at: "app/a", colour: "red" }] })[0]).toMatch(
      /^trace\.0: Unrecognized key/,
    );

    expect(problemsOf({ trigger: { at: "app/a", kind: "action" }, extra: 1 })[0]).toMatch(/^\(root\): Unrecognized key/);
  });

  it("follows a step written more coarsely from the call that arrived inside it", () => {
    const events = parsed({
      trigger: { at: "app/web", kind: "action" },
      trace: [
        { from: "app/web", to: "app/api/router", kind: "call", response: "done" },
        { from: "app/api", to: "app/db.users", kind: "read" },
      ],
    }).declared!.events;
    expect(events.map((event) => [event.id, event.type === "return" ? null : event.cause])).toEqual([
      ["trigger", null],
      ["#1", "trigger"],
      ["#2", "#1"],
      ["#1.returned", null],
    ]);
  });

  it("does not hold a response up for something that happened back at the caller", () => {
    const events = parsed({
      trigger: { at: "app/api/router", kind: "request" },
      trace: [
        { id: "ask", from: "app/api/router", to: "app/pricing", kind: "call", response: 12 },
        { from: "app/pricing", to: "app/db.prices", kind: "read" },
        { effect: "response", at: "app/api/router", cause: "ask" },
      ],
    }).declared!.events;
    expect(events.map((event) => event.id)).toEqual(["trigger", "ask", "#2", "ask.returned", "#3"]);
  });

  it("assumes a step after a callback happens inside the callback, as the list cannot say", () => {
    const events = parsed({
      trigger: { at: "app/router", kind: "request" },
      trace: [
        { from: "app/router", to: "app/a", kind: "call", response: 1 },
        { from: "app/a", to: "app/router", kind: "call" },
        { from: "app/router", to: "app/b", kind: "call" },
      ],
    }).declared!.events;
    expect(events.map((event) => [event.id, event.type === "return" ? null : event.cause])).toEqual([
      ["trigger", null],
      ["#1", "trigger"],
      ["#2", "#1"],
      ["#3", "#2"],
      ["#1.returned", null],
    ]);
  });

  it("refuses a cause that is not an earlier step, and an id used twice", () => {
    expect(
      problemsOf({
        trigger: { at: "app/a", kind: "action" },
        trace: [{ from: "app/a", to: "app/b", kind: "call", cause: "later" }],
      }),
    ).toEqual(['trace.0.cause: there is no earlier step called "later". A step can only follow from one before it.']);

    expect(
      problemsOf({
        trigger: { at: "app/a", kind: "action" },
        trace: [
          { id: "x", from: "app/a", to: "app/b", kind: "call" },
          { id: "x", from: "app/b", to: "app/c", kind: "call" },
        ],
      }),
    ).toEqual(['trace.1.id: "x" is already the id of an earlier step.']);
  });

  it("refuses a cause that names a step by its position, which would drift", () => {
    expect(
      problemsOf({
        trigger: { at: "app/a", kind: "action" },
        trace: [
          { from: "app/a", to: "app/b", kind: "call" },
          { from: "app/b", to: "app/c", kind: "call", cause: "#1" },
        ],
      }),
    ).toEqual(['trace.1.cause: name the step this follows from by the id you gave it, or "trigger"']);
  });

  it("refuses a file name that could not be an id", () => {
    expect(problemsOf(sendAMessage, "Send_Message")).toEqual([
      'the file name "Send_Message" must be kebab-case, such as "borrow-a-book"',
    ]);
  });

  it("gives expectations that can be evaluated against the trace", () => {
    const execution = parsed(sendAMessage);
    expect(evaluate(execution.declared!, execution.expect!)).toEqual({ passed: true, failures: [], source: "declared" });
  });
});

describe("checking an execution against the architecture", () => {
  it("finds nothing wrong when everything it names is there", () => {
    expect(checkExecution(parsed(sendAMessage), chatArchitecture)).toEqual([]);
  });

  it("points at a block that is not there, or an entry it does not have", () => {
    const execution = parsed({
      trigger: { at: "app/client/ui/buton", kind: "action" },
      given: { "app/infrastructure/database": {}, "app/infrastructure/database.users": {} },
      trace: [{ from: "app/api/router", to: "app/infrastructure/queue.subscribe", kind: "send" }],
      expect: { never: ["app/payments"], state: { "app/infrastructure/database.messages": {} } },
    });
    expect(checkExecution(execution, chatArchitecture)).toEqual([
      'trigger.at: there is no block at "app/client/ui/buton".',
      // Nothing was said about what sets it going, either.
      'trigger: say what sets this going, with "description".',
      'trigger: name the code it arrives at, with "code", as in "src/client/ui/sendButton.ts#onSendPressed".',
      'given.app/infrastructure/database: "app/infrastructure/database" names a block but not which of its entries, as in "app/infrastructure/database.<entry>".',
      'given.app/infrastructure/database.users: "app/infrastructure/database" has no entry called "users". Its entries are: messages.',
      'trace step #1, to: "app/infrastructure/queue" has no entry called "subscribe". Its entries are: publish.',
      // A step nobody has said anything about is a step nobody can read.
      'trace step #1: say what this step is, with "description".',
      'trace step #1: name the code that makes it, with "code", as in "src/api/router.ts#handleSend".',
      'expect.never.0: there is no block at "app/payments".',
    ]);
  });

  it("reads the architecture of a real project", async () => {
    const architecture = architectureOf(await loadProject(path.join(examples, "tickets")));
    expect(architecture.get("tickets/tickets-db")).toEqual(["events", "bookings"]);
    expect(architecture.get("tickets/booking-api/book-seats")).toEqual([]);

    const book = parsed(
      {
        trigger: {
          at: "tickets/box-office.bookSeats",
          kind: "action",
          description: "Someone at the box office books seats for a gig.",
          code: "src/pricing.ts#bookSeats",
          payload: { eventId: "gig", seats: 2, email: "ada@example.com" },
        },
        given: { "tickets/tickets-db.events": { gig: { id: "gig", name: "Night Gig", seatsLeft: 10, price: 25 } } },
        expect: { effects: [{ at: "tickets/outbox.confirmations", kind: "message-published" }] },
      },
      "book-seats",
    );
    expect(checkExecution(book, architecture)).toEqual([]);
  });
});

describe("loading a project's executions", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "fragmentor-executions-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("has none when there is no folder for them", async () => {
    expect(await loadExecutions(dir)).toEqual({ executions: [], problems: [] });
  });

  it("reads the ones that are sound and says what is wrong with the rest", async () => {
    await mkdir(path.join(dir, "executions"));
    await writeFile(path.join(dir, "executions", "send-a-message.json"), JSON.stringify(sendAMessage));
    await writeFile(path.join(dir, "executions", "half-written.json"), "{ \"trigger\": ");
    await writeFile(path.join(dir, "executions", "notes.txt"), "not an execution");

    const loaded = await loadExecutions(dir);
    expect(loaded.executions.map((execution) => execution.id)).toEqual(["send-a-message"]);
    expect(loaded.problems).toHaveLength(1);
    expect(loaded.problems[0]!.file).toBe("executions/half-written.json");
    expect(loaded.problems[0]!.problems[0]).toMatch(/^it is not valid JSON/);
  });
});
