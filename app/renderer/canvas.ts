import type { Point } from "../../src/project/layout.js";
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
 */

let notify: (options: { redraw: boolean }) => void = () => {};
export function onCanvasChange(callback: (options: { redraw: boolean }) => void): void {
  notify = callback;
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

/* -------------------------------------------------------------------------- */
/* Drawing                                                                     */
/* -------------------------------------------------------------------------- */

function clearCanvas(): void {
  element("bus-layer").replaceChildren();
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
  ui.view = path.split("/").slice(0, -1).join("/") || PROJECT_VIEW;
  ui.selection.clear();
  ui.selection.add(block.id);
  ui.selectedBus = null;
  notify({ redraw: true });
}

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

  for (const bus of graph.buses.values()) {
    const geometry = busGeometry(graph, layout, bus);
    if (!geometry) continue;

    const colour = busColour(graph, ui.view, bus);
    const group = svgEl("g", { class: "bus-group" }, busLayer);

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
    drawNode(graph, node, point, nodeLayer);
  }

  applySelection();
  applyViewport();
}

function drawNode(graph: Graph, node: GraphNode, point: Point, layer: Element): void {
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

  svgEl("rect", { x: 0, y: 0, width: NODE_W, height, rx: 3, class: "block-plate" }, group);
  svgEl("rect", { x: 0, y: 0, width: NODE_W, height: HEAD_H, rx: 3, class: "block-head" }, group);
  svgEl("line", { x1: 0, y1: HEAD_H, x2: NODE_W, y2: HEAD_H, class: "block-divider" }, group);
  svgEl("text", { x: 10, y: 15, class: "block-name" }, group).textContent = node.label;
  svgEl("text", { x: 10, y: 27, class: "block-kind" }, group).textContent = node.sublabel;

  if (node.child?.mode === "each" && node.child.eachOver) {
    svgEl("text", { x: NODE_W - 10, y: 15, class: "each-badge", "text-anchor": "end" }, group)
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
    }, group);
    svgEl("circle", { cx: 0, cy: y + groupHeight / 2, r: 3.5, class: "bus-dot", fill: "#0d1113", stroke: colour }, group);
    svgEl("text", { x: 11, y: y + 10, class: "group-label", fill: colour }, group).textContent = `from ${sourceLabel}`;

    busGroup.signals.forEach((signal, i) => {
      svgEl("text", { x: 15, y: y + GROUP_HEAD_H + i * ROW_H + 11, class: "port-label" }, group)
        .textContent = signal.targetPort;
    });

    y += groupHeight + 7;
  }

  // Right edge: everything the block produces leaves on one bus.
  if (node.outputs.length > 0) {
    const top = HEAD_H + BODY_PAD;
    svgEl("text", { x: NODE_W - 15, y: top + 10, class: "bus-out-label", "text-anchor": "end" }, group)
      .textContent = "bus out";
    node.outputs.forEach((port, i) => {
      svgEl("text", {
        x: NODE_W - 15,
        y: top + GROUP_HEAD_H + i * ROW_H + 11,
        class: "port-label",
        "text-anchor": "end",
      }, group).textContent = port.name;
    });
    svgEl("circle", { cx: NODE_W, cy: top + rightHeight / 2, r: 4, class: "bus-dot", fill: "#0d1113", stroke: "#2b8d5c" }, group);
  }

  node.capabilities.forEach((cap, i) => {
    const cx = 26 + i * 58;
    svgEl("line", { x1: cx, y1: height, x2: cx, y2: height + 11, class: "cap-line" }, group);
    svgEl("circle", { cx, cy: height + 14, r: 3.5, class: "cap-dot" }, group);
    svgEl("text", { x: cx + 8, y: height + 17.5, class: "port-label" }, group).textContent = cap.name;
  });

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

export function openDiagram(path: string): void {
  ui.view = path;
  ui.selection.clear();
  ui.selectedBus = null;
  ui.userAdjusted = false;
  notify({ redraw: true });
  fitWhenReady(20);
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

export function fitToView(): void {
  if (!currentGraph || !currentLayout) return;
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

  const rect = element("canvas-svg").getBoundingClientRect();
  if (!rect.width || !rect.height || !Number.isFinite(minX)) return;

  // Fitting shrinks a diagram to make it visible; it never magnifies one, or a
  // project with two small systems in it would open absurdly zoomed in.
  const zoom = Math.min(1, Math.max(0.25, Math.min(rect.width / (maxX - minX), rect.height / (maxY - minY))));
  ui.zoom = zoom;
  ui.panX = (rect.width - (maxX - minX) * zoom) / 2 - minX * zoom;
  ui.panY = (rect.height - (maxY - minY) * zoom) / 2 - minY * zoom;
  applyViewport();
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
  fitToView();
}
