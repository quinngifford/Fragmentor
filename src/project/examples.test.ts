import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadProject, validateProject } from "./project.js";
import { boundStores } from "./stores.js";
import { loadExecutions } from "./executions.js";
import { projectSnapshot } from "./snapshot.js";
import { project } from "../model/trace.js";
import type { Trace } from "../model/trace.js";
import { evaluate } from "../run/expect.js";
import { runBlock } from "../run/run.js";
import type { RunEvent } from "../run/run.js";

/**
 * The example projects are checked in exactly as an agent would leave them,
 * so they are the closest thing to real use the suite has. These tests hold
 * them to the rules, and use them to exercise the parts of the model that are
 * easy to get wrong.
 */

const examples = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "examples");
const tickets = path.join(examples, "tickets");

const EVENTS = "tickets/tickets-db.events";
const BOOKINGS = "tickets/tickets-db.bookings";
const CONFIRMATIONS = "tickets/outbox.confirmations";
const gig = (seatsLeft: number) => ({ id: "gig", name: "Night Gig", seatsLeft, price: 25 });

describe("the tickets example", () => {
  it("reads off disk, validates cleanly, and says what each part is", async () => {
    const project = await loadProject(tickets);
    expect(validateProject(project)).toEqual([]);

    const roleOf = (blockPath: string) => project.byPath.get(blockPath)!.block.role;
    expect(roleOf("tickets")).toBe("component");
    expect(roleOf("tickets/box-office")).toBe("client");
    expect(roleOf("tickets/booking-api")).toBe("service");
    expect(roleOf("tickets/booking-api/pricing")).toBe("component");
    expect(roleOf("tickets/tickets-db")).toBe("database");
    expect(roleOf("tickets/outbox")).toBe("queue");
    expect(project.byPath.get("tickets/reminders")!.block.planned).toBe(true);
  });

  it("keeps a block two handlers use beside them, and one only a handler uses inside it", async () => {
    const project = await loadProject(tickets);
    const partsOf = (blockPath: string) => project.byPath.get(blockPath)!.children.map((child) => child.block.id);

    expect(partsOf("tickets/booking-api")).toEqual(["book-seats", "cancel-booking", "find-event", "pricing"]);
    expect(partsOf("tickets/booking-api/book-seats")).toEqual(["reserve"]);
  });

  it("gives each store port a way into the one entry it stands for", async () => {
    const project = await loadProject(tickets);
    const node = project.byPath.get("tickets/booking-api/book-seats")!;

    expect(boundStores(project, node).map((store) => [store.port, store.capability, store.target])).toEqual([
      ["events", "Store", EVENTS],
      ["bookings", "Store", BOOKINGS],
      ["confirmations", "Queue", CONFIRMATIONS],
    ]);
  });

  it("books seats across the architecture, writing the database and sending the confirmation", async () => {
    const outcome = await runBlock({
      projectDir: tickets,
      blockPath: "tickets/booking-api/book-seats",
      input: { eventId: "gig", seats: 5, email: "ada@example.com" },
      stores: { [EVENTS]: { gig: gig(10) } },
    });

    expect(outcome.error).toBeUndefined();
    expect(outcome.output).toEqual({ booked: true, message: "Booked 5 for Night Gig: booking gig-10.", total: 122.5 });
    expect(outcome.stores[EVENTS]).toEqual({ kind: "store", rows: { gig: gig(5) } });
    expect(outcome.stores[BOOKINGS]).toEqual({
      kind: "store",
      rows: { "gig-10": { id: "gig-10", eventId: "gig", email: "ada@example.com", seats: 5, total: 122.5 } },
    });
    expect(outcome.stores[CONFIRMATIONS]).toEqual({
      kind: "queue",
      sent: [{ email: "ada@example.com", event: "Night Gig", seats: 5, total: 122.5 }],
    });
  });

  it("turns away a request it cannot meet without writing or sending anything", async () => {
    const outcome = await runBlock({
      projectDir: tickets,
      blockPath: "tickets/booking-api/book-seats",
      input: { eventId: "gig", seats: 3, email: "ada@example.com" },
      stores: { [EVENTS]: { gig: gig(2) } },
    });

    expect(outcome.output).toEqual({ booked: false, message: "Sorry, only 2 left for Night Gig.", total: 0 });
    expect(outcome.stores[EVENTS]).toEqual({ kind: "store", rows: { gig: gig(2) } });
    expect(outcome.stores[BOOKINGS]).toEqual({ kind: "store", rows: {} });
    expect(outcome.stores[CONFIRMATIONS]).toEqual({ kind: "queue", sent: [] });
  });

  it("sees every call a run makes, whichever part of the architecture it goes to", async () => {
    const events: RunEvent[] = [];
    await runBlock({
      projectDir: tickets,
      blockPath: "tickets/booking-api/book-seats",
      input: { eventId: "gig", seats: 2, email: "ada@example.com" },
      stores: { [EVENTS]: { gig: gig(10) } },
      onEvent: (event) => events.push(event),
    });

    const calls = events.filter((event): event is Extract<RunEvent, { type: "call" }> => event.type === "call");
    const blockOf = new Map(calls.map((call) => [call.id, call.block]));
    // Each call with the call that made it: a sibling, a part of a sibling,
    // and a part of its own, none of them wired to it.
    expect(calls.map((call) => [call.block, call.parent === null ? null : blockOf.get(call.parent)])).toEqual([
      ["tickets/booking-api/book-seats", null],
      ["tickets/booking-api/find-event", "tickets/booking-api/book-seats"],
      ["tickets/booking-api/pricing/price-seat", "tickets/booking-api/book-seats"],
      ["tickets/booking-api/pricing/price-seat", "tickets/booking-api/book-seats"],
      ["tickets/booking-api/book-seats/reserve", "tickets/booking-api/book-seats"],
    ]);
  });
});

describe("the messenger example", () => {
  const messenger = path.join(examples, "messenger");

  it("points every block at code that exists, and every execution at blocks that do", async () => {
    const snapshot = await projectSnapshot(messenger);
    expect(snapshot.diagnostics).toEqual([]);
    expect(snapshot.executions.map((execution) => execution.id)).toEqual([
      "clean-up-sessions",
      "deliver-a-notification",
      "log-in",
      "log-out",
      "send-a-message",
    ]);
  });

  it("writes down traces that agree with their own expectations, and says they were written, not seen", async () => {
    const { executions, problems } = await loadExecutions(messenger);
    expect(problems).toEqual([]);
    for (const execution of executions) {
      expect(execution.declared?.source, execution.id).toBe("declared");
      const result = evaluate(execution.declared!, execution.expect!);
      expect(result.failures, execution.id).toEqual([]);
    }
  });

  it("draws sending a message at every level of detail from one trace", async () => {
    const { executions } = await loadExecutions(messenger);
    const trace = executions.find((execution) => execution.id === "send-a-message")!.declared as Trace;
    const edges = (...expanded: string[]) =>
      Object.fromEntries([...project(trace, { expanded: new Set(expanded) }).edges.values()].map((edge) => [edge.key, edge.interactions.length]));

    // Zoomed out: the client asks the API, and the API reaches the infrastructure.
    expect(edges("app")).toEqual({
      "(outside)->app/client": 1,
      "app/client->app/api": 1,
      "app/api->app/infrastructure": 3,
    });

    // Inside the API: the router hands the message to messaging twice, and
    // both reach the infrastructure, which stays closed.
    const inside = edges("app", "app/api");
    expect(inside["app/api/router->app/api/messaging"]).toBe(2);
    expect(inside["app/api/messaging->app/infrastructure"]).toBe(2);
    expect(inside["app/api/router->app/api/auth"]).toBe(1);

    // Inside messaging, with the infrastructure open as well.
    const finer = edges("app", "app/api", "app/api/messaging", "app/infrastructure");
    expect(finer["app/api/messaging/save-message->app/infrastructure/database"]).toBe(1);
    expect(finer["app/api/messaging/notify-recipient->app/infrastructure/queue"]).toBe(1);
  });
});
