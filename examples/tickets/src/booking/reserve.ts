import type { ReserveInput, ReserveOutput, ReserveCaps } from "../../blocks/tickets/booking-api/book-seats/reserve/contract.js";

/**
 * Take the seats off the event, record the booking, and send the confirmation.
 *
 * A booking is numbered by how many seats were left when it was made, so it
 * can be found again. Two bookings of one event cannot be given the same
 * number while its seats only go down, and cancelling one puts seats back, so
 * nothing here guarantees it for good.
 */
export async function reserve(input: ReserveInput, caps: ReserveCaps): Promise<ReserveOutput> {
  const { event, seats, email, total } = input;
  const bookingId = `${event.id}-${event.seatsLeft}`;

  await caps.events.write(event.id, { ...event, seatsLeft: event.seatsLeft - seats });
  await caps.bookings.write(bookingId, { id: bookingId, eventId: event.id, email, seats, total });
  await caps.confirmations.send({ email, event: event.name, seats, total });
  return { bookingId };
}
