import type { ClassifyTicketInput, ClassifyTicketOutput, ClassifyTicketCaps } from "./contract.js";

/** Words that put a ticket in one category, tried in this order. */
const CATEGORIES: [ClassifyTicketOutput["category"], string[]][] = [
  ["outage", ["down", "outage", "unavailable", "503", "cannot log in"]],
  ["billing", ["invoice", "charge", "refund", "billing", "payment"]],
  ["bug", ["error", "broken", "wrong", "crash", "bug"]],
];

/** Words that say the person is not willing to wait, whatever the ticket is about. */
const URGENT = ["urgent", "asap", "immediately", "critical", "blocked"];

/** Read what the agent typed and say what kind of ticket it is, and whether it sounds urgent. */
export async function classifyTicket(
  input: ClassifyTicketInput,
  caps: ClassifyTicketCaps,
): Promise<ClassifyTicketOutput> {
  const said = `${input.ticket.subject} ${input.ticket.body}`.toLowerCase();
  const found = CATEGORIES.find(([, words]) => words.some((word) => said.includes(word)));

  return {
    // Nothing recognised means somebody asking how to do something, which is
    // the least alarming thing a ticket can be.
    category: found ? found[0] : "howto",
    urgent: URGENT.some((word) => said.includes(word)),
  };
}
