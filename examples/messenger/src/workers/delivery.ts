import { dispatch } from "../client/state.js";
import { db } from "../infrastructure/db.js";
import { subscribe } from "../infrastructure/queue.js";
import type { Notification } from "../infrastructure/queue.js";

/**
 * Takes a notification off the queue and pushes the message to the
 * recipient's page, if they have one open. The push stands in for a socket.
 */
export async function deliverNotification(notification: Notification): Promise<void> {
  const message = db.messages.get(notification.messageId);
  const open = [...db.sessions.values()].some((session) => session.userId === notification.to);
  if (message && open) await dispatch({ type: "received", from: message.from, text: message.text });
}

subscribe(deliverNotification);
