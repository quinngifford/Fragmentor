import type { SnapshotAccess, SnapshotBlock } from "../../src/project/snapshot.js";
import { BOX_H, BOX_W, buildTree, busY, shownAt, spineX } from "./tree.js";
import type { Tree, TreeNode } from "./tree.js";
import { boxOfStep, buildFlow } from "./flow.js";
import type { Flow, FlowBox } from "./flow.js";
import { BLOCK_PALETTE, COLOUR_BY, blockColours, requireSnapshot, roleColours, ui, viewSettings } from "./state.js";
import type { ColourBy } from "./state.js";
import { el, element } from "./dom.js";
import { ROLES, ROLE_IDS } from "../../src/model/roles.js";
import type { Role } from "../../src/model/roles.js";

/**
 * The canvas: the whole architecture, drawn as one tree.
 *
 * Every block of every system is on screen at once, each under the block it
 * is part of, joined by plain right-angled lines. Those lines say one thing,
 * containment, and nothing else on the drawing is allowed to look like them:
 * what a block can reach is an arrow, and what a run did is an arrow, and
 * both can be put away. Folding a block is the only thing that takes blocks
 * off the drawing, and what happens inside a folded block is then drawn at
 * the block standing for it.
 *
 * Drawing and updating are deliberately separate. Selecting, or stepping
 * through a run, changes attributes on the elements that are already there;
 * only a change to the project, or folding, rebuilds them. That is not an
 * optimisation — an element replaced between two clicks can never receive a
 * double-click.
 */

let notify: (options: { redraw: boolean }) => void = () => {};
export function onCanvasChange(callback: (options: { redraw: boolean }) => void): void {
  notify = callback;
}

const drawnListeners: Array<() => void> = [];
/** Called whenever the tree has been drawn afresh, so anything laid over it can be put back. */
export function onCanvasDrawn(callback: () => void): void {
  drawnListeners.push(callback);
}

let stepPicked: () => void = () => {};
/** Called when the person clicks the step drawn on the tree. */
export function onStepPicked(callback: () => void): void {
  stepPicked = callback;
}

let breakpointToggled: (blockPath: string) => void = () => {};
/** Called when the person clicks a block's breakpoint. */
export function onBreakpointToggle(callback: (blockPath: string) => void): void {
  breakpointToggled = callback;
}

let opened: (kind: "code" | "details", blockPath: string) => void = () => {};
/** Called when the person asks to see a block's code, or what it holds. */
export function onBlockWindow(callback: (kind: "code" | "details", blockPath: string) => void): void {
  opened = callback;
}

let notesPicked: (blockPath: string) => void = () => {};
/** Called when the person clicks the mark saying a block has notes waiting, with the block the first of them is on. */
export function onNotesPicked(callback: (blockPath: string) => void): void {
  notesPicked = callback;
}

let currentTree: Tree | null = null;
let currentFlow: Flow | null = null;

/**
 * The execution to draw as a flow, and how to word each of its steps. Set by
 * whoever holds the trace. `notSeen` is the steps, by their place in it, that
 * a recording contradicts.
 */
type FlowShown = { flow: Flow; at: number; name: (path: string | null) => string; notSeen: Set<number> };
let flowSource: () => FlowShown | null = () => null;
export function onFlowWanted(source: () => FlowShown | null): void {
  flowSource = source;
}

let stepChosen: (at: number) => void = () => {};
/** Called when the person picks one step out of the flow. */
export function onStepChosen(callback: (at: number) => void): void {
  stepChosen = callback;
}
/** The drawn elements, so they can be updated rather than replaced. */
const nodeElements = new Map<string, SVGGElement>();
const accessElements = new Map<string, SVGGElement>();

export function treeInView(): Tree | null {
  return currentTree;
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

export function applyViewport(): void {
  element("viewport").setAttribute("transform", `translate(${ui.panX} ${ui.panY}) scale(${ui.zoom})`);
  element("zoom-level").textContent = `${Math.round(ui.zoom * 100)}%`;
}

/* -------------------------------------------------------------------------- */
/* Colour                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The colour a block is drawn in when the tree is coloured block by block:
 * taken from where it sits in the tree, so neighbours are never given
 * neighbouring hues, and kept for as long as the tree holds the same blocks.
 * A colour chosen by hand wins, and is remembered in this profile.
 */
export function blockColour(path: string): string {
  const chosen = blockColours.get(path);
  if (chosen) return chosen;

  // Taken from where the block sits in the hierarchy, so it is the same
  // colour on the tree, in an execution and in the inspector, and so no two
  // blocks beside each other, or one inside another, are given the same hue.
  const snapshot = ui.snapshot;
  const parent = path.split("/").slice(0, -1).join("/");
  const siblings = parent === "" ? (snapshot?.systems.map((system) => system.rootBlock) ?? []) : (snapshot?.blocks[parent]?.children ?? []);
  const depth = path.split("/").length - 1;
  const at = Math.max(0, siblings.indexOf(path));
  return BLOCK_PALETTE[(depth * 3 + at) % BLOCK_PALETTE.length]!;
}

/* -------------------------------------------------------------------------- */
/* Updating what is already drawn                                             */
/* -------------------------------------------------------------------------- */

export function applySelection(): void {
  for (const [path, group] of nodeElements) group.dataset.selected = String(ui.selection.has(path));
  for (const [id, group] of accessElements) group.dataset.selected = String(ui.selectedLink === id);
}

export function applyBreakpoints(): void {
  for (const [path, group] of nodeElements) group.dataset.breakpoint = String(ui.breakpoints.has(path));
}

/** Whether the arrows saying what each block can reach are drawn. */
export function applyDependencies(): void {
  element<SVGSVGElement>("canvas-svg").dataset.dependencies = ui.showDependencies ? "shown" : "hidden";
}

/** A run laid over the tree: how each block, and whatever is inside it, is doing. */
export interface RunOverlay {
  /** How each block is doing, and whether the run went wrong in it, rather than only inside it. */
  nodes: Map<string, { state: "running" | "paused" | "done" | "failed" | "stopped"; note: string; flag?: boolean }>;
}

export function applyRunOverlay(overlay: RunOverlay | null): void {
  for (const [path, group] of nodeElements) {
    const run = overlay?.nodes.get(path);
    if (run) group.dataset.run = run.state;
    else delete group.dataset.run;
    group.dataset.runFlag = String(run?.flag ?? false);
    const note = group.querySelector<SVGTextElement>(".run-note");
    if (note) note.textContent = run?.note ?? "";
    const kind = group.querySelector<SVGTextElement>(".block-kind");
    if (note && kind) makeRoomForNote(kind, note);
  }
}

/**
 * A note shares its line with the block's kind, and a long kind, such as a
 * database's, would run into it until neither could be read. The kind gives
 * way while the note is there, and comes back whole when it goes.
 */
function makeRoomForNote(kind: SVGTextElement, note: SVGTextElement): void {
  const whole = (kind.dataset.whole ??= kind.textContent ?? "");
  kind.textContent = whole;
  if (!note.textContent) return;
  const room = Number(note.getAttribute("x")) - note.getComputedTextLength() - 6 - Number(kind.getAttribute("x"));
  let shown = whole;
  while (shown.length > 1 && kind.getComputedTextLength() > room) {
    shown = shown.slice(0, -1);
    kind.textContent = `${shown.trimEnd()}…`;
  }
}

/* -------------------------------------------------------------------------- */
/* One step of an execution                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The step on screen: one arrow between two blocks, or one thing a run left
 * at a block. Only ever one at a time — the whole of an execution is a
 * drawing of its own, not a web over the architecture.
 *
 * An arrow runs the way the step does, so its head is always where the step
 * arrives. An answer coming back out of whoever was called is therefore drawn
 * out of that block and into whoever asked, rather than along the call it
 * answers the other way round.
 */
export interface ExecutionMark {
  /** Where the step leaves: a block, or null for outside the system. */
  from: string | null;
  /** Where it arrives: a block, or null where it goes back outside. Where an effect is marked. */
  to: string | null;
  label: string;
  /** The whole step in words, for hovering over the arrow. */
  title: string;
  /** Whether anything travelled, which is drawn as flow rather than as a line lighting up. */
  data: boolean;
  /** An answer coming back, which the arrow is already drawn the way of. */
  back: boolean;
  /** Set when the step is something the run left behind rather than a move between blocks. */
  effect: string | null;
}

interface Point {
  x: number;
  y: number;
}

let currentMark: ExecutionMark | null = null;

export function applyExecutionMark(mark: ExecutionMark | null): void {
  currentMark = mark;
  element("canvas-svg").classList.toggle("tracing", mark !== null);
  const lit = new Set(mark ? [mark.from, mark.to].filter((each): each is string => each !== null) : []);
  for (const [path, group] of nodeElements) group.dataset.current = String(lit.has(path));
  drawExecutionMark();
}

/**
 * Which way an arrow has to go round the two blocks it joins, where there is
 * no room between them to draw it: over the top of both, or out to one side.
 */
type Round = "above" | "beside" | null;

/** Where an arrow between two blocks leaves and arrives, and how it goes round them. */
function arrowEnds(a: TreeNode, b: TreeNode): { start: Point; end: Point; round: Round } {
  const across = Math.max(a.x, b.x) - Math.min(a.x + BOX_W, b.x + BOX_W);
  const down = Math.max(a.y, b.y) - Math.min(a.y + BOX_H, b.y + BOX_H);
  const sameRow = Math.abs(a.y - b.y) < BOX_H * 1.2;
  const sameColumn = Math.abs(a.x - b.x) < BOX_W * 0.9;

  // Two blocks with next to nothing between them leave an arrow nowhere to be
  // drawn: squeezed into the gap it is a squiggle with its head cut off, and
  // its word does not fit there at all. So it goes round the outside of both
  // instead — over the top of two standing side by side, and out to the side
  // of one sitting on top of another.
  if (sameRow && across < 90) {
    return { start: { x: a.x + BOX_W / 2, y: a.y }, end: { x: b.x + BOX_W / 2, y: b.y }, round: "above" };
  }
  // Parts listed under a block stand ten pixels apart, and the first of them
  // twenty-two under the block itself, which is what this is for. Always out
  // to the right: what is on their left is the line down from the block they
  // are part of, and an arrow crossing that reads as if it meant something.
  if (sameColumn && down < 2 * (LABEL_H + LABEL_CLEAR)) {
    return {
      start: { x: a.x + BOX_W, y: a.y + BOX_H / 2 },
      end: { x: b.x + BOX_W, y: b.y + BOX_H / 2 },
      round: "beside",
    };
  }

  const start = sideOf({ x: b.x + BOX_W / 2, y: b.y + BOX_H / 2 }, a);
  return { start, end: sideOf(start, b), round: null };
}

/**
 * Where the whole arrow runs: between two blocks, or between a block and
 * outside the system, which is a place off to that block's left rather than a
 * box of its own. Either end can be the outside one: a trigger arrives from
 * there, and the answer a recording ends on goes back there.
 */
function markEnds(
  from: TreeNode | null,
  to: TreeNode | null,
): { start: Point; end: Point; round: Round; outside: Point | null } | null {
  if (from && to) return { ...arrowEnds(from, to), outside: null };
  const block = from ?? to;
  if (!block) return null;
  const outside = outsideAt(block);
  const edge = sideOf(outside, block);
  return from ? { start: edge, end: outside, round: null, outside } : { start: outside, end: edge, round: null, outside };
}

/** How much room the mark for outside the system takes: a dot with its word over it. */
const OUTSIDE_W = 50;
const OUTSIDE_H = 26;

/**
 * Where outside the system is marked for a block: to its left at its own
 * height, and failing that wherever nearby is clear — further out, past it,
 * or a row up or down.
 *
 * Nothing on the tree stands for outside, so the mark landing on a block
 * would read as that block being outside the system, and it is drawn over the
 * blocks now, so it can no longer hide behind one. A block deep in a crowded
 * row can have nothing beside it at all: a run starting at the last of a
 * block's parts has its own siblings above and below it and whatever the
 * system keeps to its left.
 */
function outsideAt(block: TreeNode): Point {
  const middle = block.y + BOX_H / 2;
  const columns = [block.x - 74, block.x - 150, block.x + BOX_W + 74];
  for (const y of [middle, block.y - 24, block.y + BOX_H + 24]) {
    for (const x of columns) {
      if (clearOf(x - OUTSIDE_W / 2, y - OUTSIDE_H + 7, OUTSIDE_W, OUTSIDE_H)) return { x, y };
    }
  }
  return { x: block.x - 74, y: middle };
}

/** Where an arrow meets a block: on the side it comes from, or on the edge it comes over. */
function sideOf(from: Point, node: TreeNode): Point {
  const middle = { x: node.x + BOX_W / 2, y: node.y + BOX_H / 2 };
  if (Math.abs(from.x - middle.x) > BOX_W / 2) {
    return { x: from.x < middle.x ? node.x : node.x + BOX_W, y: middle.y };
  }
  return { x: middle.x, y: from.y < middle.y ? node.y : node.y + BOX_H };
}

/**
 * An arc between two points, bowed clear of whatever it runs between, with
 * `at` giving any point along it.
 *
 * Always an arc, never a straight line: the tree's own lines are straight, and
 * an arrow must never be taken for one. Two blocks side by side are only a
 * gap apart, so the bow is what gives the arrow, and its word, room to be
 * seen at all.
 */
function arrowPath(start: Point, end: Point, round: Round = null): { d: string; at: (t: number) => Point } {
  const span = Math.hypot(end.x - start.x, end.y - start.y) || 1;
  const bow = Math.max(26, Math.min(70, span * 0.22));
  // Two blocks all but touching leave no room between them, so the arrow goes
  // round the outside of them, where it and its word can be read.
  const control = round === "above"
    ? { x: (start.x + end.x) / 2, y: Math.min(start.y, end.y) - 34 - span * 0.06 }
    : round === "beside"
    ? { x: Math.max(start.x, end.x) + 40 + span * 0.06, y: (start.y + end.y) / 2 }
    : (() => {
        // Otherwise bowed upwards across the drawing, and sideways up or down
        // it, so the two ends never hide behind each other.
        const across = Math.abs(end.x - start.x) >= Math.abs(end.y - start.y);
        const normal = across
          ? { x: 0, y: -1 * Math.sign(end.x - start.x || 1) }
          : { x: Math.sign(end.y - start.y || 1), y: 0 };
        return { x: (start.x + end.x) / 2 + normal.x * bow, y: (start.y + end.y) / 2 + normal.y * bow };
      })();
  // Stopped short along the way in, so the arrowhead is not covered by the block.
  const toward = { x: end.x - control.x, y: end.y - control.y };
  const length = Math.hypot(toward.x, toward.y) || 1;
  const stop = { x: end.x - (toward.x / length) * 9, y: end.y - (toward.y / length) * 9 };
  return {
    d: `M ${start.x} ${start.y} Q ${control.x} ${control.y}, ${stop.x} ${stop.y}`,
    at: (t: number) => ({
      x: (1 - t) * (1 - t) * start.x + 2 * (1 - t) * t * control.x + t * t * stop.x,
      y: (1 - t) * (1 - t) * start.y + 2 * (1 - t) * t * control.y + t * t * stop.y,
    }),
  };
}

/** How wide a chip is for its words, which are set in a monospaced 9px. */
const chipWidth = (text: string) => text.length * 5.6 + 14;
const CHIP_H = 15;
/** And the word on an arrow, set a little larger. */
const labelWidth = (text: string) => text.length * 5.9 + 12;
const LABEL_H = 14;
/** How far the word stands off the arrow, so the line still reads under it. */
const LABEL_CLEAR = 7;

/** Whether a box put here would land on a block: parts listed under a block sit close under it. */
function clearOf(x: number, y: number, width: number, height: number): boolean {
  for (const node of currentTree?.nodes.values() ?? []) {
    if (x < node.x + BOX_W && node.x < x + width && y < node.y + BOX_H && node.y < y + height) return false;
  }
  return true;
}

/**
 * Where the word on an arrow goes: along the arrow, at the first place clear
 * of every block, above the line where there is room for it and below where
 * there is not.
 *
 * The arrow is drawn over the blocks rather than under them, so it is never
 * hidden; its word is one short word on a crowded drawing, and putting it
 * where nothing else is written is what keeps it readable. Given nowhere
 * clear it stays in the middle, where its own plate carries it.
 */
function labelSpot(at: (t: number) => Point, width: number): Point {
  const beside = LABEL_CLEAR + width / 2;
  for (const t of [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74]) {
    const point = at(t);
    // Over the arrow, under it, or out to either side of it, which is where
    // the room is when the arrow is the one that went round a block.
    for (const spot of [
      { x: point.x, y: point.y - LABEL_CLEAR - LABEL_H },
      { x: point.x, y: point.y + LABEL_CLEAR },
      { x: point.x + beside, y: point.y - LABEL_H / 2 },
      { x: point.x - beside, y: point.y - LABEL_H / 2 },
    ]) {
      if (clearOf(spot.x - width / 2, spot.y, width, LABEL_H)) return spot;
    }
  }
  const middle = at(0.5);
  return { x: middle.x, y: middle.y - LABEL_CLEAR - LABEL_H };
}

function drawExecutionMark(): void {
  const layer = element("exec-layer");
  layer.replaceChildren();
  const mark = currentMark;
  if (!mark || !currentTree) return;

  // Something the run left behind: a chip over the block responsible, or
  // under it where the block above leaves no room.
  if (mark.effect !== null) {
    const at = mark.to === null ? null : currentTree.nodes.get(mark.to);
    if (!at) return;
    const width = chipWidth(mark.effect);
    const group = svgEl("g", { class: "exec-effect", "data-current": "true" }, layer);
    const x = at.x + BOX_W / 2 - width / 2;
    const y = clearOf(x, at.y - 22, width, CHIP_H) ? at.y - 22 : at.y + BOX_H + 7;
    svgEl("rect", { x, y, width, height: CHIP_H, rx: CHIP_H / 2, class: "exec-effect-chip" }, group);
    svgEl("text", { x: x + width / 2, y: y + 10.5, class: "exec-effect-text", "text-anchor": "middle" }, group).textContent =
      mark.effect;
    return;
  }

  const from = mark.from === null ? null : (currentTree.nodes.get(mark.from) ?? null);
  const to = mark.to === null ? null : (currentTree.nodes.get(mark.to) ?? null);
  // A block the drawing has lost leaves nothing to draw the step between.
  if ((mark.from !== null && !from) || (mark.to !== null && !to)) return;
  const between = markEnds(from, to);
  if (!between) return;
  const geometry = arrowPath(between.start, between.end, between.round);

  if (between.outside) {
    const outside = svgEl("g", { class: "exec-outside" }, layer);
    svgEl("circle", { cx: between.outside.x, cy: between.outside.y, r: 4.5, class: "exec-outside-dot" }, outside);
    svgEl("text", {
      x: between.outside.x,
      y: between.outside.y - 9,
      class: "exec-outside-label",
      "text-anchor": "middle",
    }, outside).textContent = "outside";
  }

  const group = svgEl("g", {
    class: "exec-line-group",
    "data-data": String(mark.data),
    "data-current": mark.back ? "back" : "out",
  }, layer);
  svgEl("path", { d: geometry.d, class: "exec-line", "marker-end": "url(#exec-arrow)" }, group);
  svgEl("title", {}, group).textContent = mark.title;

  const width = labelWidth(mark.label);
  const spot = labelSpot(geometry.at, width);
  svgEl("rect", { x: spot.x - width / 2, y: spot.y, width, height: LABEL_H, rx: 3, class: "exec-label-plate" }, group);
  svgEl("text", { x: spot.x, y: spot.y + 10.5, class: "exec-label", "text-anchor": "middle" }, group).textContent = mark.label;

  // The step is a thing in its own right, with its own page, opened from its
  // word: the only part of the arrow that takes a click, because it is the
  // only part put somewhere no block is.
  group.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
    stepPicked();
  });
}

/* -------------------------------------------------------------------------- */
/* The camera                                                                  */
/* -------------------------------------------------------------------------- */

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

/** Part of the way from one camera to another. Scale moves geometrically, which is how a zoom looks steady. */
function between(a: Camera, b: Camera, t: number): Camera {
  return {
    cx: a.cx + (b.cx - a.cx) * t,
    cy: a.cy + (b.cy - a.cy) * t,
    scale: a.scale * Math.pow(b.scale / a.scale, t),
  };
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/**
 * Runs `step` with eased progress from 0 to 1 over `duration`, for as long as
 * `current` says nothing newer has taken over. A window that is not being
 * painted gets no animation frames, so rather than leave a move half made, it
 * is finished without them.
 */
function tween(duration: number, step: (t: number) => void, current: () => boolean): void {
  const started = performance.now();
  let finished = false;
  const finish = () => {
    finished = true;
    clearTimeout(fallback);
  };
  const fallback = setTimeout(() => {
    if (finished) return;
    if (current()) step(1);
    finish();
  }, duration + 250);

  const frame = (now: number) => {
    if (finished) return;
    if (!current()) return finish();
    const progress = Math.min(1, (now - started) / duration);
    step(ease(progress));
    if (progress < 1) requestAnimationFrame(frame);
    else finish();
  };
  requestAnimationFrame(frame);
}

/** Each new move, or fit, takes over from the one before it. */
let moves = 0;

function treeBounds(): Box | null {
  if (currentFlow) {
    return { x: -30, y: -30, width: currentFlow.width + 60, height: currentFlow.height + 90 };
  }
  if (!currentTree || currentTree.nodes.size === 0) return null;
  return boundsOf(currentTree);
}

/** The room a tree takes, with a margin round it for what is drawn beside its boxes. */
export function boundsOf(tree: Tree): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of tree.nodes.values()) {
    minX = Math.min(minX, node.x - 30);
    minY = Math.min(minY, node.y - 34);
    maxX = Math.max(maxX, node.x + BOX_W + 30);
    maxY = Math.max(maxY, node.y + BOX_H + 30);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** The furthest out the drawing goes, by zooming or by Fit. */
const SMALLEST_SCALE = 0.2;

/**
 * The furthest out a fit made on the person's behalf goes: the size at which
 * a block's name can still be read. A large system is then bigger than the
 * window, so it opens at its top, a drag away from the rest, rather than all
 * of it in specks. Fit still shows everything, however small that makes it.
 */
export const READABLE_SCALE = 0.6;

/**
 * The camera that fits a drawing into a canvas of the given size.
 *
 * With nothing to start from, the whole drawing is shrunk until it is all in
 * view. Otherwise it is shrunk no further than READABLE_SCALE, and a drawing
 * still too big is shown from its top, just under whatever `clearAtTop`
 * pixels the bars along the top of the canvas take, and across from where it
 * starts: the top block of the first system, kept far enough in that the
 * view does not open on empty space beside the drawing.
 */
export function fittedCamera(bounds: Box, width: number, height: number, startsAt: number | null, clearAtTop = 0): Camera {
  // Fitting shrinks the tree to make it visible; it never magnifies it, or a
  // project with one block in it would open absurdly zoomed in.
  const whole = Math.min(1, Math.max(SMALLEST_SCALE, Math.min(width / bounds.width, height / bounds.height)));
  const centre = { cx: bounds.x + bounds.width / 2, cy: bounds.y + bounds.height / 2 };
  if (startsAt === null || whole >= READABLE_SCALE) return { ...centre, scale: whole };

  const scale = READABLE_SCALE;
  const halfWide = width / 2 / scale;
  return {
    cx: bounds.width <= 2 * halfWide ? centre.cx : Math.min(Math.max(startsAt, bounds.x + halfWide), bounds.x + bounds.width - halfWide),
    cy: bounds.y + (height / 2 - clearAtTop) / scale,
    scale,
  };
}

function fitCamera(): Camera | null {
  const bounds = treeBounds();
  const { width, height } = canvasSize();
  if (!bounds || !width || !height) return null;
  if (ui.fitsWhole) return fittedCamera(bounds, width, height, null);

  // A run drawn end to end starts at its left; the tree at its first system.
  const top = currentFlow ? null : currentTree?.roots[0];
  const bars = document.querySelector(".canvas-top")?.getBoundingClientRect();
  const clearAtTop = bars ? Math.max(0, bars.bottom - element("canvas-svg").getBoundingClientRect().top) : 0;
  return fittedCamera(bounds, width, height, top ? top.x + BOX_W / 2 : bounds.x, clearAtTop);
}

/** Brings the tree into view: the whole of it once Fit has been pressed, and otherwise as much as can be read. */
export function fitToView(animated = false): void {
  const target = fitCamera();
  if (!target) return;

  const id = ++moves;
  if (!animated || lessMotion()) {
    setCamera(target);
    return;
  }
  const start = currentCamera();
  tween(320, (t) => setCamera(between(start, target, t)), () => id === moves);
}

/** The canvas has no size until layout settles, so keep asking. `then` follows the fit, once there is one. */
export function fitWhenReady(attempts: number, then?: () => void): void {
  const rect = element("canvas-svg").getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) {
    fitToView();
    then?.();
    return;
  }
  if (attempts > 0) requestAnimationFrame(() => fitWhenReady(attempts - 1, then));
}

/** Eases the canvas over to a point, without changing how far out it is zoomed. */
function moveToPoint(cx: number, cy: number): void {
  const id = ++moves;
  const start = currentCamera();
  const target = { cx, cy, scale: start.scale };
  if (lessMotion()) setCamera(target);
  else tween(300, (t) => setCamera(between(start, target, t)), () => id === moves);
}

/**
 * Brings one block into view and selects it: the tree is unfolded as far as
 * it takes to show it, and the canvas eases over to where it stands.
 */
export function revealBlock(path: string): void {
  const snapshot = ui.snapshot;
  if (!snapshot || !snapshot.blocks[path]) return;

  // Anything folded between the system and the block is opened, or there
  // would be nothing to bring into view.
  const segments = path.split("/");
  let unfolded = false;
  for (let depth = 1; depth < segments.length; depth += 1) {
    if (ui.folded.delete(segments.slice(0, depth).join("/"))) unfolded = true;
  }

  ui.selection.clear();
  ui.selection.add(path);
  ui.selectedLink = null;
  notify({ redraw: unfolded });
  if (!unfolded) applySelection();

  const node = currentTree?.nodes.get(path);
  if (node) moveToPoint(node.x + BOX_W / 2, node.y + BOX_H / 2);
}

/** Brings whichever blocks a step joins into view, when they are off screen. */
export function keepInView(paths: string[]): void {
  if (!currentTree) return;
  const boxes = paths.map((path) => currentTree!.nodes.get(path)).filter((node): node is TreeNode => Boolean(node));
  if (boxes.length === 0) return;

  const { width, height } = canvasSize();
  const onScreen = boxes.every((node) => {
    const x = node.x * ui.zoom + ui.panX;
    const y = node.y * ui.zoom + ui.panY;
    return x > 0 && y > 0 && x + BOX_W * ui.zoom < width && y + BOX_H * ui.zoom < height;
  });
  if (onScreen) return;

  const cx = boxes.reduce((total, node) => total + node.x + BOX_W / 2, 0) / boxes.length;
  const cy = boxes.reduce((total, node) => total + node.y + BOX_H / 2, 0) / boxes.length;
  moveToPoint(cx, cy);
}

/* -------------------------------------------------------------------------- */
/* Drawing                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * What the tree held when it was last drawn, so that blocks the agent adds
 * can be told apart from those already there. Opening a project forgets it
 * all: blocks that were there all along are simply there.
 */
let drawnBefore: Set<string> | null = null;
let everythingArrives = false;
/**
 * When each block's arrival began, so a redraw inside the animation, such as
 * the Changes bar's after git answers, carries it on from where it was
 * instead of cutting it short: a negative delay starts an animation part-way through.
 */
const arrivals = new Map<string, number>();

/** Called when a project is opened. In one the agent has not started on, each block arrives as it is written. */
export function resetArrivals(projectIsEmpty: boolean): void {
  drawnBefore = null;
  everythingArrives = projectIsEmpty;
  arrivals.clear();
}

export function clearCanvas(): void {
  for (const id of ["branch-layer", "access-layer", "node-layer", "exec-layer"]) {
    element(id).replaceChildren();
  }
  nodeElements.clear();
  accessElements.clear();
  currentTree = null;
  currentFlow = null;
  document.querySelectorAll(".canvas-empty").forEach((each) => each.remove());
  renderLegend(false);
  showCanvasChrome(false);
}

/**
 * The zoom bar and the gesture hint are about a drawing, so an empty canvas
 * — the waiting card, the welcome screen, a note — shows neither. Drawing
 * again brings them back in the same breath.
 */
function showCanvasChrome(showing: boolean): void {
  for (const each of document.querySelectorAll<HTMLElement>(".zoom-bar, .canvas-top .hint")) each.hidden = !showing;
}

/**
 * Empties the canvas and leaves a note where the tree would be: plain words,
 * or something built already, which has to carry the `canvas-empty` class so
 * that it goes again when the canvas is next cleared.
 */
export function showCanvasMessage(message: string | HTMLElement): void {
  clearCanvas();
  if (typeof message !== "string") {
    element("canvas-wrap").append(message);
    return;
  }
  const note = document.createElement("p");
  note.className = "canvas-empty";
  note.textContent = message;
  element("canvas-wrap").append(note);
}

/** Blocks arriving together come in one after another, the way they were written. */
const ARRIVAL_STAGGER_MS = 70;
/** The longest an arrival takes once begun: the plate's light, after the longest stagger. */
const ARRIVAL_MS = 1800 + 12 * ARRIVAL_STAGGER_MS;

/**
 * How long until this block's arrival begins, negative once it has: null for
 * a block that is simply there. Begun now for a block arriving in this draw.
 */
export function arrivalDelayOf(arrivals: Map<string, number>, path: string, arriving: number, now: number): number | null {
  if (arriving !== -1) arrivals.set(path, now + Math.min(arriving, 12) * ARRIVAL_STAGGER_MS);
  const began = arrivals.get(path);
  if (began === undefined) return null;
  if (began - now < -ARRIVAL_MS) {
    arrivals.delete(path);
    return null;
  }
  return began - now;
}

export function renderCanvas(): void {
  clearCanvas();

  if (ui.shows === "flow") {
    renderFlow();
    return;
  }

  const tree = buildTree(ui.folded);
  if (tree.nodes.size === 0) {
    showCanvasMessage("This project has no blocks yet.");
    return;
  }
  showCanvasChrome(true);
  currentTree = tree;

  const before = drawnBefore ?? (everythingArrives ? new Set<string>() : null);
  const arriving = before ? [...tree.nodes.keys()].filter((path) => !before.has(path)) : [];

  drawBranches(tree, element("branch-layer"));
  drawAccesses(tree, element("access-layer"));
  const nodeLayer = element("node-layer");
  const marks = noteMarks(tree);
  const changed = changeDots(tree);
  const now = performance.now();
  for (const node of tree.nodes.values()) {
    drawNode(node, nodeLayer, arrivalDelayOf(arrivals, node.path, arriving.indexOf(node.path), now), marks.get(node.path), changed.get(node.path));
  }

  renderLegend(true);
  drawnBefore = new Set(tree.nodes.keys());
  everythingArrives = false;

  applyDependencies();
  applySelection();
  applyBreakpoints();
  applyViewport();
  for (const listener of drawnListeners) listener();
}

/* -------------------------------------------------------------------------- */
/* One execution, end to end                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The execution being stepped through, as its own drawing: every step in
 * order, left to right, wrapping onto another row when it runs out of width.
 *
 * Nothing here is the architecture. A block is drawn once for every time the
 * run is at it, so the drawing only ever goes forwards.
 */
function renderFlow(): void {
  const shown = flowSource();
  if (!shown) {
    showCanvasMessage("Pick an execution above to see it from beginning to end.");
    return;
  }

  showCanvasChrome(true);
  currentFlow = shown.flow;
  const layer = element("node-layer");
  // The lines of the drawing itself, which the step showing never clears.
  const lines = element("branch-layer");
  const current = boxOfStep(shown.flow, shown.at);

  shown.flow.boxes.forEach((box, at) => {
    const before = at > 0 ? shown.flow.boxes[at - 1]! : null;
    if (box.arrow && before) drawFlowArrow(before, box, box === current, lines);
    drawFlowBox(box, shown.name(box.path), box === current, shown.at, shown.notSeen, layer);
  });

  applyViewport();
  for (const listener of drawnListeners) listener();
}

/** One box of the flow: where the run was, at that moment. */
function drawFlowBox(box: FlowBox, name: string, current: boolean, at: number, notSeen: Set<number>, layer: Element): void {
  const block = (box.path === null ? null : ui.snapshot?.blocks[box.path]) ?? null;
  // A step the recording contradicts glows red as a failure does, wherever
  // it is drawn: the arrow into this box, or something left here.
  const failing = (box.arrow !== null && notSeen.has(box.arrow.at)) || box.effects.some((effect) => notSeen.has(effect.at));
  const group = svgEl("g", {
    class: "block-box flow-box",
    transform: `translate(${box.x} ${box.y})`,
    "data-role": block?.role ?? "function",
    "data-planned": String(Boolean(block?.planned)),
    "data-architecture": String(Boolean(block?.architecture)),
    "data-tinted": String(block !== null && (viewSettings.colourBy === "block" || block.architecture)),
    "data-current": String(current),
    "data-failing": String(failing),
    "data-key": box.path ?? "(outside)",
  }, layer);
  if (block && viewSettings.colourBy === "block" && !block.planned) {
    group.style.setProperty("--role", blockColour(block.path));
  }

  const body = svgEl("g", { class: "block-body" }, group);
  svgEl("rect", { x: 0, y: 0, width: BOX_W, height: BOX_H, rx: 3, class: "block-plate" }, body);
  svgEl("text", { x: 12, y: 17, class: "block-name" }, body).textContent =
    name.length > NAME_CHARS ? `${name.slice(0, NAME_CHARS - 1)}…` : name;
  svgEl("text", { x: 12, y: 30, class: "block-kind" }, body).textContent = block?.roleLabel ?? "OUTSIDE THE SYSTEM";

  // What the run left while it was here, under the box it left it at.
  box.effects.forEach((effect, row) => {
    const width = chipWidth(effect.label);
    const chip = svgEl("g", { class: "exec-effect", "data-current": String(effect.at === at) }, group);
    const y = BOX_H + 8 + row * (CHIP_H + 4);
    svgEl("rect", { x: 0, y, width, height: CHIP_H, rx: CHIP_H / 2, class: "exec-effect-chip" }, chip);
    svgEl("text", { x: width / 2, y: y + 10.5, class: "exec-effect-text", "text-anchor": "middle" }, chip).textContent =
      effect.label;
    chip.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
      stepChosen(effect.at);
    });
  });

  if (box.arrow) {
    const at = box.arrow.at;
    group.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
      stepChosen(at);
    });
  }
  if (block) svgEl("title", {}, group).textContent = `${block.name} — ${block.responsibility}`;
}

/** The step between one box and the next: along the row, or down onto the next one. */
function drawFlowArrow(from: FlowBox, to: FlowBox, current: boolean, layer: Element): void {
  const arrow = to.arrow!;
  const sameRow = from.y === to.y;
  // Along the row, or round the end of it: out to the right, down, back
  // across, and into the first box of the next row.
  const geometry = sameRow
    ? {
        d: `M ${from.x + BOX_W} ${from.y + BOX_H / 2} H ${to.x - 9}`,
        middle: { x: (from.x + BOX_W + to.x) / 2, y: from.y + BOX_H / 2 },
      }
    : (() => {
        const out = from.x + BOX_W + 26;
        const back = to.x - 26;
        const down = (from.y + BOX_H + to.y) / 2;
        return {
          d: `M ${from.x + BOX_W} ${from.y + BOX_H / 2} H ${out} V ${down} H ${back} V ${to.y + BOX_H / 2} H ${to.x - 9}`,
          middle: { x: (out + back) / 2, y: down },
        };
      })();

  const group = svgEl("g", {
    class: "exec-line-group",
    "data-data": String(arrow.data),
    "data-current": current ? (arrow.back ? "back" : "out") : "none",
  }, layer);
  svgEl("path", { d: geometry.d, class: "exec-line", "marker-end": "url(#exec-arrow)" }, group);
  svgEl("path", { d: geometry.d, class: "line-hit" }, group);
  svgEl("text", {
    x: geometry.middle.x,
    y: geometry.middle.y - 7,
    class: "exec-label",
    "text-anchor": "middle",
  }, group).textContent = arrow.label;
  group.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
    stepChosen(arrow.at);
  });
}

/** The lines saying what is part of what: down out of a block, across, and down into each part. */
function drawBranches(tree: Tree, layer: Element): void {
  for (const node of tree.nodes.values()) {
    if (node.children.length === 0) continue;

    if (node.listed) {
      // Parts with no parts of their own are listed down the side of the
      // block they belong to, with a stub into each.
      const spine = spineX(node);
      const last = node.children[node.children.length - 1]!;
      svgEl("path", { d: `M ${spine} ${node.y + BOX_H} V ${last.y + BOX_H / 2}`, class: "branch" }, layer);
      for (const child of node.children) {
        svgEl("path", { d: `M ${spine} ${child.y + BOX_H / 2} H ${child.x}`, class: "branch" }, layer);
      }
      continue;
    }

    const turn = busY(node);
    const first = node.children[0]!;
    const last = node.children[node.children.length - 1]!;
    svgEl("path", { d: `M ${node.x + BOX_W / 2} ${node.y + BOX_H} V ${turn}`, class: "branch" }, layer);
    if (node.children.length > 1) {
      svgEl("path", { d: `M ${first.x + BOX_W / 2} ${turn} H ${last.x + BOX_W / 2}`, class: "branch" }, layer);
    }
    for (const child of node.children) {
      svgEl("path", { d: `M ${child.x + BOX_W / 2} ${turn} V ${child.y}`, class: "branch" }, layer);
    }
  }
}

/** Everything one block reaches in another with the same verb, as one arrow. */
export interface AccessArrow {
  id: string;
  source: string;
  target: string;
  verb: SnapshotAccess["verb"];
  entries: SnapshotAccess[];
}

/**
 * What each block is able to reach, gathered onto whatever is on screen: a
 * block folded away is reached through the block standing for it. These are
 * standing facts about the architecture, never a record of what happened, so
 * they are drawn as arrows and can be put away altogether.
 */
export function accessArrows(tree: Tree): Map<string, AccessArrow> {
  const snapshot = requireSnapshot();
  const arrows = new Map<string, AccessArrow>();

  for (const block of Object.values(snapshot.blocks)) {
    const source = shownAt(tree, block.path);
    if (!source) continue;
    for (const access of block.access) {
      if (access.resourcePath === null) continue;
      const target = shownAt(tree, access.resourcePath);
      // Reaching something drawn at the same block is already said by the tree.
      if (!target || target.path === source.path) continue;
      const id = `${source.path}=>${target.path}:${access.verb}`;
      const arrow = arrows.get(id) ?? { id, source: source.path, target: target.path, verb: access.verb, entries: [] };
      if (!arrow.entries.some((each) => each.text === access.text)) arrow.entries.push(access);
      arrows.set(id, arrow);
    }
  }
  return arrows;
}

function accessLabel(arrow: AccessArrow, target: SnapshotBlock): string {
  if (arrow.entries.length === 1) {
    const only = arrow.entries[0]!;
    return only.entry === null ? only.verb : `${only.verb} ${only.entry}`;
  }
  const named = arrow.entries.filter((entry) => entry.entry !== null).length;
  if (named !== arrow.entries.length) return arrow.verb;
  // Counted in whatever the resource calls them, so "calls 2 operations"
  // reads as the two it is rather than as a number nobody can place.
  return `${arrow.verb} ${named} ${ROLES[target.role].entryNoun}s`;
}

function drawAccesses(tree: Tree, layer: Element): void {
  for (const arrow of accessArrows(tree).values()) {
    const source = tree.nodes.get(arrow.source);
    const target = tree.nodes.get(arrow.target);
    if (!source || !target) continue;
    const planned = source.block.planned || target.block.planned;

    const group = svgEl("g", {
      class: "access-group",
      "data-access": arrow.id,
      "data-planned": String(planned),
      "data-role": target.block.role,
    }, layer);
    // Coloured block by block, a line matches the block the data comes out
    // of, so one colour can be followed from where it starts.
    // Reading takes data out of what is read, so that line is the colour of
    // the store; everything else is the colour of the block that reaches.
    if (viewSettings.colourBy === "block" && !planned) {
      group.style.setProperty("--role", blockColour(arrow.verb === "reads" ? target.path : source.path));
    }

    const between = arrowEnds(source, target);
    const geometry = arrowPath(between.start, between.end, between.round);
    const middle = geometry.at(0.5);

    svgEl("path", { d: geometry.d, class: "access", "marker-end": "url(#access-arrow)" }, group);
    svgEl("path", { d: geometry.d, class: "line-hit" }, group);
    svgEl("title", {}, group).textContent = [
      `${source.block.name} → ${target.block.name}`,
      ...arrow.entries.map((entry) => entry.text),
      planned ? "Planned: not built yet." : "",
    ]
      .filter(Boolean)
      .join("\n");
    svgEl("text", {
      x: middle.x,
      y: middle.y - 5,
      class: "access-label",
      "text-anchor": "middle",
    }, group).textContent = accessLabel(arrow, target.block);

    group.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
      ui.selection.clear();
      ui.selectedLink = arrow.id;
      applySelection();
      notify({ redraw: false });
    });

    accessElements.set(arrow.id, group);
  }
}

/**
 * A mark in the corner of every block saying what kind of thing it is.
 *
 * The label beside it says it in words, but a word has to be read and a shape
 * does not: at a glance across a whole system the cylinders are the stores and
 * the people are the clients. Each is drawn in a 12 by 12 box, as strokes
 * only, so it takes the colour of whatever it sits on.
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

/** Only a block Fragmentor runs can be paused on the way through. */
function canPause(block: SnapshotBlock): boolean {
  return block.runnable;
}

/** Whether there is code to show, and whether there is anything else worth a window of its own. */
export function hasCode(block: SnapshotBlock): boolean {
  return block.code !== null;
}

export function hasDetails(block: SnapshotBlock): boolean {
  return block.exposes.length > 0 || block.inputs.length > 0 || block.outputs.length > 0 || block.access.length > 0;
}

/**
 * The open notes a block on screen carries: how many wait for the agent and
 * how many for the person, the block the first is on, and whether any is on
 * a part folded away inside it.
 */
interface NoteMark {
  forAgent: number;
  forPerson: number;
  first: string;
  inside: boolean;
  /** Whether the agent has said it is working on any of them. */
  working: boolean;
  /** Whether any, still with the agent, flags a run that went wrong or a problem Fragmentor reported. */
  failing: boolean;
}

/**
 * The open notes on each block on screen. A note on a block folded away is
 * gathered onto the block standing for it, as a step of a trace is, so
 * folding never hides that something is waiting.
 */
function noteMarks(tree: Tree): Map<string, NoteMark> {
  const marks = new Map<string, NoteMark>();
  for (const note of ui.snapshot?.notes ?? []) {
    // A note on a block that has gone is listed in the project's panel; it is
    // not on any block, so it is drawn on none.
    if (note.waiting === null || !ui.snapshot?.blocks[note.block]) continue;
    const node = shownAt(tree, note.block);
    if (!node) continue;
    const mark = marks.get(node.path) ?? { forAgent: 0, forPerson: 0, first: note.block, inside: false, working: false, failing: false };
    if (note.block !== node.path) mark.inside = true;
    // Both are about what the agent still has to do: once it has answered,
    // the note is the person's to judge, and says how the run went again.
    if (note.waiting === "agent" && note.working !== undefined) mark.working = true;
    if (note.waiting === "agent" && note.messages.some((each) => each.from === "person" && (each.run !== undefined || each.problem !== undefined))) {
      mark.failing = true;
    }
    if (note.waiting === "agent") mark.forAgent += 1;
    else mark.forPerson += 1;
    marks.set(node.path, mark);
  }
  return marks;
}

/**
 * The blocks the Changes list is talking about, by path, with what the dot
 * on each should say. Handed in by whoever keeps the list, so the canvas
 * never has to know where the changes come from. Null while no list is open.
 */
let changedBlocks: () => Map<string, string> | null = () => null;
export function onChangeMarks(provider: () => Map<string, string> | null): void {
  changedBlocks = provider;
}

/**
 * The dot each block on screen carries while the Changes list is open. One
 * on a block folded away is gathered onto the block standing for it, as a
 * note's count is, so folding never hides where the work happened.
 */
function changeDots(tree: Tree): Map<string, string> {
  const dots = new Map<string, string>();
  const listed = changedBlocks();
  if (!listed) return dots;
  for (const [path, said] of listed) {
    const node = shownAt(tree, path);
    if (!node) continue;
    const gathered = node.path !== path || dots.has(node.path);
    dots.set(node.path, gathered ? "What changed is inside it. The Changes list has the details." : said);
  }
  return dots;
}

/**
 * A count on a block's corner saying notes are open on it. It is amber while
 * any of them waits for the person, and quiet while all of them are with the
 * agent: nothing about a note is wrong, so it is never red.
 */
function drawNoteMark(group: SVGGElement, mark: NoteMark): void {
  const count = mark.forAgent + mark.forPerson;
  const badge = svgEl("g", {
    class: "note-mark",
    transform: `translate(${BOX_W} 0)`,
    "data-waiting": mark.forPerson > 0 ? "person" : "agent",
    "data-working": String(mark.working),
  }, group);
  const whose = [mark.forPerson > 0 ? `${mark.forPerson} for you` : "", mark.forAgent > 0 ? `${mark.forAgent} for your agent` : ""]
    .filter(Boolean)
    .join(", ");
  const where = mark.inside ? " on it or inside it" : "";
  const doing = mark.working ? " Your agent is working on it now." : "";
  svgEl("title", {}, badge).textContent = `${count} open note${count === 1 ? "" : "s"}${where}: ${whose}.${doing} Click to read them.`;
  // A ring spreading out from the count while the agent works on it.
  if (mark.working) svgEl("circle", { r: 8, class: "note-mark-ring" }, badge);
  svgEl("circle", { r: 8, class: "note-mark-dot" }, badge);
  svgEl("text", { y: 3.5, class: "note-mark-count", "text-anchor": "middle" }, badge).textContent = count > 9 ? "9+" : String(count);
  badge.addEventListener("pointerdown", (event) => event.stopPropagation());
  badge.addEventListener("dblclick", (event) => event.stopPropagation());
  badge.addEventListener("click", (event) => {
    event.stopPropagation();
    notesPicked(mark.first);
  });
}

/**
 * A red flag at a block's corner, beside its count of notes: something went
 * wrong there. It shows while a run being watched went wrong in the block
 * itself, rather than only inside it, and while a note still with the agent
 * flags a run that went wrong or a problem Fragmentor reported.
 * It is drawn on every block and shown by those two states, so a run can
 * raise it without drawing anything anew.
 */
function drawFlag(group: SVGGElement): void {
  const flag = svgEl("g", { class: "block-flag", transform: `translate(${BOX_W - 20} -9)` }, group);
  svgEl("title", {}, flag).textContent = "Something went wrong here: in the run being watched, or in a run or problem flagged for your agent.";
  svgEl("path", { d: "M0.75 0.5 V11", class: "block-flag-pole" }, flag);
  svgEl("path", { d: "M1.5 0.5 H9.5 L7.25 3.75 L9.5 7 H1.5 Z", class: "block-flag-cloth" }, flag);
}

/** How much of a name fits across a box, at 12.5px. */
const NAME_CHARS = 21;

function drawNode(node: TreeNode, layer: Element, arrivalDelay: number | null, notes: NoteMark | undefined, changed: string | undefined): void {
  const block = node.block;
  const group = svgEl("g", {
    class: "block-box",
    transform: `translate(${node.x} ${node.y})`,
    "data-planned": String(block.planned),
    "data-role": block.role,
    // A single flag, so the styles for a block that is not code sit at the
    // same weight as the ones for a planned block and can be overridden by
    // them: a planned database reads as planned first.
    "data-architecture": String(block.architecture),
    "data-tinted": String(viewSettings.colourBy === "block" || block.architecture),
    "data-key": node.path,
    // Its own id as well as its path, which is how anything looking for one
    // block by name finds it without writing out where it sits.
    "data-id": block.id,
  }, layer);
  if (viewSettings.colourBy === "block" && !block.planned) group.style.setProperty("--role", blockColour(node.path));

  svgEl("title", {}, group).textContent = [
    `${block.name} — ${block.roleLabel.toLowerCase()}`,
    block.planned ? "Planned: drawn, but not built yet." : "",
    block.responsibility,
  ]
    .filter(Boolean)
    .join("\n\n");

  // Everything drawn sits in its own group, so an arrival can scale it
  // without disturbing the position the outer group holds.
  const body = svgEl("g", { class: "block-body" }, group);
  if (arrivalDelay !== null) {
    body.classList.add("appearing");
    body.style.animationDelay = `${arrivalDelay}ms`;
  }

  // The plate is what can be focused, not the group around it: a browser
  // draws a focus ring around everything in a group, which here would reach
  // out to the fold and the breakpoint beside it.
  svgEl("rect", {
    x: 0,
    y: 0,
    width: BOX_W,
    height: BOX_H,
    rx: 3,
    class: "block-plate",
    tabindex: "0",
    role: "button",
    "aria-label": block.name,
  }, body);

  const icon = svgEl("g", { class: "role-icon", transform: "translate(7 14)" }, body);
  svgEl("title", {}, icon).textContent = block.roleLabel;
  for (const d of ROLE_ICONS[block.role]) svgEl("path", { d, class: "role-icon-line" }, icon);

  const name = block.name.length > NAME_CHARS ? `${block.name.slice(0, NAME_CHARS - 1)}…` : block.name;
  svgEl("text", { x: 25, y: 17, class: "block-name" }, body).textContent = name;
  svgEl("text", { x: 25, y: 30, class: "block-kind" }, body).textContent = block.planned ? "PLANNED" : block.roleLabel;
  // How the block is doing in a run being watched; empty otherwise.
  svgEl("text", { x: BOX_W - 8, y: 30, class: "run-note", "text-anchor": "end" }, body);

  drawBlockButtons(group, block);
  if (node.hasParts) drawFold(group, node);
  if (notes) drawNoteMark(group, notes);
  // A small neutral dot on the other corner while the Changes list is open:
  // a marker only, never a control, so it takes no clicks from the block.
  if (changed !== undefined) {
    const dot = svgEl("g", { class: "change-mark" }, group);
    svgEl("title", {}, dot).textContent = changed;
    svgEl("circle", { r: 4.5, class: "change-mark-dot" }, dot);
  }
  // A failure flagged for the agent is drawn as a failed run is, until the
  // agent has answered it: outlined, glowing and flagged in red.
  group.dataset.failing = String(notes?.failing ?? false);
  drawFlag(group);

  // Beside the block's name: where a run can be told to pause before it.
  if (canPause(block)) {
    const breakpoint = svgEl("g", { class: "breakpoint", transform: `translate(-10 ${BOX_H / 2})` }, group);
    svgEl("title", {}, breakpoint).textContent = "Pause here: a run stops before this block, so you can see what reaches it.";
    const hit = svgEl("circle", { r: 9, class: "breakpoint-hit" }, breakpoint);
    svgEl("circle", { r: 4.5, class: "breakpoint-dot" }, breakpoint);
    hit.addEventListener("pointerdown", (event) => event.stopPropagation());
    hit.addEventListener("dblclick", (event) => event.stopPropagation());
    hit.addEventListener("click", (event) => {
      event.stopPropagation();
      breakpointToggled(block.path);
    });
  }

  nodeElements.set(node.path, group);
  attachNodeBehaviour(group, node);
}

/**
 * The windows a block can open: its code, and what it holds. They show while
 * the pointer is on the block, so a name has the width of the box the rest of
 * the time.
 */
function drawBlockButtons(group: SVGGElement, block: SnapshotBlock): void {
  const wanted: Array<{ kind: "code" | "details"; label: string; title: string }> = [];
  if (hasDetails(block)) {
    wanted.push({ kind: "details", label: "▤", title: `${block.name}: its interface, and what it reaches` });
  }
  if (hasCode(block)) wanted.push({ kind: "code", label: "</>", title: `The code behind ${block.name}` });

  wanted.forEach((each, at) => {
    const button = svgEl("g", {
      class: "block-button",
      transform: `translate(${BOX_W - 6 - (at + 1) * 22} 4)`,
    }, group);
    svgEl("title", {}, button).textContent = each.title;
    svgEl("rect", { x: 0, y: 0, width: 20, height: 14, rx: 2, class: "block-button-plate" }, button);
    svgEl("text", { x: 10, y: 10.5, class: "block-button-text", "text-anchor": "middle" }, button).textContent = each.label;
    button.addEventListener("pointerdown", (event) => event.stopPropagation());
    button.addEventListener("dblclick", (event) => event.stopPropagation());
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      opened(each.kind, block.path);
    });
  });
}

/** Where the line to a block's parts leaves it, so folding them away is done where they leave. */
function drawFold(group: SVGGElement, node: TreeNode): void {
  const fold = svgEl("g", {
    class: "fold",
    transform: `translate(${node.listed ? spineX(node) - node.x : BOX_W / 2} ${BOX_H})`,
  }, group);
  svgEl("title", {}, fold).textContent = node.folded
    ? `Show what ${node.block.name} is made of`
    : `Fold ${node.block.name}: put its parts away`;
  svgEl("circle", { r: 9, class: "fold-hit" }, fold);
  svgEl("circle", { r: 6, class: "fold-dot" }, fold);
  svgEl("path", { d: node.folded ? "M -3 0 H 3 M 0 -3 V 3" : "M -3 0 H 3", class: "fold-mark" }, fold);
  fold.addEventListener("pointerdown", (event) => event.stopPropagation());
  fold.addEventListener("dblclick", (event) => event.stopPropagation());
  fold.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleFold(node.path);
  });
}

export function toggleFold(path: string): void {
  if (ui.folded.has(path)) ui.folded.delete(path);
  else ui.folded.add(path);
  notify({ redraw: true });
}

function attachNodeBehaviour(group: SVGGElement, node: TreeNode): void {
  const select = (add: boolean) => {
    if (add) {
      if (ui.selection.has(node.path)) ui.selection.delete(node.path);
      else ui.selection.add(node.path);
    } else {
      ui.selection.clear();
      ui.selection.add(node.path);
    }
    ui.selectedLink = null;
    applySelection();
    notify({ redraw: false });
  };

  group.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
    select(event.ctrlKey || event.metaKey);
  });

  // Double-clicking a block is asking for more of it: its parts, or its code.
  group.addEventListener("dblclick", (event) => {
    event.stopPropagation();
    if (node.hasParts) toggleFold(node.path);
    else if (hasCode(node.block)) opened("code", node.path);
  });

  group.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && node.hasParts) {
      event.preventDefault();
      toggleFold(node.path);
      return;
    }
    if (event.key !== " ") return;
    event.preventDefault();
    select(false);
  });
}

let legendReadOnly = false;
/** For a page that shows the colours without offering to change them: the swatches do nothing, and there is nothing to reset. */
export function makeLegendReadOnly(): void {
  legendReadOnly = true;
}

/**
 * What the colours mean, and where they are changed.
 *
 * Every kind is listed whatever happens to be on screen, because the legend is
 * also where a colour is chosen: a kind missing from the list would be a
 * colour nobody could reach. Coloured block by block there is nothing to
 * explain and each block's colour is set in the inspector instead, so it goes.
 */
function renderLegend(drawn: boolean): void {
  const legend = element<HTMLElement>("legend");

  if (!drawn || viewSettings.colourBy !== "role") {
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
    renderLegend(true);
  });
  head.append(toggle);
  legend.append(head);

  if (ui.legendCollapsed) return;

  const blocks = [...(currentTree?.nodes.values() ?? [])].map((node) => node.block);
  const present = new Set(blocks.filter((block) => !block.planned).map((block) => block.role));

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
    if (legendReadOnly) swatch.disabled = true;
    swatch.addEventListener("input", () => {
      roleColours.set(role, swatch.value);
    });

    const name = el("span", "legend-text", role === "function" ? "code" : ROLES[role].label.toLowerCase());
    row.append(swatch, name);
    legend.append(row);
  }

  const planned = el("div", "legend-row");
  planned.dataset.role = "planned";
  planned.dataset.here = String(blocks.some((block) => block.planned));
  planned.append(el("span", "legend-swatch fixed"), el("span", "legend-text", "planned, not built yet"));
  legend.append(planned);
  if (legendReadOnly) return;

  const reset = el("button", "legend-reset", "Reset to default");
  reset.type = "button";
  reset.addEventListener("click", () => {
    for (const role of ROLE_IDS) roleColours.set(role, null);
    renderLegend(true);
  });
  legend.append(reset);
}

/* -------------------------------------------------------------------------- */
/* Panning and zooming                                                         */
/* -------------------------------------------------------------------------- */

export function setUpCanvasGestures(): void {
  const svg = element<SVGSVGElement>("canvas-svg");
  let pan: { x: number; y: number; panX: number; panY: number; moved: boolean } | null = null;

  svg.addEventListener("pointerdown", (event) => {
    const target = event.target as Element;
    if (target.closest(".block-box") || target.closest(".access-group")) return;
    pan = { x: event.clientX, y: event.clientY, panX: ui.panX, panY: ui.panY, moved: false };
    svg.classList.add("panning");
    // The pointer can be gone again before this runs — a touch lifted at
    // once, or a click the self-check plays in. Panning works uncaptured;
    // only a drag that leaves the window would stop early.
    try {
      svg.setPointerCapture(event.pointerId);
    } catch {
      /* nothing to capture */
    }
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
  const next = Math.min(3, Math.max(SMALLEST_SCALE, ui.zoom * factor));
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

/**
 * The buttons over the drawing: what a colour on the diagram means, whether
 * dependencies are drawn, and the zoom. The colour button says which way it is
 * showing now and moves to the other when it is pressed, so nothing has to be
 * opened to find out which way round it is.
 */
export function setUpZoomBar(): void {
  const labels: Record<ColourBy, string> = {
    block: "Colour: by block",
    role: "Colour: by kind",
  };

  const colour = element("colour-by");
  const show = () => {
    colour.textContent = labels[viewSettings.colourBy];
  };

  colour.addEventListener("click", () => {
    const at = COLOUR_BY.indexOf(viewSettings.colourBy);
    viewSettings.setColourBy(COLOUR_BY[(at + 1) % COLOUR_BY.length]!);
    show();
    notify({ redraw: true });
  });

  // What each block reaches is a standing fact rather than something that
  // happened, and can be put away to leave the blocks, or an execution, alone.
  const dependencies = element("show-dependencies");
  const showDependencies = () => {
    dependencies.textContent = ui.showDependencies ? "Dependencies: shown" : "Dependencies: hidden";
    dependencies.setAttribute("aria-pressed", String(ui.showDependencies));
  };
  dependencies.addEventListener("click", () => {
    ui.setShowDependencies(!ui.showDependencies);
    showDependencies();
    applyDependencies();
  });

  show();
  showDependencies();

  element("zoom-in").addEventListener("click", () => {
    const rect = element("canvas-svg").getBoundingClientRect();
    zoomAbout(rect.width / 2, rect.height / 2, 1.2);
  });
  element("zoom-out").addEventListener("click", () => {
    const rect = element("canvas-svg").getBoundingClientRect();
    zoomAbout(rect.width / 2, rect.height / 2, 1 / 1.2);
  });
  element("zoom-fit").addEventListener("click", () => {
    ui.userAdjusted = false;
    ui.fitsWhole = true;
    fitToView(true);
  });
}
