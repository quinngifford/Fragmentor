import type { BlockVersion, BlockVersions } from "../../src/project/history.js";
import type { CaseResult } from "../../src/run/run.js";
import type { ComparedBlock, ComparedTest, VersionComparison } from "../../src/run/versions.js";
import type { Result } from "../ipc.js";
import { statusWord } from "./bench.js";
import { el, section, subsection } from "./dom.js";
import { openWindow } from "./popup.js";
import { forgetBlocks, ui } from "./state.js";

/**
 * A block's earlier versions, in a window over the drawing.
 *
 * Fragmentor keeps no history of its own: the versions are commits of the git
 * repository holding the project, and the kernel reads them. This window lists
 * them, compares one with the block as it is, and swaps one in and back out.
 *
 * What it shows lives in its own elements rather than in `ui`. Nothing else
 * draws from it, and a comparison that took seconds to run has to outlive the
 * agent writing a file, which redraws everything that is drawn from `ui`.
 */

let notify: () => Promise<void> = async () => {};
/** Called once a swap or an undo has rewritten the project, to show it at once. */
export function onVersionsChange(callback: () => Promise<void>): void {
  notify = callback;
}

/** The window on screen: which block it is for, the list it was drawn from, and whether something in it is running. */
interface Shown {
  blockPath: string;
  body: HTMLElement;
  listed: string;
  busy: boolean;
}

/** The versions window last opened. It is on screen while its body is. */
let showing: Shown | null = null;

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** Whether a block path is `root` or one of its parts, however deep. */
function under(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/** What the window calls the block, as the project on screen has it. */
function about(blockPath: string): { name: string; parts: boolean } {
  const block = ui.snapshot?.blocks[blockPath];
  return { name: block?.name ?? blockPath, parts: (block?.children.length ?? 0) > 0 };
}

export async function openVersionsWindow(blockPath: string): Promise<void> {
  const dir = ui.dir;
  if (!dir || !ui.snapshot?.blocks[blockPath]) return;

  // Opened at once, so the window is never a blank rectangle while git is asked.
  const body = el("div", "window-sections");
  body.append(el("p", "bench-note", "Reading the project's git history…"));
  openWindow(about(blockPath).name, `versions · ${blockPath}`, body);
  const shown: Shown = { blockPath, body, listed: "", busy: false };
  showing = shown;

  const result = await window.fragmentor.blockVersions(dir, blockPath);
  // Something else was opened, or it was closed, while the history was read.
  if (!body.isConnected) return;
  draw(shown, result);
}

/**
 * Reads the list again, and redraws the window only if it changed, so a
 * comparison on screen stays there. Nothing is redrawn while something in the
 * window is running; a comparison that finishes, and every swap and undo, reads
 * the list again, so a change heard in the meantime is not lost.
 */
export async function refreshVersionsWindow(): Promise<void> {
  const shown = showing;
  const dir = ui.dir;
  if (!shown || !dir || !shown.body.isConnected || shown.busy) return;

  const result = await window.fragmentor.blockVersions(dir, shown.blockPath);
  if (showing !== shown || ui.dir !== dir || !shown.body.isConnected || shown.busy) return;
  if (JSON.stringify(result) !== shown.listed) draw(shown, result);
}

function draw(shown: Shown, result: Result<BlockVersions>): void {
  shown.listed = JSON.stringify(result);
  const { name, parts } = about(shown.blockPath);

  if (!result.ok) {
    shown.body.replaceChildren(el("p", "bench-note bad", `Could not read the versions: ${result.error}`));
    return;
  }
  const { unavailable, versions, more, changed, blocked, swapped } = result.value;

  const node = section("Versions");
  shown.body.replaceChildren(node);
  node.append(
    el(
      "p",
      "bench-note",
      parts
        ? `A version is ${name} and its parts as they were at one commit of the project's git history, with their saved tests and the code they point at.`
        : `A version is ${name} as it was at one commit of the project's git history, with its saved tests and the code it points at.`,
    ),
  );
  // Only where the buttons it describes are shown.
  if (unavailable === null && blocked === null) {
    node.append(
      el(
        "p",
        "bench-note",
        "Compare runs the saved tests of both versions against both. Swap to this puts that version's files in place of these, and Undo swap puts these back.",
      ),
    );
  }
  if (unavailable !== null) node.append(el("p", "bench-note", unavailable));
  // Said once, up front, rather than as the answer to every Swap pressed.
  if (blocked !== null) node.append(el("p", "bench-note bad", blocked));

  // The saved tests' rows, because a version is read the same way: its name
  // on a line of its own, and what can be done with it underneath.
  const list = el("div", "cases versions");

  const now = el("div", "case-row version-row");
  now.dataset.now = "true";
  now.append(
    el("div", "case-name", "Now"),
    el(
      "div",
      "version-meta",
      swapped !== null
        ? `Swapped to the version “${swapped.subject}”, of ${when(swapped.date)}.`
        : versions.length === 0
          ? "Not in any version yet."
          : changed
            ? "Changed since the latest version. These changes are not in any version yet."
            : "The same as the latest version.",
    ),
  );
  if (swapped !== null) {
    const undo = el("button", undefined, "Undo swap");
    undo.title = `Put ${name} back as it was before the swap, from the copy kept when it was made.`;
    undo.addEventListener("click", () => void swapOrUndo(shown, now, null));
    const actions = el("div", "case-actions");
    actions.append(undo);
    now.append(actions);
  }
  list.append(now);

  // Undoing needs only the copy the swap kept, not git, so a swap can still
  // be undone while git cannot list the versions.
  if (unavailable !== null) {
    if (swapped !== null) node.append(list);
    return;
  }

  versions.forEach((version, at) => {
    const row = el("div", "case-row version-row");
    row.dataset.commit = version.commit;
    row.append(
      el("div", "case-name", version.subject),
      el(
        "div",
        "version-meta",
        `${when(version.date)} · ${version.author} · ${version.commit.slice(0, 7)}${at === 0 ? " · latest" : ""}${
          swapped?.commit === version.commit ? " · swapped in" : ""
        }`,
      ),
    );
    if (blocked === null) {
      const compare = el("button", undefined, "Compare");
      compare.title = `Run the saved tests of both versions against ${name} as it is now and as it was then.`;
      compare.addEventListener("click", () => void compareWith(shown, row, version));
      const swap = el("button", undefined, "Swap to this");
      swap.title = `Make ${name} as it was in this version. Undo swap returns it to how it is now.`;
      swap.addEventListener("click", () => void swapOrUndo(shown, row, version));
      const actions = el("div", "case-actions");
      actions.append(compare, swap);
      row.append(actions);
    }
    list.append(row);
  });
  node.append(list);

  if (versions.length === 0) {
    node.append(
      el(
        "p",
        "bench-note",
        `No commit holds ${name} yet. Its versions start at the first commit that does, and FRAGMENTOR.md asks your agent to commit each time it finishes a block.`,
      ),
    );
  }
  if (more) node.append(el("p", "bench-note", "Only the newest 100 versions are listed."));
}

/** What is happening to one row, or what went wrong with it, across the whole row. Null takes it away. */
function rowNote(row: HTMLElement, text: string | null, bad = false): void {
  row.querySelector(":scope > .bench-note")?.remove();
  if (text === null) return;
  // Above any comparison already there, next to the buttons it is about.
  row.insertBefore(el("p", bad ? "bench-note bad" : "bench-note", text), row.querySelector(":scope > .version-compare"));
}

/** One thing at a time: while a comparison or a swap runs, nothing else in the window can be pressed. */
function setBusy(shown: Shown, busy: boolean): void {
  shown.busy = busy;
  for (const button of shown.body.querySelectorAll<HTMLButtonElement>(".versions button")) button.disabled = busy;
}

async function compareWith(shown: Shown, row: HTMLElement, version: BlockVersion): Promise<void> {
  const dir = ui.dir;
  if (!dir) return;

  setBusy(shown, true);
  rowNote(row, "Comparing: running the saved tests against both versions…");
  const result = await window.fragmentor.compareVersion(dir, shown.blockPath, version.commit);
  setBusy(shown, false);
  if (!shown.body.isConnected) return;

  if (!result.ok) {
    // Kept on screen: a list read again now could redraw it away.
    rowNote(row, `Could not compare: ${result.error}`, true);
    return;
  }
  rowNote(row, null);
  row.querySelector(":scope > .version-compare")?.remove();
  row.append(comparison(shown.blockPath, result.value));
  await refreshVersionsWindow();
}

/**
 * What comparing found: every test of the block and its parts, from either
 * version, and whichever other tests in its system come out differently, since
 * a swap can change what a block outside it does without touching its files.
 */
function comparison(blockPath: string, compared: VersionComparison): HTMLElement {
  const { name, parts } = about(blockPath);
  const whole = `${name}${parts ? " and its parts" : ""}`;
  const box = el("div", "version-compare");
  box.append(
    el(
      "p",
      "bench-note",
      `Every saved test of ${whole}, from either version, runs against both, as does every other saved test in ${compared.system}. A test saved in both versions runs as it is saved now.`,
    ),
  );

  const tests = compared.inside.flatMap((block) => block.tests);
  const total = tests.length;
  const differ = tests.filter((test) => test.differs).length;
  // A test that ends in an error in both versions, because the block could
  // not be run or because its code threw, came out the same only in failing
  // the same way, which says nothing about the two versions.
  const erred = (result: CaseResult | null) => result !== null && result.status === "error" && result.inputProblems.length === 0;
  const erredBoth = total > 0 && tests.every((test) => erred(test.now) && erred(test.then));
  const unread = compared.inside.some((block) => block.unreadable.now !== null || block.unreadable.then !== null);
  box.append(
    el(
      "p",
      "case-summary",
      total === 0
        ? `Neither version of ${whole} has a saved test${unread ? " that could be read" : ""}.`
        : erredBoth
          ? `Every saved test of ${whole} ends in an error in both versions: ${tests[0]!.now!.error ?? "No reason given."}`
          : differ === 0
            ? `Every saved test of ${whole} comes out the same in both versions.`
            : `${differ} of ${total} saved test${total === 1 ? "" : "s"} of ${whole} ${differ === 1 ? "comes" : "come"} out differently.`,
    ),
  );
  for (const block of compared.inside) box.append(testsOf(block));

  const others = compared.othersRun;
  if (others > 0) {
    const elsewhere = compared.outside.reduce((sum, block) => sum + block.tests.length, 0);
    box.append(
      el(
        "p",
        "bench-note compare-others",
        elsewhere === 0
          ? `Every other saved test in ${compared.system} comes out the same in both versions.`
          : `${elsewhere} of ${others} other saved test${others === 1 ? "" : "s"} in ${compared.system} ${elsewhere === 1 ? "comes" : "come"} out differently:`,
      ),
    );
  }
  // Listed even when no other test ran: a block can be here only because
  // its tests could not be read.
  for (const block of compared.outside) box.append(testsOf(block));
  return box;
}

function testsOf(block: ComparedBlock): HTMLElement {
  const node = subsection(block.name);
  const { unreadable } = block;
  if (unreadable.now !== null) node.append(el("p", "bench-note bad", `Its saved tests could not be read now: ${unreadable.now}`));
  if (unreadable.then !== null) node.append(el("p", "bench-note bad", `Its saved tests could not be read as they were then: ${unreadable.then}`));
  const list = el("div", "cases");
  for (const test of block.tests) list.append(compareRow(test));
  node.append(list);
  return node;
}

/** A saved test's row, with how it came out now where its buttons would be, and how it came out then beside it. */
function compareRow(test: ComparedTest): HTMLElement {
  const row = el("div", "case-row compare-row");
  row.dataset.differs = String(test.differs);

  const label = el("div", "case-name", test.name);
  const saved =
    test.saved === "now" ? " · new since then" : test.saved === "then" ? " · no longer saved" : test.redefined ? " · changed since then" : "";
  if (saved) label.append(el("span", "case-saved", saved));

  row.append(label, outcome("now", test.now), outcome("then", test.then));
  return row;
}

/**
 * How a test came out in one version, in the bench's words. A block that is
 * not in that version, or a test whose input no longer fits it, neither
 * passed nor failed, so both are drawn like a test with no expectation.
 */
function outcome(side: "now" | "then", result: CaseResult | null): HTMLElement {
  const [word, tone] =
    result === null
      ? ["not in this version", "unchecked"]
      : result.status === "error" && result.inputProblems.length > 0
        ? ["does not fit", "unchecked"]
        : [statusWord(result.status), result.status];
  const cell = el("div", `case-status ${tone}${side === "then" ? " compare-then" : ""}`, `${side} · ${word}`);
  // A refused input's error only says it was refused; the problems say why.
  if (result !== null) {
    cell.title =
      result.differences.length > 0 ? result.differences.join("\n") : [result.error ?? "", ...result.inputProblems].filter(Boolean).join("\n");
  }
  return cell;
}

/**
 * Swaps the block to a version, or with no version, undoes its last swap.
 *
 * Either one rewrites the block's files, so neither goes ahead while the code
 * editor holds unsaved text for one of them: that text was typed against the
 * file being replaced, and saving it afterwards would quietly undo the swap.
 */
async function swapOrUndo(shown: Shown, row: HTMLElement, version: BlockVersion | null): Promise<void> {
  const dir = ui.dir;
  if (!dir) return;
  const { blockPath } = shown;
  const { name } = about(blockPath);

  const unsaved = [...ui.edits.keys()].find((path) => under(blockPath, path));
  if (unsaved !== undefined) {
    const text = `Save or revert the unsaved changes to ${ui.snapshot?.blocks[unsaved]?.name ?? unsaved}'s code first: ${
      version === null ? "undoing the swap" : "swapping"
    } would replace that file.`;
    rowNote(row, text, true);
    ui.status = { text, tone: "bad" };
    await notify();
    return;
  }

  setBusy(shown, true);
  rowNote(row, version === null ? "Undoing the swap…" : "Swapping…");
  const result =
    version === null
      ? await window.fragmentor.undoSwap(dir, blockPath)
      : await window.fragmentor.swapVersion(dir, blockPath, version.commit);
  if (ui.dir !== dir) return;

  // A swap to what is already there changes nothing and keeps no record; an
  // undo always keeps one, so its swap can't be undone twice.
  if (result.ok && result.value.changed === 0 && version !== null) {
    ui.status = { text: `${name} is already as it was in that version.`, tone: "info" };
  } else {
    // Even a swap that failed may have written some files before it stopped.
    forgetBlocks(blockPath);
    if (!result.ok) {
      const text = version === null ? `Could not undo the swap of ${name}: ${result.error}` : `Could not swap ${name}: ${result.error}`;
      rowNote(row, text, true);
      ui.status = { text, tone: "bad" };
    } else if (version === null) {
      ui.status = { text: `Put ${name} back as it was before the swap.`, tone: "good" };
    } else {
      ui.status = { text: `Swapped ${name} to the version “${version.subject}”. Undo swap is in its Versions window.`, tone: "good" };
    }
  }

  await notify();
  setBusy(shown, false);
  // Read again, for the swap Undo swap now reverses. A failure that still left
  // a copy behind gets its Undo swap; one that did not keeps its note. A
  // window closed in the meantime stays closed.
  if (result.ok) {
    if (shown.body.isConnected) await openVersionsWindow(blockPath);
  } else {
    await refreshVersionsWindow();
  }
}
