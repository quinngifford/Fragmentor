import { handle } from "./server.js";

/**
 * The page someone books from, which is not a block either.
 *
 * `box-office` is a client on the diagram: it is not called, it calls. What it
 * offers are the two things a person can press, and each of them asks the
 * server for the operation the block diagram says it calls.
 */

/** What the page is showing, which is the whole of its state. */
export let showing = "Pick an event.";

/** Pressed once, when someone confirms how many seats they want. */
export async function onBookPressed(form: { eventId: string; seats: number; email: string }): Promise<string> {
  const answer = await handle({ operation: "bookSeats", body: form });
  showing = answer.message;
  return showing;
}

/** Pressed from the booking someone wants to give back. */
export async function onCancelPressed(bookingId: string): Promise<string> {
  const answer = await handle({ operation: "cancelBooking", body: { bookingId } });
  showing = answer.message;
  return showing;
}
