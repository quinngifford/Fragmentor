import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { analyticsOf, holding, isWeakSpotNote, kindOf, ordinal, reachesOf, usersOf, weakSpotNote } from "./analytics.js";
import type { Analytics, Measure } from "./analytics.js";
import type { ReachSeen } from "./rules.js";
import { projectSnapshot } from "./snapshot.js";
import type { ProjectSnapshot } from "./snapshot.js";

/**
 * The measurements are held to the two examples as Fragmentor really reads
 * them, so every number here is one the window, the page and the command
 * all show; and to snapshots whose reach is rewritten by hand, for the cases
 * the examples do not have.
 */

const examples = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "examples");

let tickets: ProjectSnapshot;
let messenger: ProjectSnapshot;

beforeAll(async () => {
  tickets = await projectSnapshot(path.join(examples, "tickets"));
  messenger = await projectSnapshot(path.join(examples, "messenger"));
}, 60_000);

const measureOf = (analytics: Analytics, dimension: string, system: string, id: string): Measure =>
  analytics.dimensions.find((each) => each.id === dimension)!.system[system]!.find((each) => each.id === id)!;
const blockMeasure = (analytics: Analytics, dimension: string, block: string, id: string): Measure =>
  analytics.dimensions.find((each) => each.id === dimension)!.blocks[block]!.find((each) => each.id === id)!;

/** The same snapshot with who-reaches-whom replaced, every entry exact unless said otherwise. */
const seeing = (snapshot: ProjectSnapshot, entries: Partial<ReachSeen>[]): ProjectSnapshot => ({
  ...snapshot,
  reachSeen: entries.map((each) => ({ from: "", to: "", evidence: "x from src/x.ts", exact: true, on: "code", entry: null, verb: null, planned: false, ...each })),
});

describe("who is used by whom", () => {
  it("counts each block that reaches another once, however many ways, and says which ways", () => {
    const users = usersOf(tickets, "tickets/tickets-db");
    expect(users.map((each) => each.path)).toEqual([
      "tickets/booking-api/book-seats",
      "tickets/booking-api/book-seats/reserve",
      "tickets/booking-api/cancel-booking",
      "tickets/booking-api/find-event",
      "tickets/reminders",
    ]);
    expect(users.every((each) => each.detail.startsWith("on the diagram:"))).toBe(true);
    expect(users.find((each) => each.path === "tickets/reminders")!.planned).toBe(true);
    expect(users.find((each) => each.path === "tickets/booking-api/find-event")!.detail).toBe("on the diagram: reads events");

    const findEvent = usersOf(tickets, "tickets/booking-api/find-event");
    expect(findEvent.map((each) => [each.path, each.detail])).toEqual([
      ["tickets/booking-api/book-seats", "in the code: findEvent"],
      ["tickets/booking-api/cancel-booking", "in the code: findEvent"],
    ]);
  });

  it("leaves a block's own parts and what holds it out of what it reaches", () => {
    const reaches = reachesOf(tickets, "tickets/booking-api/book-seats").map((each) => each.path);
    expect(reaches).toContain("tickets/booking-api/find-event");
    expect(reaches).toContain("tickets/booking-api/pricing/price-seat");
    expect(reaches).not.toContain("tickets/booking-api/book-seats/reserve");
    expect(reaches).not.toContain("tickets/booking-api");
    expect(reaches).toHaveLength(4);
  });

  it("counts a pair joined by the diagram and by the code once, saying both", () => {
    const users = usersOf(messenger, "app/infrastructure/database");
    expect(users).toHaveLength(6);
    const logOut = users.find((each) => each.path === "app/api/auth/log-out")!;
    expect(logOut.detail).toBe("on the diagram: writes sessions; in the code: db");
  });

  it("computes nothing from an entry a file had to be counted whole for", () => {
    const rough = seeing(tickets, [{ from: "tickets/box-office", to: "tickets/booking-api/pricing/price-seat", exact: false }]);
    expect(usersOf(rough, "tickets/booking-api/pricing/price-seat")).toEqual([]);
  });
});

describe("the coupling measures", () => {
  it("rank the blocks the window shows, with its spread and its rows equal to the counts", () => {
    const analytics = analyticsOf(tickets);
    const usedBy = measureOf(analytics, "coupling", "tickets", "used-by");
    expect(usedBy.rows.slice(0, 3).map((row) => [row.name, row.value])).toEqual([
      ["Tickets Database", 5],
      ["Outbox", 3],
      ["Find Event", 2],
    ]);
    expect(usedBy.spread).toEqual({ min: 0, median: 1, max: 5, n: 13, kind: "blocks" });
    for (const row of usedBy.rows) expect(usersOf(tickets, row.path)).toHaveLength(row.value);
    expect(usedBy.of).toContain("each block that reaches this one, once");

    const store = blockMeasure(analytics, "coupling", "tickets/tickets-db", "used-by");
    expect(store.text).toBe("5");
    expect(store.rank).toEqual({ place: 1, of: 2, kind: "stores" });
    expect(store.rows.map((row) => row.planned)).toEqual([false, false, false, false, true]);
    expect(blockMeasure(analytics, "coupling", "tickets/tickets-db", "reaches").rank).toBeNull();
  });

  it("say what an outward share means at either end and in between, and show none at 0 of 0", () => {
    const analytics = analyticsOf(tickets);
    expect(blockMeasure(analytics, "coupling", "tickets/tickets-db", "outward").text).toBe("0 (everything leans on it)");
    expect(blockMeasure(analytics, "coupling", "tickets/box-office", "outward").text).toBe("1 (it leans on everything)");
    expect(blockMeasure(analytics, "coupling", "tickets/booking-api/find-event", "outward")).toMatchObject({ value: 0.33, text: "0.33 (1 of 3 go out)" });
    expect(blockMeasure(analytics, "coupling", "tickets", "outward")).toMatchObject({ value: null, text: "— (no dependencies either way)" });
  });

  it("find the one dependency on Messenger that points at a less settled part, and none on Tickets", () => {
    const settled = measureOf(analyticsOf(messenger), "coupling", "app", "settled");
    expect(settled.rows.map((row) => row.text)).toEqual(["State (outward share 0.4) → Router (outward share 0.83)"]);
    expect(measureOf(analyticsOf(tickets), "coupling", "tickets", "settled").rows).toEqual([]);
  });

  it("count the blocks whose declared access names each table or channel, by what they do there", () => {
    const shared = measureOf(analyticsOf(messenger), "coupling", "app", "shared");
    expect(shared.rows.map((row) => row.text)).toEqual([
      "Database · sessions: 5 blocks (3 reads, 3 writes)",
      "Database · messages: 2 blocks (1 reads, 1 writes)",
      "Queue · notifications: 2 blocks (1 reads, 1 writes)",
      "Database · users: 1 block (1 reads)",
    ]);
    const events = measureOf(analyticsOf(tickets), "coupling", "tickets", "shared").rows.find((row) => row.text.includes("events"))!;
    expect(events.value).toBe(4);
  });
});

describe("modularity and cohesion", () => {
  it("measure how much of its parts' traffic a block keeps inside, counted as pairs", () => {
    const kept = measureOf(analyticsOf(tickets), "modularity", "tickets", "kept-inside");
    const bookingApi = kept.rows.find((row) => row.path === "tickets/booking-api")!;
    expect(bookingApi.text).toBe("0.31 (4 between its parts, 3 coming in, 6 going out)");
    expect(kept.rows.map((row) => row.path)).not.toContain("tickets/box-office");
    expect(blockMeasure(analyticsOf(tickets), "modularity", "tickets/booking-api", "kept-inside").value).toBe(0.31);
  });

  it("say which parts form a group, in one sentence, joined by reach or by a shared table", () => {
    const groups = (snapshot: ProjectSnapshot, block: string) => blockMeasure(analyticsOf(snapshot), "cohesion", block, "groups").text;
    expect(groups(tickets, "tickets/booking-api/pricing")).toBe("Pricing: its 2 parts form 2 groups: Price Seat · Refund For");
    expect(groups(messenger, "app/client/ui")).toBe("UI: its 3 parts form 3 groups: Chat View · Login Form · Send Button");
    expect(groups(messenger, "app/infrastructure")).toBe("Infrastructure: its 2 parts form 2 groups: Database · Queue");
    // Both workers read the same table, and nothing else joins them.
    expect(groups(messenger, "app/workers")).toBe("Workers: its 2 parts form 1 group: Clean Up Sessions + Deliver Notification");
    expect(analyticsOf(tickets).dimensions.find((each) => each.id === "cohesion")!.blocks["tickets/box-office"]).toBeUndefined();
  });
});

describe("weak spots", () => {
  it("find Messenger's circle, on the block that holds both ends, with every entry that closes it", () => {
    const cycles = analyticsOf(messenger).weakSpots.find((kind) => kind.kind === "cycle")!;
    expect(cycles.measured).toBe(true);
    expect(cycles.spots).toHaveLength(1);
    expect(cycles.spots[0]).toMatchObject({
      headline: "Parts that use each other in a circle: State and UI",
      block: "app/client",
      blockName: "Client",
      evidence: ["in the code: State → UI, showMessage from src/client/ui/chatView.ts", "in the code: UI → State, dispatch from src/client/state.ts"],
    });
    expect(analyticsOf(tickets).weakSpots.find((kind) => kind.kind === "cycle")!.spots).toEqual([]);
  });

  it("report a circle through nested parts at the level of the parts, and a three-block circle once", () => {
    const nested = seeing(tickets, [
      { from: "tickets/booking-api/book-seats", to: "tickets/box-office" },
      { from: "tickets/box-office", to: "tickets/booking-api/pricing/price-seat" },
    ]);
    const spots = analyticsOf(nested).weakSpots.find((kind) => kind.kind === "cycle")!.spots;
    expect(spots.map((spot) => [spot.headline, spot.block])).toEqual([["Parts that use each other in a circle: Booking API and Box Office", "tickets"]]);

    const three = seeing(tickets, [
      { from: "tickets/box-office", to: "tickets/booking-api" },
      { from: "tickets/booking-api", to: "tickets/outbox" },
      { from: "tickets/outbox", to: "tickets/box-office" },
    ]);
    expect(analyticsOf(three).weakSpots.find((kind) => kind.kind === "cycle")!.spots.map((spot) => spot.headline)).toEqual([
      "Parts that use each other in a circle: Booking API, Box Office and Outbox".replace(", Box Office and", " and Box Office and"),
    ]);
  });

  it("never make a circle of a block and its own part, or of entries a file was counted whole for", () => {
    const parentAndPart = seeing(tickets, [
      { from: "tickets/booking-api/book-seats", to: "tickets/booking-api" },
      { from: "tickets/booking-api", to: "tickets/booking-api/book-seats" },
    ]);
    expect(analyticsOf(parentAndPart).weakSpots.find((kind) => kind.kind === "cycle")!.spots).toEqual([]);
    const rough = seeing(tickets, [
      { from: "tickets/box-office", to: "tickets/outbox", exact: false },
      { from: "tickets/outbox", to: "tickets/box-office", exact: false },
    ]);
    expect(analyticsOf(rough).weakSpots.find((kind) => kind.kind === "cycle")!.spots).toEqual([]);
  });

  it("say when a circle is only the diagram's, and mark a planned block's part in it", () => {
    const drawn = seeing(tickets, [
      { from: "tickets/box-office", to: "tickets/reminders", on: "diagram", evidence: 'declares "calls reminders.remind"', verb: "calls", entry: "remind" },
      { from: "tickets/reminders", to: "tickets/box-office", on: "diagram", evidence: 'declares "calls box-office.show"', verb: "calls", entry: "show", planned: true },
    ]);
    const spot = analyticsOf(drawn).weakSpots.find((kind) => kind.kind === "cycle")!.spots[0]!;
    expect(spot.evidence).toEqual([
      'on the diagram: Box Office → Reminders, declares "calls reminders.remind"',
      'on the diagram: Reminders → Box Office, declares "calls box-office.show" (planned)',
    ]);
  });

  it("say that a circle was not looked for where the code was not read, instead of none", () => {
    const unread: ProjectSnapshot = {
      ...tickets,
      systems: tickets.systems.map((system) => ({ ...system, reachRead: false, reachNotReadBecause: "Python code is not read yet" })),
    };
    const analytics = analyticsOf(unread);
    const cycles = analytics.weakSpots.find((kind) => kind.kind === "cycle")!;
    expect(cycles.measured).toBe(false);
    expect(cycles.reason).toBe("only the diagram's arrows were followed in Tickets");
    expect(analytics.notMeasured).toEqual([{ system: "tickets", name: "Tickets", reasons: ["Python code is not read yet"] }]);
    expect(measureOf(analytics, "coupling", "tickets", "used-by").of).toContain("the access the diagram declares only");
  });

  it("write the note a flagged spot hands the agent, and recognise it again", () => {
    const spot = analyticsOf(messenger).weakSpots.find((kind) => kind.kind === "cycle")!.spots[0]!;
    const note = weakSpotNote(spot);
    expect(note.split("\n")[0]).toBe("Weak spot: Parts that use each other in a circle: State and UI");
    expect(note).toContain("- in the code: UI → State, dispatch from src/client/state.ts");
    expect(note).toContain("`fragmentor analytics app/client` shows whether it is still there");
    expect(isWeakSpotNote(note, spot)).toBe(true);
    expect(isWeakSpotNote("Weak spot: something else\n" + note, spot)).toBe(false);
  });
});

describe("the rest", () => {
  it("counts what is held to a contract and what has saved tests, and says what cannot be measured", () => {
    const analytics = analyticsOf(tickets);
    expect(measureOf(analytics, "reliability", "tickets", "held").text).toBe("6 of 6 function blocks");
    expect(measureOf(analytics, "reliability", "tickets", "tests")).toMatchObject({ value: 13, text: "13 over 6 held blocks, 0 with none" });
    expect(measureOf(analytics, "reliability", "tickets", "failure").unavailable).toBe("not measured: needs runs of your app in use, or its monitoring");
    expect(measureOf(analyticsOf(messenger), "reliability", "app", "held").text).toBe("0 of 12 function blocks");
    expect(blockMeasure(analyticsOf(messenger), "reliability", "app/api/router", "tests").text).toBe("none can be saved: only code held to a contract runs here");
  });

  it("lists who shares each store, the same blocks as its Used by", () => {
    const analytics = analyticsOf(tickets);
    const shares = measureOf(analytics, "scalability", "tickets", "shares");
    expect(shares.rows.map((row) => row.text)).toEqual(["Tickets Database: used by 5"]);
    expect(blockMeasure(analytics, "scalability", "tickets/tickets-db", "shares").rows.map((row) => row.path)).toEqual(
      usersOf(tickets, "tickets/tickets-db").map((each) => each.path),
    );
    expect(measureOf(analytics, "scalability", "tickets", "load").unavailable).toBe("not measurable here; needs load or production data");
  });

  it("prints exactly 'not built yet' for what later phases fill in", () => {
    const analytics = analyticsOf(tickets);
    for (const id of ["complexity", "maintainability", "runtime"]) {
      expect(measureOf(analytics, id, "tickets", id).unavailable).toBe("not built yet");
    }
    expect(analytics.weakSpots.filter((kind) => kind.kind !== "cycle").map((kind) => kind.reason)).toEqual(["not built yet", "not built yet"]);
  });

  it("gives the same answer whatever order the entries come in, and copes with a page from before this work", () => {
    const shuffled = { ...messenger, reachSeen: [...messenger.reachSeen].reverse() };
    expect(JSON.stringify(analyticsOf(shuffled))).toBe(JSON.stringify(analyticsOf(messenger)));
    const old = { ...tickets } as Partial<ProjectSnapshot>;
    delete old.reachSeen;
    const analytics = analyticsOf(old as ProjectSnapshot);
    expect(measureOf(analytics, "coupling", "tickets", "used-by").rows).toEqual([]);
  });

  it("has the small words right", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101].map(ordinal)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "101st"]);
    expect([kindOf("function"), kindOf("database"), kindOf("queue"), kindOf("component")]).toEqual(["function blocks", "stores", "stores", "components"]);
    expect(holding(["app/client/ui", "app/client/state"])).toBe("app/client");
    expect(holding(["app/client", "tickets/outbox"])).toBe("");
  });
});
