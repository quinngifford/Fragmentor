import { db } from "../infrastructure/db.js";

/** Every night, removes the sessions that have run out. */
export function cleanUpSessions(now: number): number {
  let removed = 0;
  for (const session of db.sessions.values()) {
    if (session.expiresAt <= now) {
      db.sessions.delete(session.id);
      removed += 1;
    }
  }
  return removed;
}
