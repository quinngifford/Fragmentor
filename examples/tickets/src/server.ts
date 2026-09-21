import type { Queue, Store } from "../blocks/capabilities.js";
import { bookSeats } from "./booking/book-seats.js";
import { cancelBooking } from "./booking/cancel-booking.js";

/**
 * The server that receives booking requests, which is not a block.
 *
 * `booking-api`'s own responsibility says as much: the code that takes real
 * requests lives outside the blocks. All it does is create the real
 * capabilities and hand each request to the block that answers it, which is
 * the one seam the whole model rests on — everything below this file is a
 * block Fragmentor checks and runs, and nothing above it is.
 */

interface Event {
  id: string;
  name: string;
  seatsLeft: number;
  price: number;
}

interface Booking {
  id: string;
  eventId: string;
  email: string;
  seats: number;
  total: number;
}

interface Confirmation {
  email: string;
  event: string;
  seats: number;
  total: number;
}

/** One table, kept in memory. A deployment would hand the blocks the real database instead. */
function table<Row>(rows: Record<string, Row>): Store<Row> {
  return {
    async read(key) {
      return rows[key] ?? null;
    },
    async list() {
      return Object.values(rows);
    },
    async write(key, row) {
      rows[key] = row;
    },
    async remove(key) {
      delete rows[key];
    },
  };
}

/** One channel. A deployment would put the messages on the real queue. */
function channel<Message>(sent: Message[]): Queue<Message> {
  return {
    async send(message) {
      sent.push(message);
    },
  };
}

export const events: Record<string, Event> = {
  gig: { id: "gig", name: "Night Gig", seatsLeft: 10, price: 25 },
};
export const bookings: Record<string, Booking> = {};
export const confirmations: Confirmation[] = [];

/** What every block in this system is handed when the server calls it. */
const caps = {
  events: table(events),
  bookings: table(bookings),
  confirmations: channel(confirmations),
};

export type Request =
  | { operation: "bookSeats"; body: { eventId: string; seats: number; email: string } }
  | { operation: "cancelBooking"; body: { bookingId: string } };

/** Hands one request to the block that answers it, and gives back what that block returned. */
export async function handle(request: Request): Promise<{ booked: boolean; message: string; total: number } | { refunded: number; message: string }> {
  if (request.operation === "bookSeats") return bookSeats(request.body, caps);
  return cancelBooking(request.body, caps);
}
