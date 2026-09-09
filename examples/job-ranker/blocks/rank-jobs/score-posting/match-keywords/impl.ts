import type { MatchKeywordsInput, MatchKeywordsOutput, MatchKeywordsCaps } from "./contract.js";

/** Count how often each profile keyword appears in the posting's tokens. */
export async function matchKeywords(input: MatchKeywordsInput, caps: MatchKeywordsCaps): Promise<MatchKeywordsOutput> {
  throw new Error("Match Keywords has no implementation yet.");
}
