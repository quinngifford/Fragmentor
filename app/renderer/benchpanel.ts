import { benchParts } from "./bench.js";
import { el } from "./dom.js";
import { BENCH_SIZE, readBenchSize, rememberBenchSize, ui } from "./state.js";

/**
 * The test bench, in a window that can be moved off the drawing.
 *
 * Trying a block out is a different kind of work from reading the inspector.
 * It wants room — a form, the rows a store starts with, what came back, the
 * saved tests — and it wants the architecture still visible behind it, because
 * what a run does to the rest of the system is the thing worth watching. So it
 * is neither a panel that pushes the inspector's own sections down the page nor
 * a window that covers the tree: it is a window over the canvas, moved and
 * sized to wherever it is least in the way, and the inspector keeps only the
 * ways into it.
 *
 * Where it was put and how big it was pulled are kept in `ui`, so redrawing the
 * project — which happens every time the agent writes a file, and every time a
 * run reports — leaves it where the person put it. Its size outlives the
 * session, because how much room this work wants is a fact about the person
 * rather than about the block.
 */

function host(): HTMLElement {
  const found = document.getElementById("panels");
  if (!found) throw new Error("The interface is missing #panels.");
  return found as HTMLElement;
}

/** Opens the bench for a block, or for one entry of something that is not called. */
export function openBenchWindow(blockPath: string, entry: string | null = null): void {
  const at = ui.bench?.blockPath === blockPath ? ui.bench : null;
  const size = at ? { w: at.w, h: at.h } : readBenchSize();
  // Measured on the canvas rather than on the host, which is hidden until
  // there is a window to put in it and would give back nothing.
  const rect = document.getElementById("canvas-wrap")?.getBoundingClientRect();
  const width = Math.min(size.w, Math.max(BENCH_SIZE.leastW, (rect?.width ?? size.w) - 32));
  ui.bench = {
    blockPath,
    entry,
    // Where it first appears: down the side of the drawing, so the tree is
    // still readable while the form is filled in.
    x: at?.x ?? Math.max(16, Math.round((rect?.width ?? width + 64) - width - 24)),
    y: at?.y ?? 72,
    w: width,
    h: size.h,
    minimised: at?.minimised ?? false,
  };
}

export function closeBenchWindow(): void {
  ui.bench = null;
}

export function benchWindowIsOpen(): boolean {
  return ui.bench !== null;
}

/** How much room there is to put a window in, which is whatever the canvas covers. */
function room(): { width: number; height: number } {
  const rect = host().getBoundingClientRect();
  return { width: rect.width || BENCH_SIZE.standardW, height: rect.height || BENCH_SIZE.standardH };
}

function within(value: number, least: number, most: number): number {
  return Math.min(Math.max(value, least), Math.max(least, most));
}

/**
 * A pointer held down on one part of the window until it is let go.
 *
 * Tracked on the window rather than on the part pressed, as the splitter
 * beside the inspector is: the pointer leaves a thin edge the moment it starts
 * moving. What is moving is written back to `ui` and applied to the element
 * directly rather than by redrawing — a redraw per pointer event would rebuild
 * the form being filled in.
 */
function whileHeld(on: HTMLElement, start: (event: PointerEvent) => ((at: PointerEvent) => void) | null, end?: () => void): void {
  on.addEventListener("pointerdown", (event) => {
    const move = start(event);
    if (!move) return;

    const follow = (at: PointerEvent) => {
      if (at.pointerId === event.pointerId) move(at);
    };
    const stop = (up: PointerEvent) => {
      if (up.pointerId !== event.pointerId) return;
      window.removeEventListener("pointermove", follow);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      end?.();
    };

    window.addEventListener("pointermove", follow);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    event.preventDefault();
  });
}

/** Dragging, by the window's own head. */
function draggable(pane: HTMLElement, head: HTMLElement): void {
  whileHeld(
    head,
    (event) => {
      if (!(event.target instanceof Element) || event.target.closest("button")) return null;
      const bench = ui.bench;
      if (!bench) return null;

      const from = { x: event.clientX, y: event.clientY, left: bench.x, top: bench.y };
      pane.classList.add("dragging");

      return (moved) => {
        const space = room();
        const x = within(from.left + (moved.clientX - from.x), 0, space.width - 80);
        const y = within(from.top + (moved.clientY - from.y), 0, space.height - 40);
        pane.style.left = `${x}px`;
        pane.style.top = `${y}px`;
        if (ui.bench) {
          ui.bench.x = x;
          ui.bench.y = y;
        }
      };
    },
    () => pane.classList.remove("dragging"),
  );
}

/**
 * The edges and corners a window is pulled by.
 *
 * `moves` says whether that edge carries the window's own corner with it, and
 * `grows` which way the size follows the pointer. An edge that moves the corner
 * takes its new position from the size that was actually allowed, so pulling
 * past the smallest the window may be stops rather than dragging it sideways.
 */
const EDGES = [
  { at: "n", cursor: "ns", movesX: 0, movesY: 1, growsW: 0, growsH: -1 },
  { at: "s", cursor: "ns", movesX: 0, movesY: 0, growsW: 0, growsH: 1 },
  { at: "e", cursor: "ew", movesX: 0, movesY: 0, growsW: 1, growsH: 0 },
  { at: "w", cursor: "ew", movesX: 1, movesY: 0, growsW: -1, growsH: 0 },
  { at: "ne", cursor: "nesw", movesX: 0, movesY: 1, growsW: 1, growsH: -1 },
  { at: "nw", cursor: "nwse", movesX: 1, movesY: 1, growsW: -1, growsH: -1 },
  { at: "se", cursor: "nwse", movesX: 0, movesY: 0, growsW: 1, growsH: 1 },
  { at: "sw", cursor: "nesw", movesX: 1, movesY: 0, growsW: -1, growsH: 1 },
] as const;

function resizable(pane: HTMLElement): void {
  for (const edge of EDGES) {
    const grip = el("div", `bench-grip bench-grip-${edge.at}`);
    grip.dataset.edge = edge.at;
    pane.append(grip);

    whileHeld(
      grip,
      (event) => {
        const bench = ui.bench;
        if (!bench) return null;

        const from = { x: event.clientX, y: event.clientY, left: bench.x, top: bench.y, w: bench.w, h: bench.h };
        pane.classList.add("sizing");
        document.body.dataset.sizing = edge.cursor;
        event.stopPropagation();

        return (moved) => {
          const space = room();
          const dx = moved.clientX - from.x;
          const dy = moved.clientY - from.y;
          const w = within(from.w + edge.growsW * dx, BENCH_SIZE.leastW, space.width);
          const h = within(from.h + edge.growsH * dy, BENCH_SIZE.leastH, space.height);
          const x = edge.movesX ? within(from.left + (from.w - w), 0, space.width - 80) : from.left;
          const y = edge.movesY ? within(from.top + (from.h - h), 0, space.height - 40) : from.top;

          pane.style.width = `${w}px`;
          pane.style.height = `${h}px`;
          pane.style.left = `${x}px`;
          pane.style.top = `${y}px`;
          if (ui.bench) Object.assign(ui.bench, { w, h, x, y });
        };
      },
      () => {
        pane.classList.remove("sizing");
        delete document.body.dataset.sizing;
        if (ui.bench) rememberBenchSize(ui.bench.w, ui.bench.h);
      },
    );
  }
}

/**
 * Draws the bench window, or takes it away.
 *
 * Called from every redraw, so what a run left behind appears in it, and so a
 * block that has gone — renamed by the agent, or made planned — takes its bench
 * with it rather than leaving a window about nothing.
 */
export function renderBenchWindow(): void {
  const pane = host();
  pane.replaceChildren();

  const open = ui.bench;
  const block = open === null ? undefined : ui.snapshot?.blocks[open.blockPath];
  if (!open || !block) {
    pane.hidden = true;
    if (open && !block) ui.bench = null;
    return;
  }
  pane.hidden = false;

  // A window sized on a wide canvas must still fit a narrow one: the app is
  // resized, and the rail and the inspector come and go, under a window that
  // was left where it was. What it was pulled to is kept; what is drawn is
  // whatever of that there is room for.
  const space = room();
  const w = within(open.w, BENCH_SIZE.leastW, space.width);
  const h = within(open.h, BENCH_SIZE.leastH, space.height);
  const x = within(open.x, 0, space.width - 80);
  const y = within(open.y, 0, space.height - 40);

  const window_ = el("div", "bench-window");
  window_.dataset.minimised = String(open.minimised);
  window_.style.left = `${x}px`;
  window_.style.top = `${y}px`;
  window_.style.width = `${w}px`;
  // Rolled up, the window is as tall as its head and no taller.
  if (!open.minimised) window_.style.height = `${h}px`;

  const head = el("div", "bench-window-head");
  const names = el("div", "window-names");
  names.append(
    el("h2", undefined, open.entry === null ? `Try ${block.name}` : `Try ${open.entry}`),
    el("div", "window-sub", open.blockPath),
  );

  const buttons = el("div", "window-buttons");
  const roll = el("button", "window-close", open.minimised ? "▢" : "—");
  roll.type = "button";
  roll.title = open.minimised ? "Open the bench back up" : "Roll the bench up to its title";
  roll.addEventListener("click", () => {
    if (ui.bench) ui.bench.minimised = !ui.bench.minimised;
    notify();
  });

  const close = el("button", "window-close", "✕");
  close.type = "button";
  close.title = "Close the bench (Esc)";
  close.addEventListener("click", () => {
    closeBenchWindow();
    notify();
  });
  buttons.append(roll, close);
  head.append(names, buttons);
  window_.append(head);

  if (!open.minimised) {
    const body = el("div", "bench-window-body");
    body.append(...benchParts(block, open.entry, ui.bench?.route ?? ""));
    window_.append(body);
  }

  pane.append(window_);
  draggable(window_, head);
  if (!open.minimised) resizable(window_);
}

let notify: () => void = () => {};
export function onBenchWindowChange(callback: () => void): void {
  notify = callback;
}
