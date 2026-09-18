import { db } from "../../infrastructure/db.js";

/** Keeps a message someone sent. */
export function saveMessage(from: string, to: string, text: string, now = Date.now()): string {
  const id = `m-${db.messages.size + 1}`;
  db.messages.set(id, { id, from, to, text, sentAt: now });
  return id;
}
