import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { projectSnapshot } from "../../src/project/snapshot.js";
import { accessEnds, autoLayout, buildGraph, entryLines, measure } from "./graph.js";
import type { Graph } from "./graph.js";
import { ui, viewSettings } from "./state.js";
import type { StoresAt } from "./state.js";

/**
 * The diagram the canvas draws, without drawing it.
 *
 * Everything here is decided before a single element is created: which blocks
 * appear, which access lines are gathered up from inside them, which resource
 * has to be brought in from a diagram further out, and where it all lands.
 * Those are the parts worth holding still; whether the result looks right is
 * a person's judgement, and the self-check's screenshots are for that.
 */

const linkShortener = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "examples",
  "link-shortener",
);

/** Everything one block reaches, named once however many lines run to it. */
function reachedBy(graph: Graph, source: string): string[] {
  const targets = [...graph.accesses.values()].filter((link) => link.source === source).map((link) => link.target);
  return [...new Set(targets)].sort();
}

/** The canvas is handed a snapshot and nothing else, so that is all a test needs. */
async function open(view: string, storesAt: StoresAt = "kept"): Promise<Graph> {
  ui.snapshot = await projectSnapshot(linkShortener);
  ui.view = view;
  viewSettings.storesAt = storesAt;
  const graph = buildGraph(view);
  if (!graph) throw new Error(`${view} has no diagram.`);
  return graph;
}

describe("the whole application, drawn", () => {
  let graph: Graph;
  beforeAll(async () => {
    graph = await open("link-shortener");
  });

  it("draws every part of the system, each as the thing it is", () => {
    expect([...graph.nodes.keys()]).toEqual(["browser", "api", "links-db", "click-events", "geo-lookup"]);
    expect(graph.nodes.get("links-db")!.sublabel).toBe("DATABASE");
    // Nothing calls a geolocation provider yet, so that one is still a plan.
    expect(graph.nodes.get("geo-lookup")!.sublabel).toBe("PLANNED");
    // Nothing is handed from one of these to the next, so there are no wires.
    expect(graph.signals).toEqual([]);
  });

  it("gathers what the handlers inside the service reach, so the top level shows it", () => {
    expect(reachedBy(graph, "browser")).toEqual(["api"]);
    // The service itself declares none of these; the blocks inside it do.
    expect(reachedBy(graph, "api")).toEqual(["click-events", "geo-lookup", "links-db"]);
  });

  it("keeps a read and a write to one database as two lines, each its own way round", () => {
    const between = [...graph.accesses.values()].filter((link) => link.source === "api" && link.target === "links-db");

    expect(between.map((link) => `${link.verb} ${link.direction}`).sort()).toEqual(["reads in", "writes out"]);
    for (const link of between) expect(link.fromWithin).toBe(true);
  });

  it("shows a table as its columns", () => {
    const [links] = graph.nodes.get("links-db")!.exposes;
    expect(entryLines(links!)).toEqual([
      "code: string",
      "url: string",
      "owner: string",
      "createdAt: number",
    ]);
  });

  it("reads left to right, from whoever starts the system to what it calls", () => {
    const placed = autoLayout(graph);

    // The browser calls the API, and the API calls the geolocation service,
    // so the calls run along the diagram in the order they happen.
    expect(placed.get("browser")!.x).toBeLessThan(placed.get("api")!.x);
    expect(placed.get("api")!.x).toBeLessThan(placed.get("geo-lookup")!.x);
  });

  it("keeps the data structures under what reaches them, not further along it", () => {
    const placed = autoLayout(graph);
    const api = placed.get("api")!;
    const apiBottom = api.y + measure(graph.nodes.get("api")!).height;

    // A store is not a step in the flow: the API reads and writes it in the
    // same breath, so putting it further right would say something untrue
    // about when it happens.
    for (const key of ["links-db", "click-events"]) {
      expect(placed.get(key)!.y, key).toBeGreaterThanOrEqual(apiBottom);
    }
    // The queue is where a click ends up, but the system's answer goes back
    // to the browser, so the queue is not the far end of the diagram.
    expect(placed.get("click-events")!.x).toBeLessThan(placed.get("geo-lookup")!.x);
  });

  it("loops a store clockwise: out of the right, down, and back into the left", () => {
    const placed = autoLayout(graph);
    const api = placed.get("api")!;
    const write = graph.accesses.get("api=>links-db:writes")!;
    const read = graph.accesses.get("api=>links-db:reads")!;

    const out = accessEnds(graph, placed, write)!;
    const back = accessEnds(graph, placed, read)!;

    // What the API writes leaves its right edge; what it reads arrives on its
    // left, the same way its ports would be drawn.
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

describe("inside the service", () => {
  let graph: Graph;
  beforeAll(async () => {
    graph = await open("link-shortener/api", "everywhere");
  });

  it("brings in a resource that lives outside this diagram, and says so", () => {
    // links-db sits beside the service, so nothing here lists it as a child;
    // asked for on every level it is drawn anyway, or the handlers that read
    // it would point at nothing.
    const database = graph.nodes.get("links-db")!;
    expect(database.referenced).toBe(true);
    expect(graph.nodes.get("create-link")!.referenced).toBe(false);
  });

  it("shows what a request path reaches, gathered from the blocks inside it", () => {
    // create-link touches the database itself; follow-link does not, but the
    // three blocks inside it touch all three resources.
    expect(reachedBy(graph, "create-link")).toEqual(["links-db"]);
    expect(reachedBy(graph, "follow-link")).toEqual(["click-events", "geo-lookup", "links-db"]);
  });

  it("marks an access the block itself declared apart from one gathered from inside", () => {
    const own = [...graph.accesses.values()].find((link) => link.source === "create-link")!;
    const gathered = [...graph.accesses.values()].find((link) => link.source === "follow-link")!;
    expect(own.fromWithin).toBe(false);
    expect(gathered.fromWithin).toBe(true);
  });

  it("draws no line from a block to the one whose diagram this is", () => {
    // Looking outward reaches the service the handlers are inside, so an
    // access naming it resolves; drawing it would be a line to the frame
    // around everything else. The checks refuse it; the canvas ignores it.
    ui.snapshot!.blocks["link-shortener/api/create-link"]!.access = [
      {
        text: "calls api.createLink",
        verb: "calls",
        resource: "api",
        resourcePath: "link-shortener/api",
        resourceName: "Link API",
        entry: "createLink",
      },
    ];

    const redrawn = buildGraph("link-shortener/api")!;
    expect([...redrawn.accesses.values()].map((link) => link.target)).not.toContain("api");
    expect(redrawn.nodes.has("api")).toBe(false);
  });
});

describe("which diagram a store is drawn on", () => {
  it("draws it where it is kept, and leaves the diagrams under that to their own work", async () => {
    // The database is a child of the application, so the application's own
    // diagram is where it belongs, and nothing under it borrows it.
    const top = await open("link-shortener", "kept");
    expect(top.nodes.has("links-db")).toBe(true);

    const service = await open("link-shortener/api", "kept");
    expect(service.nodes.has("links-db")).toBe(false);
    expect([...service.nodes.keys()]).toEqual(["create-link", "follow-link"]);
  });

  it("draws it on every level when every level should say where its data comes from", async () => {
    const service = await open("link-shortener/api", "everywhere");
    expect(service.nodes.get("links-db")!.referenced).toBe(true);
    expect(reachedBy(service, "follow-link")).toContain("links-db");
  });

  it("draws it beside the block that truly touches it, and nowhere else", async () => {
    const service = await open("link-shortener/api", "used");
    // create-link says so itself; follow-link only contains a block that does.
    expect(reachedBy(service, "create-link")).toEqual(["links-db"]);
    expect(reachedBy(service, "follow-link")).toEqual([]);

    // And the level above says nothing at all, because nothing there declares it.
    const top = await open("link-shortener", "used");
    expect([...top.accesses.values()].map((link) => link.target)).toEqual(["api"]);
  });
});

describe("inside the request path", () => {
  let graph: Graph;
  beforeAll(async () => {
    graph = await open("link-shortener/api/follow-link", "everywhere");
  });

  it("keeps the handlers' own wires, which are still ordinary wires", () => {
    expect(graph.signals.map((signal) => `${signal.source}.${signal.sourcePort}`).sort()).toEqual([
      "input.code",
      "input.ip",
      "input.now",
      "locate-visitor.country",
      "resolve-link.link",
      "resolve-link.link",
      "record-click.click",
    ].sort());
  });

  it("reaches three resources, every one of them from further out", () => {
    const targets = [...graph.accesses.values()].map((link) => `${link.source}->${link.target}`).sort();
    expect(targets).toEqual([
      "locate-visitor->geo-lookup",
      "record-click->click-events",
      "resolve-link->links-db",
    ]);
    for (const key of ["links-db", "geo-lookup", "click-events"]) {
      expect(graph.nodes.get(key)!.referenced).toBe(true);
    }
  });
});
