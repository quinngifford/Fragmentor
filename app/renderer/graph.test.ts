import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { projectSnapshot } from "../../src/project/snapshot.js";
import { place } from "../../src/model/trace.js";
import {
  TILE_W,
  WAY_IN,
  accessEnds,
  autoLayout,
  buildGraph,
  drawnAt,
  entryLines,
  exposedRow,
  fitLine,
  layoutFor,
  measure,
  widthOf,
} from "./graph.js";
import type { Graph } from "./graph.js";
import { ui } from "./state.js";

/**
 * The diagram the canvas draws, without drawing it.
 *
 * Everything here is decided before a single element is created: which blocks
 * appear, which access lines are gathered up from inside them, and where it
 * all lands. Those are the parts worth holding still; whether the result
 * looks right is a person's judgement, and the self-check's screenshots are
 * for that.
 */

const examples = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "examples");
const tickets = path.join(examples, "tickets");
const messenger = path.join(examples, "messenger");

/** Everything one block reaches, named once however many lines run to it. */
function reachedBy(graph: Graph, source: string): string[] {
  const targets = [...graph.accesses.values()].filter((link) => link.source === source).map((link) => link.target);
  return [...new Set(targets)].sort();
}

/** The canvas is handed a snapshot and nothing else, so that is all a test needs. */
async function open(view: string): Promise<Graph> {
  ui.snapshot = await projectSnapshot(tickets);
  ui.view = view;
  const graph = buildGraph(view);
  if (!graph) throw new Error(`${view} has no diagram.`);
  return graph;
}

describe("the whole application, drawn", () => {
  let graph: Graph;
  beforeAll(async () => {
    graph = await open("tickets");
  });

  it("draws every part of the system, each as the thing it is", () => {
    expect([...graph.nodes.keys()].sort()).toEqual(["booking-api", "box-office", "outbox", "reminders", "tickets-db"]);
    expect(graph.nodes.get("tickets-db")!.sublabel).toBe("DATABASE: PostgreSQL");
    // Nothing sends reminders yet, so that one is still a plan.
    expect(graph.nodes.get("reminders")!.sublabel).toBe("PLANNED");
  });

  it("joins a button to the operation it triggers, not the block it is in", () => {
    const fromOffice = [...graph.accesses.values()].filter((link) => link.source === "box-office");

    // Two buttons calling two operations are two lines, each naming both ends.
    expect(fromOffice.map((link) => `${link.from} -> ${link.entries[0]!.entry}`).sort()).toEqual([
      "bookSeats -> bookSeats",
      "cancelBooking -> cancelBooking",
    ]);

    // And each meets the rows it names rather than the edges of the boxes.
    const placed = autoLayout(graph);
    const book = fromOffice.find((link) => link.from === "bookSeats")!;
    const cancel = fromOffice.find((link) => link.from === "cancelBooking")!;
    const first = accessEnds(graph, placed, book)!;
    const second = accessEnds(graph, placed, cancel)!;

    expect(first.from.y).toBeLessThan(second.from.y);
    expect(first.to.y).toBeLessThan(second.to.y);
    expect(first.from.y).toBe(placed.get("box-office")!.y + exposedRow(graph.nodes.get("box-office")!, "bookSeats")!);
    expect(first.to.y).toBe(placed.get("booking-api")!.y + exposedRow(graph.nodes.get("booking-api")!, "bookSeats")!);
  });

  it("gathers what the functions inside the service reach, so the top level shows it", () => {
    expect(reachedBy(graph, "box-office")).toEqual(["booking-api"]);
    // The service itself declares none of these; the blocks inside it do.
    expect(reachedBy(graph, "booking-api")).toEqual(["outbox", "tickets-db"]);
  });

  it("keeps a read and a write to one database as two lines, each its own way round", () => {
    const between = [...graph.accesses.values()].filter((link) => link.source === "booking-api" && link.target === "tickets-db");

    expect(between.map((link) => `${link.verb} ${link.direction}`).sort()).toEqual(["reads in", "writes out"]);
    for (const link of between) expect(link.fromWithin).toBe(true);
  });

  it("shows a table as its columns", () => {
    const [events] = graph.nodes.get("tickets-db")!.exposes;
    expect(entryLines(events!)).toEqual(["id: string", "name: string", "seatsLeft: number", "price: number"]);
  });

  it("reads left to right, from whoever starts the system to what it calls", () => {
    const placed = autoLayout(graph);
    expect(placed.get("box-office")!.x).toBeLessThan(placed.get("booking-api")!.x);
  });

  it("keeps the stores under what reaches them, not further along it", () => {
    const placed = autoLayout(graph);
    const api = placed.get("booking-api")!;
    const apiBottom = api.y + measure(graph.nodes.get("booking-api")!).height;

    // A store is not a step in the flow: the API reads and writes it in the
    // same breath, so putting it further right would say something untrue
    // about when it happens.
    for (const key of ["tickets-db", "outbox"]) {
      expect(placed.get(key)!.y, key).toBeGreaterThanOrEqual(apiBottom);
    }
  });

  it("loops a store clockwise: out of the right, down, and back into the left", () => {
    const placed = autoLayout(graph);
    const api = placed.get("booking-api")!;
    const write = graph.accesses.get("booking-api=>tickets-db:writes")!;
    const read = graph.accesses.get("booking-api=>tickets-db:reads")!;

    const out = accessEnds(graph, placed, write)!;
    const back = accessEnds(graph, placed, read)!;

    // What the API writes leaves its right edge; what it reads arrives on its left.
    expect(out.from.x).toBe(api.x + 208);
    expect(back.to.x).toBe(api.x);
    // And the two never cross under the store: what comes back leaves the
    // near side of it, what goes in arrives at the far side.
    expect(back.from.x).toBeLessThan(out.to.x);
  });

  it("leaves no two blocks on top of each other, stores included", () => {
    const placed = autoLayout(graph);
    const boxes = [...graph.nodes.values()].map((node) => ({
      key: node.key,
      ...placed.get(node.key)!,
      height: measure(node).height,
    }));

    for (const a of boxes) {
      for (const b of boxes) {
        if (a.key >= b.key) continue;
        const apart = a.x + 208 <= b.x || b.x + 208 <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
        expect(apart, `${a.key} and ${b.key} overlap`).toBe(true);
      }
    }
  });
});

describe("a store kept inside a group", () => {
  it("is reached through the group while the group is closed", async () => {
    await open("tickets");
    const snapshot = ui.snapshot!;
    const database = snapshot.blocks["tickets/tickets-db"]!;

    // The same application with an archive kept inside an infrastructure
    // group, and the event lookup reading it by its path from there.
    snapshot.blocks["tickets"]!.children.push("tickets/infrastructure");
    snapshot.blocks["tickets/infrastructure"] = {
      ...database,
      path: "tickets/infrastructure",
      id: "infrastructure",
      name: "Infrastructure",
      role: "component",
      roleLabel: "COMPONENT",
      exposes: [],
      children: ["tickets/infrastructure/archive-db"],
    };
    snapshot.blocks["tickets/infrastructure/archive-db"] = { ...database, path: "tickets/infrastructure/archive-db", id: "archive-db" };
    snapshot.blocks["tickets/booking-api/find-event"]!.access.push({
      text: "reads infrastructure/archive-db.events",
      from: null,
      verb: "reads",
      resource: "infrastructure/archive-db",
      resourcePath: "tickets/infrastructure/archive-db",
      resourceName: "Tickets Database",
      entry: "events",
    });

    const graph = buildGraph("tickets")!;
    expect(reachedBy(graph, "booking-api")).toEqual(["infrastructure", "outbox", "tickets-db"]);
    expect(graph.accesses.get("booking-api=>infrastructure:reads")?.entries.map((entry) => entry.text)).toEqual([
      "reads infrastructure/archive-db.events",
    ]);
  });
});

describe("inside the service", () => {
  let graph: Graph;
  beforeAll(async () => {
    graph = await open("tickets/booking-api");
  });

  it("shows the parts that are there, and nothing kept on another level", () => {
    // Every store this service touches is kept beside the service, not in it,
    // so its own diagram is its parts and the way into them.
    expect([...graph.nodes.keys()].sort()).toEqual([WAY_IN, "book-seats", "cancel-booking", "find-event", "pricing"].sort());
  });

  it("draws the way in: each operation, and the block that answers it", () => {
    const wayIn = [...graph.accesses.values()].filter((link) => link.source === WAY_IN);
    expect(wayIn.map((link) => `${link.entries[0]!.entry} -> ${link.target}`).sort()).toEqual([
      "bookSeats -> book-seats",
      "cancelBooking -> cancel-booking",
    ]);

    expect(wayIn.every((link) => link.answers)).toBe(true);

    const boundary = graph.nodes.get(WAY_IN)!;
    expect(boundary.boundary).toBe(true);
    expect(boundary.exposes.map((entry) => entry.name).sort()).toEqual(["bookSeats", "cancelBooking"]);
  });

  it("draws a function's contract as what it takes and gives back, and a group of parts as neither", () => {
    const book = graph.nodes.get("book-seats")!;
    expect(book.inputs.map((port) => port.name)).toEqual(["eventId", "seats", "email"]);
    expect(book.outputs.map((port) => port.name)).toEqual(["booked", "message", "total"]);

    const pricing = graph.nodes.get("pricing")!;
    expect(pricing.sublabel).toBe("COMPONENT: module");
    expect(pricing.inputs).toEqual([]);
    expect(pricing.outputs).toEqual([]);
  });

  it("draws nothing for one part calling another, which is what a run shows", () => {
    // book-seats calls find-event and the pricing beside it, and nothing on
    // the diagram says so: only what each reaches outside the code is drawn.
    const between = [...graph.accesses.values()].filter((link) => link.source !== WAY_IN);
    expect(between).toEqual([]);
  });

  it("draws no line from a block to the one whose diagram this is", () => {
    // Looking outward reaches the service the handlers are inside, so an
    // access naming it resolves; drawing it would be a line to the frame
    // around everything else. The checks refuse it; the canvas ignores it.
    ui.snapshot!.blocks["tickets/booking-api/find-event"]!.access = [
      {
        text: "calls booking-api.bookSeats",
        from: null,
        verb: "calls",
        resource: "booking-api",
        resourcePath: "tickets/booking-api",
        resourceName: "Booking API",
        entry: "bookSeats",
      },
    ];

    const redrawn = buildGraph("tickets/booking-api")!;
    expect([...redrawn.accesses.values()].map((link) => link.target)).not.toContain("booking-api");
    expect(redrawn.nodes.has("booking-api")).toBe(false);
  });
});

describe("inside a function made of parts", () => {
  it("draws its own code as the frame its part sits in", async () => {
    const graph = await open("tickets/booking-api/book-seats");
    expect([...graph.nodes.keys()]).toEqual(["reserve", WAY_IN]);

    // The code that calls the part is the function's own, so the frame is
    // drawn with its contract: a run into it has somewhere to arrive.
    const frame = graph.nodes.get(WAY_IN)!;
    expect(frame.boundary).toBe(true);
    expect(frame.sublabel).toBe("ITS OWN CODE");
    expect(frame.inputs.map((port) => port.name)).toEqual(["eventId", "seats", "email"]);

    // Alone, a store kept further out has nothing here to land on.
    expect([...graph.accesses.values()]).toEqual([]);
  });

  it("lands what its own code reaches on the tiles holding it", async () => {
    await open("tickets/booking-api/book-seats");
    const graph = buildGraph("tickets/booking-api/book-seats", { opened: new Set(), reached: new Set() })!;
    expect(reachedBy(graph, WAY_IN)).toEqual(["ctx:tickets/outbox", "ctx:tickets/tickets-db"]);
    // These are what the function reaches, not a way into it, and are labelled as such.
    expect([...graph.accesses.values()].some((link) => link.answers)).toBe(false);
  });
});

describe("the rest of the architecture, around the block in focus", () => {
  const around = (view: string, opened: string[] = [], reached: string[] = []) => {
    ui.view = view;
    return buildGraph(view, { opened: new Set(opened), reached: new Set(reached) })!;
  };
  beforeAll(async () => {
    ui.snapshot = await projectSnapshot(messenger);
  });

  it("draws every other part of the system as a tile, on the side it stands beside the focus", () => {
    const graph = around("app/api");
    const tiles = [...graph.nodes.values()].filter((node) => node.context);

    // On the diagram above, the client and the workers stand left of the API
    // and the infrastructure right of it. The API itself, and the application
    // it is part of, are not tiles: they are where this diagram came from.
    expect(tiles.map((tile) => [tile.block!.path, tile.context!.side])).toEqual([
      ["app/client", "left"],
      ["app/workers", "left"],
      ["app/infrastructure", "right"],
    ]);
    expect(tiles.map((tile) => tile.context!.caption)).toEqual(["in Messenger", null, "in Messenger"]);
  });

  it("stands the tiles clear of the diagram and of each other", () => {
    const graph = around("app/api", ["app/client", "app/infrastructure"]);
    const placed = layoutFor(graph, "app/api");
    const boxes = [...graph.nodes.values()].map((node) => ({
      key: node.key,
      ...placed.get(node.key)!,
      width: widthOf(node),
      height: measure(node).height,
    }));

    for (const a of boxes) {
      for (const b of boxes) {
        if (a.key >= b.key) continue;
        const apart = a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
        expect(apart, `${a.key} and ${b.key} overlap`).toBe(true);
      }
    }
    expect(widthOf(graph.nodes.get("ctx:app/client")!)).toBe(TILE_W);
  });

  it("opens a tile in place, independently of the focus, and draws a run into its parts", () => {
    const closed = around("app/api");
    const opened = around("app/api", ["app/infrastructure", "app/api/messaging"]);

    // The infrastructure's parts come in under it, indented.
    const parts = [...opened.nodes.values()].filter((node) => node.context?.indent === 1).map((node) => node.key);
    expect(parts).toEqual(["ctx:app/infrastructure/database", "ctx:app/infrastructure/queue"]);

    // So a run reaching the database is drawn at the database. Messaging is a
    // part of the focus, so opening it is left to its own diagram.
    const database = { path: "app/infrastructure/database", entry: "messages" };
    expect(drawnAt(closed, place(database, closed.view))).toEqual({ key: "ctx:app/infrastructure", entry: null });
    expect(drawnAt(opened, place(database, opened.view))).toEqual({ key: "ctx:app/infrastructure/database", entry: null });
    expect(opened.view.expanded.has("app/api/messaging")).toBe(false);
    const saving = { path: "app/api/messaging/save-message", entry: null };
    expect(drawnAt(opened, place(saving, opened.view))).toEqual({ key: "messaging", entry: null });
  });

  it("lands what the parts reach on the tile holding it, the deepest one open", () => {
    expect(reachedBy(around("app/api"), "messaging")).toEqual(["ctx:app/infrastructure"]);
    expect(reachedBy(around("app/api", ["app/infrastructure"]), "messaging")).toEqual([
      "ctx:app/infrastructure/database",
      "ctx:app/infrastructure/queue",
    ]);
  });

  it("meets a run at the frame's own row for an operation of the block in focus", () => {
    const graph = around("app/api");
    expect(drawnAt(graph, { path: "app/api", entry: "sendMessage" })).toEqual({ key: WAY_IN, entry: "sendMessage" });
    // A block the focus is inside has nothing drawn for it until a run reaches it.
    expect(drawnAt(around("app/api/messaging"), { path: "app/api", entry: "sendMessage" })).toBeNull();
  });

  it("draws a block the focus is inside as a frame once a run reaches it", () => {
    const graph = around("app/api/messaging", [], ["app/api"]);
    const frame = graph.nodes.get("ctx:app/api")!;
    expect(frame.boundary).toBe(true);
    expect(frame.context!.side).toBe("left");
    expect(drawnAt(graph, { path: "app/api", entry: "sendMessage" })).toEqual({ key: "ctx:app/api", entry: null });
    // It is what everything here is part of, so no dependency is drawn to it.
    expect([...graph.accesses.values()].map((link) => link.target)).not.toContain("ctx:app/api");
  });

  it("gives a group of parts a frame only when a run reaches it", () => {
    expect(around("app/api/messaging").nodes.has(WAY_IN)).toBe(false);
    expect(around("app/api/messaging", [], ["app/api/messaging"]).nodes.get(WAY_IN)?.sublabel).toBe("ITSELF");
  });
});

describe("a line too long for a block", () => {
  it("is folded rather than drawn across whatever sits to the right", () => {
    const long = "receipt: { title: string; dueInDays: number; message: string }";
    const folded = fitLine(long);

    expect(folded.length).toBeLessThan(long.length);
    expect(folded.endsWith("…")).toBe(true);
    expect(long.startsWith(folded.slice(0, -1))).toBe(true);
  });

  it("leaves a line that fits exactly as it was written", () => {
    expect(fitLine("isbn: string")).toBe("isbn: string");
  });
});
