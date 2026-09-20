import type { PriceSeatInput, PriceSeatOutput, PriceSeatCaps } from "../../blocks/tickets/booking-api/pricing/price-seat/contract.js";

/** The seat from which a booking is cheaper, and by how much. */
const DISCOUNT_FROM = 5;
const DISCOUNT = 0.1;

/** Price one seat of a booking: the fifth seat onwards is ten percent off. */
export async function priceSeat(input: PriceSeatInput, caps: PriceSeatCaps): Promise<PriceSeatOutput> {
  return { price: input.seat >= DISCOUNT_FROM ? input.fullPrice * (1 - DISCOUNT) : input.fullPrice };
}
