import type { ScorePriorityInput, ScorePriorityOutput, ScorePriorityCaps } from "./contract.js";

/** What each kind of ticket is worth before anything else is taken into account. */
const BY_CATEGORY: Record<ScorePriorityInput["category"], number> = {
  outage: 60,
  billing: 30,
  bug: 25,
  howto: 10,
};

/** What the customer is paying for, which decides how much the rest counts. */
const BY_PLAN: Record<string, number> = { enterprise: 30, pro: 15, free: 0 };

/** A customer already waiting on several tickets is kept from sinking further. */
const PER_OPEN_TICKET = 3;
const MOST_FROM_WAITING = 15;

/** Turn the customer's account and the kind of ticket into one number, and say how it got there. */
export async function scorePriority(input: ScorePriorityInput, caps: ScorePriorityCaps): Promise<ScorePriorityOutput> {
  const fromCategory = BY_CATEGORY[input.category];
  const fromPlan = BY_PLAN[input.account.plan] ?? 0;
  const fromWaiting = Math.min(input.account.openTickets * PER_OPEN_TICKET, MOST_FROM_WAITING);
  const fromUrgency = input.urgent ? 20 : 0;

  const parts = [
    `${input.category} is worth ${fromCategory}`,
    `${input.account.plan} adds ${fromPlan}`,
    `${input.account.openTickets} already open adds ${fromWaiting}`,
  ];
  if (input.urgent) parts.push(`called urgent adds ${fromUrgency}`);

  return {
    priority: Math.min(fromCategory + fromPlan + fromWaiting + fromUrgency, 100),
    reason: parts.join(", "),
  };
}
