import type { ScorePostingInput, ScorePostingOutput, ScorePostingCaps } from "./contract.js";
import { normalizeText } from "./normalize-text/impl.js";
import { matchKeywords } from "./match-keywords/impl.js";
import { computeRelevance } from "./compute-relevance/impl.js";

/** Score a single posting against the profile keywords and explain the score. */
export async function scorePosting(input: ScorePostingInput, caps: ScorePostingCaps): Promise<ScorePostingOutput> {
  const { posting, keywords } = input;

  const { tokens } = await normalizeText({ posting }, caps);
  const { matches } = await matchKeywords({ tokens, keywords }, caps);
  const { score, reasons } = await computeRelevance({ matches }, caps);

  return { score, reasons };
}
