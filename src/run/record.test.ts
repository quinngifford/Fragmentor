import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { checkRecording } from "../model/recorded.js";
import { loadProject } from "../project/project.js";
import { readAllCode } from "../project/code.js";
import { answeringBlock, recordExecution } from "./record.js";
import type { Recorded } from "./record.js";

/**
 * Recording the Tickets example for real: its code imports its contracts, so
 * every one of its executions leads to code Fragmentor can run. These are what
 * say a recording agrees with a trace that is right, and catches one that is
 * wrong.
 */

const examples = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "examples");
const BOOK_SEATS = path.join("executions", "book-seats.json");

let dir: string;
let original: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "fragmentor-record-"));
  await cp(path.join(examples, "tickets"), dir, { recursive: true });
  original = await readFile(path.join(dir, BOOK_SEATS), "utf8");
});

afterEach(async () => {
  await writeFile(path.join(dir, BOOK_SEATS), original, "utf8");
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function record(id: string): Promise<Recorded> {
  const recorded = await recordExecution(dir, id);
  if (!("trace" in recorded)) throw new Error(JSON.stringify(recorded));
  return recorded;
}

const check = (recorded: Recorded) => checkRecording(recorded.execution, recorded.trace, recorded.scope, recorded.complete);

/** book-seats.json with its written steps changed. */
async function drift(change: (steps: Record<string, unknown>[]) => void) {
  const file = JSON.parse(original);
  change(file.trace);
  await writeFile(path.join(dir, BOOK_SEATS), JSON.stringify(file), "utf8");
}

describe("the code an execution leads to", () => {
  it("follows a button through the operation it calls to the block that answers it", async () => {
    const project = await loadProject(dir);
    const code = await readAllCode(project);
    expect(answeringBlock(project, code, { path: "tickets/box-office", entry: "bookSeats" })).toEqual({
      block: "tickets/booking-api/book-seats",
    });
    expect(answeringBlock(project, code, { path: "tickets/booking-api/find-event", entry: null })).toEqual({
      block: "tickets/booking-api/find-event",
    });
    expect(answeringBlock(project, code, { path: "tickets/outbox", entry: "confirmations" })).toEqual({
      why: "Nothing on the diagram says which code answers tickets/outbox.confirmations.",
    });
  });

  it("says an operation with no block, as an anonymous handler leaves it, is why, rather than a fault", async () => {
    const project = await loadProject(dir);
    const code = await readAllCode(project);
    const api = project.byPath.get("tickets/booking-api")!.block;
    delete api.exposes.bookSeats!.block;
    project.manifest.existingCode = true;

    expect(answeringBlock(project, code, { path: "tickets/booking-api", entry: "bookSeats" })).toEqual({
      why: "its operation tickets/booking-api.bookSeats names no block that answers it, as with an anonymous handler.",
    });
    expect(answeringBlock(project, code, { path: "tickets/box-office", entry: "bookSeats" })).toEqual({
      why: "it leads to the operation tickets/booking-api.bookSeats, which names no block that answers it, as with an anonymous handler.",
    });

    // A planned service has no handler yet, and code built from the diagram
    // names a block for each operation, so in either the missing block is a gap.
    const gap = { why: "Nothing on the diagram says which code answers tickets/booking-api.bookSeats." };
    api.planned = true;
    expect(answeringBlock(project, code, { path: "tickets/booking-api", entry: "bookSeats" })).toEqual(gap);
    api.planned = false;
    project.manifest.existingCode = false;
    expect(answeringBlock(project, code, { path: "tickets/booking-api", entry: "bookSeats" })).toEqual(gap);
  });

  it("says why code that does not import its contract cannot be recorded", async () => {
    const messenger = await loadProject(path.join(examples, "messenger"));
    const found = answeringBlock(messenger, await readAllCode(messenger), { path: "app/client/ui/send-button", entry: null });
    expect(found).toEqual({ why: expect.stringContaining('"Send Button" answers app/client/ui/send-button, but cannot be recorded:') });
    expect("why" in found && found.why).toContain("does not import");
  });
});

describe("recording the Tickets executions", () => {
  it.each(["book-seats", "booking-turned-away", "cancel-booking", "cancel-without-the-event"])(
    "%s agrees with everything written down that it could see",
    async (id) => {
      const recorded = await record(id);
      const found = check(recorded);

      expect(recorded.complete).toBe(true);
      expect(found.expectations.failures).toEqual([]);
      expect(found.steps.filter((step) => step.verdict === "not-seen")).toEqual([]);
      expect(found.unwrittenCount).toBe(0);
      expect(found.notSeeded).toEqual([]);
      // Each operation's response is what its block returned, so it is checked, not set aside.
      expect(found.expectations.setAside.filter((each) => each.expectation.includes("response"))).toEqual([]);
      // What it cannot see is only the two hops before the block it ran, and what happens on the page.
      expect(found.steps.filter((step) => step.verdict === "unchecked").map((step) => step.id)).toEqual([
        "#1",
        "#2",
        `#${found.steps.length}`,
      ]);
    },
    30_000,
  );

  it("records what booking seats really did, stores included", async () => {
    const { trace } = await record("book-seats");
    const interactions = trace.events.flatMap((event) =>
      event.type === "interaction" ? [`${event.kind} ${event.to.path}${event.to.entry ? `.${event.to.entry}` : ""}`] : [],
    );
    expect(interactions).toEqual([
      "trigger tickets/booking-api/book-seats",
      "call tickets/booking-api/find-event",
      "read tickets/tickets-db.events",
      ...Array<string>(5).fill("call tickets/booking-api/pricing/price-seat"),
      "call tickets/booking-api/book-seats/reserve",
      "write tickets/tickets-db.events",
      "write tickets/tickets-db.bookings",
      "send tickets/outbox.confirmations",
    ]);
    expect(trace.state?.["tickets/tickets-db.bookings"]).toEqual({
      "gig-10": { id: "gig-10", eventId: "gig", email: "ada@example.com", seats: 5, total: 122.5 },
    });
  }, 30_000);
});

describe("a trace that no longer says what the code does", () => {
  it("is caught when a step names the wrong block as where it comes from", async () => {
    await drift((steps) => {
      steps.find((step) => step.kind === "read")!.from = "tickets/booking-api/book-seats";
    });
    const found = check(await record("book-seats"));
    expect(found.steps.filter((step) => step.verdict === "not-seen")).toEqual([
      {
        id: "#4",
        verdict: "not-seen",
        reason: "A read from tickets/booking-api/book-seats to tickets/tickets-db.events never happened.",
      },
    ]);
    // And the read the code really made is written down nowhere now.
    expect(found.unwrittenCount).toBe(1);
  }, 30_000);

  it("is caught when a step the code takes is left out", async () => {
    await drift((steps) => {
      steps.splice(steps.findIndex((step) => step.to === "tickets/booking-api/pricing/price-seat"), 1);
    });
    const found = check(await record("book-seats"));
    expect(found.steps.filter((step) => step.verdict === "not-seen")).toEqual([]);
    expect(found.unwrittenCount).toBe(5);
  }, 30_000);

  it("is caught when a step says the wrong total", async () => {
    await drift((steps) => {
      const write = steps.find((step) => step.to === "tickets/tickets-db.bookings")!;
      write.payload = { ...(write.payload as object), total: 125 };
    });
    const found = check(await record("book-seats"));
    expect(found.steps.filter((step) => step.verdict === "not-seen")).toEqual([
      {
        id: "#9",
        verdict: "not-seen",
        reason:
          "A write from tickets/booking-api/book-seats/reserve to tickets/tickets-db.bookings happened, but not as expected: payload.total was 122.5, expected 125.",
      },
    ]);
  }, 30_000);

  it("is not recorded at all when it is stopped before it starts", async () => {
    const recorded = await recordExecution(dir, "book-seats", { started: (control) => control.stop() });
    expect(recorded).toEqual({ couldNotRecord: expect.any(String) });
  }, 30_000);

  it("is not recorded at all when its payload no longer fits the code", async () => {
    const file = JSON.parse(original);
    delete file.trigger.payload.email;
    await writeFile(path.join(dir, BOOK_SEATS), JSON.stringify(file), "utf8");
    const recorded = await recordExecution(dir, "book-seats");
    expect(recorded).toEqual({ couldNotRecord: expect.stringContaining("input.email") });
  }, 30_000);
});

describe("recording blocks whose code shares a file", () => {
  let together: string;

  // Tickets with reserve's code moved into book-seats.ts, and nothing else changed.
  beforeAll(async () => {
    together = await mkdtemp(path.join(tmpdir(), "fragmentor-record-"));
    await cp(path.join(examples, "tickets"), together, { recursive: true });
    const [bookSeats, reserve] = ["book-seats.ts", "reserve.ts"].map((file) => path.join(together, "src", "booking", file));
    const [caller, called] = await Promise.all([readFile(bookSeats!, "utf8"), readFile(reserve!, "utf8")]);
    const [importLine, ...body] = called.split(/\r?\n/);
    const rest = caller.replace(/import \{ reserve \} from "\.\/reserve\.js";\r?\n/, "");
    await writeFile(bookSeats!, [importLine, rest, ...body].join("\n"), "utf8");
    await rm(reserve!);
    const blockFile = path.join(together, "blocks", "tickets", "booking-api", "book-seats", "reserve", "block.json");
    const block = JSON.parse(await readFile(blockFile, "utf8"));
    await writeFile(blockFile, JSON.stringify({ ...block, code: "src/booking/book-seats.ts#reserve" }), "utf8");
  });

  afterAll(async () => {
    await rm(together, { recursive: true, force: true });
  });

  it("contradicts nothing written down that it could not hear", async () => {
    const recorded = await recordExecution(together, "book-seats");
    if (!("trace" in recorded)) throw new Error(JSON.stringify(recorded));
    const found = check(recorded);

    // The call into reserve is made inside the file, so it is not heard, and what reserve did is heard as book seats'.
    expect(recorded.trace.events.some((event) => event.type === "interaction" && event.to.path.endsWith("/reserve"))).toBe(false);
    expect(found.expectations.failures).toEqual([]);
    expect(found.steps.filter((step) => step.verdict === "not-seen")).toEqual([]);
    expect(found.unwrittenCount).toBe(0);
    expect(found.expectations.setAside.map((each) => each.expectation)).toContain(
      "A write from tickets/booking-api/book-seats/reserve to tickets/tickets-db.bookings",
    );
  }, 30_000);

  it("does not count reserve as left alone because the call into it was not heard", async () => {
    const file = path.join(together, BOOK_SEATS);
    const execution = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...execution, expect: { never: ["tickets/booking-api/book-seats/reserve"] } }), "utf8");
    const recorded = await recordExecution(together, "book-seats");
    if (!("trace" in recorded)) throw new Error(JSON.stringify(recorded));
    expect(check(recorded).expectations).toEqual({
      failures: [],
      setAside: [{ expectation: "Nothing happens in tickets/booking-api/book-seats/reserve", why: expect.stringContaining("share src/booking/book-seats.ts") }],
    });
  }, 30_000);
});
