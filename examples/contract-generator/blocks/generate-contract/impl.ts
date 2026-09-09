import type { GenerateContractInput, GenerateContractOutput, GenerateContractCaps } from "./contract.js";

/** Produce the TypeScript contract source for one block from its ports, so the contract can never disagree with the diagram. */
export async function generateContract(input: GenerateContractInput, caps: GenerateContractCaps): Promise<GenerateContractOutput> {
  throw new Error("Generate Contract has no implementation yet.");
}
