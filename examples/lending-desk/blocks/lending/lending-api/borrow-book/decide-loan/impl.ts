import type { DecideLoanInput, DecideLoanOutput, DecideLoanCaps } from "./contract.js";

/** How many books one member may have out at a time. */
const LIMIT = 5;

/** A title the library holds only one of goes out for a week rather than three. */
const SHORT_LOAN_DAYS = 7;
const ORDINARY_LOAN_DAYS = 21;

/** Say whether this member may take this book, and for how long. */
export async function decideLoan(input: DecideLoanInput, _caps: DecideLoanCaps): Promise<DecideLoanOutput> {
  const { book, member } = input;
  const refuse = (reason: string): DecideLoanOutput => ({ allowed: false, reason, dueInDays: 0 });

  if (member.suspended) return refuse("this membership is suspended");
  if (member.onLoan >= LIMIT) return refuse(`${LIMIT} books at a time is the limit, and ${member.onLoan} are already out`);
  if (book.copies - book.onLoan <= 0) return refuse("every copy of this one is already out");

  // One copy means everyone else is waiting for it.
  const single = book.copies === 1;
  return {
    allowed: true,
    reason: single ? "the library holds only one copy" : "",
    dueInDays: single ? SHORT_LOAN_DAYS : ORDINARY_LOAN_DAYS,
  };
}
