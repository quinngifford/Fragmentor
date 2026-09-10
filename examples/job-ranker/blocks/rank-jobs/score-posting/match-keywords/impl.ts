import type { MatchKeywordsInput, MatchKeywordsOutput, MatchKeywordsCaps } from "./contract.js";

/** Count how often each profile keyword appears in the posting's tokens. */
export async function matchKeywords(input: MatchKeywordsInput, caps: MatchKeywordsCaps): Promise<MatchKeywordsOutput> {
  void caps;

  const counts = new Map<string, number>();
  for (const token of input.tokens) counts.set(token, (counts.get(token) ?? 0) + 1);

  return { matches: input.keywords.map((keyword) => ({ keyword, count: counts.get(keyword) ?? 0 })) };
}
