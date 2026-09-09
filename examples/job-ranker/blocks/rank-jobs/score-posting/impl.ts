import type { ScorePostingInput, ScorePostingOutput, ScorePostingCaps } from "./contract.js";

/** Score a single posting against the profile keywords and explain the score. */
export async function scorePosting(input: ScorePostingInput, caps: ScorePostingCaps): Promise<ScorePostingOutput> {
  throw new Error("Score Posting has no implementation yet.");
}
