import type { RankResultsInput, RankResultsOutput, RankResultsCaps } from "./contract.js";

/** Combine postings with their scores and reasons and order them best first. */
export async function rankResults(input: RankResultsInput, caps: RankResultsCaps): Promise<RankResultsOutput> {
  void caps;

  if (input.scores.length !== input.postings.length || input.reasons.length !== input.postings.length) {
    throw new Error(
      `Got ${input.postings.length} postings but ${input.scores.length} scores and ${input.reasons.length} sets of reasons.`,
    );
  }

  const ranked = input.postings.map((posting, i) => ({
    title: posting.title,
    company: posting.company,
    score: input.scores[i] ?? 0,
    reasons: input.reasons[i] ?? [],
  }));

  ranked.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return { ranked };
}
