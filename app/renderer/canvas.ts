import type { Point } from "../../src/project/layout.js";
import type { SnapshotBlock } from "../../src/project/snapshot.js";
import {
  BODY_PAD,
  FIELD_H,
  GROUP_GAP,
  GROUP_HEAD_H,
  HEAD_H,
  NODE_W,
  PROJECT_VIEW,
  ROW_H,
  TILE_W,
  buildGraph,
  accessEnds,
  blockColour,
  entryLines,
  exposedRow,
  fitLine,
  isContextKey,
  layoutFor,
  measure,
  placeContext,
  widthOf,
} from "./graph.js";
import type { AccessLink, Graph, GraphNode } from "./graph.js";
import { requireSnapshot, roleColours, selectedExecution, ui, viewSettings } from "./state.js";
import { addressesOf } from "../../src/model/trace.js";
import { el } from "./dom.js";
import { ROLES, ROLE_IDS } from "../../src/model/roles.js";
import type { Role } from "../../src/model/roles.js";

/**
 * The diagram.
 *
 * Drawing and updating are deliberately separate. Selecting or moving a block
 * changes attributes on the elements that are already there; only a change of
 * diagram rebuilds them. That is not an optimisation — an element replaced
 * between two clicks can never receive a double-click, and a dragged element
 * that is replaced mid-gesture loses the pointer and stops following the mouse.
 *
 * Moving between diagrams is animated as a zoom, so the hierarchy reads as one
 * drawing seen closer up or further away. Blocks the agent adds are brought in
 * rather than simply being there, so the person can see what just changed.
 * A run being watched is laid over the drawing in the same way: as attributes
 * on what is already drawn.
 *
 * A diagram is one block's parts. Nothing on it is a wire: what calls what is
 * what a run shows, not what the diagram is. An execution is laid over it on
 * a layer of its own, beneath the blocks, with its marks — what it left
 * behind, what happened out of sight inside a block — on another above them.
 */

let notify: (options: { redraw: boolean }) => void = () => {};
export function onCanvasChange(callback: (options: { redraw: boolean }) => void): void {
  notify = callback;
}

const drawnListeners: Array<() => void> = [];
/** Called whenever a diagram has been drawn afresh, so anything laid over it can be put back. */
export function onCanvasDrawn(callback: () => void): void {
  drawnListeners.push(callback);
}

let breakpointToggled: (blockPath: string) => void = () => {};
/** Called when the person clicks a block's breakpoint. */
export function onBreakpointToggle(callback: (blockPath: string) => void): void {
  breakpointToggled = callback;
}

let currentGraph: Graph | null = null;
let currentLayout: Map<string, Point> | null = null;

/** The drawn elements, so they can be updated rather than replaced. */
const nodeElements = new Map<string, SVGGElement>();
const accessElements = new Map<string, { group: SVGGElement; paths: SVGPathElement[]; label: SVGTextElement }>();

export function graphInView(): Graph | null {
  return currentGraph;
}

function svgEl<K extends keyof SVGElementTagNameMap>(
  name: K,
  attrs: Record<string, string | number> = {},
  parent?: Element,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  parent?.append(node);
  return node;
}

function element<T extends Element>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`The interface is missing #${id}.`);
  return found as unknown as T;
}

export function applyViewport(): void {
  element("viewport").setAttribute("transform", `translate(${ui.panX} ${ui.panY}) scale(${ui.zoom})`);
  element("zoom-level").textContent = `${Math.round(ui.zoom * 100)}%`;
}

/* -------------------------------------------------------------------------- */
/* Updating what is already drawn                                             */
/* -------------------------------------------------------------------------- */

export function applySelection(): void {
  for (const [key, group] of nodeElements) {
    group.dataset.selected = String(ui.selection.has(key));
  }
  for (const [id, drawn] of accessElements) {
    drawn.group.dataset.selected = String(ui.selectedLink === id);
  }
}

/** Moves the drawn blocks and re-routes the lines between them, without rebuilding them. */
export function applyPositions(): void {
  if (!currentGraph || !currentLayout) return;
  placeContext(currentGraph, currentLayout);

  for (const [key, group] of nodeElements) {
    const point = currentLayout.get(key);
    if (point) group.setAttribute("transform", `translate(${point.x} ${point.y})`);
  }

  for (const [id, drawn] of accessElements) {
    const link = currentGraph.accesses.get(id);
    if (!link) continue;
    const geometry = accessGeometry(currentGraph, currentLayout, link);
    if (!geometry) continue;

    for (const path of drawn.paths) path.setAttribute("d", geometry.path);
    drawn.label.setAttribute("x", String(geometry.middle.x));
    drawn.label.setAttribute("y", String(geometry.middle.y));
  }

  drawExecution();
}

export function applyBreakpoints(): void {
  for (const [key, group] of nodeElements) {
    const blockPath = currentGraph?.nodes.get(key)?.block?.path;
    group.dataset.breakpoint = String(blockPath !== undefined && ui.breakpoints.has(blockPath));
  }
}

/** A run laid over the diagram on screen: how each block, and whatever is inside it, is doing. */
export interface RunOverlay {
  nodes: Map<string, { state: "running" | "paused" | "done" | "failed" | "stopped"; note: string }>;
}

/** Shows a run on what is already drawn. */
export function applyRunOverlay(overlay: RunOverlay | null): void {
  for (const [key, group] of nodeElements) {
    const run = overlay?.nodes.get(key);
    if (run) group.dataset.run = run.state;
    else delete group.dataset.run;
    const note = group.querySelector(".run-note");
    if (note) note.textContent = run?.note ?? "";
  }
}

/** Whether the lines saying what each block reaches are drawn. */
export function applyDependencies(): void {
  element<SVGSVGElement>("canvas-svg").dataset.dependencies = ui.showDependencies ? "shown" : "hidden";
}

/* -------------------------------------------------------------------------- */
/* An execution, laid over the diagram                                         */
/* -------------------------------------------------------------------------- */

/** A place on the diagram an execution reaches: a node, and one of its rows where it draws that entry. */
export interface ExecutionEnd {
  key: string;
  entry: string | null;
}

/** Everything an execution did between two places on screen, drawn as one line. */
export interface ExecutionLine {
  id: string;
  /** Null when it came from outside the system. */
  from: ExecutionEnd | null;
  to: ExecutionEnd;
  /** Whether anything travelled along it, which is drawn as flow rather than as a line lighting up. */
  data: boolean;
  label: string;
  detail: string;
  /** Set on the line the current step is on, with which way it is going. */
  current: "out" | "back" | null;
}

/** An execution as it looks on the diagram on screen, as far as it has been stepped through. */
export interface ExecutionOverlay {
  lines: ExecutionLine[];
  /** What the run left behind, by node. */
  effects: Map<string, { labels: string[]; detail: string; current: boolean }>;
  /** Interactions that start and end inside one node, too fine to draw at this resolution, by node. */
  inside: Map<string, { count: number; detail: string; current: boolean }>;
  /** Nodes where anything happened. Everything else is dimmed. */
  involved: Set<string>;
  /** Nodes the current step is at. */
  current: Set<string>;
  /** What set it going, written where it comes in from outside. */
  trigger: string;
}

let currentExecution: ExecutionOverlay | null = null;

/** The blocks the execution on the diagram reaches themselves, which then need drawing even with nothing else to show. */
function executionReaches(): Set<string> {
  const trace = selectedExecution()?.declared;
  return new Set(trace?.events.flatMap((event) => addressesOf(event).map((address) => address.path)) ?? []);
}

/** Shows an execution over what is already drawn, or takes it off. */
export function applyExecutionOverlay(overlay: ExecutionOverlay | null): void {
  currentExecution = overlay;
  element("canvas-svg").classList.toggle("tracing", overlay !== null);
  for (const [key, group] of nodeElements) {
    if (overlay) {
      group.dataset.involved = String(overlay.involved.has(key));
      group.dataset.current = String(overlay.current.has(key));
    } else {
      delete group.dataset.involved;
      delete group.dataset.current;
    }
  }
  drawExecution();
}

interface EndBox {
  x: number;
  y: number;
  width: number;
  height: number;
  /** How far down it the line meets it: the row it names, or the middle of its head. */
  row: number;
  /** A tile's side of the diagram; null for anything else. */
  side: "left" | "right" | null;
}

function endBox(end: ExecutionEnd): EndBox | null {
  const node = currentGraph?.nodes.get(end.key);
  const at = currentLayout?.get(end.key);
  if (!node || !at) return null;
  return {
    x: at.x,
    y: at.y,
    width: widthOf(node),
    height: measure(node).height,
    row: exposedRow(node, end.entry) ?? HEAD_H / 2,
    side: node.context?.side ?? null,
  };
}

/** How far a line between two places in one column swings out past them. */
const SWING = 46;

/**
 * Where a line between two places meets them. Side by side, it runs from the
 * near edge of one to the near edge of the other, at the rows it names. One
 * above the other, it leaves and arrives on the same side and swings out past
 * them, which keeps it clear of whatever stands between: away from the
 * diagram for tiles, and to the right for anything else.
 */
function lineEnds(a: EndBox, b: EndBox, offset: number): { from: Point; to: Point; swing: number | null } {
  const ay = a.y + a.row + offset;
  const by = b.y + b.row + offset;
  if (b.x >= a.x + a.width) return { from: { x: a.x + a.width, y: ay }, to: { x: b.x, y: by }, swing: null };
  if (b.x + b.width <= a.x) return { from: { x: a.x, y: ay }, to: { x: b.x + b.width, y: by }, swing: null };
  const left = (a.side ?? b.side) === "left";
  return {
    from: { x: left ? a.x : a.x + a.width, y: ay },
    to: { x: left ? b.x : b.x + b.width, y: by },
    swing: left ? -SWING : SWING,
  };
}

/** The curve of one line, stopped short for its arrowhead, and a point on its middle for its label. */
function executionPath(from: Point, to: Point, swing: number | null): { d: string; middle: Point } {
  const pull = (to.x - from.x) * 0.45;
  const c1 = swing === null ? { x: from.x + pull, y: from.y } : { x: from.x + swing, y: from.y };
  const c2 = swing === null ? { x: to.x - pull, y: to.y } : { x: to.x + swing, y: to.y };
  const stop = shortOf(to, c2);
  return {
    d: `M ${from.x} ${from.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${stop.x} ${stop.y}`,
    middle: { x: (from.x + 3 * c1.x + 3 * c2.x + to.x) / 8, y: (from.y + 3 * c1.y + 3 * c2.y + to.y) / 8 },
  };
}

/** How long a chip is for its words, which are set in a monospaced 9px. */
const chipWidth = (text: string) => text.length * 5.6 + 14;
const chipsWidth = (labels: string[]) => labels.reduce((sum, label) => sum + chipWidth(label) + 4, -4);
const CHIP_H = 15;

function drawExecution(): void {
  const lines = element("exec-layer");
  const marks = element("exec-marks");
  lines.replaceChildren();
  marks.replaceChildren();
  const overlay = currentExecution;
  if (!overlay || !currentGraph || !currentLayout) return;

  // A line each way between the same two places is drawn a little apart, or
  // the two would read as one.
  const pairs = new Set<string>();
  for (const line of overlay.lines) {
    const to = endBox(line.to);
    const from = line.from ? endBox(line.from) : null;
    if (!to || (line.from && !from)) continue;
    const pair = [line.from?.key ?? "", line.to.key].sort().join(" ");
    const offset = pairs.has(pair) ? 7 : 0;
    pairs.add(pair);

    let geometry: { d: string; middle: Point };
    if (from) {
      const ends = lineEnds(from, to, offset);
      geometry = executionPath(ends.from, ends.to, ends.swing);
    } else {
      // From outside the system: a mark just off to the left of where it
      // arrives, and past anything the run left on that side of a tile.
      const at = { x: to.x, y: to.y + to.row };
      const chips = to.side === "left" ? overlay.effects.get(line.to.key)?.labels : undefined;
      const start = { x: at.x - 64 - (chips ? chipsWidth(chips) + 8 : 0), y: at.y };
      const outside = svgEl("g", { class: "exec-outside" }, lines);
      svgEl("circle", { cx: start.x, cy: start.y, r: 4.5, class: "exec-outside-dot" }, outside);
      svgEl("text", { x: start.x, y: start.y - 9, class: "exec-outside-label", "text-anchor": "middle" }, outside).textContent =
        overlay.trigger;
      geometry = executionPath({ x: start.x + 5, y: start.y }, at, null);
    }

    const group = svgEl("g", {
      class: "exec-line-group",
      "data-data": String(line.data),
      "data-current": line.current ?? "none",
    }, lines);
    svgEl("path", { d: geometry.d, class: "exec-line", "marker-end": "url(#exec-arrow)" }, group);
    svgEl("path", { d: geometry.d, class: "line-hit" }, group);
    svgEl("title", {}, group).textContent = line.detail;
    svgEl("text", { x: geometry.middle.x, y: geometry.middle.y - 6, class: "exec-label", "text-anchor": "middle" }, group).textContent =
      line.label;
  }

  // What was left behind goes over a block, or beside a tile, on the side
  // away from the diagram, where the tiles above and below leave room.
  for (const [key, effect] of overlay.effects) {
    const box = endBox({ key, entry: null });
    if (!box) continue;
    const widths = effect.labels.map(chipWidth);
    const total = chipsWidth(effect.labels);
    let x = box.side === null ? box.x : box.side === "right" ? box.x + box.width + 8 : box.x - 8 - total;
    const y = box.side === null ? box.y - CHIP_H - 5 : box.y + (HEAD_H - CHIP_H) / 2;

    const group = svgEl("g", { class: "exec-effect", "data-current": String(effect.current) }, marks);
    svgEl("title", {}, group).textContent = effect.detail;
    effect.labels.forEach((label, i) => {
      const width = widths[i]!;
      svgEl("rect", { x, y, width, height: CHIP_H, rx: CHIP_H / 2, class: "exec-effect-chip" }, group);
      svgEl("text", { x: x + width / 2, y: y + 10.5, class: "exec-effect-text", "text-anchor": "middle" }, group).textContent = label;
      x += width + 4;
    });
  }

  // What happened out of sight inside a block, counted on its head.
  for (const [key, inside] of overlay.inside) {
    const box = endBox({ key, entry: null });
    if (!box) continue;
    const mark = svgEl("g", { class: "exec-inside", "data-current": String(inside.current) }, marks);
    svgEl("title", {}, mark).textContent = inside.detail;
    svgEl("text", { x: box.x + box.width - 10, y: box.y + 27, "text-anchor": "end" }, mark).textContent = `${inside.count} inside`;
  }
}

/* -------------------------------------------------------------------------- */
/* The camera                                                                  */
/* -------------------------------------------------------------------------- */

/** Where the canvas is looking: the point of the diagram at its centre, and how large it is drawn. */
interface Camera {
  cx: number;
  cy: number;
  scale: number;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const lessMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function canvasSize(): { width: number; height: number } {
  const rect = element("canvas-svg").getBoundingClientRect();
  return { width: rect.width, height: rect.height };
}

function currentCamera(): Camera {
  const { width, height } = canvasSize();
  return { cx: (width / 2 - ui.panX) / ui.zoom, cy: (height / 2 - ui.panY) / ui.zoom, scale: ui.zoom };
}

function setCamera(camera: Camera): void {
  const { width, height } = canvasSize();
  ui.zoom = camera.scale;
  ui.panX = width / 2 - camera.cx * camera.scale;
  ui.panY = height / 2 - camera.cy * camera.scale;
  applyViewport();
}

/** A camera that fills most of the canvas with one part of the diagram. */
function cameraOn(box: Box): Camera {
  const { width, height } = canvasSize();
  return {
    cx: box.x + box.width / 2,
    cy: box.y + box.height / 2,
    scale: 0.9 * Math.min(width / box.width, height / box.height),
  };
}

/** Part of the way from one camera to another. Scale moves geometrically, which is how a zoom looks steady. */
function between(a: Camera, b: Camera, t: number): Camera {
  return {
    cx: a.cx + (b.cx - a.cx) * t,
    cy: a.cy + (b.cy - a.cy) * t,
    scale: a.scale * Math.pow(b.scale / a.scale, t),
  };
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function setFade(opacity: number): void {
  element<SVGGElement>("viewport").style.opacity = String(opacity);
}

/**
 * Runs `step` with eased progress from 0 to 1 over `duration`, for as long as
 * `current` says nothing newer has taken over. Resolves true only if it ran
 * to the end.
 */
function tween(duration: number, step: (t: number) => void, current: () => boolean): Promise<boolean> {
  return new Promise((resolve) => {
    const started = performance.now();
    let finished = false;
    const finish = (completed: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(fallback);
      resolve(completed);
    };

    // A window that is not being painted gets no animation frames. Rather
    // than leave a move half made, finish it without them.
    const fallback = setTimeout(() => {
      if (!current()) return finish(false);
      step(1);
      finish(true);
    }, duration + 250);

    const frame = (now: number) => {
      if (finished) return;
      if (!current()) return finish(false);
      const progress = Math.min(1, (now - started) / duration);
      step(ease(progress));
      if (progress < 1) requestAnimationFrame(frame);
      else finish(true);
    };
    requestAnimationFrame(frame);
  });
}

/** Each new move, or fit, takes over from the one before it. */
let moves = 0;
let fits = 0;
let moving = false;
/** The diagram a move under way is heading for, so a second ask for it is not a second move. */
let movingTo: string | null = null;
/** What to do when that move arrives. A later ask for the same diagram replaces it. */
let onArrival: () => void = () => {};

function diagramBounds(): Box | null {
  if (!currentGraph || !currentLayout) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const node of currentGraph.nodes.values()) {
    const point = currentLayout.get(node.key);
    if (!point) continue;
    const { height } = measure(node);
    minX = Math.min(minX, point.x - 30);
    minY = Math.min(minY, point.y - 20);
    maxX = Math.max(maxX, point.x + widthOf(node) + 30);
    maxY = Math.max(maxY, point.y + height + 34);
  }

  // An execution draws past the blocks: where it comes in from outside, and
  // what it left beside a tile. Those are part of what has to be seen.
  for (const id of ["exec-layer", "exec-marks"]) {
    const layer = element<SVGGElement>(id);
    if (layer.childElementCount === 0) continue;
    const box = layer.getBBox();
    minX = Math.min(minX, box.x - 12);
    minY = Math.min(minY, box.y - 12);
    maxX = Math.max(maxX, box.x + box.width + 12);
    maxY = Math.max(maxY, box.y + box.height + 12);
  }

  return Number.isFinite(minX) ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY } : null;
}

function fitCamera(): Camera | null {
  const bounds = diagramBounds();
  const { width, height } = canvasSize();
  if (!bounds || !width || !height) return null;

  // Fitting shrinks a diagram to make it visible; it never magnifies one, or a
  // project with two small systems in it would open absurdly zoomed in.
  const scale = Math.min(1, Math.max(0.25, Math.min(width / bounds.width, height / bounds.height)));
  return { cx: bounds.x + bounds.width / 2, cy: bounds.y + bounds.height / 2, scale };
}

/**
 * Brings the whole diagram into view. A move between diagrams fits at its
 * end, so a fit asked for in the meantime is left to it.
 */
export function fitToView(animated = false): void {
  if (moving) return;
  const target = fitCamera();
  if (!target) return;

  const id = ++fits;
  if (!animated || lessMotion()) {
    setCamera(target);
    return;
  }
  const start = currentCamera();
  void tween(320, (t) => setCamera(between(start, target, t)), () => id === fits && !moving);
}

/** The canvas has no size until layout settles, so keep asking. */
export function fitWhenReady(attempts: number): void {
  const rect = element("canvas-svg").getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) {
    fitToView();
    return;
  }
  if (attempts > 0) requestAnimationFrame(() => fitWhenReady(attempts - 1));
}

/* -------------------------------------------------------------------------- */
/* Moving between diagrams                                                     */
/* -------------------------------------------------------------------------- */

/** Whether `path` lies inside the diagram at `ancestor`, at any depth. */
function isInside(path: string, ancestor: string): boolean {
  return ancestor === PROJECT_VIEW ? path !== PROJECT_VIEW : path.startsWith(`${ancestor}/`);
}

/** The node in `ancestor`'s diagram that `path` lies inside: one of its children, or for the project, a system. */
function nodeToward(ancestor: string, path: string): string {
  return (ancestor === PROJECT_VIEW ? path : path.slice(ancestor.length + 1)).split("/")[0]!;
}

function nodeBox(key: string): Box | null {
  const node = currentGraph?.nodes.get(key);
  const point = currentLayout?.get(key);
  if (!node || !point) return null;
  return { x: point.x, y: point.y, width: widthOf(node), height: measure(node).height };
}

/**
 * Puts another diagram on the canvas. Going into a block zooms into it until
 * it fills the canvas, and its own diagram takes over from there; coming back
 * out zooms away from it into the diagram around it. A jump between unrelated
 * diagrams simply fades.
 */
async function moveTo(path: string, arrive: () => void): Promise<void> {
  // Already on the way there. Restarting the move would zoom back to where it
  // began and set off again, which is all the eye would see of it.
  if (movingTo === path) {
    onArrival = arrive;
    return;
  }

  const from = ui.view;
  const id = ++moves;
  fits += 1;
  const current = () => id === moves;
  const svg = element("canvas-svg");

  onArrival = arrive;
  const change = () => {
    ui.view = path;
    ui.selection.clear();
    ui.selectedLink = null;
    ui.userAdjusted = false;
    onArrival();
    notify({ redraw: true });
  };

  const { width, height } = canvasSize();
  if (path === from || lessMotion() || !currentGraph || !width || !height) {
    moving = false;
    movingTo = null;
    svg.classList.remove("moving");
    setFade(1);
    change();
    fitWhenReady(20);
    return;
  }

  const down = isInside(path, from);
  const up = isInside(from, path);
  moving = true;
  movingTo = path;
  svg.classList.add("moving");

  // Leave the diagram on screen: into the block the new one is inside, or
  // back away from it.
  const start = currentCamera();
  const into = down ? nodeBox(nodeToward(from, path)) : null;
  const leaveTo = into ? cameraOn(into) : { ...start, scale: start.scale * (up ? 0.55 : 1) };
  const left = await tween(down || up ? 240 : 140, (t) => {
    setCamera(between(start, leaveTo, t));
    setFade(1 - t * t);
  }, current);
  // Taken over by a newer move, which is now the one saying where the canvas
  // goes and when it is no longer moving.
  if (!left) return;

  change();

  // Arrive: out of the block that was just left, or growing into place.
  const target = fitCamera();
  if (!target) {
    moving = false;
    movingTo = null;
    svg.classList.remove("moving");
    setFade(1);
    return;
  }
  const outOf = up ? nodeBox(nodeToward(path, from)) : null;
  const enterFrom = outOf ? cameraOn(outOf) : { ...target, scale: target.scale * (down ? 0.6 : 1) };
  setCamera(enterFrom);
  setFade(0);
  await tween(down || up ? 300 : 160, (t) => {
    setCamera(between(enterFrom, target, t));
    setFade(t);
  }, current);

  if (current()) {
    moving = false;
    movingTo = null;
    svg.classList.remove("moving");
    setFade(1);
  }
}

/** Opens a block's diagram: the parts it is made of. `arrive` runs as it is put on screen, for choosing what to select there. */
export function openDiagram(path: string, arrive: () => void = () => {}): void {
  void moveTo(path, arrive);
}

/**
 * Brings a block into view: one made of parts opens to show them, and any
 * other is selected in the diagram of the block it belongs to.
 */
export function showBlock(path: string): void {
  const block = ui.snapshot?.blocks[path];
  if (!block) return;
  if (block.children.length > 0) {
    openDiagram(path);
    return;
  }

  const parent = path.split("/").slice(0, -1).join("/") || PROJECT_VIEW;
  const select = () => {
    ui.selection.clear();
    ui.selection.add(block.id);
    ui.selectedLink = null;
  };

  if (parent !== ui.view) {
    openDiagram(parent, select);
    return;
  }
  select();
  applySelection();
  notify({ redraw: false });
}

/* -------------------------------------------------------------------------- */
/* Drawing                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * What each diagram held when it was last drawn, so that blocks the agent
 * adds can be told apart from those already there. Opening a project
 * forgets it all: blocks that were there all along are simply there.
 */
const drawnBefore = new Map<string, { nodes: Set<string> }>();
let everythingArrives = false;

/**
 * Called when a project is opened. In a project the agent has not defined
 * yet, the first diagram it writes arrives block by block.
 */
export function resetArrivals(projectIsEmpty: boolean): void {
  drawnBefore.clear();
  everythingArrives = projectIsEmpty;
}

/** Takes the diagram off the canvas, as when a project is closed. */
export function clearCanvas(): void {
  element("access-layer").replaceChildren();
  element("exec-layer").replaceChildren();
  element("node-layer").replaceChildren();
  element("exec-marks").replaceChildren();
  nodeElements.clear();
  accessElements.clear();
  currentGraph = null;
  currentLayout = null;
  document.querySelectorAll(".canvas-empty").forEach((el) => el.remove());
  renderLegend(null);
}

/** Empties the canvas and leaves a note where the diagram would be. */
export function showCanvasMessage(text: string): void {
  clearCanvas();
  const note = document.createElement("p");
  note.className = "canvas-empty";
  note.textContent = text;
  element("canvas-wrap").append(note);
}

/**
 * What the colours mean, and where they are changed.
 *
 * Every kind is listed whatever happens to be on this diagram, because the
 * legend is also where a colour is chosen: a kind missing from the list would
 * be a colour nobody could reach. What is on screen is marked, so the list
 * still says something about the diagram in front of you.
 *
 * Coloured block by block there is nothing to explain and each block's colour
 * is set in the inspector instead, so the legend goes away.
 */
function renderLegend(graph: Graph | null): void {
  const legend = element<HTMLElement>("legend");

  if (!graph || viewSettings.colourBy !== "role") {
    legend.hidden = true;
    return;
  }

  legend.hidden = false;
  legend.dataset.collapsed = String(ui.legendCollapsed);
  legend.replaceChildren();

  const head = el("div", "legend-head");
  head.append(el("span", "legend-title", "Colours"));

  const toggle = el("button", "legend-toggle");
  toggle.type = "button";
  toggle.textContent = ui.legendCollapsed ? "▾" : "▴";
  toggle.title = ui.legendCollapsed ? "Show what the colours mean" : "Hide the colours";
  toggle.addEventListener("click", () => {
    ui.setLegendCollapsed(!ui.legendCollapsed);
    renderLegend(graph);
  });
  head.append(toggle);
  legend.append(head);

  if (ui.legendCollapsed) return;

  const present = new Set(
    [...graph.nodes.values()].flatMap((node) => (node.block && !node.block.planned ? [node.block.role] : [])),
  );

  for (const role of ROLE_IDS) {
    const row = el("div", "legend-row");
    row.dataset.role = role;
    row.dataset.here = String(present.has(role));

    // The swatch is the colour input itself, so one press opens the picker
    // rather than a menu that then offers one.
    const swatch = el("input", "legend-swatch");
    swatch.type = "color";
    swatch.value = roleColours.get(role);
    swatch.title = `${ROLES[role].label}: ${ROLES[role].description}`;
    swatch.addEventListener("input", () => {
      roleColours.set(role, swatch.value);
    });

    const name = el("span", "legend-text", role === "function" ? "code" : ROLES[role].label.toLowerCase());
    row.append(swatch, name);
    legend.append(row);
  }

  const planned = el("div", "legend-row");
  planned.dataset.role = "planned";
  planned.dataset.here = String([...graph.nodes.values()].some((node) => node.block?.planned));
  planned.append(el("span", "legend-swatch fixed"), el("span", "legend-text", "planned, not built yet"));
  legend.append(planned);

  const reset = el("button", "legend-reset", "Back to the defaults");
  reset.type = "button";
  reset.addEventListener("click", () => {
    for (const role of ROLE_IDS) roleColours.set(role, null);
    renderLegend(graph);
  });
  legend.append(reset);
}

/** Blocks arriving together come in one after another, the way they were written. */
const ARRIVAL_STAGGER_MS = 70;

export function renderCanvas(): void {
  clearCanvas();

  const graph = buildGraph(ui.view, { opened: ui.expanded, reached: executionReaches() });
  if (!graph) {
    const parent = requireSnapshot().blocks[ui.view];
    showCanvasMessage(
      parent
        ? `${parent.name} has no parts inside it.\nThe inspector shows what it is${parent.architecture ? "" : ", its contract and its code"}.`
        : "This block no longer exists.",
    );
    return;
  }

  currentGraph = graph;
  const nodeLayer = element("node-layer");
  const layout = layoutFor(graph, ui.view);
  currentLayout = layout;

  const before = drawnBefore.get(ui.view) ?? (everythingArrives ? { nodes: new Set<string>() } : null);
  const arrivingNodes = before ? [...graph.nodes.keys()].filter((key) => !before.nodes.has(key)) : [];
  const lineDelay = Math.min(arrivingNodes.length, 12) * ARRIVAL_STAGGER_MS + 200;

  drawAccesses(graph, layout, element("access-layer"), lineDelay, before !== null);

  for (const node of graph.nodes.values()) {
    const point = layout.get(node.key);
    if (!point) continue;
    const arrival = arrivingNodes.indexOf(node.key);
    drawNode(graph, node, point, nodeLayer, arrival === -1 ? null : Math.min(arrival, 12) * ARRIVAL_STAGGER_MS);
  }

  renderLegend(graph);
  drawnBefore.set(ui.view, { nodes: new Set(graph.nodes.keys()) });
  everythingArrives = false;

  applyDependencies();
  applySelection();
  applyBreakpoints();
  applyViewport();
  for (const listener of drawnListeners) listener();
}

/** Only TypeScript blocks in a structured project run, so only they can be paused. */
function canPause(block: SnapshotBlock): boolean {
  return (
    ui.snapshot?.mode === "structured" &&
    block.language === "typescript" &&
    !block.planned &&
    // A database is never called, and neither is a group of parts.
    !block.architecture
  );
}

/** How far short of a block an access line stops, so its arrowhead shows. */
const ARROW_ROOM = 11;

/**
 * A curve that bends the way it actually travels.
 *
 * An access can run either way — down out of a block and back up into it,
 * most often — and pointing an arrowhead along a curve that approached from
 * the wrong side would make a read look like a write.
 */
/** How far a line to a store below swings clear of the column on its way. */
const BOW = 58;

function accessCurve(a: Point, b: Point, bow: number): string {
  const dx = (b.x - a.x) * 0.4;
  const dy = (b.y - a.y) * 0.35;
  // A line that mostly drops leaves and arrives sideways instead, bowed out
  // past the column, so a store under one block does not send its line
  // through the block beneath it.
  if (Math.abs(b.y - a.y) > Math.abs(b.x - a.x)) {
    return `M ${a.x} ${a.y} C ${a.x + bow} ${a.y + dy}, ${b.x + bow} ${b.y - dy}, ${b.x} ${b.y}`;
  }
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
}

/** The last stretch, pulled back so the blocks drawn over this layer leave the arrowhead showing. */
function shortOf(head: Point, tail: Point): Point {
  const dx = head.x - tail.x;
  const dy = head.y - tail.y;
  const length = Math.hypot(dx, dy) || 1;
  return { x: head.x - (dx / length) * ARROW_ROOM, y: head.y - (dy / length) * ARROW_ROOM };
}

function accessGeometry(graph: Graph, layout: Map<string, Point>, link: AccessLink) {
  const ends = accessEnds(graph, layout, link);
  if (!ends) return null;

  const stop = shortOf(ends.to, ends.from);
  // Out of a block goes down its right, back into it comes up its left, which
  // is the loop a store below it makes. Each further line on the same side
  // swings wider, so one on its way past a nearer store goes round it.
  const bow = (link.direction === "out" ? BOW : -BOW) * (1 + link.lane * 0.45);
  const dropping = Math.abs(stop.y - ends.from.y) > Math.abs(stop.x - ends.from.x);
  return {
    path: accessCurve(ends.from, stop, bow),
    middle: {
      x: (ends.from.x + ends.to.x) / 2 + (dropping ? bow : 0),
      y: (ends.from.y + ends.to.y) / 2 - 6,
    },
  };
}

/** `reads users`, then `reads 3 tables` once there are too many to name. */
function accessLabel(link: AccessLink, resource: GraphNode | undefined): string {
  // The way into a service is named by the operation alone: "calls" would be
  // the wrong word for a boundary that is answering rather than asking.
  if (link.answers) return link.entries[0]?.entry ?? "answers";
  if (link.entries.length === 1) {
    const only = link.entries[0]!;
    // Named at both ends, the line already meets the two entries it joins, so
    // the label says what it does rather than repeating where it lands.
    if (link.from !== null) return only.verb;
    return only.entry === null ? only.verb : `${only.verb} ${only.entry}`;
  }
  const named = link.entries.filter((entry) => entry.entry !== null).length;
  if (named !== link.entries.length) return link.verb;
  // Counted in whatever the resource calls them, so "calls 2" reads as the
  // two operations it is rather than as a number nobody can place.
  const noun = resource?.block ? ROLES[resource.block.role].entryNoun : "in all";
  return `${link.verb} ${named} ${noun}s`;
}

/** What an access carries, as the resource describes it. */
function accessDetail(link: AccessLink, resource: GraphNode | undefined, owner: GraphNode | undefined): string[] {
  // Into a service, what the operation accepts is written on the boundary the
  // line leaves rather than on the block it arrives at.
  if (link.answers) {
    return link.entries.map((each) => {
      const operation = owner?.exposes.find((exposed) => exposed.name === each.entry);
      return operation?.accepts ? `${each.entry}: ${operation.accepts}` : (each.entry ?? each.text);
    });
  }
  return link.entries.map((entry) => {
    if (entry.entry === null) return entry.text;
    const exposed = resource?.exposes.find((each) => each.name === entry.entry);
    const shape = link.direction === "in" ? exposed?.returns : exposed?.accepts;
    return shape ? `${entry.entry}: ${shape}` : entry.entry;
  });
}

function drawAccesses(graph: Graph, layout: Map<string, Point>, layer: Element, delay: number, arriving: boolean): void {
  for (const link of graph.accesses.values()) {
    const geometry = accessGeometry(graph, layout, link);
    if (!geometry) continue;

    const owner = graph.nodes.get(link.source);
    const resource = graph.nodes.get(link.target);
    // Drawn as quietly as the block it reaches, because what an unbuilt
    // resource holds is exactly what has not been decided.
    const planned = Boolean(owner?.block?.planned) || Boolean(resource?.block?.planned);

    const group = svgEl("g", {
      class: "access-group",
      "data-access": link.id,
      "data-within": String(link.fromWithin),
      "data-planned": String(planned),
      "data-role": resource?.block?.role ?? "function",
    }, layer);

    // Coloured block by block, a line matches whichever block the data comes
    // out of, so one colour can be followed from where it starts.
    if (viewSettings.colourBy === "block" && !planned) {
      const from = link.direction === "in" ? link.target : link.source;
      group.style.setProperty("--role", blockColour(graph, ui.view, from));
    }

    svgEl("path", { d: geometry.path, class: "access", "marker-end": "url(#access-arrow)" }, group);
    svgEl("path", { d: geometry.path, class: "line-hit" }, group);
    svgEl("title", {}, group).textContent = [
      link.direction === "in"
        ? `${resource?.label} → ${owner?.label}`
        : `${owner?.label} → ${resource?.label}`,
      ...accessDetail(link, resource, owner),
      link.fromWithin ? "Declared by a block inside." : "",
      planned ? "Planned: not built yet." : "",
    ]
      .filter(Boolean)
      .join("\n");

    svgEl("text", {
      x: geometry.middle.x,
      y: geometry.middle.y,
      class: "access-label",
      "text-anchor": "middle",
    }, group).textContent = accessLabel(link, resource);

    // An access is a standing relationship rather than a value travelling, so
    // it fades in rather than being drawn along its length.
    if (arriving) {
      group.classList.add("appearing");
      group.style.animationDelay = `${delay}ms`;
    }

    accessElements.set(link.id, {
      group,
      paths: [...group.querySelectorAll("path")] as SVGPathElement[],
      label: group.querySelector("text")!,
    });
  }
}

/** What a block holds, drawn down its middle: a table's columns, a queue's channels. */
function drawExposed(node: GraphNode, body: Element): void {
  let y = HEAD_H + BODY_PAD;
  for (const entry of node.exposes) {
    const lines = entryLines(entry);
    const height = GROUP_HEAD_H + lines.length * FIELD_H;

    svgEl("rect", { x: 7, y, width: NODE_W - 14, height, rx: 2, class: "exposed-plate" }, body);
    const title = svgEl("text", { x: 13, y: y + 10, class: "exposed-name" }, body);
    title.textContent = entry.name;
    if (entry.description) svgEl("title", {}, title).textContent = entry.description;

    lines.forEach((line, i) => {
      const shown = fitLine(line);
      const field = svgEl("text", { x: 17, y: y + GROUP_HEAD_H + i * FIELD_H + 9, class: "exposed-field" }, body);
      field.textContent = shown;
      // A type too long for the block is folded, not lost.
      if (shown !== line) svgEl("title", {}, field).textContent = line;
    });

    y += height + GROUP_GAP;
  }
}

/**
 * A mark in the corner of every block saying what kind of thing it is.
 *
 * The label beneath the name already says it in words, but a word has to be
 * read and a shape does not: at a glance across a whole diagram the cylinders
 * are the stores and the people are the clients. Each is drawn in a 12 by 12
 * box, as strokes only, so it takes the colour of whatever it sits on.
 */
const ROLE_ICONS: Record<Role, string[]> = {
  // Angle brackets: code.
  function: ["M4.5 3 L1.5 6 L4.5 9", "M7.5 3 L10.5 6 L7.5 9"],
  // A frame holding two smaller boxes: something made of parts.
  component: ["M1.5 1.5 H10.5 V10.5 H1.5 Z", "M3.5 3.5 H6 V6 H3.5 Z", "M6.8 6.2 H8.8 V8.5 H6.8 Z"],
  // Two racked units: a program of ours, running somewhere.
  service: ["M1.5 3 H10.5 V5.8 H1.5 Z", "M1.5 7 H10.5 V9.8 H1.5 Z", "M3 4.4 H3.01", "M3 8.4 H3.01"],
  // A box with an arrow leaving it: not ours, and out of our hands.
  external: ["M9.5 6.5 V10.5 H1.5 V2.5 H5.5", "M7 5 L10.5 1.5", "M7.5 1.5 H10.5 V4.5"],
  // The cylinder everyone draws a database as.
  database: [
    "M2 3 C2 1.7 3.8 1 6 1 C8.2 1 10 1.7 10 3 V9 C10 10.3 8.2 11 6 11 C3.8 11 2 10.3 2 9 Z",
    "M2 3 C2 4.3 3.8 5 6 5 C8.2 5 10 4.3 10 3",
  ],
  // A lidded box: things put away somewhere outside the program.
  storage: ["M1.5 2.5 H10.5 V10 H1.5 Z", "M1.5 5.2 H10.5", "M5 7.6 H7"],
  // Three waiting in a row.
  queue: ["M1.5 3.5 H3.8 V8.5 H1.5 Z", "M4.9 3.5 H7.2 V8.5 H4.9 Z", "M8.3 3.5 H10.6 V8.5 H8.3 Z"],
  // Braces: data the program is holding.
  structure: ["M5 1.8 C3.6 1.8 4.1 5 2.6 6 C4.1 7 3.6 10.2 5 10.2", "M7 1.8 C8.4 1.8 7.9 5 9.4 6 C7.9 7 8.4 10.2 7 10.2"],
  // A person: whoever sets the whole thing going.
  client: ["M4 4 A2 2 0 1 1 8 4 A2 2 0 1 1 4 4", "M1.8 10.6 C1.8 7.6 10.2 7.6 10.2 10.6"],
};

/** Where the mark sits: the top right of the head, clear of everything else. */
function drawRoleIcon(node: GraphNode, body: Element): void {
  // A boundary stands for the way in or out rather than for a block, so it
  // has no kind of its own to show.
  if (node.boundary || !node.block) return;

  const icon = svgEl("g", { class: "role-icon", transform: `translate(${widthOf(node) - 21} 4)` }, body);
  svgEl("title", {}, icon).textContent = node.sublabel;
  for (const d of ROLE_ICONS[node.block.role]) svgEl("path", { d, class: "role-icon-line" }, icon);
}

/** `arrivalDelay` is null for a block that was already there, and otherwise when it should arrive. */
function drawNode(graph: Graph, node: GraphNode, point: Point, layer: Element, arrivalDelay: number | null): void {
  if (node.context) {
    drawTile(graph, node, point, layer, arrivalDelay);
    return;
  }
  const { height } = measure(node);
  const group = svgEl("g", {
    class: "block-box",
    transform: `translate(${point.x} ${point.y})`,
    "data-boundary": String(node.boundary),
    "data-planned": String(Boolean(node.block?.planned)),
    "data-role": node.block?.role ?? "function",
    // A single flag, so the styles for a block that is not code sit at the
    // same weight as the ones for a planned block and can be overridden by
    // them: a planned database reads as planned first.
    "data-architecture": String(Boolean(node.block?.architecture)),
    // Whether the plate takes a colour at all: by role, only what is not code
    // does; block by block, everything but the boundary does.
    "data-tinted": String(
      node.block !== null && (viewSettings.colourBy === "block" || node.block.architecture),
    ),
    "data-key": node.key,
  }, layer);

  // Block by block, the colour is worked out here rather than in a stylesheet
  // that cannot know where a block sits. A planned block keeps its grey: it
  // is not built, which outranks what kind of thing it would have been.
  if (viewSettings.colourBy === "block" && node.block && !node.block.planned) {
    group.style.setProperty("--role", blockColour(graph, ui.view, node.key));
  }

  // A planned block is on the diagram to be read, so what it is for and the
  // fact that it is not built yet are the first things its tooltip says. A
  // resource brought in from above says so too, because it explains why
  // nothing in this diagram lists it as a child.
  svgEl("title", {}, group).textContent = node.block
    ? [
        node.block.planned ? "Planned: drawn, but not built yet." : "",
        node.block.responsibility,
        node.block.children.length > 0 ? "Double-click to see what it is made of." : "",
      ]
        .filter(Boolean)
        .join("\n\n")
    : `${node.label} of ${graph.parent.name}`;

  // Everything drawn sits in its own group, so an arrival can scale it
  // without disturbing the position the outer group holds.
  const body = svgEl("g", { class: "block-body" }, group);
  if (arrivalDelay !== null) {
    body.classList.add("appearing");
    body.style.animationDelay = `${arrivalDelay}ms`;
  }

  // The plate is what can be focused, not the group around it: a browser
  // draws a focus ring around everything in a group, which here would reach
  // out to the breakpoint beside the name and the capability dots below. A
  // ring around the plate is the box, which is what it should be. Keys still
  // reach the group, because they bubble up from here.
  svgEl("rect", {
    x: 0,
    y: 0,
    width: NODE_W,
    height,
    rx: 3,
    class: "block-plate",
    tabindex: "0",
    role: "button",
    "aria-label": node.label,
  }, body);
  svgEl("rect", { x: 0, y: 0, width: NODE_W, height: HEAD_H, rx: 3, class: "block-head" }, body);
  svgEl("line", { x1: 0, y1: HEAD_H, x2: NODE_W, y2: HEAD_H, class: "block-divider" }, body);
  svgEl("text", { x: 10, y: 15, class: "block-name" }, body).textContent = node.label;
  svgEl("text", { x: 10, y: 27, class: "block-kind" }, body).textContent = node.sublabel;
  drawRoleIcon(node, body);
  // How the block is doing in a run being watched; empty otherwise.
  svgEl("text", { x: NODE_W - 10, y: 27, class: "run-note", "text-anchor": "end" }, body);

  // A resource has no ports to stack up its sides. What it holds goes down
  // the middle instead, which is the whole reason a database is worth
  // drawing rather than naming.
  if (node.exposes.length > 0) {
    drawExposed(node, body);
    nodeElements.set(node.key, group);
    attachNodeBehaviour(group, node);
    return;
  }

  // A function's contract, as what it takes and what it gives back. These are
  // not ends of anything: what calls it, and what it calls, is what a run shows.
  const top = HEAD_H + BODY_PAD;
  if (node.inputs.length > 0) {
    svgEl("text", { x: 11, y: top + 10, class: "group-label" }, body).textContent = "takes";
    node.inputs.forEach((port, i) => {
      svgEl("text", { x: 15, y: top + GROUP_HEAD_H + i * ROW_H + 11, class: "port-label" }, body).textContent = port.name;
    });
  }
  if (node.outputs.length > 0) {
    svgEl("text", { x: NODE_W - 11, y: top + 10, class: "group-label", "text-anchor": "end" }, body).textContent = "gives back";
    node.outputs.forEach((port, i) => {
      svgEl("text", {
        x: NODE_W - 15,
        y: top + GROUP_HEAD_H + i * ROW_H + 11,
        class: "port-label",
        "text-anchor": "end",
      }, body).textContent = port.name;
    });
  }

  node.capabilities.forEach((cap, i) => {
    const cx = 26 + i * 58;
    svgEl("line", { x1: cx, y1: height, x2: cx, y2: height + 11, class: "cap-line" }, body);
    svgEl("circle", { cx, cy: height + 14, r: 3.5, class: "cap-dot" }, body);
    svgEl("text", { x: cx + 8, y: height + 17.5, class: "port-label" }, body).textContent = cap.name;
  });

  // Beside the block's name: where a run can be told to pause before it.
  if (node.block && !node.boundary && canPause(node.block)) {
    const blockPath = node.block.path;
    const breakpoint = svgEl("g", { class: "breakpoint", transform: `translate(-12 ${HEAD_H / 2})` }, group);
    svgEl("title", {}, breakpoint).textContent = "Pause here: a run stops before this block, so you can see what reaches it.";
    const hit = svgEl("circle", { r: 9, class: "breakpoint-hit" }, breakpoint);
    svgEl("circle", { r: 4.5, class: "breakpoint-dot" }, breakpoint);
    hit.addEventListener("pointerdown", (event) => event.stopPropagation());
    hit.addEventListener("dblclick", (event) => event.stopPropagation());
    hit.addEventListener("click", (event) => {
      event.stopPropagation();
      breakpointToggled(blockPath);
    });
  }

  nodeElements.set(node.key, group);
  attachNodeBehaviour(group, node);
}

/** Longer names are cut on a tile, which is narrower than a block. Hovering it gives the whole. */
const TILE_NAME_CHARS = 17;

/**
 * A block outside the one in focus: its name and kind, small, with a switch
 * to open it in place when it has parts. It is there to be arrived at, so it
 * stays quiet until a run reaches it.
 */
function drawTile(graph: Graph, node: GraphNode, point: Point, layer: Element, arrivalDelay: number | null): void {
  const tile = node.context!;
  const block = node.block!;
  const group = svgEl("g", {
    class: "block-box",
    transform: `translate(${point.x} ${point.y})`,
    "data-context": "true",
    "data-boundary": String(node.boundary),
    "data-planned": String(block.planned),
    "data-role": block.role,
    "data-architecture": String(block.architecture),
    "data-tinted": String(viewSettings.colourBy === "block" || block.architecture),
    "data-key": node.key,
  }, layer);
  if (viewSettings.colourBy === "block" && !block.planned) {
    group.style.setProperty("--role", blockColour(graph, ui.view, node.key));
  }

  svgEl("title", {}, group).textContent = [
    `${block.name}, ${block.roleLabel.toLowerCase()}`,
    block.responsibility,
    "Double-click to go to it.",
  ].join("\n\n");

  if (tile.caption) svgEl("text", { x: 2, y: -7, class: "tile-caption" }, group).textContent = tile.caption;

  const body = svgEl("g", { class: "block-body" }, group);
  if (arrivalDelay !== null) {
    body.classList.add("appearing");
    body.style.animationDelay = `${arrivalDelay}ms`;
  }
  svgEl("rect", {
    x: 0,
    y: 0,
    width: TILE_W,
    height: HEAD_H,
    rx: 3,
    class: "block-plate",
    tabindex: "0",
    role: "button",
    "aria-label": node.label,
  }, body);
  const left = tile.expandable ? 22 : 10;
  const name = node.label.length > TILE_NAME_CHARS ? `${node.label.slice(0, TILE_NAME_CHARS - 1)}…` : node.label;
  svgEl("text", { x: left, y: 15, class: "block-name" }, body).textContent = name;
  svgEl("text", { x: left, y: 27, class: "block-kind" }, body).textContent = node.sublabel;
  drawRoleIcon(node, body);
  svgEl("text", { x: TILE_W - 10, y: 27, class: "run-note", "text-anchor": "end" }, body);

  if (tile.expandable) {
    const toggle = svgEl("g", { class: "tile-toggle", transform: `translate(11 ${HEAD_H / 2})` }, group);
    svgEl("title", {}, toggle).textContent = tile.expanded ? `Close ${block.name}` : `Open ${block.name} here, to show its parts`;
    svgEl("circle", { r: 8, class: "tile-toggle-hit" }, toggle);
    svgEl("path", { d: tile.expanded ? "M -3.5 -1.5 L 0 2 L 3.5 -1.5" : "M -1.5 -3.5 L 2 0 L -1.5 3.5", class: "tile-toggle-mark" }, toggle);
    toggle.addEventListener("pointerdown", (event) => event.stopPropagation());
    toggle.addEventListener("dblclick", (event) => event.stopPropagation());
    toggle.addEventListener("click", (event) => {
      event.stopPropagation();
      if (ui.expanded.has(block.path)) ui.expanded.delete(block.path);
      else ui.expanded.add(block.path);
      notify({ redraw: true });
      if (!ui.userAdjusted) fitToView(true);
    });
  }

  nodeElements.set(node.key, group);
  attachNodeBehaviour(group, node);
}

/* -------------------------------------------------------------------------- */
/* Selection, dragging, panning, zooming                                       */
/* -------------------------------------------------------------------------- */

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  moved: boolean;
  origin: Map<string, Point>;
}

let drag: DragState | null = null;

async function persistLayout(): Promise<void> {
  const snapshot = ui.snapshot;
  if (!snapshot || !currentLayout) return;

  const positions: Record<string, Point> = {};
  for (const [key, point] of currentLayout) {
    // Tiles are placed around the diagram, not by hand.
    if (!isContextKey(key)) positions[key] = { x: Math.round(point.x), y: Math.round(point.y) };
  }

  // Keep the open snapshot in step so a later redraw does not snap blocks back.
  snapshot.layout = { ...snapshot.layout, [ui.view]: positions };

  const result = await window.fragmentor.saveLayout({ dir: snapshot.dir, viewPath: ui.view, positions });
  if (!result.ok) {
    ui.status = { text: `Could not save the layout: ${result.error}`, tone: "bad" };
    notify({ redraw: false });
  }
}

function attachNodeBehaviour(group: SVGGElement, node: GraphNode): void {
  group.addEventListener("pointerdown", (event) => {
    event.stopPropagation();

    if (event.ctrlKey || event.metaKey) {
      if (ui.selection.has(node.key)) ui.selection.delete(node.key);
      else ui.selection.add(node.key);
      ui.selectedLink = null;
      applySelection();
      notify({ redraw: false });
      return;
    }

    if (!ui.selection.has(node.key)) {
      ui.selection.clear();
      ui.selection.add(node.key);
      ui.selectedLink = null;
      applySelection();
      notify({ redraw: false });
    }

    // A tile stands where the diagram puts it, so it is picked out but not moved.
    if (!currentLayout || node.context) return;
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      origin: new Map(
        [...ui.selection].filter((key) => !isContextKey(key)).map((key) => [key, { ...(currentLayout!.get(key) ?? { x: 0, y: 0 }) }]),
      ),
    };
    element("canvas-svg").classList.add("dragging");

    // Tracked on the window rather than through pointer capture: the pointer
    // can leave the block it started on, and capture is refused outright for a
    // pointer the browser is not already tracking.
    const onMove = (move: PointerEvent) => {
      if (!drag || drag.pointerId !== move.pointerId || !currentLayout) return;

      const dx = (move.clientX - drag.startX) / ui.zoom;
      const dy = (move.clientY - drag.startY) / ui.zoom;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
        drag.moved = true;
        ui.userAdjusted = true;
      }

      for (const [key, origin] of drag.origin) currentLayout.set(key, { x: origin.x + dx, y: origin.y + dy });
      applyPositions();
    };

    const onUp = (up: PointerEvent) => {
      if (drag && drag.pointerId !== up.pointerId) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);

      element("canvas-svg").classList.remove("dragging");
      const moved = drag?.moved ?? false;
      drag = null;
      if (moved) void persistLayout();
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  });

  // Into a part made of parts; to a tile, wherever it is.
  const go = (): boolean => {
    if (!node.block || node.block.path === ui.view) return false;
    if (node.context) showBlock(node.block.path);
    else if (node.block.children.length > 0) openDiagram(node.block.path);
    else return false;
    return true;
  };

  group.addEventListener("dblclick", (event) => {
    event.stopPropagation();
    go();
  });

  group.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && go()) {
      event.preventDefault();
      return;
    }
    if (event.key !== " ") return;
    event.preventDefault();
    ui.selection.clear();
    ui.selection.add(node.key);
    ui.selectedLink = null;
    applySelection();
    notify({ redraw: false });
  });
}

export function setUpCanvasGestures(): void {
  const svg = element<SVGSVGElement>("canvas-svg");
  let pan: { x: number; y: number; panX: number; panY: number; moved: boolean } | null = null;

  svg.addEventListener("pointerdown", (event) => {
    const target = event.target as Element;
    if (target.closest(".block-box") || target.closest(".access-group")) return;
    pan = { x: event.clientX, y: event.clientY, panX: ui.panX, panY: ui.panY, moved: false };
    svg.classList.add("panning");
    svg.setPointerCapture(event.pointerId);
  });

  svg.addEventListener("pointermove", (event) => {
    if (!pan) return;
    ui.panX = pan.panX + (event.clientX - pan.x);
    ui.panY = pan.panY + (event.clientY - pan.y);
    if (Math.abs(event.clientX - pan.x) > 2 || Math.abs(event.clientY - pan.y) > 2) {
      pan.moved = true;
      ui.userAdjusted = true;
    }
    applyViewport();
  });

  const endPan = () => {
    if (!pan) return;
    svg.classList.remove("panning");
    const clicked = !pan.moved;
    pan = null;
    if (clicked) {
      ui.selection.clear();
      ui.selectedLink = null;
      applySelection();
      notify({ redraw: false });
    }
  };

  svg.addEventListener("pointerup", endPan);
  svg.addEventListener("pointercancel", endPan);

  svg.addEventListener("wheel", (event) => {
    event.preventDefault();
    const rect = svg.getBoundingClientRect();
    zoomAbout(event.clientX - rect.left, event.clientY - rect.top, event.deltaY < 0 ? 1.12 : 1 / 1.12);
  }, { passive: false });
}

export function zoomAbout(px: number, py: number, factor: number): void {
  const next = Math.min(3, Math.max(0.25, ui.zoom * factor));
  const scale = next / ui.zoom;
  ui.panX = px - (px - ui.panX) * scale;
  ui.panY = py - (py - ui.panY) * scale;
  ui.zoom = next;
  ui.userAdjusted = true;
  applyViewport();
}

export function watchCanvasSize(): void {
  if (typeof ResizeObserver !== "function") return;
  new ResizeObserver(() => {
    if (!ui.userAdjusted) fitToView();
  }).observe(element("canvas-wrap"));
}

export function resetLayout(): void {
  const snapshot = ui.snapshot;
  if (!snapshot) return;
  const layout = { ...snapshot.layout };
  delete layout[ui.view];
  snapshot.layout = layout;
  ui.userAdjusted = false;
  notify({ redraw: true });
  void window.fragmentor.saveLayout({ dir: snapshot.dir, viewPath: ui.view, positions: {} });
  fitToView(true);
}
