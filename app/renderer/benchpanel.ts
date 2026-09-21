import type { SnapshotBlock } from "../../src/project/snapshot.js";
import { benchSections, entryBenchSection } from "./bench.js";
import { watchSection } from "./watch.js";
import { el } from "./dom.js";
import { ui } from "./state.js";

/**
 * The test bench, in a window that can be moved off the drawing.
 *
 * Trying a block out is a different kind of work from reading the inspector.
 * It wants room — a form, the rows a store starts with, what came back, the
 * saved tests — and it wants the architecture still visible behind it, because
 * what a run does to the rest of the system is the thing worth watching. So it
 * is neither a panel that pushes the inspector's own sections down the page nor
 * a window that covers the tree: it is a small window over the canvas, dragged
 * wherever it is least in the way, and the inspector keeps one button to it.
 *
 * Where it was dragged to is kept in `ui`, so redrawing the project — which
 * happens every time the agent writes a file, and every time a run reports —
 * leaves it where the person put it.
 */

const WIDTH = 430;

function host(): HTMLElement {
  const found = document.getElementById("panels");
  if (!found) throw new Error("The interface is missing #panels.");
  return found as HTMLElement;
}

/** Opens the bench for a block, or for one entry of something that is not called. */
export function openBenchWindow(blockPath: string, entry: string | null = null): void {
  const at = ui.bench?.blockPath === blockPath ? ui.bench : null;
  // Measured on the canvas rather than on the host, which is hidden until
  // there is a window to put in it and would give back nothing.
  const rect = document.getElementById("canvas-wrap")?.getBoundingClientRect();
  ui.bench = {
    blockPath,
    entry,
    // Where it first appears: down the side of the drawing, so the tree is
    // still readable while the form is filled in.
    x: at?.x ?? Math.max(16, Math.round((rect?.width ?? WIDTH + 64) - WIDTH - 24)),
    y: at?.y ?? 84,
  };
}

export function closeBenchWindow(): void {
  ui.bench = null;
}

export function benchWindowIsOpen(): boolean {
  return ui.bench !== null;
}

/**
 * Dragging, by the window's own head.
 *
 * The position is written back to `ui` as the pointer moves, and the element is
 * moved directly rather than by redrawing: a redraw per pointer event would
 * rebuild the form being filled in.
 */
function draggable(pane: HTMLElement, head: HTMLElement): void {
  head.addEventListener("pointerdown", (event) => {
    if (!(event.target instanceof Element) || event.target.closest("button")) return;
    const bench = ui.bench;
    if (!bench) return;

    const from = { x: event.clientX, y: event.clientY, left: bench.x, top: bench.y };
    head.setPointerCapture(event.pointerId);
    pane.classList.add("dragging");

    const move = (moved: PointerEvent) => {
      const rect = host().getBoundingClientRect();
      const x = Math.min(Math.max(0, from.left + (moved.clientX - from.x)), Math.max(0, rect.width - 80));
      const y = Math.min(Math.max(0, from.top + (moved.clientY - from.y)), Math.max(0, rect.height - 40));
      pane.style.left = `${x}px`;
      pane.style.top = `${y}px`;
      if (ui.bench) {
        ui.bench.x = x;
        ui.bench.y = y;
      }
    };

    const done = () => {
      head.removeEventListener("pointermove", move);
      head.removeEventListener("pointerup", done);
      head.removeEventListener("pointercancel", done);
      pane.classList.remove("dragging");
    };

    head.addEventListener("pointermove", move);
    head.addEventListener("pointerup", done);
    head.addEventListener("pointercancel", done);
    event.preventDefault();
  });
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

  const window_ = el("div", "bench-window");
  window_.style.left = `${open.x}px`;
  window_.style.top = `${open.y}px`;
  window_.style.width = `${WIDTH}px`;

  const head = el("div", "bench-window-head");
  const names = el("div", "window-names");
  names.append(
    el("h2", undefined, open.entry === null ? `Try ${block.name}` : `Try ${open.entry}`),
    el("div", "window-sub", open.blockPath),
  );
  const close = el("button", "window-close", "✕");
  close.type = "button";
  close.title = "Close the bench (Esc)";
  close.addEventListener("click", () => {
    closeBenchWindow();
    notify();
  });
  head.append(names, close);

  const body = el("div", "bench-window-body");
  body.append(...sectionsFor(block, open.entry));

  window_.append(head, body);
  pane.append(window_);
  draggable(window_, head);
}

/** What the window holds: everything about running this block, and nothing else. */
function sectionsFor(block: SnapshotBlock, entry: string | null): HTMLElement[] {
  if (entry !== null) {
    const route = ui.bench?.route ?? "";
    return [entryBenchSection(entry, block, route)];
  }

  const [bench, cases] = benchSections(block);
  const watching = watchSection(block);
  return watching ? [bench, watching, cases] : [bench, cases];
}

let notify: () => void = () => {};
export function onBenchWindowChange(callback: () => void): void {
  notify = callback;
}
