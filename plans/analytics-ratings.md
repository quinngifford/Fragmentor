# Ratings on the Architecture Analytics window: plan

## What the person asked for (2026-10-12)
The measurements and their sentences are right but are not the first thing to see. The window should open on a dashboard: a rating for each of the eight categories, green = good and red = bad, and behind each a ranked list of the best and worst blocks. The detailed measurements stay, behind a click. Decisions taken with the person: a 0–100 score with a colour band; fixed rules of thumb, stated; the details behind each category.

## What changes
- **A pure module, `src/project/ratings.ts`**, turns an `Analytics` into ratings: per system, per category, a score 0–100 from one rule of thumb over one measure a block already has, the mean of its blocks as the category's score, and the blocks ranked best first with the measurement that rated each. Bands: 70 and over good (green), 40–69 fair (amber), under 40 poor (red). A category nothing can be rated under says why, in the measure's own words, and gets no colour. Planned blocks are not rated.
- **The rules**, each stated under its ranking and in the agent's print:
  - Coupling: 100 for a block that reaches one other block or none, 0 at eight or more.
  - Modularity: the share of a block's parts' dependencies kept between them, as a percentage.
  - Cohesion: 100 when a block's parts form one group, 50 for two, 0 for three or more.
  - Complexity: 100 at five ways through its busiest function or fewer, 0 at twenty or more.
  - Maintainability: 100 at twenty statements or fewer, 0 at a hundred and twenty or more.
  - Runtime performance: 100 at ten milliseconds or under for its slowest recorded call, 50 at a hundred, 0 at a second.
  - Reliability: 50 for code held to its contract, up to 50 more for three saved tests, 25 off for each recorded call that threw.
  - Scalability: for a store, 100 when two blocks or fewer use it, 0 at eight or more.
  Straight lines between the ends. All arbitrary, on purpose, and said so.
- **The window** opens on Weak spots, then eight rating cards. A card opens its ranked list under the grid, with the rule in one sentence and **Show the measurements**, which reveals today's section for that category. Not measured stays at the bottom when there is anything in it.
- **Each block's panel** shows the block's ratings as coloured pills, with **Show the measurements** revealing the lists it shows today. The exported page shows the same.
- **`fragmentor analytics`** prints Ratings after the weak spots: each category's score, band, best and worst block; a block's own view prints its ratings with the measurement behind each.
- **The website band** draws the dashboard instead of one measure's rows, with Tickets' real ratings.
- **The runtime measure on a block** carries its slowest call in milliseconds as its value, so the rule can read it.

## Affected
`src/project/ratings.ts` (new) and its test; `src/project/analytics.ts` (one value); `app/renderer/analytics.ts`, `detail.ts`, `styles.css`; `src/cli.ts` and its test; the self-check in `app/main.ts`; `site/index.html` and `styles.css`; PROJECT.md, README.md, STATUS.md.

## Risks and decisions
- The thresholds are rules of thumb the person asked for; a small project can score oddly (Tickets' Coupling is pulled down by Book Seats reaching four blocks). They are one table in one file, easy to change.
- A rating reads as a grade. The window says under the cards that these are rules of thumb and that the measurements are one click away; the advanced view keeps "a measurement is never a problem".
- Ratings cover what the measures cover: stores under Scalability, blocks with parts under Modularity and Cohesion, function blocks under the rest.

## Verification
`ratings.test.ts` at each rule's ends and the band edges, on the Tickets snapshot; the CLI test for the Ratings lines; a self-check step that opens the window on eight cards, opens one, reads its ranking best first, and reveals the measurements; `npm run check:app` and the whole suite, one at a time; the site at desktop and phone width with the numbers the command prints.
