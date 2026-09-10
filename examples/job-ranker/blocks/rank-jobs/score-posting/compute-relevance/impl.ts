import type { ComputeRelevanceInput, ComputeRelevanceOutput, ComputeRelevanceCaps } from "./contract.js";

/** Turn keyword match counts into a relevance score and a short reason for each contribution. */
export async function computeRelevance(
  input: ComputeRelevanceInput,
  caps: ComputeRelevanceCaps,
): Promise<ComputeRelevanceOutput> {
  void caps;

  const hits = input.matches.filter((match) => match.count > 0);
  if (hits.length === 0) return { score: 0, reasons: ["No profile keywords appear in this posting."] };

  // Repeated mentions count for something, but with diminishing returns, so a
  // posting that says one word ten times cannot beat one that matches broadly.
  const raw = hits.reduce((total, match) => total + 1 + Math.log2(match.count), 0);
  const score = Math.round((raw / (input.matches.length || 1)) * 1000) / 1000;

  const reasons = hits
    .slice()
    .sort((a, b) => b.count - a.count || a.keyword.localeCompare(b.keyword))
    .map((match) => `${match.keyword} appears ${match.count} time${match.count === 1 ? "" : "s"}`);

  return { score, reasons };
}
