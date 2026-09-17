import type { LoadAccountInput, LoadAccountOutput, LoadAccountCaps } from "./contract.js";

/** Find one customer's account among the accounts we keep. */
export async function loadAccount(input: LoadAccountInput, caps: LoadAccountCaps): Promise<LoadAccountOutput> {
  const account = await caps.accounts.read(input.accountId);
  if (!account) throw new Error(`There is no account "${input.accountId}".`);
  return { account };
}
