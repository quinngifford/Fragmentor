import type { SnapshotAccess, SnapshotBlock } from "../../src/project/snapshot.js";
import { BOX_H, BOX_W, buildTree, busY, shownAt, spineX } from "./tree.js";
import type { Tree, TreeNode } from "./tree.js";
import { BLOCK_PALETTE, blockColours, requireSnapshot, roleColours, ui, viewSettings } from "./state.js";
import { el } from "./dom.js";
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

let currentTree: Tree | null = null;
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
/* Colour                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The colour a block is drawn in when the tree is coloured block by block:
 * taken from where it sits in the tree, so neighbours are never given
 * neighbouring hues, and kept for as long as the tree holds the same blocks.
 * A colour chosen by hand wins, and is remembered in this profile.
 */
export function blockColour(path: string): string {
  const chosen = blockColours.get("", path);
  if (chosen) return chosen;
  const order = currentTree ? [...currentTree.nodes.keys()].indexOf(path) : -1;
  return BLOCK_PALETTE[(order < 0 ? 0 : order) % BLOCK_PALETTE.length]!;
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
  nodes: Map<string, { state: "running" | "paused" | "done" | "failed" | "stopped"; note: string }>;
}

export function applyRunOverlay(overlay: RunOverlay | null): void {
  for (const [path, group] of nodeElements) {
    const run = overlay?.nodes.get(path);
    if (run) group.dataset.run = run.state;
    else delete group.dataset.run;
    const note = group.querySelector(".run-note");
    if (note) note.textContent = run?.note ?? "";
  }
}

/* -------------------------------------------------------------------------- */
/* One step of an execution                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The step on screen: one arrow between two blocks, or one thing a run left
 * at a block. Only ever one at a time — the whole of an execution is a
 * drawing of its own, not a web over the architecture.
 */
export interface ExecutionMark {
  /** Where it came from: a block, or null for outside the system. */
  from: string | null;
  /** The block it arrived at, or where the effect landed. */
  to: string;
  label: string;
  /** Whether anything travelled, which is drawn as flow rather than as a line lighting up. */
  data: boolean;
  /** An answer coming back, which runs the other way. */
  back: boolean;
  /** Set when the step is something the run left behind rather than a move between blocks. */
  effect: string | null;
}

let currentMark: ExecutionMark | null = null;

export function applyExecutionMark(mark: ExecutionMark | null): void {
  currentMark = mark;
  element("canvas-svg").classList.toggle("tracing", mark !== null);
  const lit = new Set(mark ? [mark.from, mark.to].filter((each): each is string => each !== null) : []);
  for (const [path, group] of nodeElements) group.dataset.current = String(lit.has(path));
  drawExecutionMark();
}

/** Where an arrow between two blocks leaves and arrives, and whether it has to go over them. */
function arrowEnds(a: TreeNode, b: TreeNode): { start: { x: number; y: number }; end: { x: number; y: number }; over: boolean } {
  const gap = Math.max(a.x, b.x) - Math.min(a.x + BOX_W, b.x + BOX_W);
  const sameRow = Math.abs(a.y - b.y) < BOX_H * 1.2;
  if (sameRow && gap < 90) {
    return { start: { x: a.x + BOX_W / 2, y: a.y }, end: { x: b.x + BOX_W / 2, y: b.y }, over: true };
  }
  const start = sideOf({ x: b.x + BOX_W / 2, y: b.y + BOX_H / 2 }, a);
  return { start, end: sideOf(start, b), over: false };
}

/** Where an arrow meets a block: on the side it comes from, or on the edge it comes over. */
function sideOf(from: { x: number; y: number }, node: TreeNode): { x: number; y: number } {
  const middle = { x: node.x + BOX_W / 2, y: node.y + BOX_H / 2 };
  if (Math.abs(from.x - middle.x) > BOX_W / 2) {
    return { x: from.x < middle.x ? node.x : node.x + BOX_W, y: middle.y };
  }
  return { x: middle.x, y: from.y < middle.y ? node.y : node.y + BOX_H };
}

/**
 * An arc between two points, bowed clear of whatever it runs between.
 *
 * Always an arc, never a straight line: the tree's own lines are straight, and
 * an arrow must never be taken for one. Two blocks side by side are only a
 * gap apart, so the bow is what gives the arrow, and its word, room to be
 * seen at all.
 */
function arrowPath(start: { x: number; y: number }, end: { x: number; y: number }, over = false) {
  const span = Math.hypot(end.x - start.x, end.y - start.y) || 1;
  const bow = Math.max(26, Math.min(70, span * 0.22));
  // Two blocks all but touching leave no room between them, so the arrow goes
  // up and over them, where it and its word can be read.
  const control = over
    ? { x: (start.x + end.x) / 2, y: Math.min(start.y, end.y) - 34 - span * 0.06 }
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
    middle: { x: (start.x + 2 * control.x + end.x) / 4, y: (start.y + 2 * control.y + end.y) / 4 },
  };
}

/** How wide a chip is for its words, which are set in a monospaced 9px. */
const chipWidth = (text: string) => text.length * 5.6 + 14;

function drawExecutionMark(): void {
  const layer = element("exec-layer");
  const marks = element("exec-marks");
  layer.replaceChildren();
  marks.replaceChildren();
  const mark = currentMark;
  if (!mark || !currentTree) return;

  const to = currentTree.nodes.get(mark.to);
  if (!to) return;

  // Something the run left behind: a chip over the block responsible.
  if (mark.effect !== null) {
    const width = chipWidth(mark.effect);
    const group = svgEl("g", { class: "exec-effect", "data-current": "true" }, marks);
    const x = to.x + BOX_W / 2 - width / 2;
    const y = to.y - 22;
    svgEl("rect", { x, y, width, height: 15, rx: 7.5, class: "exec-effect-chip" }, group);
    svgEl("text", { x: x + width / 2, y: y + 10.5, class: "exec-effect-text", "text-anchor": "middle" }, group).textContent =
      mark.effect;
    return;
  }

  const from = mark.from === null ? null : currentTree.nodes.get(mark.from);
  if (mark.from !== null && !from) return;

  // From outside the system: a mark off to the left of where it arrives.
  const between = from
    ? arrowEnds(from, to)
    : { start: { x: to.x - 74, y: to.y + BOX_H / 2 }, end: sideOf({ x: to.x - 74, y: to.y + BOX_H / 2 }, to), over: false };
  const { start, end } = between;
  const geometry = arrowPath(start, end, between.over);

  if (!from) {
    const outside = svgEl("g", { class: "exec-outside" }, layer);
    svgEl("circle", { cx: start.x, cy: start.y, r: 4.5, class: "exec-outside-dot" }, outside);
    svgEl("text", { x: start.x, y: start.y - 9, class: "exec-outside-label", "text-anchor": "middle" }, outside).textContent =
      "outside";
  }

  const group = svgEl("g", {
    class: "exec-line-group",
    "data-data": String(mark.data),
    "data-current": mark.back ? "back" : "out",
  }, layer);
  svgEl("path", { d: geometry.d, class: "exec-line", "marker-end": "url(#exec-arrow)" }, group);
  svgEl("text", {
    x: geometry.middle.x,
    y: geometry.middle.y - 6,
    class: "exec-label",
    "text-anchor": "middle",
  }, group).textContent = mark.label;
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
  if (!currentTree || currentTree.nodes.size === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of currentTree.nodes.values()) {
    minX = Math.min(minX, node.x - 30);
    minY = Math.min(minY, node.y - 34);
    maxX = Math.max(maxX, node.x + BOX_W + 30);
    maxY = Math.max(maxY, node.y + BOX_H + 30);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function fitCamera(): Camera | null {
  const bounds = treeBounds();
  const { width, height } = canvasSize();
  if (!bounds || !width || !height) return null;

  // Fitting shrinks the tree to make it visible; it never magnifies it, or a
  // project with one block in it would open absurdly zoomed in.
  const scale = Math.min(1, Math.max(0.2, Math.min(width / bounds.width, height / bounds.height)));
  return { cx: bounds.x + bounds.width / 2, cy: bounds.y + bounds.height / 2, scale };
}

/** Brings the whole tree into view. */
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

/** The canvas has no size until layout settles, so keep asking. */
export function fitWhenReady(attempts: number): void {
  const rect = element("canvas-svg").getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) {
    fitToView();
    return;
  }
  if (attempts > 0) requestAnimationFrame(() => fitWhenReady(attempts - 1));
}

/** Eases the canvas over to a point, without changing how far out it is zoomed. */
function moveToPoint(cx: number, cy: number): void {
  const id = ++moves;
  const start = currentCamera();
  const target = { cx, cy, scale: start.scale };
  ui.userAdjusted = true;
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

/** Called when a project is opened. In one the agent has not started on, each block arrives as it is written. */
export function resetArrivals(projectIsEmpty: boolean): void {
  drawnBefore = null;
  everythingArrives = projectIsEmpty;
}

export function clearCanvas(): void {
  for (const id of ["branch-layer", "access-layer", "exec-layer", "node-layer", "exec-marks"]) {
    element(id).replaceChildren();
  }
  nodeElements.clear();
  accessElements.clear();
  currentTree = null;
  document.querySelectorAll(".canvas-empty").forEach((each) => each.remove());
  renderLegend(false);
}

/** Empties the canvas and leaves a note where the tree would be. */
export function showCanvasMessage(text: string): void {
  clearCanvas();
  const note = document.createElement("p");
  note.className = "canvas-empty";
  note.textContent = text;
  element("canvas-wrap").append(note);
}

/** Blocks arriving together come in one after another, the way they were written. */
const ARRIVAL_STAGGER_MS = 70;

export function renderCanvas(): void {
  clearCanvas();

  const tree = buildTree(ui.folded);
  if (tree.nodes.size === 0) {
    showCanvasMessage("This project has no blocks yet.");
    return;
  }
  currentTree = tree;

  const before = drawnBefore ?? (everythingArrives ? new Set<string>() : null);
  const arriving = before ? [...tree.nodes.keys()].filter((path) => !before.has(path)) : [];

  drawBranches(tree, element("branch-layer"));
  drawAccesses(tree, element("access-layer"));
  const nodeLayer = element("node-layer");
  for (const node of tree.nodes.values()) {
    const arrival = arriving.indexOf(node.path);
    drawNode(node, nodeLayer, arrival === -1 ? null : Math.min(arrival, 12) * ARRIVAL_STAGGER_MS);
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
    if (viewSettings.colourBy === "block" && !planned) group.style.setProperty("--role", blockColour(source.path));

    const between = arrowEnds(source, target);
    const geometry = arrowPath(between.start, between.end, between.over);

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
      x: geometry.middle.x,
      y: geometry.middle.y - 5,
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

/** Only TypeScript blocks in a structured project run, so only they can be paused. */
function canPause(block: SnapshotBlock): boolean {
  return ui.snapshot?.mode === "structured" && block.language === "typescript" && !block.planned && !block.architecture;
}

/** Whether there is code to show, and whether there is anything else worth a window of its own. */
export function hasCode(block: SnapshotBlock): boolean {
  return block.code !== null || (!block.architecture && !block.planned && ui.snapshot?.mode === "structured");
}

export function hasDetails(block: SnapshotBlock): boolean {
  return block.exposes.length > 0 || block.inputs.length > 0 || block.outputs.length > 0 || block.access.length > 0;
}

/** How much of a name fits across a box, at 12.5px. */
const NAME_CHARS = 21;

function drawNode(node: TreeNode, layer: Element, arrivalDelay: number | null): void {
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
    wanted.push({ kind: "details", label: "▤", title: `What ${block.name} holds, and what it reaches` });
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

  const reset = el("button", "legend-reset", "Back to the defaults");
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
  const next = Math.min(3, Math.max(0.2, ui.zoom * factor));
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
