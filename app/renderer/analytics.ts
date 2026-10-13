import { analyticsOf, codeFilesOf, ordinal, READING_HISTORY } from "../../src/project/analytics.js";
import type { Analytics, Dimension, Measure, Row, WeakSpot, WeakSpotKind } from "../../src/project/analytics.js";
import { BAND_WORDS, ratingsOf } from "../../src/project/ratings.js";
import type { Band, BlockRating, CategoryRating } from "../../src/project/ratings.js";
import type { ProjectSnapshot } from "../../src/project/snapshot.js";
import { revealBlock } from "./canvas.js";
import { analyticsExtra } from "./detail.js";
import { el, section, subsection } from "./dom.js";
import { weakSpotFlag } from "./notes.js";
import { closeWindow, openWindow } from "./popup.js";
import { requireSnapshot, ui } from "./state.js";

/**
 * View › Architecture Analytics: the weak spots, then a rating for each of
 * the eight categories, and behind each the measurements it rests on.
 *
 * A rating is a rule of thumb the person chose, 0 to 100, coloured by band;
 * a card opens the category's blocks ranked best first, each with the
 * measurement that rated it, and "Show the measurements" reveals the
 * category's section: one sentence saying what is measured and from what,
 * the system's numbers, then rows per block, highest first, each a button
 * that shows the block on the drawing. In that section colour appears in
 * two places only, a weak-spot heading at none and a function over the
 * published limit, because a measurement is never a problem.
 *
 * The window is drawn once, from the snapshot as it is when it opens;
 * reopening it reads the current one.
 */

const ROWS_SHOWN = 8;
/** A ranking shows this many of the best and of the worst before "Show all". */
const RANKED_SHOWN = 5;

/** The rows of a measure, or the spots of a kind: the first few shown and the rest behind "Show all". */
function rowsOf<T>(rows: T[], draw: (row: T) => HTMLElement): HTMLElement {
  const list = el("div", "measure-rows");
  const shown = rows.slice(0, ROWS_SHOWN);
  for (const row of shown) list.append(draw(row));
  if (rows.length > shown.length) {
    const more = el("button", "btn quiet tiny", `Show all (${rows.length})`);
    more.type = "button";
    more.addEventListener("click", () => {
      more.remove();
      for (const row of rows.slice(shown.length)) list.append(draw(row));
    });
    list.append(more);
  }
  return list;
}

/** Closes the window and shows the block, since the window would cover it. */
function showBlock(blockPath: string): void {
  closeWindow();
  revealBlock(blockPath);
}

/** One block's row under a measure: the block, its number, a bar against the largest, and what produced it. */
function measureRow(row: Row, largest: number): HTMLElement {
  const isBlock = row.path !== "";
  const node = el(isBlock ? "button" : "div", `measure-row${row.band === "warn" ? " warn" : ""}`);
  if (node instanceof HTMLButtonElement) {
    node.type = "button";
    node.title = `Show ${row.name} on the drawing`;
    node.addEventListener("click", () => showBlock(row.path));
  }
  const head = el("div", "measure-head");
  // A row's text is either a whole sentence that names the block itself, or a number beside the block's name.
  const sentence = row.text.startsWith(row.name);
  head.append(el("span", "measure-name", sentence ? row.text : `${row.name}${row.planned ? " · planned" : ""}`));
  if (!sentence) head.append(el("span", "measure", row.text));
  node.append(head);
  if (largest > 0 && row.value > 0 && !sentence) {
    const meter = el("div", "meter");
    const fill = el("div", "meter-fill");
    fill.style.width = `${Math.round((100 * row.value) / largest)}%`;
    meter.append(fill);
    node.append(meter);
  }
  if (row.detail !== null && row.detail !== row.text) {
    for (const line of row.detail.split("\n")) node.append(el("div", "measure-detail", line));
  }
  return node;
}

/** One measure: its headline number, the sentence, and its rows. */
function measurePart(measure: Measure): HTMLElement {
  const part = el("div", "measure-part");
  const head = el("div", "measure-head");
  head.append(el("span", "measure-label", measure.label));
  if (measure.unavailable !== null) {
    head.append(el("span", "measure measure-none", measure.unavailable));
    part.append(head);
    return part;
  }
  const rank = measure.rank === null ? "" : ` — ${ordinal(measure.rank.place)} of ${measure.rank.of} ${measure.rank.kind}`;
  head.append(el("span", `measure${measure.band === "warn" ? " warn" : ""}`, `${measure.text}${rank}`));
  part.append(head);
  if (measure.spread !== null) {
    const { min, median, max, n, kind } = measure.spread;
    part.append(el("div", "measure-spread", `min ${min} · median ${median} · max ${max}, over ${n} ${kind}`));
  }
  if (measure.of !== "") part.append(el("p", "measure-of", measure.of));
  if (measure.rows.length > 0) {
    const largest = Math.max(...measure.rows.map((row) => row.value));
    part.append(rowsOf(measure.rows, (row) => measureRow(row, largest)));
  }
  return part;
}

/** A category's measurements: the section a rating rests on. */
function dimensionSection(analytics: Analytics, dimension: Dimension): HTMLElement {
  const node = section(dimension.name);
  node.dataset.dimension = dimension.id;
  for (const system of analytics.systems) {
    const measures = dimension.system[system.root] ?? [];
    // Systems are separate programs, so each is measured on its own and never summed.
    const holder = analytics.systems.length > 1 ? subsection(`${system.name} · ${system.blocks} blocks, ${system.dependencies} dependencies`) : node;
    for (const measure of measures) holder.append(measurePart(measure));
    if (holder !== node) node.append(holder);
  }
  return node;
}

/** A score as a pill in its band's colour. */
export function scorePill(score: number, band: Band, word = false): HTMLElement {
  return el("span", `score ${band}`, word ? `${score} ${BAND_WORDS[band]}` : String(score));
}

/** One block in a ranking: its name, its score, and the measurement that rated it. */
function ratedRow(block: BlockRating, place: number): HTMLElement {
  const row = el("button", "measure-row rated");
  row.type = "button";
  row.dataset.rank = String(place);
  row.title = `Show ${block.name} on the drawing`;
  row.addEventListener("click", () => showBlock(block.path));
  const head = el("div", "measure-head");
  head.append(el("span", "measure-name", block.name), scorePill(block.score, block.band));
  row.append(head, el("div", "measure-detail", block.why));
  return row;
}

/** A category's blocks best first: all of them when few, else the best and the worst with the rest behind "Show all". */
function ranking(blocks: BlockRating[]): HTMLElement {
  const list = el("div", "measure-rows");
  if (blocks.length <= RANKED_SHOWN * 2) {
    blocks.forEach((block, index) => list.append(ratedRow(block, index + 1)));
    return list;
  }
  blocks.slice(0, RANKED_SHOWN).forEach((block, index) => list.append(ratedRow(block, index + 1)));
  const more = el("button", "btn quiet tiny", `Show all (${blocks.length})`);
  more.type = "button";
  const worst = el("div", "measure-rows");
  blocks.slice(-RANKED_SHOWN).forEach((block, index) => worst.append(ratedRow(block, blocks.length - RANKED_SHOWN + index + 1)));
  more.addEventListener("click", () => {
    const middle = el("div", "measure-rows");
    blocks.slice(RANKED_SHOWN, -RANKED_SHOWN).forEach((block, index) => middle.append(ratedRow(block, RANKED_SHOWN + index + 1)));
    more.replaceWith(middle);
  });
  list.append(more, worst);
  return list;
}

/** One category opened: its score, its rule, its blocks ranked, and the measurements behind one more click. */
function ratingPanel(analytics: Analytics, category: CategoryRating): HTMLElement {
  const panel = el("div", "rating-panel");
  panel.dataset.rating = category.id;
  const head = el("div", "measure-head");
  head.append(el("span", "measure-label", category.name));
  head.append(category.score === null ? el("span", "measure measure-none", `not rated: ${category.unrated}`) : scorePill(category.score, category.band!, true));
  panel.append(head);
  panel.append(el("p", "measure-of", category.rule));
  if (category.blocks.length > 0) panel.append(ranking(category.blocks));
  const show = el("button", "btn quiet tiny", "Show the measurements");
  show.type = "button";
  show.addEventListener("click", () => show.replaceWith(dimensionSection(analytics, analytics.dimensions.find((each) => each.id === category.id)!)));
  panel.append(show);
  return panel;
}

/** The eight cards, each opening its category under the grid, one at a time. */
function ratingsSection(analytics: Analytics, snapshot: ProjectSnapshot): HTMLElement {
  const node = section("Ratings");
  node.dataset.ratings = "true";
  node.append(
    el(
      "p",
      "measure-of",
      "A rule of thumb for each category, 0 to 100: 70 and over is good, under 40 poor. Open one for its blocks ranked best first and the rule it uses; the measurements it rests on are one click further, and a measurement is never a problem.",
    ),
  );
  const ratings = ratingsOf(analytics, snapshot);
  for (const system of ratings.systems) {
    const holder = ratings.systems.length > 1 ? subsection(system.name) : node;
    const grid = el("div", "rating-grid");
    const opened = el("div", "rating-opened");
    const panels = new Map<string, HTMLElement>();
    const cards: HTMLButtonElement[] = [];
    for (const category of system.categories) {
      const card = el("button", `rating-card${category.band === null ? " unrated" : ` ${category.band}`}`);
      card.type = "button";
      card.dataset.category = category.id;
      card.setAttribute("aria-expanded", "false");
      card.append(
        el("span", "rating-name", category.name),
        el("span", `rating-score${category.score === null ? " none" : ""}`, category.score === null ? "—" : String(category.score)),
        el("span", "rating-word", category.band === null ? "not rated" : BAND_WORDS[category.band]),
        el("span", "rating-count", category.score === null ? category.unrated! : `${category.blocks.length} ${category.blocks.length === 1 ? "block" : "blocks"} rated`),
      );
      const panel = ratingPanel(analytics, category);
      panel.hidden = true;
      panels.set(category.id, panel);
      opened.append(panel);
      card.addEventListener("click", () => {
        const open = panel.hidden;
        for (const [id, each] of panels) each.hidden = !(open && id === category.id);
        for (const each of cards) each.setAttribute("aria-expanded", String(open && each === card));
      });
      cards.push(card);
      grid.append(card);
    }
    holder.append(grid, opened);
    if (holder !== node) node.append(holder);
  }
  return node;
}

/** One weak spot: the finding, where it is, its evidence, and Flag. */
function spotRow(spot: WeakSpot, kind: WeakSpotKind): HTMLElement {
  const line = el("div", "spot-line");
  const row = el(spot.block === null ? "div" : "button", `measure-row spot${spot.band === "warn" ? " warn" : ""}`);
  if (row instanceof HTMLButtonElement) {
    row.type = "button";
    row.title = `Show ${spot.blockName} on the drawing`;
    row.addEventListener("click", () => showBlock(spot.block!));
  }
  const head = el("div", "measure-head");
  head.append(el("span", "measure-name", spot.headline.slice(kind.title.length + 2)));
  head.append(el("span", "measure-where", spot.block === null ? "under no block" : `on ${spot.blockName}`));
  row.append(head);
  for (const evidence of spot.evidence) row.append(el("div", "measure-detail", evidence));
  line.append(row);
  const flag = spot.block === null ? null : weakSpotFlag(spot);
  if (flag) line.append(flag);
  return line;
}

function weakSpotsSection(analytics: Analytics): HTMLElement {
  const node = section("Weak spots");
  node.dataset.weakSpots = "true";
  node.append(el("p", "measure-of", "The few findings worth asking your agent about, with their evidence. Flag one to hand it to the agent as a note; it fixes it, or replies saying why it should stay. A weak spot is never a problem."));
  for (const kind of analytics.weakSpots) {
    const count = kind.spots.length;
    const title = !kind.measured && count === 0 ? `${kind.title}: not measured: ${kind.reason}` : `${kind.title}: ${count === 0 ? "none" : count}`;
    // Green only where the kind was measured and found nothing.
    const part = subsection(title, kind.measured && count === 0 ? "good" : undefined);
    part.dataset.kind = kind.kind;
    if (count > 0) part.append(rowsOf(kind.spots, (spot) => spotRow(spot, kind)));
    node.append(part);
  }
  return node;
}

function notMeasuredSection(analytics: Analytics): HTMLElement {
  const node = section("Not measured");
  if (analytics.notMeasured.length === 0) {
    node.append(el("p", "measure-of", "None: every system's code was read."));
    return node;
  }
  for (const each of analytics.notMeasured) node.append(el("p", "measure-of", `${each.name}: ${each.reasons.join("; ")}`));
  return node;
}

/**
 * Asks git which commits touched the code, for the snapshot on screen, and
 * keeps the answer in the state for every reader of the measurements: the
 * panel and this window. Asked as a project loads and again when this window
 * opens, since a commit changes no file the project is read from. While an
 * answer is on its way the last one stands, or "Reading history…" before the first.
 */
export function readCodeChanges(dir: string, snapshot: ProjectSnapshot): Promise<void> {
  const standing = ui.codeChanges?.snapshot === snapshot ? ui.codeChanges.result : { unavailable: READING_HISTORY };
  const read: NonNullable<typeof ui.codeChanges> = { snapshot, result: standing, landed: Promise.resolve() };
  read.landed = window.fragmentor.codeChanges(dir, codeFilesOf(snapshot).all).then((result) => {
    read.result = result.ok ? result.value : { unavailable: `Changes could not be read: ${result.error}` };
  });
  ui.codeChanges = read;
  return read.landed;
}

function analyticsBody(snapshot: ProjectSnapshot): HTMLElement {
  const analytics = analyticsOf(snapshot, analyticsExtra(snapshot));
  const body = el("div", "window-sections analytics");
  body.append(
    el(
      "p",
      "measure-scope",
      analytics.systems.map((system) => `${system.name}: ${system.blocks} blocks, ${system.dependencies} dependencies`).join(" · "),
    ),
  );
  body.append(weakSpotsSection(analytics));
  body.append(ratingsSection(analytics, snapshot));
  body.append(notMeasuredSection(analytics));
  return body;
}

/** Opens the window over the drawing, measured from the snapshot as it is now, the recordings made so far, and what git says now. */
export function openAnalyticsWindow(): void {
  const snapshot = requireSnapshot();
  const body = analyticsBody(snapshot);
  openWindow(
    "Architecture Analytics",
    "Rated by rules of thumb from the diagram, the code, the project's history and what was recorded here. Weak spots are the few worth asking about.",
    body,
  );
  if (ui.dir === null) return;
  // Drawn again, in place, only if git's answer differs from the one it was drawn with.
  const drawnWith = JSON.stringify(ui.codeChanges?.snapshot === snapshot ? ui.codeChanges.result : null);
  void readCodeChanges(ui.dir, snapshot).then(() => {
    if (body.isConnected && JSON.stringify(ui.codeChanges?.result ?? null) !== drawnWith) body.replaceWith(analyticsBody(snapshot));
  });
}
