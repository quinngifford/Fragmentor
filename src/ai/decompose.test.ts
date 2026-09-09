import { describe, expect, it } from "vitest";
import { buildBlocksFromProposal, proposeDecomposition } from "./decompose.js";
import type { Proposal } from "./decompose.js";
import { ScriptedModelClient } from "./modelClient.js";
import { makeBlock } from "../model/testing.js";
import { parseType } from "../model/typeExpression.js";
import type { Block } from "../model/block.js";
import type { Granularity } from "../project/project.js";

const granularity: Granularity = { level: 3, maxDepth: 4 };

function parent(): Block {
  return makeBlock({
    id: "rank-jobs",
    name: "Rank Jobs",
    responsibility: "Rank job postings by how well they match a profile.",
    inputs: {
      postings: { type: parseType("{ title: string; description: string }[]") },
      profile: { type: parseType("{ skills: string[] }") },
    },
    outputs: { ranked: { type: parseType("{ title: string; score: number }[]") } },
  });
}

/** A decomposition that satisfies every rule. */
function goodProposal(): Proposal {
  return {
    reasoning: "Pull the profile apart once, score each posting against it, then order the results.",
    children: [
      {
        id: "extract-keywords",
        name: "Extract Keywords",
        responsibility: "Reduce a profile to the keywords worth matching against.",
        inputs: { profile: { type: "{ skills: string[] }" } },
        outputs: { keywords: { type: "string[]" } },
        likelyLeaf: true,
      },
      {
        id: "score-posting",
        name: "Score Posting",
        responsibility: "Score one posting against the keywords.",
        inputs: {
          posting: { type: "{ title: string; description: string }" },
          keywords: { type: "string[]" },
        },
        outputs: { scored: { type: "{ title: string; score: number }" } },
        mode: "each",
        eachOver: "posting",
        likelyLeaf: true,
      },
      {
        id: "sort-by-score",
        name: "Sort By Score",
        responsibility: "Order the scored postings from best to worst.",
        inputs: { scored: { type: "{ title: string; score: number }[]" } },
        outputs: { ranked: { type: "{ title: string; score: number }[]" } },
        likelyLeaf: false,
      },
    ],
    wires: [
      { from: "input.profile", to: "extract-keywords.profile" },
      { from: "input.postings", to: "score-posting.posting" },
      { from: "extract-keywords.keywords", to: "score-posting.keywords" },
      { from: "score-posting.scored", to: "sort-by-score.scored" },
      { from: "sort-by-score.ranked", to: "output.ranked" },
    ],
  };
}

const errorsOf = (diagnostics: { severity: string; message: string }[]) =>
  diagnostics.filter((d) => d.severity === "error").map((d) => d.message);

describe("buildBlocksFromProposal", () => {
  it("turns a sound proposal into a composite and its children", () => {
    const result = buildBlocksFromProposal(parent(), goodProposal());

    expect(errorsOf(result.diagnostics)).toEqual([]);
    expect(result.parent.kind).toBe("composite");
    expect(result.children.map((c) => c.id)).toEqual(["extract-keywords", "score-posting", "sort-by-score"]);
    expect(result.parent.children).toContainEqual({ block: "score-posting", mode: "each", eachOver: "posting" });
    expect(result.parent.wires).toHaveLength(5);
  });

  it("understands that an iterated child sends and receives arrays", () => {
    // score-posting takes a single posting and returns a single scored item,
    // yet is wired to an array input and an array consumer. That only
    // validates because mode "each" adjusts the arity on its wires.
    const result = buildBlocksFromProposal(parent(), goodProposal());
    const scorer = result.children.find((c) => c.id === "score-posting")!;

    expect(scorer.inputs.posting!.type).toEqual(parseType("{ title: string; description: string }"));
    expect(errorsOf(result.diagnostics)).toEqual([]);
  });

  it("adds capabilities the work turned out to need", () => {
    const proposal = goodProposal();
    proposal.children[0]!.capabilities = { model: { capability: "Model" } };
    proposal.addedParentCapabilities = { model: { capability: "Model", description: "Used to expand keywords." } };

    const result = buildBlocksFromProposal(parent(), proposal);
    expect(errorsOf(result.diagnostics)).toEqual([]);
    expect(result.parent.capabilities.model).toEqual({ capability: "Model", description: "Used to expand keywords." });
  });

  it("catches a child needing a capability nobody supplies", () => {
    const proposal = goodProposal();
    proposal.children[0]!.capabilities = { model: { capability: "Model" } };

    const result = buildBlocksFromProposal(parent(), proposal);
    expect(errorsOf(result.diagnostics)).toContain(
      '"extract-keywords" needs the capability "model" (Model), but "Rank Jobs" does not declare it.',
    );
  });

  it("rejects a child that would collide with how wires name the parent", () => {
    const proposal = goodProposal();
    proposal.children[0]!.id = "input";

    const result = buildBlocksFromProposal(parent(), proposal);
    expect(errorsOf(result.diagnostics)).toContain(
      '"input" cannot be used as a block id because it is how wires refer to the parent\'s own ports.',
    );
  });

  it("rejects duplicate child ids", () => {
    const proposal = goodProposal();
    proposal.children[1]!.id = "extract-keywords";

    expect(errorsOf(buildBlocksFromProposal(parent(), proposal).diagnostics)).toContain(
      'Two children were both given the id "extract-keywords".',
    );
  });

  it("reports a type it cannot read, naming the port", () => {
    const proposal = goodProposal();
    proposal.children[0]!.outputs = { keywords: { type: "Array<Keyword>" } };

    expect(errorsOf(buildBlocksFromProposal(parent(), proposal).diagnostics)).toContainEqual(
      expect.stringContaining('The output "keywords" of "extract-keywords" has a type that could not be read'),
    );
  });

  it("reports a wire endpoint that is not written properly", () => {
    const proposal = goodProposal();
    proposal.wires[0] = { from: "profile", to: "extract-keywords.profile" };

    expect(errorsOf(buildBlocksFromProposal(parent(), proposal).diagnostics)).toContain(
      'The wire source "profile" is not written as "input.port" or "child-id.port".',
    );
  });

  it("rejects a wire that runs backwards out of a parent output", () => {
    const proposal = goodProposal();
    proposal.wires.push({ from: "output.ranked", to: "sort-by-score.scored" });

    expect(errorsOf(buildBlocksFromProposal(parent(), proposal).diagnostics)).toContain(
      'A wire cannot start at "output.ranked"; the parent\'s outputs are destinations, not sources.',
    );
  });

  it("catches a mismatch between what a child produces and what the next expects", () => {
    const proposal = goodProposal();
    proposal.children[2]!.inputs = { scored: { type: "string[]" } };

    expect(errorsOf(buildBlocksFromProposal(parent(), proposal).diagnostics)).toContainEqual(
      expect.stringContaining("Type mismatch"),
    );
  });
});

describe("proposeDecomposition", () => {
  it("returns a clean result on the first try", async () => {
    const client = new ScriptedModelClient([JSON.stringify(goodProposal())]);
    const result = await proposeDecomposition({
      parent: parent(),
      projectGoal: "Rank job postings.",
      blockPath: "rank-jobs",
      granularity,
      depth: 0,
      client,
    });

    expect(result.attempts).toBe(1);
    expect(errorsOf(result.diagnostics)).toEqual([]);
    expect(result.furtherDecomposition).toEqual(["sort-by-score"]);
  });

  it("feeds the problems back and accepts the corrected proposal", async () => {
    const broken = goodProposal();
    broken.children[2]!.inputs = { scored: { type: "string[]" } };

    const client = new ScriptedModelClient([JSON.stringify(broken), JSON.stringify(goodProposal())]);
    const result = await proposeDecomposition({
      parent: parent(),
      projectGoal: "Rank job postings.",
      blockPath: "rank-jobs",
      granularity,
      depth: 0,
      client,
    });

    expect(result.attempts).toBe(2);
    expect(errorsOf(result.diagnostics)).toEqual([]);

    // The second request must actually carry the problem, or the retry is
    // just rerolling the dice.
    const followUp = client.requests[1]!;
    expect(followUp.messages).toHaveLength(3);
    expect(followUp.messages[2]!.content).toContain("Type mismatch");
  });

  it("gives up after the attempt limit and hands back what it had", async () => {
    const broken = goodProposal();
    broken.children[2]!.inputs = { scored: { type: "string[]" } };
    const responses = [broken, broken, broken].map((p) => JSON.stringify(p));

    const client = new ScriptedModelClient(responses);
    const result = await proposeDecomposition({
      parent: parent(),
      projectGoal: "Rank job postings.",
      blockPath: "rank-jobs",
      granularity,
      depth: 0,
      client,
      maxAttempts: 3,
    });

    expect(result.attempts).toBe(3);
    expect(errorsOf(result.diagnostics).length).toBeGreaterThan(0);
    expect(client.requests).toHaveLength(3);
  });

  it("retries when the response is not readable at all, then reports clearly", async () => {
    const client = new ScriptedModelClient(["not json", "{}"]);

    await expect(
      proposeDecomposition({
        parent: parent(),
        projectGoal: "Rank job postings.",
        blockPath: "rank-jobs",
        granularity,
        depth: 0,
        client,
        maxAttempts: 2,
      }),
    ).rejects.toThrow(/could not be read after 2 attempts/);

    expect(client.requests).toHaveLength(2);
  });

  it("tells the model when its children have to be plain code", async () => {
    const client = new ScriptedModelClient([JSON.stringify(goodProposal())]);
    await proposeDecomposition({
      parent: parent(),
      projectGoal: "Rank job postings.",
      blockPath: "a/b/c",
      granularity: { level: 3, maxDepth: 4 },
      depth: 3,
      client,
    });

    expect(client.requests[0]!.messages[0]!.content).toContain("must be implementable as plain code");
  });
});
