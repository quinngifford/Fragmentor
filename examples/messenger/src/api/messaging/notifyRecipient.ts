import { publish } from "../../infrastructure/queue.js";

/** Puts a notification on the queue, so the recipient hears about it without the sender waiting. */
export async function notifyRecipient(to: string, messageId: string): Promise<void> {
  await publish({ to, messageId });
}
