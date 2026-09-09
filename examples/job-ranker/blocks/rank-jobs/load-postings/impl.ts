import type { LoadPostingsInput, LoadPostingsOutput, LoadPostingsCaps } from "./contract.js";

/** Read the postings file and parse it into structured postings. */
export async function loadPostings(input: LoadPostingsInput, caps: LoadPostingsCaps): Promise<LoadPostingsOutput> {
  throw new Error("Load Postings has no implementation yet.");
}
