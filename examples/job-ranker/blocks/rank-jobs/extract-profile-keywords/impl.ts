import type {
  ExtractProfileKeywordsInput,
  ExtractProfileKeywordsOutput,
  ExtractProfileKeywordsCaps,
} from "./contract.js";

/** Reduce a candidate profile to the lowercase keywords worth matching against. */
export async function extractProfileKeywords(
  input: ExtractProfileKeywordsInput,
  caps: ExtractProfileKeywordsCaps,
): Promise<ExtractProfileKeywordsOutput> {
  void caps;

  const seen = new Set<string>();
  for (const skill of input.profile.skills) {
    for (const raw of skill.toLowerCase().split(/[^a-z0-9+#.]+/)) {
      // Dots are kept inside a word so node.js survives, but a trailing one
      // would stop the keyword ever matching.
      const word = raw.replace(/^[.]+|[.]+$/g, "");
      // Single letters match far too much to be worth scoring.
      if (word.length > 1) seen.add(word);
    }
  }

  return { keywords: [...seen].sort() };
}
