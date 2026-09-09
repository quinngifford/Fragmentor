import type { AssembleSourceInput, AssembleSourceOutput, AssembleSourceCaps } from "./contract.js";

/** Lay the rendered pieces out as a complete TypeScript file with its generated-file header. */
export async function assembleSource(input: AssembleSourceInput, caps: AssembleSourceCaps): Promise<AssembleSourceOutput> {
  throw new Error("Assemble Source has no implementation yet.");
}
