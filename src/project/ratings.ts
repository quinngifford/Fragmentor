import type { Analytics, Dimension, Measure } from "./analytics.js";
import type { ProjectSnapshot } from "./snapshot.js";

/**
 * Ratings: a score from 0 to 100 for each category, by one rule of thumb
 * over one measurement each block already has, and the blocks ranked best
 * first. The rules are arbitrary on purpose, chosen by the person, stated
 * beside every ranking; the measurements they rest on are one click away.
 * A category nothing can be rated under says why, in the measure's words.
 */

export type Band = "good" | "fair" | "poor";

/** The least score of each band. */
export const BANDS = { good: 70, fair: 40 } as const;

export const BAND_WORDS: Record<Band, string> = { good: "Good", fair: "Fair", poor: "Poor" };

export interface BlockRating {
  path: string;
  name: string;
  score: number;
  band: Band;
  /** The measurement that rated it, in the measure's own words. */
  why: string;
}

export interface CategoryRating {
  id: string;
  name: string;
  /** The mean of its blocks' scores, or null when nothing could be rated. */
  score: number | null;
  band: Band | null;
  /** Why there is no score, when there is none. */
  unrated: string | null;
  /** The rule of thumb, stated. */
  rule: string;
  /** Best first. */
  blocks: BlockRating[];
}

export interface Ratings {
  systems: { root: string; name: string; categories: CategoryRating[] }[];
}

export function bandOf(score: number): Band {
  return score >= BANDS.good ? "good" : score >= BANDS.fair ? "fair" : "poor";
}

/** A straight line from 100 at `top` to 0 at `zero`, held at the ends. */
function line(value: number, top: number, zero: number): number {
  if (value <= top) return 100;
  if (value >= zero) return 0;
  return Math.round(100 - ((value - top) * 100) / (zero - top));
}

interface Rule {
  /** The measure the rule reads, by id, among the block's measures of the category. */
  measure: string;
  rule: string;
  /** Null when the block cannot be rated from its measures. */
  score: (own: Measure[]) => number | null;
}

const byId = (own: Measure[], id: string): Measure | undefined => own.find((measure) => measure.id === id && measure.unavailable === null && measure.value !== null);

const RULES: Record<string, Rule> = {
  coupling: {
    measure: "reaches",
    rule: "100 for a block that reaches one other block or none, 0 at eight or more, a straight line between.",
    score: (own) => {
      const reaches = byId(own, "reaches");
      return reaches === undefined ? null : line(reaches.value!, 1, 8);
    },
  },
  modularity: {
    measure: "kept-inside",
    rule: "The share of a block's parts' dependencies kept between them, as a percentage.",
    score: (own) => {
      const kept = byId(own, "kept-inside");
      return kept === undefined ? null : Math.round(kept.value! * 100);
    },
  },
  cohesion: {
    measure: "groups",
    rule: "100 when a block's parts form one group, 50 for two, 0 for three or more.",
    score: (own) => {
      const groups = byId(own, "groups");
      return groups === undefined ? null : line(groups.value!, 1, 3);
    },
  },
  complexity: {
    measure: "ways",
    rule: "100 at five ways through its busiest function or fewer, 0 at twenty or more, a straight line between.",
    score: (own) => {
      const ways = byId(own, "ways");
      return ways === undefined ? null : line(ways.value!, 5, 20);
    },
  },
  maintainability: {
    measure: "size",
    rule: "100 at twenty statements or fewer, 0 at a hundred and twenty or more, a straight line between.",
    score: (own) => {
      const size = byId(own, "size");
      return size === undefined ? null : line(size.value!, 20, 120);
    },
  },
  runtime: {
    measure: "runtime",
    rule: "100 at ten milliseconds or under for its slowest recorded call, 50 at a hundred, 0 at a second or more.",
    score: (own) => {
      const slowest = byId(own, "runtime");
      if (slowest === undefined || slowest.value! <= 0) return null;
      return Math.max(0, Math.min(100, Math.round(100 - 50 * Math.log10(slowest.value! / 10))));
    },
  },
  reliability: {
    measure: "held",
    rule: "50 for code held to its contract, up to 50 more for three saved tests, 25 off for each recorded call that threw.",
    score: (own) => {
      const held = byId(own, "held");
      if (held === undefined) return null;
      const tests = byId(own, "tests")?.value ?? 0;
      const threw = byId(own, "threw")?.value ?? 0;
      return Math.max(0, Math.min(100, Math.round(held.value! * 50 + (Math.min(tests, 3) / 3) * 50 - 25 * threw)));
    },
  },
  scalability: {
    measure: "shares",
    rule: "For a store, 100 when two blocks or fewer use it, 0 at eight or more, a straight line between.",
    score: (own) => {
      const shared = byId(own, "shares");
      return shared === undefined ? null : line(shared.value!, 2, 8);
    },
  },
};

/** The measurement behind a block's score, in the measure's own words: `reaches 4`, `held to a contract yes · saved tests 2`. */
function whyOf(dimension: Dimension, own: Measure[]): string {
  const ids = dimension.id === "reliability" ? ["held", "tests", "threw"] : [RULES[dimension.id]!.measure];
  return ids
    .map((id) => own.find((measure) => measure.id === id))
    .filter((measure): measure is Measure => measure !== undefined && measure.unavailable === null)
    .map((measure) => `${measure.label.toLowerCase()} ${measure.text}`)
    .join(" · ");
}

/** Why a category has no score: the system's own measure's words, or that no block has what it rates. */
function unratedOf(dimension: Dimension, root: string): string {
  const rule = RULES[dimension.id]!;
  const system = (dimension.system[root] ?? []).find((measure) => measure.id === rule.measure) ?? dimension.system[root]?.[0];
  if (system !== undefined && system.unavailable !== null) return system.unavailable;
  return "no block has what this rates";
}

export function ratingsOf(analytics: Analytics, snapshot: ProjectSnapshot): Ratings {
  return {
    systems: analytics.systems.map((system) => ({
      root: system.root,
      name: system.name,
      categories: analytics.dimensions.map((dimension) => {
        const rule = RULES[dimension.id]!;
        const blocks: BlockRating[] = [];
        for (const [path, own] of Object.entries(dimension.blocks)) {
          const block = snapshot.blocks[path];
          if (block === undefined || block.planned || !(path === system.root || path.startsWith(`${system.root}/`))) continue;
          const score = rule.score(own);
          if (score === null) continue;
          blocks.push({ path, name: block.name, score, band: bandOf(score), why: whyOf(dimension, own) });
        }
        blocks.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
        const score = blocks.length === 0 ? null : Math.round(blocks.reduce((sum, block) => sum + block.score, 0) / blocks.length);
        return {
          id: dimension.id,
          name: dimension.name,
          score,
          band: score === null ? null : bandOf(score),
          unrated: score === null ? unratedOf(dimension, system.root) : null,
          rule: rule.rule,
          blocks,
        };
      }),
    })),
  };
}
