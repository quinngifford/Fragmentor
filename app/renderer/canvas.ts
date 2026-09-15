import type { Point } from "../../src/project/layout.js";
import type { SnapshotBlock } from "../../src/project/snapshot.js";
import {
  BODY_PAD,
  GROUP_HEAD_H,
  HEAD_H,
  NODE_W,
  PROJECT_VIEW,
  ROW_H,
  buildGraph,
  busColour,
  busInPoint,
  busOutPoint,
  layoutFor,
  measure,
} from "./graph.js";
import type { Bus, Graph, GraphNode } from "./graph.js";
import { requireSnapshot, ui } from "./state.js";

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
 */

let notify: (options: { redraw: boolean }) => void = () => {};
export function onCanvasChange(callback: (options: { redraw: boolean }) => void): void {
  notify = callback;
}

let drawn: () => void = () => {};
/** Called whenever a diagram has been drawn afresh, so anything laid over it can be put back. */
export function onCanvasDrawn(callback: () => void): void {
  drawn = callback;
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
const busElements = new Map<string, { group: SVGGElement; paths: SVGPathElement[]; label: SVGTextElement }>();

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

function curve(a: Point, b: Point): string {
  const dx = Math.max(40, Math.abs(b.x - a.x) * 0.5);
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
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
  for (const [id, drawn] of busElements) {
    const bus = currentGraph?.buses.get(id);
    drawn.group.dataset.selected = String(ui.selectedBus === id);
    drawn.group.dataset.linked = String(
      Boolean(bus && ui.selection.has(bus.source) && ui.selection.has(bus.target)),
    );
  }
}

/** Moves the drawn blocks and re-routes their buses, without rebuilding them. */
export function applyPositions(): void {
  if (!currentGraph || !currentLayout) return;

  for (const [key, group] of nodeElements) {
    const point = currentLayout.get(key);
    if (point) group.setAttribute("transform", `translate(${point.x} ${point.y})`);
  }

  for (const [id, drawn] of busElements) {
    const bus = currentGraph.buses.get(id);
    if (!bus) continue;
    const geometry = busGeometry(currentGraph, currentLayout, bus);
    if (!geometry) continue;

    for (const path of drawn.paths) path.setAttribute("d", geometry.path);
    drawn.label.setAttribute("x", String(geometry.middle.x));
    drawn.label.setAttribute("y", String(geometry.middle.y));
  }
}

function busGeometry(graph: Graph, layout: Map<string, Point>, bus: Bus) {
  const sourceNode = graph.nodes.get(bus.source);
  const targetNode = graph.nodes.get(bus.target);
  const from = layout.get(bus.source);
  const to = layout.get(bus.target);
  if (!sourceNode || !targetNode || !from || !to) return null;

  const start = busOutPoint(sourceNode, from);
  const end = busInPoint(targetNode, to, bus.source);
  return {
    path: curve(start, end),
    middle: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 - 6 },
  };
}

export function applyBreakpoints(): void {
  for (const [key, group] of nodeElements) {
    const blockPath = currentGraph?.nodes.get(key)?.block?.path;
    group.dataset.breakpoint = String(blockPath !== undefined && ui.breakpoints.has(blockPath));
  }
}

/** A run laid over the diagram on screen: how each block is doing, and what each bus carried. */
export interface RunOverlay {
  nodes: Map<string, { state: "running" | "paused" | "done" | "failed"; note: string }>;
  /** Buses whose values are known, with the label to show on each. */
  buses: Map<string, string>;
}

/**
 * Shows a run on what is already drawn. `pulses` are buses that data has
 * just travelled along, each sent a pulse of light from end to end.
 */
export function applyRunOverlay(overlay: RunOverlay | null, pulses: string[] = []): void {
  for (const [key, group] of nodeElements) {
    const run = overlay?.nodes.get(key);
    if (run) group.dataset.run = run.state;
    else delete group.dataset.run;
    const note = group.querySelector(".run-note");
    if (note) note.textContent = run?.note ?? "";
  }

  for (const [id, drawn] of busElements) {
    const label = overlay?.buses.get(id);
    drawn.group.dataset.carried = String(label !== undefined);
    drawn.label.textContent = label ?? drawn.label.dataset.plain ?? "";
  }

  const layer = element("pulse-layer");
  for (const id of pulses) {
    const line = busElements.get(id)?.paths[0];
    if (!line) continue;
    const pulse = svgEl("path", {
      d: line.getAttribute("d") ?? "",
      class: "bus-pulse",
      stroke: line.getAttribute("stroke") ?? "#4fe38f",
      pathLength: 1,
    }, layer);
    pulse.addEventListener("animationend", () => pulse.remove());
    // Where animation is turned off, nothing ends it.
    window.setTimeout(() => pulse.remove(), 1500);
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
    maxX = Math.max(maxX, point.x + NODE_W + 30);
    maxY = Math.max(maxY, point.y + height + 34);
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
  return { x: point.x, y: point.y, width: NODE_W, height: measure(node).height };
}

/**
 * Puts another diagram on the canvas. Going into a block zooms into it until
 * it fills the canvas, and its own diagram takes over from there; coming back
 * out zooms away from it into the diagram around it. A jump between unrelated
 * diagrams simply fades.
 */
async function moveTo(path: string, arrive: () => void): Promise<void> {
  const from = ui.view;
  const id = ++moves;
  fits += 1;
  const current = () => id === moves;
  const svg = element("canvas-svg");

  const change = () => {
    ui.view = path;
    ui.selection.clear();
    ui.selectedBus = null;
    ui.userAdjusted = false;
    arrive();
    notify({ redraw: true });
  };

  const { width, height } = canvasSize();
  if (path === from || lessMotion() || !currentGraph || !width || !height) {
    moving = false;
    svg.classList.remove("moving");
    setFade(1);
    change();
    fitWhenReady(20);
    return;
  }

  const down = isInside(path, from);
  const up = isInside(from, path);
  moving = true;
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
  if (!left) return;

  change();

  // Arrive: out of the block that was just left, or growing into place.
  const target = fitCamera();
  if (!target) {
    moving = false;
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
    svg.classList.remove("moving");
    setFade(1);
  }
}

/** Opens a composite's diagram. `arrive` runs as it is put on screen, for choosing what to select there. */
export function openDiagram(path: string, arrive: () => void = () => {}): void {
  void moveTo(path, arrive);
}

/**
 * Brings a block into view: a composite opens its own diagram, and a leaf is
 * selected in its parent's.
 */
export function showBlock(path: string): void {
  const block = ui.snapshot?.blocks[path];
  if (!block) return;
  if (block.kind === "composite") {
    openDiagram(path);
    return;
  }

  const parent = path.split("/").slice(0, -1).join("/") || PROJECT_VIEW;
  const select = () => {
    ui.selection.clear();
    ui.selection.add(block.id);
    ui.selectedBus = null;
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
 * What each diagram held when it was last drawn, so that blocks and buses the
 * agent adds can be told apart from those already there. Opening a project
 * forgets it all: blocks that were there all along are simply there.
 */
const drawnBefore = new Map<string, { nodes: Set<string>; buses: Set<string> }>();
let everythingArrives = false;

/**
 * Called when a project is opened. In a project the agent has not defined
 * yet, the first diagram it writes arrives block by block.
 */
export function resetArrivals(projectIsEmpty: boolean): void {
  drawnBefore.clear();
  everythingArrives = projectIsEmpty;
}

function clearCanvas(): void {
  element("bus-layer").replaceChildren();
  element("pulse-layer").replaceChildren();
  element("node-layer").replaceChildren();
  nodeElements.clear();
  busElements.clear();
  currentGraph = null;
  currentLayout = null;
  document.querySelectorAll(".canvas-empty").forEach((el) => el.remove());
}

/** Empties the canvas and leaves a note where the diagram would be. */
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

  const graph = buildGraph(ui.view);
  if (!graph) {
    const parent = requireSnapshot().blocks[ui.view];
    showCanvasMessage(
      parent
        ? `${parent.name} is a leaf block.\nIts behaviour is code, not a diagram — the inspector shows its contract and source.`
        : "This block no longer exists.",
    );
    return;
  }

  currentGraph = graph;
  const busLayer = element("bus-layer");
  const nodeLayer = element("node-layer");
  const layout = layoutFor(graph, ui.view);
  currentLayout = layout;

  const before = drawnBefore.get(ui.view) ?? (everythingArrives ? { nodes: new Set<string>(), buses: new Set<string>() } : null);
  const arrivingNodes = before ? [...graph.nodes.keys()].filter((key) => !before.nodes.has(key)) : [];
  const busDelay = Math.min(arrivingNodes.length, 12) * ARRIVAL_STAGGER_MS + 200;

  for (const bus of graph.buses.values()) {
    const geometry = busGeometry(graph, layout, bus);
    if (!geometry) continue;

    const colour = busColour(graph, ui.view, bus);
    const group = svgEl("g", { class: "bus-group", "data-bus": bus.id }, busLayer);

    const line = svgEl("path", { d: geometry.path, class: "bus", stroke: colour }, group);
    const hit = svgEl("path", { d: geometry.path, class: "bus-hit" }, group);
    svgEl("title", {}, group).textContent =
      `${graph.nodes.get(bus.source)?.label} → ${graph.nodes.get(bus.target)?.label}\n${bus.signals
        .map((s) => `${s.targetPort}: ${s.type ?? "unknown"}`)
        .join("\n")}`;

    const label = svgEl("text", {
      x: geometry.middle.x,
      y: geometry.middle.y,
      class: "bus-count",
      "text-anchor": "middle",
      fill: colour,
    }, group);
    label.textContent = bus.signals.length === 1 ? bus.signals[0]!.targetPort : `${bus.signals.length} signals`;
    // Kept, so the label can go back to it once a run is taken off the diagram.
    label.dataset.plain = label.textContent;

    if (before && !before.buses.has(bus.id)) {
      // Drawn along its length, once the blocks it joins have arrived. A path
      // length of 1 lets the dash be measured without knowing the curve's.
      group.classList.add("appearing");
      group.style.animationDelay = `${busDelay}ms`;
      line.setAttribute("pathLength", "1");
    }

    hit.addEventListener("click", (event) => {
      event.stopPropagation();
      ui.selectedBus = bus.id;
      ui.selection.clear();
      applySelection();
      notify({ redraw: false });
    });

    busElements.set(bus.id, { group, paths: [line, hit], label });
  }

  for (const node of graph.nodes.values()) {
    const point = layout.get(node.key);
    if (!point) continue;
    const arrival = arrivingNodes.indexOf(node.key);
    drawNode(graph, node, point, nodeLayer, arrival === -1 ? null : Math.min(arrival, 12) * ARRIVAL_STAGGER_MS);
  }

  drawnBefore.set(ui.view, { nodes: new Set(graph.nodes.keys()), buses: new Set(graph.buses.keys()) });
  everythingArrives = false;

  applySelection();
  applyBreakpoints();
  applyViewport();
  drawn();
}

/** Only TypeScript blocks in a structured project run, so only they can be paused. */
function canPause(block: SnapshotBlock): boolean {
  return ui.snapshot?.mode === "structured" && block.language === "typescript";
}

/** `arrivalDelay` is null for a block that was already there, and otherwise when it should arrive. */
function drawNode(graph: Graph, node: GraphNode, point: Point, layer: Element, arrivalDelay: number | null): void {
  const { height, rightHeight } = measure(node);
  const group = svgEl("g", {
    class: "block-box",
    transform: `translate(${point.x} ${point.y})`,
    "data-boundary": String(node.boundary),
    "data-key": node.key,
    tabindex: "0",
    role: "button",
  }, layer);

  svgEl("title", {}, group).textContent = node.block
    ? node.block.responsibility + (node.block.kind === "composite" ? "\n\nDouble-click to open this block's diagram." : "")
    : `${node.label} of ${graph.parent.name}`;

  // Everything drawn sits in its own group, so an arrival can scale it
  // without disturbing the position the outer group holds.
  const body = svgEl("g", { class: "block-body" }, group);
  if (arrivalDelay !== null) {
    body.classList.add("appearing");
    body.style.animationDelay = `${arrivalDelay}ms`;
  }

  svgEl("rect", { x: 0, y: 0, width: NODE_W, height, rx: 3, class: "block-plate" }, body);
  svgEl("rect", { x: 0, y: 0, width: NODE_W, height: HEAD_H, rx: 3, class: "block-head" }, body);
  svgEl("line", { x1: 0, y1: HEAD_H, x2: NODE_W, y2: HEAD_H, class: "block-divider" }, body);
  svgEl("text", { x: 10, y: 15, class: "block-name" }, body).textContent = node.label;
  svgEl("text", { x: 10, y: 27, class: "block-kind" }, body).textContent = node.sublabel;
  // How the block is doing in a run being watched; empty otherwise.
  svgEl("text", { x: NODE_W - 10, y: 27, class: "run-note", "text-anchor": "end" }, body);

  if (node.child?.mode === "each" && node.child.eachOver) {
    svgEl("text", { x: NODE_W - 10, y: 15, class: "each-badge", "text-anchor": "end" }, body)
      .textContent = `× each ${node.child.eachOver}`;
  }

  // Left edge: one bracket per incoming bus, with its signals inside it.
  let y = HEAD_H + BODY_PAD;
  for (const busGroup of node.groups) {
    const bus = graph.buses.get(`${busGroup.source}->${node.key}`);
    const colour = bus ? busColour(graph, ui.view, bus) : "#2b8d5c";
    const groupHeight = GROUP_HEAD_H + busGroup.signals.length * ROW_H;
    const sourceLabel = graph.nodes.get(busGroup.source)?.label ?? busGroup.source;

    svgEl("path", {
      d: `M 6 ${y + 2} L 1 ${y + 2} L 1 ${y + groupHeight - 2} L 6 ${y + groupHeight - 2}`,
      class: "group-bracket",
      stroke: colour,
    }, body);
    svgEl("circle", { cx: 0, cy: y + groupHeight / 2, r: 3.5, class: "bus-dot", fill: "#0d1113", stroke: colour }, body);
    svgEl("text", { x: 11, y: y + 10, class: "group-label", fill: colour }, body).textContent = `from ${sourceLabel}`;

    busGroup.signals.forEach((signal, i) => {
      svgEl("text", { x: 15, y: y + GROUP_HEAD_H + i * ROW_H + 11, class: "port-label" }, body)
        .textContent = signal.targetPort;
    });

    y += groupHeight + 7;
  }

  // Right edge: everything the block produces leaves on one bus.
  if (node.outputs.length > 0) {
    const top = HEAD_H + BODY_PAD;
    svgEl("text", { x: NODE_W - 15, y: top + 10, class: "bus-out-label", "text-anchor": "end" }, body)
      .textContent = "bus out";
    node.outputs.forEach((port, i) => {
      svgEl("text", {
        x: NODE_W - 15,
        y: top + GROUP_HEAD_H + i * ROW_H + 11,
        class: "port-label",
        "text-anchor": "end",
      }, body).textContent = port.name;
    });
    svgEl("circle", { cx: NODE_W, cy: top + rightHeight / 2, r: 4, class: "bus-dot", fill: "#0d1113", stroke: "#2b8d5c" }, body);
  }

  node.capabilities.forEach((cap, i) => {
    const cx = 26 + i * 58;
    svgEl("line", { x1: cx, y1: height, x2: cx, y2: height + 11, class: "cap-line" }, body);
    svgEl("circle", { cx, cy: height + 14, r: 3.5, class: "cap-dot" }, body);
    svgEl("text", { x: cx + 8, y: height + 17.5, class: "port-label" }, body).textContent = cap.name;
  });

  // Beside the block's name: where a run can be told to pause before it.
  if (node.block && canPause(node.block)) {
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
  for (const [key, point] of currentLayout) positions[key] = { x: Math.round(point.x), y: Math.round(point.y) };

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
      ui.selectedBus = null;
      applySelection();
      notify({ redraw: false });
      return;
    }

    if (!ui.selection.has(node.key)) {
      ui.selection.clear();
      ui.selection.add(node.key);
      ui.selectedBus = null;
      applySelection();
      notify({ redraw: false });
    }

    if (!currentLayout) return;
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      origin: new Map([...ui.selection].map((key) => [key, { ...(currentLayout!.get(key) ?? { x: 0, y: 0 }) }])),
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

  group.addEventListener("dblclick", (event) => {
    event.stopPropagation();
    if (node.block?.kind === "composite") openDiagram(node.block.path);
  });

  group.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && node.block?.kind === "composite") {
      event.preventDefault();
      openDiagram(node.block.path);
      return;
    }
    if (event.key !== " ") return;
    event.preventDefault();
    ui.selection.clear();
    ui.selection.add(node.key);
    ui.selectedBus = null;
    applySelection();
    notify({ redraw: false });
  });
}

export function setUpCanvasGestures(): void {
  const svg = element<SVGSVGElement>("canvas-svg");
  let pan: { x: number; y: number; panX: number; panY: number; moved: boolean } | null = null;

  svg.addEventListener("pointerdown", (event) => {
    const target = event.target as Element;
    if (target.closest(".block-box") || target.closest(".bus-group")) return;
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
      ui.selectedBus = null;
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
