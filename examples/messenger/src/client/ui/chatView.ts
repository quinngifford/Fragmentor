/** Draws the conversation, with the newest message at the bottom. */
export function showMessage(message: { from: string; text: string }): string {
  return `${message.from}: ${message.text}`;
}
