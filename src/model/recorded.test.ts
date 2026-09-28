import { describe, expect, it } from "vitest";
import { parseExecutionFile } from "../project/executions.js";
import { checkRecording, recordedTrace } from "./recorded.js";
import type { HeardEvent, HeardOutcome, RecordingScope } from "./recorded.js";
import type { Trace } from "./trace.js";

/**
 * A recording made by hand: what the harness would report for booking seats
 * in examples/tickets, and what such a recording could see. Nothing runs
 * here, so every rule can be held to a case small enough to read.
 */

const BOOK = "tickets/booking-api/book-seats";
const FIND = "tickets/booking-api/find-event";
const PRICE = "tickets/booking-api/pricing/price-seat";
const RESERVE = "tickets/booking-api/book-seats/reserve";

const scope: RecordingScope = {
  runs: BOOK,
  blocks: {
    [BOOK]: "src/booking/book-seats.ts#bookSeats",
    [RESERVE]: "src/booking/reserve.ts#reserve",
    [FIND]: "src/booking/find-event.ts#findEvent",
    [PRICE]: "src/booking/price-seat.ts#priceSeat",
  },
  stores: ["tickets/tickets-db.events", "tickets/tickets-db.bookings", "tickets/outbox.confirmations"],
  answers: ["tickets/booking-api.bookSeats"],
  unseen: ["tickets/booking-api.bookSeats", "tickets/box-office.bookSeats", "tickets/outbox.reminders"],
};

const gig = { id: "gig", name: "Night Gig", seatsLeft: 10, price: 25 };
const booking = { id: "gig-10", eventId: "gig", seats: 2, total: 50 };

/** Book two seats: find the event, price both seats at once, and reserve them. */
const heard: HeardEvent[] = [
  { type: "call", id: 1, parent: null, block: BOOK, input: { eventId: "gig", seats: 2 } },
  { type: "call", id: 2, parent: 1, block: FIND, input: { eventId: "gig" } },
  { type: "store", id: 3, parent: 2, target: "tickets/tickets-db.events", op: "read", key: "gig", value: gig },
  { type: "return", id: 2, output: { event: gig } },
  // Both seats are priced at once, so their calls overlap.
  { type: "call", id: 4, parent: 1, block: PRICE, input: { fullPrice: 25, seat: 1 } },
  { type: "call", id: 5, parent: 1, block: PRICE, input: { fullPrice: 25, seat: 2 } },
  { type: "return", id: 5, output: { price: 25 } },
  { type: "return", id: 4, output: { price: 25 } },
  { type: "call", id: 6, parent: 1, block: RESERVE, input: { seats: 2, total: 50 } },
  { type: "store", id: 7, parent: 6, target: "tickets/tickets-db.events", op: "write", key: "gig", value: { ...gig, seatsLeft: 8 } },
  { type: "store", id: 8, parent: 6, target: "tickets/tickets-db.bookings", op: "write", key: "gig-10", value: booking },
  { type: "store", id: 9, parent: 6, target: "tickets/outbox.confirmations", op: "send", value: { total: 50 } },
  { type: "return", id: 6, output: { bookingId: "gig-10" } },
  { type: "return", id: 1, output: { booked: true, total: 50 } },
];

const outcome: HeardOutcome = {
  stores: {
    "tickets/tickets-db.events": { kind: "store", rows: { gig: { ...gig, seatsLeft: 8 } } },
    "tickets/outbox.confirmations": { kind: "queue", sent: [{ total: 50 }] },
  },
};

const trace = recordedTrace("book-seats", scope, heard, outcome);
const byId = (id: string, from: Trace = trace) => from.events.find((event) => event.id === id);

/** An execution as its file would say it, triggered at the box office. */
function written(file: { trace?: unknown[]; expect?: object; given?: object }) {
  const parsed = parseExecutionFile(
    {
      trigger: { at: "tickets/box-office.bookSeats", kind: "action", payload: { eventId: "gig", seats: 2 } },
      ...file,
    },
    "book-seats",
  );
  if (!parsed.ok) throw new Error(parsed.problems.join("\n"));
  return parsed.execution;
}

const step = (from: string, to: string, kind: string, more: object = {}) => ({ from, to, kind, ...more });
const verdicts = (file: Parameters<typeof written>[0], complete = true, from: Trace = trace) =>
  checkRecording(written(file), from, scope, complete).steps.map(({ verdict, reason }) => (reason === null ? verdict : [verdict, reason]));

describe("turning what the harness heard into a trace", () => {
  it("makes the first call the trigger, from outside, into the block that ran", () => {
    expect(trace.source).toBe("recorded");
    expect(trace.events[0]).toEqual({
      type: "interaction",
      id: "trigger",
      cause: null,
      from: null,
      to: { path: BOOK, entry: null },
      kind: "trigger",
      code: "src/booking/book-seats.ts#bookSeats",
      payload: { eventId: "gig", seats: 2 },
    });
  });

  it("gives every call the call that made it, even when calls overlap", () => {
    expect(byId("@2")).toMatchObject({ cause: "trigger", from: { path: BOOK }, to: { path: FIND }, kind: "call", code: "src/booking/book-seats.ts#bookSeats" });
    expect([byId("@4"), byId("@5")].map((call) => call && "cause" in call && call.cause)).toEqual(["trigger", "trigger"]);
    // A store is used by the call that was running, wherever it sits.
    expect(byId("@3")).toMatchObject({ cause: "@2", from: { path: FIND }, to: { path: "tickets/tickets-db", entry: "events" }, kind: "read" });
    expect(byId("@7")).toMatchObject({ cause: "@6", from: { path: RESERVE }, code: "src/booking/reserve.ts#reserve" });
    // Each call finishes when it really did, not in the order it started.
    expect(trace.events.filter((event) => event.type === "return").map((event) => event.id).slice(1, 3)).toEqual(["@2.returned", "@5.returned"]);
  });

  it("names a row read by its key, and gives back the row", () => {
    expect(byId("@3")).toMatchObject({ payload: { key: "gig" } });
    expect(byId("@3.returned")).toMatchObject({ type: "return", of: "@3", response: gig });
  });

  it("leaves an effect for each write, remove and send, a remove carrying the row it took away", () => {
    expect(byId("@7.effect")).toMatchObject({ type: "effect", cause: "@7", kind: "row-changed", detail: { seatsLeft: 8 } });
    expect(byId("@9")).toMatchObject({ kind: "send", payload: { total: 50 } });
    expect(byId("@9.effect")).toMatchObject({ kind: "message-published", at: { path: "tickets/outbox", entry: "confirmations" } });

    const removed = recordedTrace("x", scope, [
      heard[0]!,
      { type: "store", id: 2, parent: 1, target: "tickets/tickets-db.bookings", op: "remove", key: "gig-10", value: booking },
      { type: "store", id: 3, parent: 1, target: "tickets/tickets-db.bookings", op: "remove", key: "gone", value: null },
    ], outcome);
    expect(byId("@2", removed)).toMatchObject({ kind: "remove", payload: { key: "gig-10" } });
    expect(byId("@2.effect", removed)).toMatchObject({ kind: "row-removed", detail: booking });
    // Removing a row that was not there took nothing away.
    expect(byId("@3.effect", removed)).toBeUndefined();
  });

  it("leaves what the block run returned as the response, at that block", () => {
    expect(trace.events.at(-1)).toEqual({
      type: "effect",
      id: "trigger.response",
      cause: "trigger",
      at: { path: BOOK, entry: null },
      kind: "response",
      code: "src/booking/book-seats.ts#bookSeats",
      detail: { booked: true, total: 50 },
    });
  });

  it("says what a call threw, and leaves no response when the block run threw", () => {
    const threw = recordedTrace("x", scope, [heard[0]!, { type: "throw", id: 1, error: "There is no such event." }], outcome);
    expect(byId("trigger.returned", threw)).toEqual({
      type: "return",
      id: "trigger.returned",
      of: "trigger",
      from: null,
      to: { path: BOOK, entry: null },
      error: "There is no such event.",
    });
    expect(threw.events.some((event) => event.type === "effect")).toBe(false);
  });

  it("keeps what each store was left holding", () => {
    expect(trace.state).toEqual({
      "tickets/tickets-db.events": { gig: { ...gig, seatsLeft: 8 } },
      "tickets/outbox.confirmations": [{ total: 50 }],
    });
  });
});

describe("holding written steps to a recording", () => {
  const read = (payload: object) => step(FIND, "tickets/tickets-db.events", "read", { payload });

  it("sees a row read by the one field that names it, and not a different row", () => {
    expect(verdicts({ trace: [read({ id: "gig" })] })).toEqual(["seen"]);
    expect(verdicts({ trace: [read({ id: "other" })] })).toEqual([
      [
        "not-seen",
        'A read from tickets/booking-api/find-event to tickets/tickets-db.events happened, but not as expected: payload.key was "gig", expected "other".',
      ],
    ]);
  });

  it("does not compare how a row was looked for when the code listed the store instead", () => {
    const scanned = recordedTrace("x", scope, [
      heard[0]!,
      { type: "store", id: 2, parent: 1, target: "tickets/tickets-db.events", op: "list", value: [gig] },
    ], outcome);
    const byEmail = step(BOOK, "tickets/tickets-db.events", "read", { payload: { email: "ada@example.com" } });
    expect(verdicts({ trace: [byEmail] }, true, scanned)).toEqual(["seen"]);
  });

  it("judges a response at the operation the block run answers by what that block returned", () => {
    const response = (detail: object) => ({ effect: "response", at: "tickets/booking-api.bookSeats", detail });
    expect(verdicts({ trace: [response({ booked: true, total: 50 })] })).toEqual(["seen"]);
    expect(verdicts({ trace: [response({ total: 55 })] })).toEqual([
      ["not-seen", 'A "response" effect at tickets/booking-api/book-seats happened, but not as expected: detail.total was 50, expected 55.'],
    ]);
  });

  it("cannot check an effect a recording never leaves, or a step where the run could not see", () => {
    expect(
      verdicts({
        trace: [
          { effect: "ui-changed", at: "tickets/box-office.bookSeats" },
          step("tickets/box-office.bookSeats", "tickets/booking-api.bookSeats", "call"),
          step(RESERVE, "tickets/outbox.reminders", "send"),
        ],
      }),
    ).toEqual([
      ["unchecked", 'Fragmentor does not record "ui-changed" effects.'],
      ["unchecked", "tickets/box-office.bookSeats and tickets/booking-api.bookSeats are not part of what ran."],
      ["unchecked", "tickets/outbox.reminders is not part of what ran."],
    ]);
  });

  it("matches one step to any of several identical calls, and counts the calls no step accounts for", () => {
    const secondSeat = step(BOOK, PRICE, "call", { payload: { seat: 2 }, response: { price: 25 } });
    const check = checkRecording(written({ trace: [secondSeat] }), trace, scope, true);
    expect(check.steps.map((each) => each.verdict)).toEqual(["seen"]);
    // Both price calls are accounted for; the find, its read, the reserve and its three are not.
    expect(check.unwrittenCount).toBe(6);
  });

  it("says a call that threw gave back nothing", () => {
    const threw = recordedTrace("x", scope, [heard[0]!, heard[1]!, { type: "throw", id: 2, error: "The database is down." }], outcome);
    expect(verdicts({ trace: [step(BOOK, FIND, "call", { response: { event: gig } })] }, true, threw)).toEqual([
      [
        "not-seen",
        "A call from tickets/booking-api/book-seats to tickets/booking-api/find-event happened, but not as expected: it threw instead: The database is down.",
      ],
    ]);
  });

  it("still holds a row read by its key when the same block also lists the store", () => {
    const both = recordedTrace("x", scope, [
      ...heard.slice(0, 3),
      { type: "store", id: 10, parent: 2, target: "tickets/tickets-db.events", op: "list", value: [gig] },
    ], outcome);
    expect(verdicts({ trace: [read({ id: "gig" })] }, true, both)).toEqual(["seen"]);
    // The list names no row, so it cannot stand in for a read of the wrong one.
    expect(verdicts({ trace: [read({ id: "other" })] }, true, both)).toEqual([
      [
        "not-seen",
        'A read from tickets/booking-api/find-event to tickets/tickets-db.events happened, but not as expected: payload.key was "gig", expected "other".',
      ],
    ]);
  });

  it("needs a recorded step of its own for each step written down", () => {
    const find = step(BOOK, FIND, "call", { payload: { eventId: "gig" } });
    expect(verdicts({ trace: [find, find] })).toEqual([
      "seen",
      [
        "not-seen",
        `A call from ${BOOK} to ${FIND} happened once, which is not enough for every expectation asking for it.`,
      ],
    ]);
    // Both price calls were made, so both can be written down.
    const price = step(BOOK, PRICE, "call");
    expect(verdicts({ trace: [price, price] })).toEqual(["seen", "seen"]);
  });

  it("does not call a step missing from a run that did not finish a contradiction", () => {
    const stopped = recordedTrace("x", scope, heard.slice(0, 3), outcome);
    expect(verdicts({ trace: [step(RESERVE, "tickets/tickets-db.events", "write")] }, false, stopped)).toEqual([
      ["not-seen", "The recording ends before the run did, so this may not have happened yet."],
    ]);
  });
});

describe("holding expectations to a recording", () => {
  const expecting = (expect: object, complete = true, from: Trace = trace) =>
    checkRecording(written({ expect }), from, scope, complete).expectations;

  it("meets what the run did, and fails what it did differently", () => {
    expect(
      expecting({
        entered: [RESERVE],
        interactions: [{ from: RESERVE, to: "tickets/tickets-db.bookings", kind: "write", payload: { total: 50 } }],
        effects: [{ kind: "response", at: "tickets/booking-api.bookSeats", detail: { booked: true } }],
        state: { "tickets/tickets-db.events": { gig: { seatsLeft: 8 } } },
      }),
    ).toEqual({
      met: [
        `Something crosses into ${RESERVE}`,
        `A write from ${RESERVE} to tickets/tickets-db.bookings`,
        'A "response" effect at tickets/booking-api.bookSeats',
        "What tickets/tickets-db.events holds at the end",
      ],
      failures: [],
      setAside: [],
    });
    expect(expecting({ interactions: [{ from: RESERVE, to: "tickets/tickets-db.bookings", kind: "write", payload: { total: 55 } }] })).toEqual({
      met: [],
      failures: [
        `A write from ${RESERVE} to tickets/tickets-db.bookings happened, but not as expected: payload.total was 50, expected 55.`,
      ],
      setAside: [],
    });
  });

  it("says one of two expectations wanting the same event is met, and fails the other", () => {
    const write = { from: RESERVE, to: "tickets/tickets-db.bookings", kind: "write" };
    const found = expecting({ interactions: [write, write] });
    expect(found.met).toEqual([`A write from ${RESERVE} to tickets/tickets-db.bookings`]);
    expect(found.failures).toEqual([
      `A write from ${RESERVE} to tickets/tickets-db.bookings happened once, which is not enough for every expectation asking for it.`,
    ]);
  });

  it("holds a remove written by its row's id to the key the code removed", () => {
    const removed = recordedTrace("x", scope, [
      heard[0]!,
      { type: "store", id: 2, parent: 1, target: "tickets/tickets-db.bookings", op: "remove", key: "gig-10", value: booking },
    ], outcome);
    const remove = (id: string) => ({ interactions: [{ from: BOOK, to: "tickets/tickets-db.bookings", kind: "remove", payload: { id } }] });
    expect(expecting(remove("gig-10"), true, removed).failures).toEqual([]);
    expect(expecting(remove("gig-11"), true, removed).failures).toHaveLength(1);
  });

  it("sets aside what never happening proves nothing about, and never counts it as met", () => {
    expect(expecting({ never: ["tickets/outbox.reminders", "tickets/box-office"], effects: [{ kind: "ui-changed" }] })).toEqual({
      met: [],
      failures: [],
      setAside: [
        { expectation: 'A "ui-changed" effect', why: 'Fragmentor does not record "ui-changed" effects.' },
        { expectation: "Nothing happens in tickets/outbox.reminders", why: "tickets/outbox.reminders is not part of what ran." },
        { expectation: "Nothing happens in tickets/box-office", why: "tickets/box-office.bookSeats is not part of what ran." },
      ],
    });
  });

  it("fails a part that should have been left alone where the run was seen touching it", () => {
    // The confirmation was sent, which is enough, whatever else in the outbox could not be seen.
    expect(expecting({ never: ["tickets/outbox"] }, true, trace).failures).toEqual([
      `Nothing should have happened in tickets/outbox, but there was a send from ${RESERVE} to tickets/outbox.confirmations.`,
    ]);
    const quiet = recordedTrace("x", scope, heard.slice(0, 4), outcome);
    expect(expecting({ never: ["tickets/outbox"] }, true, quiet)).toEqual({
      met: [],
      failures: [],
      setAside: [{ expectation: "Nothing happens in tickets/outbox", why: "Checked only for tickets/outbox.confirmations." }],
    });
    // The whole system holds the block run, so something always happened in it.
    expect(expecting({ never: ["tickets"] }).failures).toHaveLength(1);
  });

  it("meets what it finds even where it cannot see everything, and sets aside what it does not", () => {
    const fromAnywhere = { to: "tickets/tickets-db.events", kind: "read" };
    expect(expecting({ interactions: [fromAnywhere] })).toEqual({ met: ["A read to tickets/tickets-db.events"], failures: [], setAside: [] });
    expect(expecting({ interactions: [{ ...fromAnywhere, kind: "remove" }] })).toEqual({
      met: [],
      failures: [],
      setAside: [
        {
          expectation: "A remove to tickets/tickets-db.events",
          why: "It does not say where it comes from, and not everything that could have made it ran.",
        },
      ],
    });
  });

  it("sets aside what a run that did not finish has not done yet", () => {
    const stopped = recordedTrace("x", scope, heard.slice(0, 3), outcome);
    expect(expecting({ entered: [RESERVE], never: [PRICE] }, false, stopped).setAside).toEqual([
      { expectation: `Something crosses into ${RESERVE}`, why: "The recording ends before the run did, so this may not have happened yet." },
      { expectation: `Nothing happens in ${PRICE}`, why: "The recording ends before the run did, so this may not have happened yet." },
    ]);
  });

  it("does not meet a read written with the wrong key because the block also listed the store", () => {
    const both = recordedTrace("x", scope, [
      ...heard.slice(0, 3),
      { type: "store", id: 10, parent: 2, target: "tickets/tickets-db.events", op: "list", value: [gig] },
    ], outcome);
    const read = (id: string) => ({ interactions: [{ from: FIND, to: "tickets/tickets-db.events", kind: "read", payload: { id } }] });
    expect(expecting(read("gig"), true, both).failures).toEqual([]);
    expect(expecting(read("other"), true, both).failures).toHaveLength(1);
  });

  it("says which starting rows the run had no way to hold", () => {
    const given = { "tickets/tickets-db.events": { gig }, "tickets/tickets-db.refunds": {} };
    expect(checkRecording(written({ given }), trace, scope, true).notSeeded).toEqual(["tickets/tickets-db.refunds"]);
  });
});

describe("blocks whose code shares a file", () => {
  // Reserve's code moved into book-seats.ts. Book seats then calls it inside
  // the file, so the harness never hears the call, and hears what reserve does
  // as book seats' own.
  const together: RecordingScope = { ...scope, blocks: { ...scope.blocks, [RESERVE]: "src/booking/book-seats.ts#reserve" } };
  const inOneFile = recordedTrace(
    "book-seats",
    together,
    heard.flatMap((event) => (event.id === 6 ? [] : event.type === "store" && event.parent === 6 ? [{ ...event, parent: 1 }] : [event])),
    outcome,
  );
  const sharing = `${BOOK} and ${RESERVE} share src/booking/book-seats.ts, and a call inside one file is not heard, so what one of them does may be heard as another's.`;
  const expecting = (expect: object, from: Trace = inOneFile) => checkRecording(written({ expect }), from, together, true).expectations;

  it("cannot check a step either one takes, whether or not it was heard", () => {
    const check = checkRecording(
      written({
        trace: [
          step(BOOK, RESERVE, "call", { payload: { seats: 9 } }),
          step(RESERVE, "tickets/tickets-db.events", "write"),
          step(BOOK, "tickets/tickets-db.events", "write"),
          step(RESERVE, "tickets/tickets-db.bookings", "write"),
          step(RESERVE, "tickets/outbox.confirmations", "send"),
        ],
      }),
      inOneFile,
      together,
      true,
    );
    expect(check.steps.map(({ verdict, reason }) => [verdict, reason])).toEqual(Array(5).fill(["unchecked", sharing]));
    // What reserve did, heard as book seats', is what the steps written for reserve account for.
    expect(check.unwrittenCount).toBe(4);
  });

  it("sets aside what a block sharing a file was expected to do or not do, rather than failing or meeting it", () => {
    expect(
      expecting({
        entered: [RESERVE],
        never: [RESERVE],
        interactions: [{ from: RESERVE, to: "tickets/tickets-db.bookings", kind: "write" }],
      }),
    ).toEqual({
      met: [],
      failures: [],
      setAside: [
        { expectation: `Something crosses into ${RESERVE}`, why: sharing },
        { expectation: `A write from ${RESERVE} to tickets/tickets-db.bookings`, why: sharing },
        { expectation: `Nothing happens in ${RESERVE}`, why: sharing },
      ],
    });
  });

  it("still counts a call into such a block that was heard, and what reached a store", () => {
    // Called through its export, as another file would, reserve is heard.
    expect(expecting({ entered: [RESERVE] }, trace)).toEqual({ met: [`Something crosses into ${RESERVE}`], failures: [], setAside: [] });
    expect(expecting({ never: [BOOK] }).failures).toHaveLength(1);
    expect(
      expecting({
        effects: [
          { kind: "row-changed", at: "tickets/tickets-db.events", detail: { seatsLeft: 8 } },
          { kind: "response", at: "tickets/booking-api.bookSeats", detail: { booked: true } },
        ],
      }),
    ).toEqual({
      met: ['A "row-changed" effect at tickets/tickets-db.events', 'A "response" effect at tickets/booking-api.bookSeats'],
      failures: [],
      setAside: [],
    });
  });
});
