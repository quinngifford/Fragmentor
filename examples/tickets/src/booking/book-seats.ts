import type { BookSeatsInput, BookSeatsOutput, BookSeatsCaps } from "../../blocks/tickets/booking-api/book-seats/contract.js";
import { findEvent } from "./find-event.js";
import { priceSeat } from "./price-seat.js";
import { reserve } from "./reserve.js";

/**
 * Book seats at one event for one person when there are enough left, and say
 * what happened.
 *
 * A request that cannot be met stops here: nothing is priced, written or
 * sent. Each seat is priced on its own, all at once.
 */
export async function bookSeats(input: BookSeatsInput, caps: BookSeatsCaps): Promise<BookSeatsOutput> {
  const { eventId, seats, email } = input;
  if (!Number.isInteger(seats) || seats < 1) return { booked: false, message: "Ask for at least one seat.", total: 0 };

  const { event } = await findEvent({ eventId }, caps);
  if (event === null) return { booked: false, message: "There is no such event.", total: 0 };
  if (event.seatsLeft < seats) {
    return { booked: false, message: `Sorry, only ${event.seatsLeft} left for ${event.name}.`, total: 0 };
  }

  const prices = await Promise.all(
    Array.from({ length: seats }, (_, index) => priceSeat({ fullPrice: event.price, seat: index + 1 }, caps)),
  );
  const total = prices.reduce((sum, each) => sum + each.price, 0);

  const { bookingId } = await reserve({ event, seats, email, total }, caps);
  return { booked: true, message: `Booked ${seats} for ${event.name}: booking ${bookingId}.`, total };
}
