import type { IssueLoanInput, IssueLoanOutput, IssueLoanCaps } from "./contract.js";

/**
 * Put the loan on the record and tell the member, when there is a loan to put.
 *
 * A refused request still passes through here, because the diagram has no way
 * to skip a block. It changes nothing and sends nothing; what is on the shelf
 * is reported either way, since the receipt says so.
 */
export async function issueLoan(input: IssueLoanInput, caps: IssueLoanCaps): Promise<IssueLoanOutput> {
  const { book, member, allowed, dueInDays } = input;
  if (!allowed) return { copiesLeft: book.copies - book.onLoan };

  await caps.books.write(book.isbn, { ...book, onLoan: book.onLoan + 1 });
  await caps.notices.send({ memberId: member.id, title: book.title, dueInDays });
  return { copiesLeft: book.copies - book.onLoan - 1 };
}
