import { countLinksFor, findLink, insertLink } from "./store.js";
import type { Link } from "./store.js";

/** How many links one owner may keep, so the example has a rule worth reading. */
const PER_OWNER_LIMIT = 100;

export function createLink(url: string, code: string, owner: string, now: number): Link {
  if (countLinksFor(owner) >= PER_OWNER_LIMIT) {
    throw new Error(`${owner} already has ${PER_OWNER_LIMIT} links.`);
  }
  const link: Link = { code, url, owner, createdAt: now };
  insertLink(link);
  return link;
}

export function resolveLink(code: string): Link | undefined {
  return findLink(code);
}
