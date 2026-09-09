import type { ComputeRelevanceInput, ComputeRelevanceOutput, ComputeRelevanceCaps } from "./contract.js";

/** Turn keyword match counts into a relevance score and a short reason for each contribution. */
export async function computeRelevance(input: ComputeRelevanceInput, caps: ComputeRelevanceCaps): Promise<ComputeRelevanceOutput> {
  throw new Error("Compute Relevance has no implementation yet.");
}
