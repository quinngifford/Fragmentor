import { db } from "../infrastructure/db.js";

const DAY = 24 * 60 * 60 * 1000;

/** Says whose session this is, or that it is not a session at all. */
export function checkSession(sessionId: string, now = Date.now()): string | undefined {
  const session = db.sessions.get(sessionId);
  return session && session.expiresAt > now ? session.userId : undefined;
}

/** Checks an email and password and starts a session. */
export function logIn(email: string, password: string, now = Date.now()): string {
  const user = [...db.users.values()].find((each) => each.email === email);
  if (!user || user.passwordHash !== hash(password)) throw new Error("That email and password do not match.");
  const sessionId = `s-${db.sessions.size + 1}`;
  db.sessions.set(sessionId, { id: sessionId, userId: user.id, expiresAt: now + DAY });
  return sessionId;
}

/** Ends a session, and sends the page back to signing in. */
export function logOut(sessionId: string): string {
  db.sessions.delete(sessionId);
  return "/login";
}

function hash(password: string): string {
  return [...password].reverse().join("");
}
