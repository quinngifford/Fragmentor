/**
 * The tables this service keeps, and the queries it runs against them.
 *
 * Stands in for a real database so the example is self-contained: the shapes
 * are what matter, and they are what `links-db` draws as its schema.
 */

export interface Link {
  code: string;
  url: string;
  owner: string;
  createdAt: number;
}

export interface Click {
  code: string;
  country: string;
  at: number;
}

const links = new Map<string, Link>();

export function insertLink(link: Link): void {
  links.set(link.code, link);
}

export function findLink(code: string): Link | undefined {
  return links.get(code);
}

export function countLinksFor(owner: string): number {
  let total = 0;
  for (const link of links.values()) if (link.owner === owner) total += 1;
  return total;
}
