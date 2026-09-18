import { dispatch } from "../state.js";

/** Asks for an email and password, and hands them to the page's state. */
export async function onLogInSubmitted(email: string, password: string): Promise<void> {
  await dispatch({ type: "logIn", email, password });
}
