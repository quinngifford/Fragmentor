import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadProject, validateProject } from "./project.js";
import { boundStores } from "./stores.js";
import { loadExecutions } from "./executions.js";
import { projectSnapshot } from "./snapshot.js";
import { placeEvent } from "../model/trace.js";
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

  it("writes down what happens when something sets it going, and its traces meet their own expectations", async () => {
    const { executions, problems } = await loadExecutions(tickets);
    expect(problems).toEqual([]);
    expect(executions.map((execution) => execution.id)).toEqual([
      "book-seats",
      "booking-turned-away",
      "cancel-booking",
      // The one run where an effect a reader would expect is deliberately
      // absent: no event to put the seats back on.
      "cancel-without-the-event",
    ]);

    for (const execution of executions) {
      expect(execution.declared?.source, execution.id).toBe("declared");
      expect(evaluate(execution.declared!, execution.expect!).failures, execution.id).toEqual([]);
    }
  });

  it("says nothing about what the stores hold at the end, which only a recorded run knows", async () => {
    const { executions } = await loadExecutions(tickets);
    // The one expectation a written-down trace cannot meet, so none of them
    // claims it; `fragmentor check` reports one that does.
    for (const execution of executions) expect(execution.expect?.state, execution.id).toEqual({});
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

  it("places every step of every execution at a block that is showing, whatever is folded away", async () => {
    const snapshot = await projectSnapshot(messenger);
    const paths = Object.keys(snapshot.blocks);
    /** What the canvas shows: everything except what has been folded away. */
    const showing = (folded: string[]) => ({
      expanded: new Set(["", ...paths.filter((path) => !folded.some((fold) => path === fold || path.startsWith(`${fold}/`)))]),
    });

    for (const folded of [[], ["app/client"], ["app/api", "app/infrastructure"], ["app"]]) {
      const view = showing(folded);
      for (const execution of snapshot.executions) {
        for (const event of execution.declared!.events) {
          const placed = placeEvent(event, view);
          const where = placed.on === "edge" ? [placed.from, placed.to] : [placed.at];
          for (const address of where) {
            if (address === null) continue;
            // A folded block is still drawn; only its parts are put away.
            const hidden = folded.some((fold) => address.path.startsWith(`${fold}/`));
            expect(hidden, `${execution.id}: ${address.path} is inside a folded block [${folded}]`).toBe(false);
          }
        }
      }
    }
  });

  it("gathers a step onto the block standing for it once its parts are folded away", async () => {
    const { executions } = await loadExecutions(messenger);
    const trace = executions.find((execution) => execution.id === "send-a-message")!.declared!;
    // The button handing the message to the page's state.
    const inClient = trace.events[1]!;

    const whole = { expanded: new Set(["", "app", "app/client", "app/client/ui"]) };
    expect(placeEvent(inClient, whole)).toMatchObject({
      on: "edge",
      key: "app/client/ui/send-button->app/client/state",
    });
    expect(placeEvent(inClient, { expanded: new Set(["", "app"]) })).toMatchObject({ on: "inside", key: "app/client" });
  });
});
