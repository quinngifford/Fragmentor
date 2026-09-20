import type { SnapshotBlock } from "../../src/project/snapshot.js";
import { ROLES } from "../../src/model/roles.js";
import { accessSection, exposedSection, portSection } from "./detail.js";
import { requireSnapshot, ui } from "./state.js";
import { el, section } from "./dom.js";
import { codeLines, languageOf } from "./highlight.js";

/**
 * A window over the drawing.
 *
 * A block on the tree is a small box: its name and what kind of thing it is,
 * and no more, so a whole system stays readable. Everything else about it —
 * its code, its shape, what it reaches — is a press away, in a window big
 * enough to read it in.
 */

let onClose: () => void = () => {};
/** Called when a window closes, so whatever opened it can put its own state back. */
export function onWindowClosed(callback: () => void): void {
  onClose = callback;
}

function overlay(): HTMLElement {
  const found = document.getElementById("overlay");
  if (!found) throw new Error("The interface is missing #overlay.");
  return found as HTMLElement;
}

export function closeWindow(): void {
  const host = overlay();
  host.replaceChildren();
  host.hidden = true;
  onClose();
}

/** The frame every window shares: what it is about, and a way out of it. */
function openWindow(title: string, subtitle: string, body: HTMLElement): void {
  const host = overlay();
  host.replaceChildren();
  host.hidden = false;

  const pane = el("div", "window");
  const head = el("div", "window-head");
  const names = el("div", "window-names");
  names.append(el("h2", undefined, title), el("div", "window-sub", subtitle));
  const close = el("button", "window-close", "✕");
  close.type = "button";
  close.title = "Close (Esc)";
  close.addEventListener("click", closeWindow);
  head.append(names, close);

  const scroll = el("div", "window-body");
  scroll.append(body);
  pane.append(head, scroll);
  host.append(pane);

  // Anywhere outside the window closes it, as does Escape.
  host.addEventListener("pointerdown", (event) => {
    if (event.target === host) closeWindow();
  });
  close.focus();
}

/** Whether a window is open, which is what the Escape key needs to know. */
export function windowIsOpen(): boolean {
  return !overlay().hidden;
}

/* -------------------------------------------------------------------------- */
/* The code behind a block                                                     */
/* -------------------------------------------------------------------------- */

/** A file, coloured, with its lines numbered and the one the block starts on marked. */
function codeView(text: string, language: ReturnType<typeof languageOf>, startsAt: number | null): HTMLElement {
  const pre = el("pre", "code window-code");
  codeLines(text, language).forEach((coloured, at) => {
    const number = at + 1;
    const line = el("span", number === startsAt ? "excerpt-line target" : "excerpt-line");
    line.append(el("span", "excerpt-number", String(number)));
    while (coloured.firstChild) line.append(coloured.firstChild);
    pre.append(line);
  });
  return pre;
}

/**
 * The code a block stands for. In a structured project that is the file
 * Fragmentor holds for it; in a visual one it is whatever the block points
 * at, read off disk so the window shows the whole of it rather than the few
 * lines the inspector has room for.
 */
export async function openCodeWindow(block: SnapshotBlock): Promise<void> {
  const snapshot = requireSnapshot();
  const body = el("div", "window-sections");
  const language = languageOf(block.language, block.code?.file ?? block.files.impl);

  const own = block.sources.impl;
  if (own !== null && own !== undefined) {
    body.append(codeView(own, language, null));
    openWindow(block.name, `${block.path}/${block.files.impl}`, body);
    return;
  }

  if (!block.code) {
    body.append(el("p", "bench-note", "This block does not say where its code is."));
    openWindow(block.name, block.path, body);
    return;
  }

  // Opened at once, so the window is never a blank rectangle while the file is read.
  const pointer = block.code.pointer;
  body.append(el("p", "bench-note", `Reading ${block.code.file}…`));
  openWindow(block.name, pointer, body);

  const result = await window.fragmentor.readCode(snapshot.dir, pointer);
  // Something else was opened, or it was closed, while the file was being read.
  if (!windowIsOpen()) return;
  body.replaceChildren();

  if (!result.ok) {
    body.append(el("p", "bench-note bad", result.error));
    return;
  }
  if (result.value.text === null) {
    body.append(el("p", "bench-note", "This points at a folder, or at a file too large to show."));
  } else {
    body.append(codeView(result.value.text, language, result.value.line));
  }

  const foot = el("div", "window-foot");
  const reveal = el("button", "btn quiet", "Show in folder");
  reveal.addEventListener("click", () => {
    void window.fragmentor.revealCode(snapshot.dir, result.value.file);
  });
  foot.append(reveal);
  if (snapshot.mode === "visual") {
    foot.append(el("p", "bench-note", "Visual mode: Fragmentor shows this code and never changes it."));
  }
  body.append(foot);
}

/** The code one step of an execution runs, which may be any function in the project. */
export async function openCodeAt(pointer: string, title: string): Promise<void> {
  const snapshot = requireSnapshot();
  const body = el("div", "window-sections");
  body.append(el("p", "bench-note", `Reading ${pointer}…`));
  openWindow(title, pointer, body);

  const result = await window.fragmentor.readCode(snapshot.dir, pointer);
  if (!windowIsOpen()) return;
  body.replaceChildren();
  if (!result.ok) {
    body.append(el("p", "bench-note bad", result.error));
    return;
  }
  if (result.value.text === null) {
    body.append(el("p", "bench-note", "This points at a folder, or at a file too large to show."));
    return;
  }
  body.append(codeView(result.value.text, languageOf(snapshot.language ?? "", result.value.file), result.value.line));
}

/* -------------------------------------------------------------------------- */
/* What a block holds                                                          */
/* -------------------------------------------------------------------------- */

/** A block's shape: what it takes and gives back, or what it offers, and what it reaches. */
export function openDetailsWindow(block: SnapshotBlock): void {
  const body = el("div", "window-sections");

  if (block.architecture) {
    body.append(exposedSection(block));
  } else {
    body.append(portSection("Takes", block.inputs));
    body.append(portSection("Gives back", block.outputs));
    if (block.capabilities.length > 0) body.append(portSection("Reaches outside the program", block.capabilities, true));
  }

  const reaches = accessSection(block);
  if (reaches) body.append(reaches);

  const parts = requireSnapshot().blocks[block.path]?.children ?? [];
  if (parts.length > 0) {
    const made = section("Made of");
    const list = el("div", "ports");
    for (const part of parts) {
      const child = requireSnapshot().blocks[part];
      if (!child) continue;
      const row = el("div", "port-row");
      row.append(el("div", "pname", child.name), el("div", "ptype", child.roleLabel.toLowerCase()));
      if (child.responsibility) row.append(el("div", "pdesc", child.responsibility));
      list.append(row);
    }
    made.append(list);
    body.append(made);
  }

  openWindow(block.name, `${ROLES[block.role].label.toLowerCase()} · ${block.path}`, body);
}

/** Opens whichever window a block's buttons ask for. */
export function openBlockWindow(kind: "code" | "details", blockPath: string): void {
  const block = ui.snapshot?.blocks[blockPath];
  if (!block) return;
  if (kind === "code") void openCodeWindow(block);
  else openDetailsWindow(block);
}

/** Called once, as the window starts: Escape closes whatever is open. */
export function setUpWindows(): void {
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && windowIsOpen()) {
      event.preventDefault();
      closeWindow();
    }
  });
}
