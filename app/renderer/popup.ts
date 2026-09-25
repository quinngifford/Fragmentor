import type { NoteAnchor } from "../../src/project/notes.js";
import type { SnapshotBlock } from "../../src/project/snapshot.js";
import { ROLES } from "../../src/model/roles.js";
import { interfaceSection, reachesSection } from "./detail.js";
import { requireSnapshot, ui } from "./state.js";
import { benchWindowIsOpen } from "./benchpanel.js";
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

function overlay(): HTMLElement {
  const found = document.getElementById("overlay");
  if (!found) throw new Error("The interface is missing #overlay.");
  return found as HTMLElement;
}

export function closeWindow(): void {
  const host = overlay();
  host.replaceChildren();
  host.hidden = true;
}

let linesNoted: (blockPath: string, on: NoteAnchor) => void = () => {};
/** Called when the person asks to leave a note on the lines they picked out in a block's code. */
export function onLinesNoted(callback: (blockPath: string, on: NoteAnchor) => void): void {
  linesNoted = callback;
}

/** The frame every window shares: what it is about, and a way out of it. */
export function openWindow(title: string, subtitle: string, body: HTMLElement): void {
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
  close.focus();
}

/** Whether a window is open, which is what the Escape key needs to know. */
export function windowIsOpen(): boolean {
  return !overlay().hidden;
}

/* -------------------------------------------------------------------------- */
/* The code behind a block                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A file, coloured, with its lines numbered and the ones it is opened for
 * marked: the line a block starts on, or the lines a note is about. The first
 * of them is brought into view once the window is on screen.
 */
function codeView(text: string, language: ReturnType<typeof languageOf>, marked: number | [number, number] | null): HTMLElement {
  const [first, last] = marked === null ? [0, -1] : typeof marked === "number" ? [marked, marked] : marked;
  const pre = el("pre", "code window-code");
  codeLines(text, language).forEach((coloured, at) => {
    const number = at + 1;
    const line = el("span", number >= first && number <= last ? "excerpt-line target" : "excerpt-line");
    line.append(el("span", "excerpt-number", String(number)));
    while (coloured.firstChild) line.append(coloured.firstChild);
    pre.append(line);
  });
  requestAnimationFrame(() => pre.children[first - 1]?.scrollIntoView({ block: "center" }));
  return pre;
}

/** The lines the person has picked out in a code window, first and last, counting from 1. */
function pickedLines(pre: HTMLElement): [number, number] | null {
  const picked = window.getSelection();
  if (!picked || picked.rangeCount === 0 || picked.isCollapsed) return null;
  const range = picked.getRangeAt(0);
  const lineOf = (node: Node) => (node instanceof Element ? node : node.parentElement)?.closest(".excerpt-line") ?? null;
  const [start, end] = [lineOf(range.startContainer), lineOf(range.endContainer)];
  if (!start || !end || !pre.contains(start) || !pre.contains(end)) return null;
  const lines = [...pre.children];
  const first = lines.indexOf(start) + 1;
  let last = lines.indexOf(end) + 1;
  // A selection ending before any of a line's code, as a triple-click or a
  // drag down to the next line does, has not taken that line: all it holds
  // of it is the line's number, which cannot be selected.
  const tail = document.createRange();
  tail.setStart(end, 0);
  tail.setEnd(range.endContainer, range.endOffset);
  const number = end.querySelector(".excerpt-number")?.textContent ?? "";
  if (last > first && tail.toString().length <= number.length) last -= 1;
  return [first, last];
}

/**
 * The foot of a block's code window: a note on the lines picked out, and
 * anything else about the code. The lines are taken from the text shown,
 * which is kept with the note as it was.
 */
function codeFoot(block: SnapshotBlock, file: string, text: string, pre: HTMLElement): HTMLElement {
  const foot = el("div", "window-foot");
  const note = el("button", "btn quiet", "Leave a note on the selected lines");
  // Pressing a button would otherwise take the selection away before its click is heard.
  note.addEventListener("mousedown", (event) => event.preventDefault());
  const hint = el("p", "bench-note", "Select some lines, then leave a note on them for your coding agent.");
  note.addEventListener("click", () => {
    const lines = pickedLines(pre);
    if (lines === null) {
      hint.textContent = "Select the lines the note is about first: drag across them in the code above.";
      hint.classList.add("bad");
      return;
    }
    const kept = text.replace(/\r\n/g, "\n").split("\n").slice(lines[0] - 1, lines[1]).join("\n");
    linesNoted(block.path, { file, lines, text: kept });
  });
  foot.append(note, hint);
  return foot;
}

/**
 * The code a block stands for, whole: the file it points at, read off disk
 * rather than from the snapshot, which carries only the few lines the
 * inspector has room for. Code Fragmentor holds to a contract is already in
 * hand, because that is the code it offers to edit.
 */
export async function openCodeWindow(block: SnapshotBlock): Promise<void> {
  const snapshot = requireSnapshot();
  const body = el("div", "window-sections");
  const language = languageOf(block.language, block.code?.file ?? block.files.code);

  const own = block.sources.code;
  if (own !== null && own !== undefined) {
    const shown = codeView(own, language, block.code?.line ?? null);
    body.append(shown, codeFoot(block, block.code?.file ?? block.files.code, own, shown));
    openWindow(block.name, block.files.code, body);
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
  let foot: HTMLElement = el("div", "window-foot");
  if (result.value.text === null) {
    body.append(el("p", "bench-note", "This points at a folder, or at a file too large to show."));
  } else {
    const shown = codeView(result.value.text, language, result.value.line);
    body.append(shown);
    foot = codeFoot(block, result.value.file, result.value.text, shown);
  }

  const reveal = el("button", "btn quiet", "Show in folder");
  reveal.addEventListener("click", () => {
    void window.fragmentor.revealCode(snapshot.dir, result.value.file);
  });
  foot.append(reveal);
  if (block.drawnBecause !== null) foot.append(el("p", "bench-note", block.drawnBecause));
  body.append(foot);
}

/**
 * Where lines kept with a note are in a file now: found by what they said,
 * since the answer to a note usually moves them, or null where they are no
 * longer there as they were.
 */
function whereNow(text: string, kept: string): [number, number] | null {
  const wanted = kept.split("\n").filter((line, at, all) => !(at === all.length - 1 && line.startsWith("… (")));
  if (wanted.length === 0 || wanted.every((line) => line.trim() === "")) return null;
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  for (let at = 0; at + wanted.length <= lines.length; at += 1) {
    if (wanted.every((line, i) => lines[at + i] === line)) return [at + 1, at + wanted.length];
  }
  return null;
}

/**
 * The code one step of an execution runs, which may be any function in the
 * project, or the lines a note is about: found again by what they said when
 * the note was left, and marked where they were if they have changed.
 */
export async function openCodeAt(pointer: string, title: string, lines?: [number, number], kept?: string): Promise<void> {
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
  const found = kept === undefined ? null : whereNow(result.value.text, kept);
  body.append(codeView(result.value.text, languageOf(snapshot.language ?? "", result.value.file), found ?? lines ?? result.value.line));
  if (kept !== undefined && found === null) {
    body.append(el("p", "bench-note", "These lines have changed since the note was left, so the lines marked are where they were then."));
  }
}

/* -------------------------------------------------------------------------- */
/* What a block holds                                                          */
/* -------------------------------------------------------------------------- */

/**
 * A block's interface, what it reaches and what it is made of — the same
 * sections, under the same headings, as the inspector's own panel. The window
 * is where there is room to read them; the panel is where they sit beside
 * everything else about the block.
 */
export function openDetailsWindow(block: SnapshotBlock): void {
  const body = el("div", "window-sections");

  body.append(interfaceSection(block));

  const reaches = reachesSection(block);
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

/** Called once, as the window starts: Escape, or anywhere outside a window, closes it. */
export function setUpWindows(onBenchEscape: () => void): void {
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    // The window over the drawing first, then the bench beside it: Escape
    // closes what is most in the way.
    if (windowIsOpen()) {
      event.preventDefault();
      closeWindow();
    } else if (benchWindowIsOpen()) {
      event.preventDefault();
      onBenchEscape();
    }
  });
  overlay().addEventListener("pointerdown", (event) => {
    if (event.target === overlay()) closeWindow();
  });
}
