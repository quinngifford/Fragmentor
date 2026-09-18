import type { FindEventInput, FindEventOutput, FindEventCaps } from "./contract.js";

/** Find the event someone asked about, or say there is none. */
export async function findEvent(input: FindEventInput, caps: FindEventCaps): Promise<FindEventOutput> {
  return { event: await caps.events.read(input.eventId) };
}
