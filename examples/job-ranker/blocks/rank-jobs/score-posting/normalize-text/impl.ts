import type { NormalizeTextInput, NormalizeTextOutput, NormalizeTextCaps } from "./contract.js";

/** Flatten a posting's title, company and description into comparable lowercase tokens. */
export async function normalizeText(input: NormalizeTextInput, caps: NormalizeTextCaps): Promise<NormalizeTextOutput> {
  void caps;

  const combined = [input.posting.title, input.posting.company, input.posting.description].join(" ");
  const tokens = combined
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    // A dot is kept so that node.js survives, which means sentence-ending
    // dots have to be trimmed or "typescript." would never match "typescript".
    .map((token) => token.replace(/^[.]+|[.]+$/g, ""))
    .filter((token) => token.length > 1);

  return { tokens };
}
