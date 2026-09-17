import type { Click, Link } from "./store.js";

/**
 * Clicks leave the request that caused them and are counted later, so they go
 * on a queue rather than into the database on the way through. `click-events`
 * is that queue.
 */
const pending: Click[] = [];

export function publishClick(link: Link, country: string, at: number): Click {
  const click: Click = { code: link.code, country, at };
  pending.push(click);
  return click;
}

/** Takes everything waiting, for whatever counts clicks. */
export function takePending(): Click[] {
  return pending.splice(0, pending.length);
}
