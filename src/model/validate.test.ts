import { describe, expect, it } from "vitest";
import { executionOrder, validateComposite } from "./validate.js";
import type { Diagnostic } from "./validate.js";
import { makeBlock, t } from "./testing.js";
import type { Block } from "./block.js";

const errors = (d: Diagnostic[]) => d.filter((x) => x.severity === "error").map((x) => x.message);
const warnings = (d: Diagnostic[]) => d.filter((x) => x.severity === "warning").map((x) => x.message);

/** A posting is scored, then the scores are summarised. */
function straightLine(): { parent: Block; children: Map<string, Block> } {
  const score = makeBlock({
    id: "score-posting",
    inputs: { posting: { type: t.object({ title: t.string }) } },
    outputs: { score: { type: t.number } },
  });

  const label = makeBlock({
    id: "label-score",
    inputs: { score: { type: t.number } },
    outputs: { label: { type: t.string } },
  });

  const parent = makeBlock({
    id: "rank-posting",
    kind: "composite",
    inputs: { posting: { type: t.object({ title: t.string }) } },
    outputs: { label: { type: t.string } },
    children: [
      { block: "score-posting", mode: "once" },
      { block: "label-score", mode: "once" },
    ],
    wires: [
      { source: { from: "input", port: "posting" }, target: { to: "block", block: "score-posting", port: "posting" } },
      {
        source: { from: "block", block: "score-posting", port: "score" },
        target: { to: "block", block: "label-score", port: "score" },
      },
      { source: { from: "block", block: "label-score", port: "label" }, target: { to: "output", port: "label" } },
    ],
  });

  return { parent, children: new Map([[score.id, score], [label.id, label]]) };
}

describe("validateComposite", () => {
  it("accepts a well-formed straight-line composite", () => {
    const { parent, children } = straightLine();
    expect(validateComposite(parent, children)).toEqual([]);
  });

  it("accepts a child run once per item, treating its wires as arrays", () => {
    const score = makeBlock({
      id: "score-posting",
      inputs: { posting: { type: t.object({ title: t.string }) }, weight: { type: t.number } },
      outputs: { score: { type: t.number } },
    });

    const parent = makeBlock({
      id: "score-all",
      kind: "composite",
      inputs: { postings: { type: t.array(t.object({ title: t.string })) }, weight: { type: t.number } },
      outputs: { scores: { type: t.array(t.number) } },
      children: [{ block: "score-posting", mode: "each", eachOver: "posting" }],
      wires: [
        // The iterated port carries an array; other inputs are broadcast as-is.
        {
          source: { from: "input", port: "postings" },
          target: { to: "block", block: "score-posting", port: "posting" },
        },
        { source: { from: "input", port: "weight" }, target: { to: "block", block: "score-posting", port: "weight" } },
        { source: { from: "block", block: "score-posting", port: "score" }, target: { to: "output", port: "scores" } },
      ],
    });

    expect(validateComposite(parent, new Map([[score.id, score]]))).toEqual([]);
  });

  it("rejects feeding a whole array to a child that runs once", () => {
    const score = makeBlock({
      id: "score-posting",
      inputs: { posting: { type: t.object({ title: t.string }) } },
      outputs: { score: { type: t.number } },
    });

    const parent = makeBlock({
      id: "score-all",
      kind: "composite",
      inputs: { postings: { type: t.array(t.object({ title: t.string })) } },
      outputs: { score: { type: t.number } },
      children: [{ block: "score-posting", mode: "once" }],
      wires: [
        {
          source: { from: "input", port: "postings" },
          target: { to: "block", block: "score-posting", port: "posting" },
        },
        { source: { from: "block", block: "score-posting", port: "score" }, target: { to: "output", port: "score" } },
      ],
    });

    expect(errors(validateComposite(parent, new Map([[score.id, score]])))).toEqual([
      expect.stringContaining("Type mismatch"),
    ]);
  });

  it("reports a wire whose types do not line up", () => {
    const { parent, children } = straightLine();
    children.set("label-score", makeBlock({ id: "label-score", inputs: { score: { type: t.string } }, outputs: { label: { type: t.string } } }));

    expect(errors(validateComposite(parent, children))).toEqual([
      expect.stringContaining("the source carries number but the destination expects string"),
    ]);
  });

  it("reports a child block that does not exist", () => {
    const { parent, children } = straightLine();
    children.delete("label-score");

    const found = errors(validateComposite(parent, children));
    expect(found).toContain('"rank-posting" refers to a child block "label-score" that does not exist.');
  });

  it("refuses a child whose id is how wires name the parent's own ports", () => {
    const { parent, children } = straightLine();
    parent.children.push({ block: "input", mode: "once" });
    children.set("input", makeBlock({ id: "input" }));

    expect(errors(validateComposite(parent, children))).toContain(
      '"rank-posting" has a child called "input", but that id is reserved: wires use "input.<port>" for the parent\'s own ports.',
    );
  });

  it("refuses a child with its parent's own id, whose names would clash with the parent's", () => {
    const { parent, children } = straightLine();
    parent.children.push({ block: "rank-posting", mode: "once" });
    children.set("rank-posting", makeBlock({ id: "rank-posting" }));

    expect(errors(validateComposite(parent, children))).toContainEqual(
      expect.stringContaining('has a child with its own id, "rank-posting"'),
    );
  });

  it("refuses children for a block the person pinned as a leaf", () => {
    const { parent, children } = straightLine();
    parent.pinnedAsLeaf = true;

    expect(errors(validateComposite(parent, children))).toContain(
      '"rank-posting" is pinned as a leaf, but it has been given children. Make it a leaf again, or set "pinnedAsLeaf" to false if the person agrees.',
    );
  });

  it("reports an input that nothing is connected to", () => {
    const { parent, children } = straightLine();
    parent.wires = parent.wires.filter((w) => !(w.target.to === "block" && w.target.port === "score"));

    expect(errors(validateComposite(parent, children))).toContain(
      'Nothing is connected to "label-score" input "score".',
    );
  });

  it("reports an input driven by more than one wire", () => {
    const { parent, children } = straightLine();
    parent.wires.push({
      source: { from: "block", block: "score-posting", port: "score" },
      target: { to: "block", block: "label-score", port: "score" },
    });

    expect(errors(validateComposite(parent, children))).toContain(
      '"label-score" input "score" is driven by 2 wires; it can only accept one.',
    );
  });

  it("reports an output that nothing produces", () => {
    const { parent, children } = straightLine();
    parent.outputs.extra = { type: t.string };

    expect(errors(validateComposite(parent, children))).toContain(
      'Nothing produces "rank-posting" output "extra".',
    );
  });

  it("requires the parent to supply every capability its children need", () => {
    const { parent, children } = straightLine();
    children.get("score-posting")!.capabilities = { http: { capability: "Http" } };

    expect(errors(validateComposite(parent, children))).toContain(
      '"score-posting" needs the capability "http" (Http), but "rank-posting" does not declare it.',
    );
  });

  it("reports a capability supplied with the wrong kind", () => {
    const { parent, children } = straightLine();
    children.get("score-posting")!.capabilities = { store: { capability: "Http" } };
    parent.capabilities = { store: { capability: "FileSystem" } };

    expect(errors(validateComposite(parent, children))).toContain(
      '"score-posting" needs "store" to be Http, but "rank-posting" supplies FileSystem.',
    );
  });

  it("reports blocks wired into a loop", () => {
    const a = makeBlock({ id: "a", inputs: { in: { type: t.number } }, outputs: { out: { type: t.number } } });
    const b = makeBlock({ id: "b", inputs: { in: { type: t.number } }, outputs: { out: { type: t.number } } });

    const parent = makeBlock({
      id: "looper",
      kind: "composite",
      outputs: { result: { type: t.number } },
      children: [{ block: "a", mode: "once" }, { block: "b", mode: "once" }],
      wires: [
        { source: { from: "block", block: "a", port: "out" }, target: { to: "block", block: "b", port: "in" } },
        { source: { from: "block", block: "b", port: "out" }, target: { to: "block", block: "a", port: "in" } },
        { source: { from: "block", block: "b", port: "out" }, target: { to: "output", port: "result" } },
      ],
    });

    expect(errors(validateComposite(parent, new Map([[a.id, a], [b.id, b]])))).toContain(
      "These blocks feed into each other in a loop, so there is no order to run them in: a -> b -> a.",
    );
  });

  it("warns about values that are produced but never used", () => {
    const { parent, children } = straightLine();
    children.get("score-posting")!.outputs.debug = { type: t.string };
    parent.inputs.unused = { type: t.string };

    const found = warnings(validateComposite(parent, children));
    expect(found).toContain('"score-posting" produces an output "debug" that nothing uses.');
    expect(found).toContain('"rank-posting" takes an input "unused" that nothing inside it uses.');
  });

  it("flags a leaf block that declares structure", () => {
    const leaf = makeBlock({ id: "leaf", children: [{ block: "x", mode: "once" }] });
    expect(errors(validateComposite(leaf, new Map()))).toEqual([
      '"leaf" is a leaf block but declares children or wires.',
    ]);
  });
});

describe("validateComposite in visual mode", () => {
  const visual = (parent: Block, children: Map<string, Block>) => validateComposite(parent, children, "visual");

  it("points out a missing wire without refusing the diagram", () => {
    const { parent, children } = straightLine();
    parent.wires = parent.wires.filter((w) => !(w.target.to === "block" && w.target.port === "score"));

    const found = visual(parent, children);
    expect(errors(found)).toEqual([]);
    expect(warnings(found)).toContain('Nothing is connected to "label-score" input "score".');
  });

  it("does not compare types, which are only text", () => {
    const { parent, children } = straightLine();
    children.set(
      "label-score",
      makeBlock({ id: "label-score", inputs: { score: { type: { kind: "text", text: "Score" } } }, outputs: { label: { type: t.string } } }),
    );
    expect(visual(parent, children)).toEqual([]);
  });

  it("accepts blocks that feed each other in a loop, as real code can", () => {
    const { parent, children } = straightLine();
    parent.wires.push({
      source: { from: "block", block: "label-score", port: "label" },
      target: { to: "block", block: "score-posting", port: "posting" },
    });
    expect(errors(visual(parent, children))).toEqual([]);
  });

  it("does not ask a block to pass its children's capabilities down", () => {
    const { parent, children } = straightLine();
    children.get("score-posting")!.capabilities = { db: { capability: "Database" } };
    expect(visual(parent, children)).toEqual([]);
  });

  it("still refuses a child that does not exist", () => {
    const { parent, children } = straightLine();
    children.delete("label-score");
    expect(errors(visual(parent, children))).toContain('"rank-posting" refers to a child block "label-score" that does not exist.');
  });
});

describe("executionOrder with a loop", () => {
  it("still lists every child, putting those caught in the loop last", () => {
    const children = [
      { block: "a", mode: "once" as const },
      { block: "b", mode: "once" as const },
      { block: "c", mode: "once" as const },
    ];
    const wires = [
      { source: { from: "block" as const, block: "b", port: "out" }, target: { to: "block" as const, block: "c", port: "in" } },
      { source: { from: "block" as const, block: "c", port: "out" }, target: { to: "block" as const, block: "b", port: "in" } },
    ];
    expect(executionOrder(children, wires)).toEqual(["a", "b", "c"]);
  });
});

describe("executionOrder", () => {
  it("orders blocks after the blocks that feed them", () => {
    const { parent } = straightLine();
    expect(executionOrder(parent.children, parent.wires)).toEqual(["score-posting", "label-score"]);
  });

  it("keeps declaration order when nothing forces an ordering", () => {
    const children = [
      { block: "c", mode: "once" as const },
      { block: "a", mode: "once" as const },
      { block: "b", mode: "once" as const },
    ];
    expect(executionOrder(children, [])).toEqual(["c", "a", "b"]);
  });

  it("puts a dependency first even when it is declared last", () => {
    const children = [
      { block: "consumer", mode: "once" as const },
      { block: "producer", mode: "once" as const },
    ];
    const wires = [
      {
        source: { from: "block" as const, block: "producer", port: "out" },
        target: { to: "block" as const, block: "consumer", port: "in" },
      },
    ];
    expect(executionOrder(children, wires)).toEqual(["producer", "consumer"]);
  });
});

describe("planned blocks", () => {
  /** The straight line again, with the block that labels a score not written yet. */
  function withPlan(): { parent: Block; children: Map<string, Block> } {
    const { parent, children } = straightLine();
    children.set(
      "label-score",
      makeBlock({
        id: "label-score",
        planned: true,
        // Words rather than types, and a port nothing reaches: both are the
        // point of drawing a block before deciding what is in it.
        inputs: { score: { type: t.text("a score of some kind") }, weight: { type: t.text("not decided") } },
        outputs: { label: { type: t.text("something to show") }, colour: { type: t.text("not decided") } },
        capabilities: { clock: { capability: "Clock" } },
      }),
    );
    return { parent, children };
  }

  it("asks nothing of one: not its types, not its wiring, not its capabilities", () => {
    const { parent, children } = withPlan();
    expect(validateComposite(parent, children)).toEqual([]);
  });

  it("would report every one of those things if the block were real", () => {
    const { parent, children } = withPlan();
    children.set("label-score", makeBlock({ ...children.get("label-score")!, planned: false }));
    const found = errors(validateComposite(parent, children));
    expect(found).toContain('Nothing is connected to "label-score" input "weight".');
    expect(found.some((message) => /Type mismatch/.test(message))).toBe(true);
    expect(found.some((message) => /needs the capability "clock"/.test(message))).toBe(true);
  });

  it("still checks everything around it", () => {
    const { parent, children } = withPlan();
    parent.wires = parent.wires.filter((wire) => wire.target.to !== "block" || wire.target.block !== "score-posting");
    expect(errors(validateComposite(parent, children))).toEqual([
      'Nothing is connected to "score-posting" input "posting".',
    ]);
  });

  it("reports gaps inside a planned parent as worth knowing, not as errors", () => {
    const { parent, children } = straightLine();
    parent.planned = true;
    parent.wires = [];
    const found = validateComposite(parent, children);
    expect(errors(found)).toEqual([]);
    expect(warnings(found).length).toBeGreaterThan(0);
  });
});

describe("a composite holding a piece of the architecture", () => {
  const database = makeBlock({
    id: "orders-db",
    role: "database",
    exposes: { orders: { accepts: t.object({ id: t.string }), returns: t.object({ id: t.string }) } },
  });

  const handler = makeBlock({
    id: "load-orders",
    inputs: { owner: { type: t.string } },
    outputs: { orders: { type: t.array(t.object({ id: t.string })) } },
    access: [{ verb: "reads", resource: "orders-db", entry: "orders" }],
  });

  function service(): { parent: Block; children: Map<string, Block> } {
    const parent = makeBlock({
      id: "orders-api",
      role: "service",
      kind: "composite",
      exposes: { listOrders: { accepts: t.object({ owner: t.string }), returns: null } },
      children: [{ block: "load-orders", mode: "once" }],
    });
    return { parent, children: new Map([["load-orders", handler]]) };
  }

  it("says what to do instead when a wire is drawn to one", () => {
    const parent = makeBlock({
      id: "orders-api",
      kind: "composite",
      children: [
        { block: "load-orders", mode: "once" },
        { block: "orders-db", mode: "once" },
      ],
      wires: [
        {
          source: { from: "block", block: "orders-db", port: "orders" },
          target: { to: "block", block: "load-orders", port: "owner" },
        },
      ],
    });
    const children = new Map([
      ["load-orders", handler],
      ["orders-db", database],
    ]);

    expect(errors(validateComposite(parent, children))).toEqual([
      expect.stringContaining('A wire touches "orders-db", which is database rather than a function'),
    ]);
  });

  it("refuses to run one once per item", () => {
    const parent = makeBlock({
      id: "orders-api",
      kind: "composite",
      children: [{ block: "orders-db", mode: "each", eachOver: "orders" }],
    });

    expect(errors(validateComposite(parent, new Map([["orders-db", database]])))).toContainEqual(
      expect.stringContaining("cannot be run once per item"),
    );
  });

  it("expects nothing to be wired to a service's own children, which are reached from outside", () => {
    const { parent, children } = service();

    // `owner` arrives from the framework code that answers the request, which
    // lives outside blocks/ and is nothing the diagram can show.
    expect(validateComposite(parent, children)).toEqual([]);
  });

  it("drops an unwired input to a warning where no code is generated from it", () => {
    const parent = makeBlock({
      id: "orders",
      kind: "composite",
      children: [
        { block: "load-orders", mode: "once" },
        { block: "orders-db", mode: "once" },
      ],
    });
    const children = new Map([
      ["load-orders", handler],
      ["orders-db", database],
    ]);

    // Whether architecture sits beneath a block is the project's answer, not
    // something to be guessed from the children in hand, so it is passed in.
    const found = validateComposite(parent, children, "structured", true);
    expect(errors(found)).toEqual([]);
    expect(warnings(found)).toContainEqual(expect.stringContaining('Nothing is connected to "load-orders" input "owner"'));

    // The same diagram with code to generate is held to the strict rule.
    expect(errors(validateComposite(parent, children))).toContainEqual(
      expect.stringContaining('Nothing is connected to "load-orders" input "owner"'),
    );
  });

  it("still refuses two wires into one input, wherever the block sits", () => {
    const source = makeBlock({ id: "pick-owner", outputs: { owner: { type: t.string } } });
    const parent = makeBlock({
      id: "orders-api",
      role: "service",
      kind: "composite",
      children: [
        { block: "pick-owner", mode: "once" },
        { block: "load-orders", mode: "once" },
      ],
      wires: [
        { source: { from: "block", block: "pick-owner", port: "owner" }, target: { to: "block", block: "load-orders", port: "owner" } },
        { source: { from: "block", block: "pick-owner", port: "owner" }, target: { to: "block", block: "load-orders", port: "owner" } },
      ],
    });
    const children = new Map([
      ["pick-owner", source],
      ["load-orders", handler],
    ]);

    // Nothing being wired to a handler is normal inside a service; two things
    // wired to one port is a contradiction anywhere, because nothing says
    // which of them wins.
    expect(warnings(validateComposite(parent, children))).toContainEqual(
      expect.stringContaining('"load-orders" input "owner" is driven by 2 wires'),
    );
  });

  it("asks nothing of the capabilities it cannot pass down", () => {
    const { parent, children } = service();
    children.set("load-orders", makeBlock({ ...handler, capabilities: { log: { capability: "Logger" } } }));

    // A service is not generated, so it never hands `caps` to anything, and
    // requiring it to declare what it cannot pass on would be a false rule.
    expect(errors(validateComposite(parent, children))).toEqual([]);
  });
});
