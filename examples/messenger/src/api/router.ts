import { checkSession, logIn, logOut } from "./auth.js";
import { notifyRecipient } from "./messaging/notifyRecipient.js";
import { saveMessage } from "./messaging/saveMessage.js";

export type Request =
  | { path: "/messages"; sessionId: string; to: string; text: string }
  | { path: "/login"; email: string; password: string }
  | { path: "/logout"; sessionId: string };

export type Response = { status: number; body: Record<string, string> };

/** Sends each request to the part of the API that handles it, checking who is asking where that matters. */
export async function route(request: Request): Promise<Response> {
  switch (request.path) {
    case "/messages": {
      const from = checkSession(request.sessionId);
      if (!from) return { status: 401, body: { error: "Sign in first." } };
      const id = saveMessage(from, request.to, request.text);
      await notifyRecipient(request.to, id);
      return { status: 201, body: { id } };
    }
    case "/login":
      return { status: 200, body: { sessionId: logIn(request.email, request.password) } };
    case "/logout":
      return { status: 200, body: { redirect: logOut(request.sessionId) } };
  }
}
