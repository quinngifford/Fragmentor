import type { WriteReceiptInput, WriteReceiptOutput, WriteReceiptCaps } from "./contract.js";

/**
 * Turn what the desk worked out into the one thing the kiosk shows.
 *
 * This block exists so that the API's response and this request path are the
 * same shape. Everything above it produces facts; only here are they turned
 * into a sentence somebody reads, which keeps that decision on the diagram
 * rather than in whatever code answers the request.
 */
export async function writeReceipt(input: WriteReceiptInput, _caps: WriteReceiptCaps): Promise<WriteReceiptOutput> {
  const { book, allowed, reason, dueInDays, copiesLeft } = input;

  const shelf = `${copiesLeft} left on the shelf`;
  const message = allowed
    ? `Enjoy "${book.title}". Back in ${dueInDays} days${reason ? `, because ${reason}` : ""} — ${shelf}.`
    : `Sorry, not this time: ${reason} — ${shelf}.`;

  return { receipt: { title: book.title, dueInDays, message } };
}
