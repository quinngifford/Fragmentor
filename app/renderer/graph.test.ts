import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { projectSnapshot } from "../../src/project/snapshot.js";
import { autoLayout, buildGraph, entryLines, measure } from "./graph.js";
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

  it("gathers what the handlers inside the service reach, so the top level shows it", () => {
    const from = (source: string) =>
      [...graph.accesses.values()].filter((link) => link.source === source).map((link) => link.target);

    expect(from("browser")).toEqual(["api"]);
    // The service itself declares none of these; the blocks inside it do.
    expect(from("api").sort()).toEqual(["click-events", "geo-lookup", "links-db"]);

    const toDatabase = [...graph.accesses.values()].find((link) => link.source === "api" && link.target === "links-db")!;
    expect(toDatabase.fromWithin).toBe(true);
    expect(toDatabase.entries.map((entry) => entry.text).sort()).toEqual([
      "reads links-db.links",
      "writes links-db.links",
    ]);
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

  it("reads left to right, from whoever starts the system to what is behind it", () => {
    const placed = autoLayout(graph);
    const column = (key: string) => placed.get(key)!.x;

    expect(column("browser")).toBeLessThan(column("api"));
    expect(column("api")).toBeLessThan(column("links-db"));
    // Everything the service reaches stands together, one step behind it.
    expect(column("links-db")).toBe(column("click-events"));
    expect(column("links-db")).toBe(column("geo-lookup"));
  });

  it("leaves no two blocks on top of each other", () => {
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

  it("brings in a resource that lives outside this diagram, and says so", () => {
    // links-db sits beside the service, so nothing here lists it as a child;
    // it is drawn anyway, or the handlers that read it would point at nothing.
    const database = graph.nodes.get("links-db")!;
    expect(database.referenced).toBe(true);
    expect(graph.nodes.get("create-link")!.referenced).toBe(false);
  });

  it("shows what a request path reaches, gathered from the blocks inside it", () => {
    const from = (source: string) =>
      [...graph.accesses.values()].filter((link) => link.source === source).map((link) => link.target).sort();

    // create-link touches the database itself; follow-link does not, but the
    // three blocks inside it touch all three resources.
    expect(from("create-link")).toEqual(["links-db"]);
    expect(from("follow-link")).toEqual(["click-events", "geo-lookup", "links-db"]);
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
