import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { recordedTrace } from "../model/recorded.js";
import type { HeardEvent, RecordingScope } from "../model/recorded.js";
import { analyticsOf, codeFilesOf, holding, isWeakSpotNote, kindOf, msWords, ordinal, reachesOf, runTimes, usersOf, weakSpotNote } from "./analytics.js";
import type { Analytics, Measure, RecordingFacts } from "./analytics.js";
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

describe("the code's shape", () => {
  it("counts the ways through every function and names the most, per system and per block", () => {
    const analytics = analyticsOf(tickets);
    expect(measureOf(analytics, "complexity", "tickets", "ways")).toMatchObject({
      text: "most: bookSeats, 5",
      spread: { min: 1, median: 1, max: 5, n: 18, kind: "functions in the code" },
    });
    expect(measureOf(analytics, "complexity", "tickets", "over").text).toBe("none");
    expect(blockMeasure(analytics, "complexity", "tickets/booking-api/book-seats", "ways").text).toMatch(/^most 5, in bookSeats · \d+ functions$/);
    expect(blockMeasure(analytics, "complexity", "tickets/booking-api/find-event", "ways").text).toBe("1 (findEvent)");
    expect(blockMeasure(analytics, "complexity", "tickets/booking-api/book-seats", "ways").rank).toEqual({ place: 1, of: 6, kind: "function blocks" });
    expect(measureOf(analyticsOf(messenger), "complexity", "app", "ways").text).toBe("most: dispatch, 7");
  });

  it("measures size as facts: statements per block with their share, and code under no block", () => {
    const analytics = analyticsOf(tickets);
    const size = measureOf(analytics, "maintainability", "tickets", "size");
    expect(size.text).toBe("48 statements in 18 functions in the code · most: bookSeats, 12 (25%)");
    expect(size.rows[0]).toMatchObject({ name: "Book Seats", value: 14, text: "14 statements (29%)" });
    expect(measureOf(analytics, "maintainability", "tickets", "unowned").text).toBe("10 statements (21%) in src/server.ts");
    expect(blockMeasure(analytics, "maintainability", "tickets/booking-api/book-seats", "size")).toMatchObject({ text: "14 statements (29% of Tickets)", share: 0.29 });
    expect(blockMeasure(analytics, "maintainability", "tickets/booking-api/find-event", "size").text).toBe("1 statement (2% of Tickets)");
    expect(measureOf(analyticsOf(messenger), "maintainability", "app", "unowned").text).toBe("none");
  });

  it("lists a function over the limit as a weak spot, with the words of the band it is in", () => {
    const over: ProjectSnapshot = {
      ...tickets,
      functions: {
        ...tickets.functions,
        "tickets/booking-api/book-seats": {
          paths: [1, 12, 17],
          sizes: [1, 20, 30],
          statements: 51,
          files: ["src/booking/book-seats.ts"],
          named: [
            { name: "settle", file: "src/booking/book-seats.ts", line: 40, paths: 17, statements: 30 },
            { name: "price", file: "src/booking/book-seats.ts", line: 20, paths: 12, statements: 20 },
          ],
        },
      },
    };
    const analytics = analyticsOf(over);
    const kind = analytics.weakSpots.find((each) => each.kind === "complexity")!;
    expect(kind.measured).toBe(true);
    expect(kind.spots.map((spot) => [spot.headline, spot.block, spot.evidence[0], spot.band])).toEqual([
      ["Functions with more than 10 ways through: settle in src/booking/book-seats.ts", "tickets/booking-api/book-seats", "17 ways through — past 15, the most that guideline allows", "warn"],
      ["Functions with more than 10 ways through: price in src/booking/book-seats.ts", "tickets/booking-api/book-seats", "12 ways through — past 10; a published guideline (NIST) allows up to 15 with a reason", "warn"],
    ]);
    const overMeasure = measureOf(analytics, "complexity", "tickets", "over");
    expect(overMeasure.text).toBe("2 (1 over 15)");
    expect(overMeasure.rows.map((row) => [row.band, row.detail])).toEqual([["warn", "src/booking/book-seats.ts:40"], ["warn", "src/booking/book-seats.ts:20"]]);
    expect(blockMeasure(analytics, "complexity", "tickets/booking-api/book-seats", "ways").band).toBe("warn");
    expect(weakSpotNote(kind.spots[0]!)).toContain("The limit is provisional: a published guideline, not a rule of this project.");
  });

  it("says the shape was not measured where the code was not read, instead of none", () => {
    const unread: ProjectSnapshot = {
      ...tickets,
      functions: {},
      systems: tickets.systems.map((system) => ({ ...system, reachRead: false, reachNotReadBecause: "Python code is not read yet" })),
    };
    const analytics = analyticsOf(unread);
    expect(measureOf(analytics, "complexity", "tickets", "ways").unavailable).toBe("not measured: Python code is not read yet");
    expect(analytics.weakSpots.find((kind) => kind.kind === "complexity")).toMatchObject({ measured: false, reason: "Python code is not read yet", spots: [] });
    expect(measureOf(analytics, "maintainability", "tickets", "size").unavailable).toBe("not measured: Python code is not read yet");
    expect(blockMeasure(analytics, "complexity", "tickets/booking-api/book-seats", "ways").unavailable).toBe("not measured: Python code is not read yet");
  });
});

describe("what the recordings showed", () => {
  const BOOK = "tickets/booking-api/book-seats";
  const FIND = "tickets/booking-api/find-event";
  const scope: RecordingScope = {
    runs: BOOK,
    blocks: { [BOOK]: "src/booking/book-seats.ts#bookSeats", [FIND]: "src/booking/find-event.ts#findEvent" },
    stores: ["tickets/tickets-db.events"],
    answers: ["tickets/booking-api.bookSeats"],
    unseen: [],
  };
  const heard: HeardEvent[] = [
    { type: "call", id: 1, parent: null, block: BOOK, input: {}, at: 0 },
    { type: "call", id: 2, parent: 1, block: FIND, input: { id: "gig" }, at: 1.5 },
    { type: "store", id: 3, parent: 2, target: "tickets/tickets-db.events", op: "read", key: "gig", value: null, at: 2 },
    { type: "return", id: 2, output: { event: null }, at: 3.25 },
    { type: "return", id: 1, output: { booked: false }, at: 10 },
  ];
  const recording = (check: RecordingFacts["check"], extra: HeardEvent[] = []): RecordingFacts => ({
    execution: "book-seats",
    name: "Book seats",
    trace: recordedTrace("book-seats", scope, [...heard.slice(0, 4), ...extra, heard[4]!], { stores: {} }),
    complete: true,
    truncated: false,
    check,
  });

  it("reads a recording's total, its slowest calls and its work, in the sandbox's own words", () => {
    const times = runTimes(recording({ agreed: true, notSeen: 0, failures: 0 }).trace);
    expect(times).toEqual({ total: 10, timed: true, slowest: [{ path: FIND, took: 1.75 }], calls: 2, storeUses: 1 });
    const analytics = analyticsOf(tickets, { recordings: [recording({ agreed: true, notSeen: 0, failures: 0 })] });
    const runs = measureOf(analytics, "runtime", "tickets", "runtime");
    expect(runs.text).toBe("1 this session");
    expect(runs.rows.map((row) => [row.text, row.detail])).toEqual([["Book seats: 10 ms · 2 calls, 1 store use", "Find Event took 2 ms"]]);
    expect(runs.of).toContain("One sample each, never a statistic");
    expect(blockMeasure(analytics, "runtime", FIND, "runtime").text).toBe("1 call · most 2 ms · median 2 ms");
    expect(blockMeasure(analytics, "runtime", "tickets/booking-api/cancel-booking", "runtime").text).toBe("none");
    const showed = measureOf(analytics, "reliability", "tickets", "showed");
    expect(showed.text).toBe("1 agreed, 0 contradicted, 0 ended by throwing");
    expect(showed.rows.map((row) => row.text)).toEqual(["Book seats: agrees with what was written down"]);
    expect(blockMeasure(analytics, "reliability", FIND, "threw").text).toBe("never");
  });

  it("says when a recording contradicted what was written down, or threw, and when a run was not timed", () => {
    const contradicted = recording({ agreed: false, notSeen: 2, failures: 1 });
    const threw = recording(null, [{ type: "call", id: 4, parent: 1, block: FIND, input: {}, at: 5 }, { type: "throw", id: 4, error: "boom", at: 6 }]);
    const analytics = analyticsOf(tickets, { recordings: [contradicted, threw] });
    expect(measureOf(analytics, "reliability", "tickets", "showed").rows.map((row) => row.text)).toEqual([
      "Book seats: ended by throwing",
      "Book seats: contradicted — 2 steps not seen, 1 expectation failed",
    ]);
    expect(blockMeasure(analytics, "reliability", FIND, "threw").text).toBe("1 time");
    const paused = recording({ agreed: true, notSeen: 0, failures: 0 }, [{ type: "paused", id: 2 }, { type: "resumed", id: 2 }]);
    expect(measureOf(analyticsOf(tickets, { recordings: [paused] }), "runtime", "tickets", "runtime").rows[0]!.text).toBe(
      "Book seats: not timed: the run was paused, or the clock gave nothing · 2 calls, 1 store use",
    );
    expect([msWords(0.4), msWords(1.4), msWords(12.6)]).toEqual(["under 1 ms", "1 ms", "13 ms"]);
  });

  it("says why there is nothing, in the reader's own words: none made yet, the code only drawn, or not this command", () => {
    expect(measureOf(analyticsOf(tickets, { recordings: [] }), "runtime", "tickets", "runtime").unavailable).toBe(
      "nothing has been recorded in this session: pick an execution above the drawing and press Record",
    );
    expect(measureOf(analyticsOf(messenger, { recordings: [] }), "runtime", "app", "runtime").unavailable).toBe(messenger.executions[0]!.unrecordable);
    expect(measureOf(analyticsOf(tickets, { recordingsUnavailable: "not here" }), "runtime", "tickets", "runtime").unavailable).toBe("not here");
    expect(measureOf(analyticsOf(tickets, { recordingsUnavailable: "not here" }), "reliability", "tickets", "showed").unavailable).toBe("not here");
    expect(measureOf(analyticsOf(tickets), "runtime", "tickets", "runtime").unavailable).toBe("not read here");
  });
});

describe("changes from git", () => {
  const BOOK = "tickets/booking-api/book-seats";
  const FIND = "tickets/booking-api/find-event";
  // The example is read in beforeAll, so everything from it is read inside each test.
  let files: Record<string, string[]>;
  let functionBlocks: number;
  let withCode: number;
  beforeAll(() => {
    files = codeFilesOf(tickets).byBlock;
    functionBlocks = Object.values(tickets.blocks).filter((block) => kindOf(block.role) === "function blocks").length;
    withCode = Object.values(tickets.blocks).filter((block) => block.role === "function" && !block.planned && files[block.path] !== undefined && (tickets.functions[block.path]?.paths.length ?? 0) > 0).length;
  });
  const given = (commits: string[][], shallow = false) => analyticsOf(tickets, { changes: { unavailable: null, commits, shallow } });
  const hotspots = (analytics: Analytics) => analytics.weakSpots.find((kind) => kind.kind === "hotspot")!;

  it("lists each block's code files once, for one question to git, and none for a planned block", () => {
    expect(files[BOOK]).toContain("src/booking/book-seats.ts");
    expect(codeFilesOf(tickets).all).toContain("src/booking/find-event.ts");
    expect(Object.keys(files).every((path) => !tickets.blocks[path]!.planned)).toBe(true);
  });

  it("counts a block's commits once however many of its files one touched, shares them out, and ranks", () => {
    const commits = [[...files[BOOK]!, ...files[FIND]!], files[BOOK]!, files[BOOK]!, files[FIND]!];
    const analytics = given(commits);
    const changes = measureOf(analytics, "maintainability", "tickets", "changes");
    expect(changes.text).toBe("4 commits touched its code in the last 12 months · most: Book Seats, 3");
    expect(changes.rows.slice(0, 2).map((row) => [row.name, row.text, row.detail])).toEqual([
      ["Book Seats", "3 commits (75%)", `in ${files[BOOK]!.join(", ")}`],
      ["Find Event", "2 commits (50%)", `in ${files[FIND]!.join(", ")}`],
    ]);
    expect(changes.of).toContain("each commit counted once for every block whose code it touched, so the blocks' shares can add to more than 100%");
    expect(changes.of).not.toContain("shallow");
    const own = blockMeasure(analytics, "maintainability", BOOK, "changes");
    expect(own.text).toBe("3 commits in the last 12 months (75% of Tickets)");
    expect(own.rank).toEqual({ place: 1, of: functionBlocks, kind: "function blocks" });
    expect(own.share).toBe(0.75);
    expect(measureOf(given(commits, true), "maintainability", "tickets", "changes").of).toContain("This clone is shallow");
    expect(measureOf(given([]), "maintainability", "tickets", "changes").text).toBe("none in the last 12 months");
  });

  it("finds a hotspot in the top quarter by commits and by ways through, with at least 3 commits, and nothing in a system of equals", () => {
    const found = hotspots(given([files[BOOK]!, files[BOOK]!, files[BOOK]!]));
    expect(found.measured).toBe(true);
    expect(found.spots.map((spot) => [spot.headline, spot.block, spot.band, ...spot.evidence.slice(0, 2)])).toEqual([
      [
        "Changes often and is hard to follow: Book Seats",
        BOOK,
        null,
        `3 commits in the last 12 months, 1st of ${withCode} function blocks with code read`,
        `bookSeats has 5 ways through, 1st of ${withCode}`,
      ],
    ]);
    expect(found.spots[0]!.evidence[2]).toContain("not that anything is wrong");
    // Two commits are not often; many commits to code with one way through are not hard to follow;
    // and a system whose blocks all changed alike has no block that changes often.
    expect(hotspots(given([files[BOOK]!, files[BOOK]!])).spots).toEqual([]);
    expect(hotspots(given([files[FIND]!, files[FIND]!, files[FIND]!, files[FIND]!])).spots).toEqual([]);
    const everything = Object.values(files).flat();
    expect(hotspots(given([everything, everything, everything])).spots).toEqual([]);
    expect(hotspots(given([]))).toMatchObject({ measured: true, reason: null, spots: [] });
    expect(analyticsOf(tickets).weakSpots.map((kind) => kind.kind)).toEqual(["cycle", "hotspot", "complexity"]);
  });

  it("says why there is nothing: git's own reason, or that this reader does not read git", () => {
    const noGit = analyticsOf(tickets, { changes: { unavailable: "no git" } });
    expect(measureOf(noGit, "maintainability", "tickets", "changes").unavailable).toBe("no git");
    expect(hotspots(noGit)).toMatchObject({ measured: false, reason: "no git", spots: [] });
    expect(measureOf(analyticsOf(tickets, { changesUnavailable: "not here" }), "maintainability", "tickets", "changes").unavailable).toBe("not here");
    expect(blockMeasure(analyticsOf(tickets), "maintainability", BOOK, "changes").unavailable).toBe("not read here");
    expect(hotspots(analyticsOf(tickets))).toMatchObject({ measured: false, reason: "not read here" });
    // A system whose code was not read has unknown ways through, so the kind was not looked for there.
    const unread = { ...tickets, systems: tickets.systems.map((system) => ({ ...system, reachRead: false, reachNotReadBecause: "Python code is not read yet" })) };
    expect(hotspots(analyticsOf(unread, { changes: { unavailable: null, commits: [], shallow: false } }))).toMatchObject({ measured: false, reason: "Python code is not read yet", spots: [] });
    // Nothing with code yet: said so, as Size says it.
    const bare = { ...tickets, functions: {}, blocks: Object.fromEntries(Object.entries(tickets.blocks).map(([path, block]) => [path, { ...block, code: null }])) };
    expect(measureOf(analyticsOf(bare, { changes: { unavailable: null, commits: [], shallow: false } }), "maintainability", "tickets", "changes").unavailable).toBe("no code yet");
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


  it("gives the same answer whatever order the entries come in, and copes with a page from before this work", () => {
    const shuffled = { ...messenger, reachSeen: [...messenger.reachSeen].reverse() };
    expect(JSON.stringify(analyticsOf(shuffled))).toBe(JSON.stringify(analyticsOf(messenger)));
    const old = { ...tickets } as Partial<ProjectSnapshot>;
    delete old.reachSeen;
    delete old.functions;
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
