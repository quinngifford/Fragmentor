import { route } from "../api/router.js";
import { showMessage } from "./ui/chatView.js";

export type Action =
  | { type: "send"; to: string; text: string }
  | { type: "logIn"; email: string; password: string }
  | { type: "logOut" }
  | { type: "received"; from: string; text: string };

/** What the page shows, and who is signed in on it. */
export const state = { sessionId: "", screen: "login" as "login" | "chat", lines: [] as string[] };

/**
 * Holds what the page shows, sends each thing the person asks for to the API,
 * and takes in messages pushed to the page. The request stands in for fetch.
 */
export async function dispatch(action: Action): Promise<void> {
  switch (action.type) {
    case "send": {
      const response = await route({ path: "/messages", sessionId: state.sessionId, to: action.to, text: action.text });
      if (response.status === 201) state.lines.push(showMessage({ from: "you", text: action.text }));
      return;
    }
    case "logIn": {
      const response = await route({ path: "/login", email: action.email, password: action.password });
      state.sessionId = response.body.sessionId ?? "";
      state.screen = "chat";
      return;
    }
    case "logOut":
      await route({ path: "/logout", sessionId: state.sessionId });
      state.sessionId = "";
      state.screen = "login";
      return;
    case "received":
      state.lines.push(showMessage({ from: action.from, text: action.text }));
  }
}
