import { dispatch } from "../state.js";

/** Hands the message someone has written to the page's state when they press send. */
export async function onSendPressed(to: string, text: string): Promise<void> {
  await dispatch({ type: "send", to, text });
}
