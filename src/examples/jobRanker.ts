import type { Proposal } from "../ai/decompose.js";
import type { Block } from "../model/block.js";
import type { Manifest } from "../project/project.js";
import { parseType } from "../model/typeExpression.js";

/**
 * A worked example used both as the end-to-end test fixture and to generate
 * the sample project under `examples/`.
 *
 * It is small enough to read in one sitting but exercises the parts of the
 * model that are easy to get wrong: a capability flowing down from the root,
 * a child invoked once per item so its wires change arity, a source feeding
 * two different destinations, and a second level of decomposition.
 */

export const jobRankerManifest: Manifest = {
  name: "Job Relevance Ranker",
  goal:
    "Read job postings from a local file, score each one against a candidate profile, and return them ordered from most to least relevant with a short explanation for each score.",
  systems: [
    { rootBlock: "rank-jobs", language: "typescript" },
    { rootBlock: "embed-postings", language: "python" },
  ],
  granularity: { level: 3, maxDepth: 4 },
};

/** The one block a user writes by hand before the AI takes over. */
export const rankJobsSeed: Block = {
  id: "rank-jobs",
  name: "Rank Jobs",
  responsibility:
    "Read job postings from a file and return them ordered by how well they match a candidate profile, with reasons.",
  kind: "leaf",
  inputs: {
    sourcePath: { type: parseType("string"), description: "File holding the postings to rank." },
    profile: { type: parseType("{ skills: string[] }"), description: "The candidate to rank against." },
  },
  outputs: {
    ranked: {
      type: parseType("{ title: string; company: string; score: number; reasons: string[] }[]"),
      description: "Best match first.",
    },
  },
  capabilities: {
    files: { capability: "FileSystem", description: "Reads the postings file." },
  },
  children: [],
  wires: [],
  pinnedAsLeaf: false,
};

export const rankJobsProposal: Proposal = {
  reasoning:
    "Loading and keyword extraction are independent, so they happen first. Scoring is per posting, so it runs once for each. Ranking needs the original postings as well as the scores, so the loaded postings feed both the scorer and the final ranking step.",
  children: [
    {
      id: "load-postings",
      name: "Load Postings",
      responsibility: "Read the postings file and parse it into structured postings.",
      inputs: { path: { type: "string" } },
      outputs: { postings: { type: "{ title: string; company: string; description: string }[]" } },
      capabilities: { files: { capability: "FileSystem" } },
      likelyLeaf: true,
    },
    {
      id: "extract-profile-keywords",
      name: "Extract Profile Keywords",
      responsibility: "Reduce a candidate profile to the lowercase keywords worth matching against.",
      inputs: { profile: { type: "{ skills: string[] }" } },
      outputs: { keywords: { type: "string[]" } },
      likelyLeaf: true,
    },
    {
      id: "score-posting",
      name: "Score Posting",
      responsibility: "Score a single posting against the profile keywords and explain the score.",
      inputs: {
        posting: { type: "{ title: string; company: string; description: string }" },
        keywords: { type: "string[]" },
      },
      outputs: { score: { type: "number" }, reasons: { type: "string[]" } },
      mode: "each",
      eachOver: "posting",
      likelyLeaf: false,
    },
    {
      id: "rank-results",
      name: "Rank Results",
      responsibility: "Combine postings with their scores and reasons and order them best first.",
      inputs: {
        postings: { type: "{ title: string; company: string; description: string }[]" },
        scores: { type: "number[]" },
        reasons: { type: "string[][]" },
      },
      outputs: { ranked: { type: "{ title: string; company: string; score: number; reasons: string[] }[]" } },
      likelyLeaf: true,
    },
  ],
  wires: [
    { from: "input.sourcePath", to: "load-postings.path" },
    { from: "input.profile", to: "extract-profile-keywords.profile" },
    { from: "load-postings.postings", to: "score-posting.posting" },
    { from: "extract-profile-keywords.keywords", to: "score-posting.keywords" },
    { from: "load-postings.postings", to: "rank-results.postings" },
    { from: "score-posting.score", to: "rank-results.scores" },
    { from: "score-posting.reasons", to: "rank-results.reasons" },
    { from: "rank-results.ranked", to: "output.ranked" },
  ],
};

export const scorePostingProposal: Proposal = {
  reasoning:
    "Turning the posting into comparable tokens, counting keyword matches, and turning counts into a score with an explanation are three separate concerns that are each worth testing on their own.",
  children: [
    {
      id: "normalize-text",
      name: "Normalize Text",
      responsibility: "Flatten a posting's title, company and description into comparable lowercase tokens.",
      inputs: { posting: { type: "{ title: string; company: string; description: string }" } },
      outputs: { tokens: { type: "string[]" } },
      likelyLeaf: true,
    },
    {
      id: "match-keywords",
      name: "Match Keywords",
      responsibility: "Count how often each profile keyword appears in the posting's tokens.",
      inputs: { tokens: { type: "string[]" }, keywords: { type: "string[]" } },
      outputs: { matches: { type: "{ keyword: string; count: number }[]" } },
      likelyLeaf: true,
    },
    {
      id: "compute-relevance",
      name: "Compute Relevance",
      responsibility: "Turn keyword match counts into a relevance score and a short reason for each contribution.",
      inputs: { matches: { type: "{ keyword: string; count: number }[]" } },
      outputs: { score: { type: "number" }, reasons: { type: "string[]" } },
      likelyLeaf: true,
    },
  ],
  wires: [
    { from: "input.posting", to: "normalize-text.posting" },
    { from: "normalize-text.tokens", to: "match-keywords.tokens" },
    { from: "input.keywords", to: "match-keywords.keywords" },
    { from: "match-keywords.matches", to: "compute-relevance.matches" },
    { from: "compute-relevance.score", to: "output.score" },
    { from: "compute-relevance.reasons", to: "output.reasons" },
  ],
};


/**
 * A second system in the same project, in a different language.
 *
 * It is not connected to the ranker and never will be: separate systems are
 * separate programs that happen to be worked on together. Embedding is the
 * kind of work that belongs in Python, which is the point of it being here.
 */
export const embedPostingsSeed: Block = {
  id: "embed-postings",
  name: "Embed Postings",
  responsibility: "Turn job postings into vectors so they can be compared by similarity.",
  kind: "leaf",
  inputs: {
    postings: { type: parseType("{ title: string; description: string }[]") },
    modelName: { type: parseType("string"), description: "Which embedding model to use." },
  },
  outputs: {
    vectors: { type: parseType("number[][]"), description: "One vector per posting, in the same order." },
  },
  capabilities: {
    log: { capability: "Logger", description: "Reports progress through a long batch." },
  },
  children: [],
  wires: [],
  pinnedAsLeaf: false,
};

export const embedPostingsProposal: Proposal = {
  reasoning:
    "Cleaning a posting into embeddable text and calling the model are separate concerns with different failure modes, and both run once per posting.",
  children: [
    {
      id: "clean-text",
      name: "Clean Text",
      responsibility: "Flatten one posting into the plain text that should be embedded.",
      inputs: { posting: { type: "{ title: string; description: string }" } },
      outputs: { text: { type: "string" } },
      mode: "each",
      eachOver: "posting",
      likelyLeaf: true,
    },
    {
      id: "embed-text",
      name: "Embed Text",
      responsibility: "Turn one piece of text into a vector using the named model.",
      inputs: { text: { type: "string" }, modelName: { type: "string" } },
      outputs: { vector: { type: "number[]" } },
      capabilities: { log: { capability: "Logger" } },
      mode: "each",
      eachOver: "text",
      likelyLeaf: true,
    },
  ],
  wires: [
    { from: "input.postings", to: "clean-text.posting" },
    { from: "clean-text.text", to: "embed-text.text" },
    { from: "input.modelName", to: "embed-text.modelName" },
    { from: "embed-text.vector", to: "output.vectors" },
  ],
};
