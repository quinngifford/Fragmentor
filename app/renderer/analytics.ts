import { analyticsOf, codeFilesOf, ordinal, READING_HISTORY } from "../../src/project/analytics.js";
import type { Analytics, Dimension, Measure, Row, WeakSpot, WeakSpotKind } from "../../src/project/analytics.js";
import type { ProjectSnapshot } from "../../src/project/snapshot.js";
import { revealBlock } from "./canvas.js";
import { analyticsExtra } from "./detail.js";
import { el, section, subsection } from "./dom.js";
import { weakSpotFlag } from "./notes.js";
import { closeWindow, openWindow } from "./popup.js";
import { requireSnapshot, ui } from "./state.js";

/**
 * View › Architecture Analytics: every measurement of the open project, in
 * one window, with the weak spots first.
 *
 * Every section has one shape, so a reader who has read one can read the
 * rest: the heading; one sentence in body size saying what is measured and
 * from what; the system's numbers; then rows per block, highest first, each
 * a button that shows the block on the drawing, with a thin bar against the
 * largest. Colour appears in two places only: a weak-spot heading at none,
 * where that kind was measured, and a function over the published limit.
 * Everything else is ink, compared in words.
 *
 * The window is drawn once, from the snapshot as it is when it opens;
 * reopening it reads the current one.
 */

const ROWS_SHOWN = 8;

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
  for (const dimension of analytics.dimensions) body.append(dimensionSection(analytics, dimension));
  body.append(notMeasuredSection(analytics));
  return body;
}

/** Opens the window over the drawing, measured from the snapshot as it is now, the recordings made so far, and what git says now. */
export function openAnalyticsWindow(): void {
  const snapshot = requireSnapshot();
  const body = analyticsBody(snapshot);
  openWindow(
    "Architecture Analytics",
    "Measured from the diagram, the code, the project's history and what was recorded here. A number is a measurement, not a problem; weak spots are the few worth asking about.",
    body,
  );
  if (ui.dir === null) return;
  // Drawn again, in place, only if git's answer differs from the one it was drawn with.
  const drawnWith = JSON.stringify(ui.codeChanges?.snapshot === snapshot ? ui.codeChanges.result : null);
  void readCodeChanges(ui.dir, snapshot).then(() => {
    if (body.isConnected && JSON.stringify(ui.codeChanges?.result ?? null) !== drawnWith) body.replaceWith(analyticsBody(snapshot));
  });
}
