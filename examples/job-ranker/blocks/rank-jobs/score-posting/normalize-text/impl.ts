import type { NormalizeTextInput, NormalizeTextOutput, NormalizeTextCaps } from "./contract.js";

/** Flatten a posting's title, company and description into comparable lowercase tokens. */
export async function normalizeText(input: NormalizeTextInput, caps: NormalizeTextCaps): Promise<NormalizeTextOutput> {
  throw new Error("Normalize Text has no implementation yet.");
}
