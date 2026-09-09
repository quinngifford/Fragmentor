import type { RankJobsInput, RankJobsOutput, RankJobsCaps } from "./contract.js";

/** Read job postings from a file and return them ordered by how well they match a candidate profile, with reasons. */
export async function rankJobs(input: RankJobsInput, caps: RankJobsCaps): Promise<RankJobsOutput> {
  throw new Error("Rank Jobs has no implementation yet.");
}
