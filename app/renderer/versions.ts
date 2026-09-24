import type { BlockVersion, BlockVersions } from "../../src/project/history.js";
import type { SnapshotBlock } from "../../src/project/snapshot.js";
import type { CaseResult } from "../../src/run/run.js";
import type { ComparedBlock, ComparedTest, VersionComparison } from "../../src/run/versions.js";
import type { Result } from "../ipc.js";
import { statusWord } from "./bench.js";
import { el, section, subsection } from "./dom.js";
import { forgetBlocks, ui } from "./state.js";

/**
 * A block's earlier versions, as the last section of its panel.
 *
 * Fragmentor keeps no history of its own: the versions are commits of the git
 * repository holding the project, and the kernel reads them. The section lists
 * them, compares one with the block as it is, and swaps one in and back out.
 *
 * The panel is drawn again whenever anything changes, and asking git takes a
 * moment, so what the section shows is kept here rather than asked for every
 * time: the list last read, the comparisons run, and what each row is doing. A
 * comparison that took seconds to run outlives the agent writing a file, and
 * the person looking at another block and coming back.
 */

let redraw: () => void = () => {};
let redrawAll: () => void = () => {};
let reloadProject: () => Promise<void> = async () => {};
/**
 * `panel` draws the inspector again, which is all that reading a list or
 * comparing changes; `all` draws everything, for what the status line says;
 * `reload` reads the project again and shows it, once a swap or an undo has
 * rewritten it. Drawing only the panel matters: the list is read every time a
 * block is picked, and drawing the tree again each time would move it under
 * the pointer.
 */
export function onVersionsChange(callbacks: { panel: () => void; all: () => void; reload: () => Promise<void> }): void {
  redraw = callbacks.panel;
  redrawAll = callbacks.all;
  reloadProject = callbacks.reload;
}

/** The list last read, and which block of which project it is for. */
let listed: { dir: string; blockPath: string; result: Result<BlockVersions> } | null = null;
/** The block whose list is being read, so a redraw meanwhile does not ask again. */
let reading: string | null = null;
/** Only the newest read counts. */
let latestRead = 0;
/** The comparison shown for a block, with the version it is against and when it was run. One a block, so the panel stays readable. */
const comparisons = new Map<string, { commit: string; at: Date; value: VersionComparison }>();
/** What a row is doing, or what went wrong with it, by block and row: a version's commit, or "now". */
const notes = new Map<string, { text: string; bad: boolean }>();
/** One thing at a time: while a comparison or a swap runs, nothing else in the section can be pressed. */
let busy = false;

const noteKey = (blockPath: string, row: string) => `${blockPath}\n${row}`;

function when(date: string | Date): string {
  return new Date(date).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** Whether a block path is `root` or one of its parts, however deep. */
function under(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/** Everything the section keeps, for a project that has closed. */
export function forgetVersions(): void {
  listed = null;
  reading = null;
  comparisons.clear();
  notes.clear();
}

/** Reads a block's list, and redraws the panel if it changed, so reading it again never takes the focus from anything. */
async function read(blockPath: string): Promise<void> {
  const dir = ui.dir;
  if (!dir) return;
  const ticket = ++latestRead;
  reading = blockPath;
  const result = await window.fragmentor.blockVersions(dir, blockPath);
  if (ticket !== latestRead || ui.dir !== dir) return;
  reading = null;

  const before = listed?.dir === dir && listed.blockPath === blockPath ? JSON.stringify(listed.result) : null;
  listed = { dir, blockPath, result };
  if (JSON.stringify(result) !== before) redraw();
}

/**
 * Reads the list on screen again, for a change the project's files cannot
 * show: an agent's commit touches only .git, which nothing watches. Nothing is
 * read while something in the section is running; a comparison that finishes,
 * and every swap and undo, reads the list again itself.
 */
export async function refreshVersions(): Promise<void> {
  const onScreen = document.querySelector<HTMLElement>("#inspector [data-versions-of]")?.dataset.versionsOf;
  if (busy || onScreen === undefined || listed?.blockPath !== onScreen) return;
  await read(onScreen);
}

export function versionsSection(block: SnapshotBlock): HTMLElement {
  const node = section("Versions");
  node.dataset.versionsOf = block.path;

  const shown = listed?.dir === ui.dir && listed?.blockPath === block.path ? listed.result : null;
  if (shown === null) {
    node.append(el("p", "bench-note", "Reading the project's git history…"));
    if (reading !== block.path) void read(block.path);
    return node;
  }
  if (!shown.ok) {
    node.append(el("p", "bench-note bad", `Could not read the versions: ${shown.error}`));
    return node;
  }
  draw(node, block, shown.value);
  return node;
}

function draw(node: HTMLElement, block: SnapshotBlock, listing: BlockVersions): void {
  const { name } = block;
  const parts = block.children.length > 0;
  const { unavailable, versions, more, changed, blocked, swapped } = listing;

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
    now.append(
      actions(
        button("Undo swap", `Put ${name} back as it was before the swap, from the copy kept when it was made.`, () =>
          swapOrUndo(block, null),
        ),
      ),
    );
  }
  rowNote(now, block.path, "now");
  list.append(now);

  // Undoing needs only the copy the swap kept, not git, so a swap can still
  // be undone while git cannot list the versions.
  if (unavailable !== null) {
    if (swapped !== null) node.append(list);
    return;
  }

  const shown = comparisons.get(block.path);
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
      row.append(
        actions(
          button("Compare", `Run the saved tests of both versions against ${name} as it is now and as it was then.`, () =>
            compareWith(block, version),
          ),
          button("Swap to this", `Make ${name} as it was in this version. Undo swap returns it to how it is now.`, () =>
            swapOrUndo(block, version),
          ),
        ),
      );
    }
    rowNote(row, block.path, version.commit);
    if (shown?.commit === version.commit) row.append(comparison(block, shown.value, shown.at));
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

function button(label: string, title: string, act: () => Promise<void>): HTMLButtonElement {
  const pressed = el("button", undefined, label);
  pressed.title = title;
  pressed.disabled = busy;
  pressed.addEventListener("click", () => void act());
  return pressed;
}

function actions(...buttons: HTMLButtonElement[]): HTMLElement {
  const box = el("div", "case-actions");
  box.append(...buttons);
  return box;
}

/** What a row is doing, or what went wrong with it, across the whole row. */
function rowNote(row: HTMLElement, blockPath: string, key: string): void {
  const note = notes.get(noteKey(blockPath, key));
  if (note) row.append(el("p", note.bad ? "bench-note bad" : "bench-note", note.text));
}

/** Sets what a row says, or takes it away, and draws the panel again. */
function say(blockPath: string, row: string, text: string | null, bad = false): void {
  if (text === null) notes.delete(noteKey(blockPath, row));
  else notes.set(noteKey(blockPath, row), { text, bad });
  redraw();
}

async function compareWith(block: SnapshotBlock, version: BlockVersion): Promise<void> {
  const dir = ui.dir;
  if (!dir) return;

  busy = true;
  say(block.path, version.commit, "Comparing: running the saved tests against both versions…");
  const result = await window.fragmentor.compareVersion(dir, block.path, version.commit);
  busy = false;
  if (ui.dir !== dir) return;

  if (!result.ok) {
    say(block.path, version.commit, `Could not compare: ${result.error}`, true);
    return;
  }
  comparisons.set(block.path, { commit: version.commit, at: new Date(), value: result.value });
  say(block.path, version.commit, null);
  await read(block.path);
}

/**
 * What comparing found: every test of the block and its parts, from either
 * version, and whichever other tests in its system come out differently, since
 * a swap can change what a block outside it does without touching its files.
 */
function comparison(block: SnapshotBlock, compared: VersionComparison, at: Date): HTMLElement {
  const whole = `${block.name}${block.children.length > 0 ? " and its parts" : ""}`;
  const box = el("div", "version-compare");
  box.append(
    el(
      "p",
      "bench-note",
      `Every saved test of ${whole}, from either version, runs against both, as does every other saved test in ${compared.system}. A test saved in both versions runs as it is saved now. Compared ${when(at)}.`,
    ),
  );

  const tests = compared.inside.flatMap((each) => each.tests);
  const total = tests.length;
  const differ = tests.filter((test) => test.differs).length;
  // A test that ends in an error in both versions, because the block could
  // not be run or because its code threw, came out the same only in failing
  // the same way, which says nothing about the two versions.
  const erred = (result: CaseResult | null) => result !== null && result.status === "error" && result.inputProblems.length === 0;
  const erredBoth = total > 0 && tests.every((test) => erred(test.now) && erred(test.then));
  const unread = compared.inside.some((each) => each.unreadable.now !== null || each.unreadable.then !== null);
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
  for (const each of compared.inside) box.append(testsOf(each));

  const others = compared.othersRun;
  if (others > 0) {
    const elsewhere = compared.outside.reduce((sum, each) => sum + each.tests.length, 0);
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
  for (const each of compared.outside) box.append(testsOf(each));

  // A comparison is long, and the panel has everything else about the block to show.
  const hide = el("button", "btn quiet tiny", "Hide comparison");
  hide.addEventListener("click", () => {
    comparisons.delete(block.path);
    redraw();
  });
  box.append(hide);
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
async function swapOrUndo(block: SnapshotBlock, version: BlockVersion | null): Promise<void> {
  const dir = ui.dir;
  if (!dir) return;
  const { path: blockPath, name } = block;
  const row = version?.commit ?? "now";

  const unsaved = [...ui.edits.keys()].find((path) => under(blockPath, path));
  if (unsaved !== undefined) {
    const text = `Save or revert the unsaved changes to ${ui.snapshot?.blocks[unsaved]?.name ?? unsaved}'s code first: ${
      version === null ? "undoing the swap" : "swapping"
    } would replace that file.`;
    ui.status = { text, tone: "bad" };
    notes.set(noteKey(blockPath, row), { text, bad: true });
    redrawAll();
    return;
  }

  busy = true;
  say(blockPath, row, version === null ? "Undoing the swap…" : "Swapping…");
  const result =
    version === null
      ? await window.fragmentor.undoSwap(dir, blockPath)
      : await window.fragmentor.swapVersion(dir, blockPath, version.commit);
  busy = false;
  if (ui.dir !== dir) return;
  notes.delete(noteKey(blockPath, row));

  // A swap to what is already there changes nothing and keeps no record; an
  // undo always keeps one, so its swap can't be undone twice.
  if (result.ok && result.value.changed === 0 && version !== null) {
    ui.status = { text: `${name} is already as it was in that version.`, tone: "info" };
  } else {
    // Even a swap that failed may have written some files before it stopped,
    // and a comparison made before it is of files that are no longer there.
    forgetBlocks(blockPath);
    comparisons.clear();
    if (!result.ok) {
      const text = version === null ? `Could not undo the swap of ${name}: ${result.error}` : `Could not swap ${name}: ${result.error}`;
      notes.set(noteKey(blockPath, row), { text, bad: true });
      ui.status = { text, tone: "bad" };
    } else if (version === null) {
      ui.status = { text: `Put ${name} back as it was before the swap.`, tone: "good" };
    } else {
      ui.status = { text: `Swapped ${name} to the version “${version.subject}”. Undo swap is under Versions in its panel.`, tone: "good" };
    }
  }

  await reloadProject();
  // Read again, for the swap Undo swap now reverses, and drawn again whatever
  // it says, since the buttons were drawn as they were while it ran.
  await read(blockPath);
  redrawAll();
}
