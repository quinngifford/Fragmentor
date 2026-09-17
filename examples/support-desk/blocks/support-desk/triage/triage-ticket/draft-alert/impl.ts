import type { DraftAlertInput, DraftAlertOutput, DraftAlertCaps } from "./contract.js";

/** Past this, whoever is on call should be woken rather than merely told. */
const WAKE_SOMEBODY = 80;

/** Write the one-line alert that goes out about this ticket. */
export async function draftAlert(input: DraftAlertInput, caps: DraftAlertCaps): Promise<DraftAlertOutput> {
  const mark = input.priority >= WAKE_SOMEBODY ? "!! " : "";
  return {
    alert: {
      headline: `${mark}${input.account.name}: ${input.ticket.subject}`,
      priority: input.priority,
      reason: input.reason,
    },
  };
}
