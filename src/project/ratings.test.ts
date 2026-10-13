import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { analyticsOf } from "./analytics.js";
import type { Analytics } from "./analytics.js";
import { bandOf, BANDS, ratingsOf } from "./ratings.js";
import type { CategoryRating } from "./ratings.js";
import { projectSnapshot } from "./snapshot.js";
import type { ProjectSnapshot } from "./snapshot.js";

/**
 * The ratings are held to the Tickets example as Fragmentor really reads it:
 * every number below is what the rules give its measurements, so a rule or
 * a measurement that changes shows here first.
 */

const examples = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "examples");
let tickets: ProjectSnapshot;
let analytics: Analytics;

beforeAll(async () => {
  tickets = await projectSnapshot(path.join(examples, "tickets"));
  analytics = analyticsOf(tickets, { recordings: [], changes: { unavailable: null, commits: [], shallow: false } });
});

const category = (ratings: ReturnType<typeof ratingsOf>, id: string): CategoryRating => ratings.systems[0]!.categories.find((each) => each.id === id)!;
const ranked = (rating: CategoryRating) => rating.blocks.map((block) => [block.name, block.score]);

describe("the bands", () => {
  it("are good from 70, fair from 40, and poor below", () => {
    expect([bandOf(100), bandOf(BANDS.good), bandOf(69), bandOf(BANDS.fair), bandOf(39), bandOf(0)]).toEqual(["good", "good", "fair", "fair", "poor", "poor"]);
  });
});

describe("the rules on Tickets", () => {
  it("rates every category, in the dimensions' order, each with its rule stated", () => {
    const ratings = ratingsOf(analytics, tickets);
    expect(ratings.systems.map((system) => system.name)).toEqual(["Tickets"]);
    expect(ratings.systems[0]!.categories.map((each) => each.id)).toEqual(["coupling", "modularity", "cohesion", "complexity", "maintainability", "runtime", "reliability", "scalability"]);
    for (const each of ratings.systems[0]!.categories) expect(each.rule.length).toBeGreaterThan(20);
  });

  it("rates coupling by what a block reaches, best first, and leaves a planned block out", () => {
    const coupling = category(ratingsOf(analytics, tickets), "coupling");
    // A block that reaches nothing is 100; Book Seats reaches four blocks: 100 - 3 * 100/7, rounded.
    expect(ranked(coupling)[0]).toEqual(["Booking API", 100]);
    expect(ranked(coupling)).toContainEqual(["Box Office", 71]);
    expect(ranked(coupling).at(-1)).toEqual(["Book Seats", 57]);
    expect(coupling).toMatchObject({ score: 90, band: "good" });
    expect(coupling.blocks.every((block, index) => index === 0 || coupling.blocks[index - 1]!.score >= block.score)).toBe(true);
    expect(coupling.blocks.some((block) => block.name === "Reminders")).toBe(false);
    expect(coupling.blocks.find((block) => block.name === "Book Seats")!.why).toBe("reaches 4");
    expect(coupling.score).not.toBeNull();
    expect(coupling.band).toBe(bandOf(coupling.score!));
  });

  it("rates modularity by the share kept inside, cohesion by the groups, and complexity by the ways through", () => {
    const ratings = ratingsOf(analytics, tickets);
    expect(ranked(category(ratings, "modularity"))).toEqual([
      ["Tickets", 100],
      ["Booking API", 31],
      ["Pricing", 0],
    ]);
    expect(category(ratings, "modularity")).toMatchObject({ score: 44, band: "fair" });
    expect(ranked(category(ratings, "cohesion"))).toEqual([
      ["Booking API", 100],
      ["Tickets", 100],
      ["Pricing", 50],
    ]);
    expect(category(ratings, "cohesion")).toMatchObject({ score: 83, band: "good" });
    const complexity = category(ratings, "complexity");
    expect(complexity).toMatchObject({ score: 100, band: "good" });
    expect(complexity.blocks.every((block) => block.score === 100)).toBe(true);
    expect(complexity.blocks.find((block) => block.name === "Book Seats")!.why).toBe("ways through its code most 5, in bookSeats · 3 functions");
  });

  it("rates maintainability by size, reliability by contract and tests, and scalability by who shares a store", () => {
    const ratings = ratingsOf(analytics, tickets);
    expect(category(ratings, "maintainability")).toMatchObject({ score: 100, band: "good" });
    const reliability = category(ratings, "reliability");
    // Held to its contract, with two saved tests: 50 + 2/3 of 50.
    expect(reliability.blocks.find((block) => block.name === "Find Event")).toMatchObject({ score: 83, band: "good", why: "held to a contract yes · saved tests 2" });
    const scalability = category(ratings, "scalability");
    // Tickets Database is shared by five blocks: 100 - 3 * 100/6.
    expect(ranked(scalability)).toEqual([["Tickets Database", 50]]);
    expect(scalability).toMatchObject({ score: 50, band: "fair" });
    expect(scalability.blocks[0]!.why).toBe("shared by 5 blocks that cannot scale apart from it");
  });

  it("says why a category has no rating, in the measure's words, and gives it no colour", () => {
    const runtime = category(ratingsOf(analytics, tickets), "runtime");
    expect(runtime).toMatchObject({ score: null, band: null, blocks: [], unrated: "nothing has been recorded in this session: pick an execution above the drawing and press Record" });
    const noGit = category(ratingsOf(analyticsOf(tickets, { changes: { unavailable: "no git" } }), tickets), "maintainability");
    expect(noGit.score).toBe(100);
  });
});
