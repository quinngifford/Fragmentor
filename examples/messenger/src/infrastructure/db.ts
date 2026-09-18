export interface User {
  id: string;
  email: string;
  passwordHash: string;
}

export interface Session {
  id: string;
  userId: string;
  expiresAt: number;
}

export interface Message {
  id: string;
  from: string;
  to: string;
  text: string;
  sentAt: number;
}

/** The tables, as the rest of the code sees them. In production each is a PostgreSQL table behind a connection pool. */
export const db = {
  users: new Map<string, User>(),
  sessions: new Map<string, Session>(),
  messages: new Map<string, Message>(),
};
