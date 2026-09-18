import type { CancelBookingInput, CancelBookingOutput, CancelBookingCaps } from "./contract.js";
import { findEvent } from "../find-event/impl.js";
import { refundFor } from "../pricing/refund-for/impl.js";

/** Cancel one booking, put its seats back on sale, and say how much is refunded. */
export async function cancelBooking(input: CancelBookingInput, caps: CancelBookingCaps): Promise<CancelBookingOutput> {
  const booking = await caps.bookings.read(input.bookingId);
  if (booking === null) return { refunded: 0, message: "There is no such booking." };

  const { event } = await findEvent({ eventId: booking.eventId }, caps);
  const { refund } = await refundFor({ total: booking.total, seats: booking.seats }, caps);

  // The seats go back on sale, if the event is still there to sell them.
  if (event !== null) await caps.events.write(event.id, { ...event, seatsLeft: event.seatsLeft + booking.seats });
  await caps.bookings.remove(booking.id);
  return { refunded: refund, message: `Cancelled booking ${booking.id}: ${refund} is on its way back.` };
}
