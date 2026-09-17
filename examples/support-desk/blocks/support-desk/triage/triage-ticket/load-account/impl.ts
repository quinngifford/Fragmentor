import type { LoadAccountInput, LoadAccountOutput, LoadAccountCaps } from "./contract.js";

/** Find one customer's account in the accounts file. */
export async function loadAccount(input: LoadAccountInput, caps: LoadAccountCaps): Promise<LoadAccountOutput> {
  const rows = JSON.parse(await caps.files.readFile(input.path)) as LoadAccountOutput["account"][];
  const account = rows.find((row) => row.id === input.accountId);
  if (!account) throw new Error(`There is no account "${input.accountId}" in ${input.path}.`);
  return { account };
}
