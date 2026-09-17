import { publishClick } from "./events.js";
import { lookupCountry } from "./geo.js";
import { countLinksFor, findLink, insertLink } from "./store.js";
import type { Click, Link } from "./store.js";

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

/**
 * One visit to a short link: find where it goes, work out where the visitor
 * came from, and put the click on the queue to be counted later. Nothing comes
 * back when the code is not one we handed out.
 *
 * This is the request path `follow-link` stands for on the diagram, and the
 * only thing that calls the three blocks drawn inside it.
 */
export function followLink(code: string, ip: string, now: number): { link: Link; click: Click } | undefined {
  const link = resolveLink(code);
  if (link === undefined) return undefined;

  const country = lookupCountry(ip);
  const click = publishClick(link, country, now);
  return { link, click };
}
