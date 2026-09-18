import type { RefundForInput, RefundForOutput, RefundForCaps } from "./contract.js";

/** What is kept back for each seat when a booking is cancelled. */
const FEE_PER_SEAT = 2;

/** Say how much of a cancelled booking comes back: all of it, less a fee for each seat. */
export async function refundFor(input: RefundForInput, caps: RefundForCaps): Promise<RefundForOutput> {
  return { refund: Math.max(0, input.total - FEE_PER_SEAT * input.seats) };
}
