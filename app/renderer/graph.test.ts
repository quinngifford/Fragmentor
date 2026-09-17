import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { projectSnapshot } from "../../src/project/snapshot.js";
import { accessEnds, autoLayout, buildGraph, entryLines, exposedRow, fitLine, measure } from "./graph.js";
import type { Graph } from "./graph.js";
import { ui } from "./state.js";

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
async function open(view: string): Promise<Graph> {
  ui.snapshot = await projectSnapshot(linkShortener);
  ui.view = view;
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

  it("joins a button to the operation it triggers, not the block it is in", () => {
    const fromBrowser = [...graph.accesses.values()].filter((link) => link.source === "browser");

    // Two buttons calling two operations are two lines, each naming both ends.
    expect(fromBrowser.map((link) => `${link.from} -> ${link.entries[0]!.entry}`).sort()).toEqual([
      "follow -> followLink",
      "shorten -> createLink",
    ]);

    // And each meets the rows it names rather than the edges of the boxes.
    const placed = autoLayout(graph);
    const shorten = fromBrowser.find((link) => link.from === "shorten")!;
    const follow = fromBrowser.find((link) => link.from === "follow")!;
    const first = accessEnds(graph, placed, shorten)!;
    const second = accessEnds(graph, placed, follow)!;

    expect(first.from.y).toBeLessThan(second.from.y);
    expect(first.to.y).toBeLessThan(second.to.y);
    expect(first.from.y).toBe(placed.get("browser")!.y + exposedRow(graph.nodes.get("browser")!, "shorten")!);
    expect(first.to.y).toBe(placed.get("api")!.y + exposedRow(graph.nodes.get("api")!, "createLink")!);
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
    graph = await open("link-shortener/api");
  });

  it("shows the blocks that are there, and nothing kept on another level", () => {
    // Every store this service touches is kept beside the service, not in it,
    // so its own diagram is the two handlers and the way into them.
    expect([...graph.nodes.keys()].sort()).toEqual(["create-link", "follow-link", "input"]);
  });

  it("draws the way in: each operation, and the block that answers it", () => {
    // Without this the handlers show inputs arriving from nowhere, because
    // the call that feeds them is the one thing the diagram does not say.
    const wayIn = [...graph.accesses.values()].filter((link) => link.source === "input");
    expect(wayIn.map((link) => `${link.entries[0]!.entry} -> ${link.target}`).sort()).toEqual([
      "createLink -> create-link",
      "followLink -> follow-link",
    ]);

    const boundary = graph.nodes.get("input")!;
    expect(boundary.boundary).toBe(true);
    expect(boundary.exposes.map((entry) => entry.name).sort()).toEqual(["createLink", "followLink"]);
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

describe("inside the request path", () => {
  let graph: Graph;
  beforeAll(async () => {
    graph = await open("link-shortener/api/follow-link");
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
