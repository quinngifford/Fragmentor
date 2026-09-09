import type { RankResultsInput, RankResultsOutput, RankResultsCaps } from "./contract.js";

/** Combine postings with their scores and reasons and order them best first. */
export async function rankResults(input: RankResultsInput, caps: RankResultsCaps): Promise<RankResultsOutput> {
  throw new Error("Rank Results has no implementation yet.");
}
