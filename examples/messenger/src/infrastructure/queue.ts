export interface Notification {
  to: string;
  messageId: string;
}

type Handler = (notification: Notification) => Promise<void>;
const handlers: Handler[] = [];

/** Puts a notification on the queue. In production this is a message broker, and the workers run apart. */
export async function publish(notification: Notification): Promise<void> {
  for (const handle of handlers) await handle(notification);
}

export function subscribe(handle: Handler): void {
  handlers.push(handle);
}
