import type { CheckMemberInput, CheckMemberOutput, CheckMemberCaps } from "./contract.js";

/** Find the member whose card was scanned. */
export async function checkMember(input: CheckMemberInput, caps: CheckMemberCaps): Promise<CheckMemberOutput> {
  const member = await caps.members.read(input.memberId);
  if (!member) throw new Error(`No member has the card number ${input.memberId}.`);
  return { member };
}
