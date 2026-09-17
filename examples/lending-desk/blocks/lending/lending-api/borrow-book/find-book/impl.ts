import type { FindBookInput, FindBookOutput, FindBookCaps } from "./contract.js";

/** Find the book that was scanned. */
export async function findBook(input: FindBookInput, caps: FindBookCaps): Promise<FindBookOutput> {
  const book = await caps.books.read(input.isbn);
  if (!book) throw new Error(`No book in this library has the ISBN ${input.isbn}.`);
  return { book };
}
