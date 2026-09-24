import type { BlockVersions, SavedVersion, VersionRef } from "../../src/project/history.js";
import type { SnapshotBlock } from "../../src/project/snapshot.js";
import type { CaseResult } from "../../src/run/run.js";
import type { ComparedBlock, ComparedTest, VersionComparison } from "../../src/run/versions.js";
import type { Result } from "../ipc.js";
import { statusWord } from "./bench.js";
import { el, section, subsection } from "./dom.js";
import { forgetBlocks, ui } from "./state.js";

/**
 * A block's versions, as the last section of its panel.
 *
 * A block has two kinds, and the kernel reads both. Its saved versions are the
 * few the person keeps on purpose, with a name, as files in the project that
 * are committed with it; its git history is every commit of the repository
 * holding the project that changed it. The section lists them, saves the block
 * as it is now, compares a version with it, and swaps one in and back out.
 *
 * The panel is drawn again whenever anything changes, and asking git takes a
 * moment, so what the section shows is kept here rather than asked for every
 * time: the list last read, the comparisons run, what each row is doing, and
 * what is typed into the form for saving a version. A comparison that took
 * seconds to run outlives the agent writing a file, and the person looking at
 * another block and coming back.
 */

let redrawAll: () => void = () => {};
let reloadProject: () => Promise<void> = async () => {};
/**
 * `all` draws everything, for what the status line says; `reload` reads the
 * project again and shows it, once a swap or an undo has rewritten it. Reading
 * a list or comparing changes nothing but this section, which draws itself
 * again in place: the list is read every time a block is picked, and drawing
 * the panel again would take the cursor from its code editor.
 */
export function onVersionsChange(callbacks: { all: () => void; reload: () => Promise<void> }): void {
  redrawAll = callbacks.all;
  reloadProject = callbacks.reload;
}

/**
 * Draws the section on screen again, whichever block it is for: something
 * running for one block leaves every block's buttons unpressable until it
 * ends. With no section on screen there is nothing to do; the panel draws it
 * from what is kept here when it next shows one.
 */
function redraw(): void {
  const old = document.querySelector<HTMLElement>("#inspector [data-versions-of]");
  const block = old ? ui.snapshot?.blocks[old.dataset.versionsOf!] : undefined;
  if (!old || !block) return;

  // Someone typing in the form keeps typing: the field they were in, and
  // where in it, are found again in the section that takes its place.
  const typing = document.activeElement;
  const field = (typing instanceof HTMLInputElement || typing instanceof HTMLTextAreaElement) && old.contains(typing) && typing.id ? typing : null;
  const at = field && { id: field.id, start: field.selectionStart, end: field.selectionEnd, scroll: field.scrollTop };

  old.replaceWith(versionsSection(block));

  const again = at && document.getElementById(at.id);
  if (at && (again instanceof HTMLInputElement || again instanceof HTMLTextAreaElement)) {
    again.focus({ preventScroll: true });
    again.setSelectionRange(at.start, at.end);
    again.scrollTop = at.scroll;
  }
}

/** The list last read, and which block of which project it is for. */
let listed: { dir: string; blockPath: string; result: Result<BlockVersions> } | null = null;
/** The block whose list is being read, so a redraw meanwhile does not ask again. */
let reading: string | null = null;
/** Only the newest read counts. */
let latestRead = 0;
/**
 * The comparison shown for a block, with the row it was run for (a commit, or
 * a saved version's id) and when. One a block, so the panel stays readable.
 */
const comparisons = new Map<string, { row: string; at: Date; value: VersionComparison }>();
/**
 * What a row is doing, or what went wrong with it, by block and row: a
 * commit, a saved version's id, "now", or "save" for the form that saves one.
 * Each is about the last thing pressed, so all of them go when the next thing
 * is. One asking for unsaved code to be saved goes as soon as it has been. One
 * asking whether to delete a saved version is that question, answered by the
 * two buttons drawn under it.
 */
const notes = new Map<string, { text: string; bad: boolean; untilSaved?: boolean; confirm?: boolean }>();
/** What is typed into the form for saving a block as a version, while it is open, so drawing the panel again never loses it. */
const drafts = new Map<string, { name: string; description: string }>();
/** Blocks whose whole git history is listed, rather than its newest commits. */
const unfolded = new Set<string>();
/** How many commits are listed until the person asks for all of them: an agent commits every small step. */
const FOLDED = 5;
/** One thing at a time: while a comparison, a swap or a save runs, nothing else in the section can be pressed. */
let busy = false;
/**
 * Which project the section is on, counted rather than named: something still
 * running for a project that has been closed must not touch what is shown for
 * the next one, even if that is the same project opened again.
 */
let session = 0;

const noteKey = (blockPath: string, row: string) => `${blockPath}\n${row}`;

/** A version of either kind, as its row acts on it: what the kernel is asked for, the row its notes and comparison belong to, and what it is called. */
interface VersionRow {
  ref: VersionRef;
  row: string;
  label: string;
}

function when(date: string | Date): string {
  return new Date(date).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** Whether a block path is `root` or one of its parts, however deep. */
function under(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/** Everything the section keeps, for a project that has closed. */
export function forgetVersions(): void {
  session += 1;
  busy = false;
  listed = null;
  reading = null;
  comparisons.clear();
  notes.clear();
  drafts.clear();
  unfolded.clear();
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
 * show: an agent's commit touches only .git, which nothing watches, and the
 * watcher leaves .fragmentor alone, where saved versions are kept. Nothing is
 * read while something in the section is running; a comparison that
 * finishes, and every save, delete, swap and undo, reads the list again itself.
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
    node.append(el("p", "bench-note", "Reading the block's versions…"));
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
  const { unavailable, blocked, swapped, saved, unreadable } = listing;

  node.append(
    el(
      "p",
      "bench-note",
      block.children.length > 0
        ? `A version is ${name} and its parts as they were at one moment, with their saved tests and the code they point at. Saved versions are the ones kept on purpose, with a name, and shared with everyone through the project's repository; git history is every commit that changed them.`
        : `A version is ${name} as it was at one moment, with its saved tests and the code it points at. Saved versions are the ones kept on purpose, with a name, and shared with everyone through the project's repository; git history is every commit that changed it.`,
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

  // Above both lists, since a version of either kind is swapped in and undone
  // the same way. Undoing needs only the copy the swap kept, not git, so a
  // swap can still be undone while git cannot list the versions.
  if (unavailable === null || swapped !== null) node.append(rows(nowRow(block, listing)));

  // Saved versions are read from their files alone, so they are listed even
  // while git cannot be used, and nobody takes them for lost.
  if (unavailable === null || saved.length > 0 || unreadable.length > 0) node.append(savedPart(block, listing));
  if (unavailable === null) node.append(gitPart(block, listing));
}

/** The saved tests' list, because a version is read the same way: its name on a line of its own, and what can be done with it underneath. */
function rows(...each: HTMLElement[]): HTMLElement {
  const list = el("div", "cases versions");
  list.append(...each);
  return list;
}

/** The block as it is now: whether a swap put it there, or how it stands against the latest commit. */
function nowRow(block: SnapshotBlock, { versions, changed, swapped }: BlockVersions): HTMLElement {
  const row = el("div", "case-row version-row");
  row.dataset.now = "true";
  row.append(
    el("div", "case-name", "Now"),
    el(
      "div",
      "version-meta",
      swapped !== null
        ? swapped.kind === "commit"
          ? `Swapped to “${swapped.subject}”, committed ${when(swapped.date)}.`
          : `Swapped to “${swapped.name}”, saved ${when(swapped.date)}.`
        : versions.length === 0
          ? "Not in any commit yet."
          : changed
            ? "Changed since the latest commit; these changes are in no commit yet."
            : "The same as the latest commit.",
    ),
  );
  if (swapped !== null) {
    row.append(
      actions(
        button("Undo swap", `Put ${block.name} back as it was before the swap, from the copy kept when it was made.`, () =>
          swapOrUndo(block, null),
        ),
      ),
    );
  }
  rowNote(row, block.path, "now");
  return row;
}

/** The versions the person saved: the form for saving another, and each one with what can be done with it. */
function savedPart(block: SnapshotBlock, listing: BlockVersions): HTMLElement {
  const { unavailable, blocked, saved, unreadable } = listing;
  const node = subsection("Saved");
  node.classList.add("version-part");
  // Saving one is refused wherever it could never be swapped back.
  const canSave = unavailable === null && blocked === null;

  if (canSave && drafts.has(block.path)) {
    node.append(saveForm(block));
  } else if (canSave) {
    node.append(
      button(
        "Save this version",
        `Keep ${block.name} as it is now, with a name, for everyone working on the project.`,
        () => {
          notes.clear();
          drafts.set(block.path, { name: "", description: "" });
          redraw();
          document.querySelector<HTMLInputElement>("#inspector [data-versions-of] .version-save input")?.focus();
        },
        "btn quiet",
      ),
    );
  }

  if (saved.length > 0) {
    node.append(rows(...saved.map((version) => savedRow(block, version, listing))));
  } else if (unavailable === null) {
    node.append(
      el(
        "p",
        "bench-note",
        canSave ? `No saved versions yet. Save one when ${block.name} works the way you want to keep it.` : "No saved versions yet.",
      ),
    );
  }

  if (unreadable.length > 0) {
    const one = unreadable.length === 1;
    node.append(
      el(
        "p",
        "bench-note bad",
        `${one ? "This file does not read as a saved version" : "These files do not read as saved versions"}, as when a merge leaves one half-written, so ${
          one ? "it is" : "they are"
        } not listed: ${unreadable.join(", ")}.`,
      ),
    );
  }
  return node;
}

/**
 * The form for saving the block as it is now. What is typed is kept in
 * `drafts` as it is typed, since the agent writing a file draws the panel
 * again underneath it.
 */
function saveForm(block: SnapshotBlock): HTMLElement {
  const draft = drafts.get(block.path)!;
  const form = el("form", "version-save");

  // The kernel refuses anything longer, so the fields do not take it.
  const name = el("input");
  name.id = `version-name-${block.path}`;
  name.type = "text";
  name.maxLength = 80;
  name.placeholder = "What to call it";
  name.value = draft.name;

  const description = el("textarea");
  description.id = `version-description-${block.path}`;
  description.maxLength = 2000;
  description.placeholder = "What it does that is worth coming back to";
  description.value = draft.description;

  const save = el("button", "btn", "Save");
  save.type = "submit";
  const ready = () => {
    save.disabled = busy || name.value.trim() === "";
  };
  ready();
  name.addEventListener("input", () => {
    draft.name = name.value;
    ready();
  });
  description.addEventListener("input", () => {
    draft.description = description.value;
  });
  // Enter in the name saves, as in any form.
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!save.disabled) void saveThis(block);
  });

  const cancel = el("button", "btn quiet", "Cancel");
  cancel.type = "button";
  cancel.disabled = busy;
  cancel.addEventListener("click", () => {
    drafts.delete(block.path);
    notes.clear();
    redraw();
  });

  const buttons = el("div", "version-save-actions");
  buttons.append(save, cancel);
  form.append(field("Name", name), field("Description, if any", description));
  rowNote(form, block.path, "save");
  form.append(buttons);
  return form;
}

function field(label: string, input: HTMLInputElement | HTMLTextAreaElement): HTMLElement {
  const box = el("div", "field");
  const title = el("label", undefined, label);
  title.htmlFor = input.id;
  box.append(title, input);
  return box;
}

function savedRow(block: SnapshotBlock, version: SavedVersion, { unavailable, blocked, swapped }: BlockVersions): HTMLElement {
  const row = el("div", "case-row version-row");
  row.dataset.saved = version.id;
  row.append(el("div", "case-name", version.name));
  if (version.description !== "") row.append(el("p", "bench-note version-about", version.description));
  row.append(
    el(
      "div",
      "version-meta",
      `saved ${when(version.date)}${version.author === "" ? "" : ` · ${version.author}`}${
        swapped?.kind === "saved" && swapped.id === version.id ? " · swapped in" : ""
      }`,
    ),
  );

  // Read-only while git cannot be used, as the rest of the section is.
  const asking = notes.get(noteKey(block.path, version.id))?.confirm === true;
  if (unavailable === null && !asking) {
    row.append(
      actions(
        ...(blocked === null ? versionButtons(block, { ref: { saved: version.id }, row: version.id, label: version.name }) : []),
        button("Delete", "Delete this saved version. The project's git history keeps whatever was committed.", () => {
          notes.clear();
          notes.set(noteKey(block.path, version.id), {
            text: `Delete “${version.name}”? It goes for everyone once the project is next committed. If it was ever committed, git's history still has it; if not, it is gone for good.`,
            bad: true,
            confirm: true,
          });
          redraw();
        }),
      ),
    );
  }
  rowNote(row, block.path, version.id);
  if (asking) {
    row.append(
      actions(
        button("Delete it", `Delete “${version.name}”.`, () => deleteSaved(block, version)),
        button("Keep", "Keep it.", () => say(block.path, version.id, null)),
      ),
    );
  }

  const shown = comparisons.get(block.path);
  if (shown?.row === version.id) row.append(comparison(block, shown.value, shown.at));
  return row;
}

/** The commits that changed the block, newest first: the newest few, until the person asks for all of them. */
function gitPart(block: SnapshotBlock, listing: BlockVersions): HTMLElement {
  const { versions, more, blocked, swapped } = listing;
  const node = subsection("Git history");
  node.classList.add("version-part");
  const all = unfolded.has(block.path);

  if (versions.length > 0) {
    const shown = comparisons.get(block.path);
    node.append(
      rows(
        ...(all ? versions : versions.slice(0, FOLDED)).map((version, at) => {
          const row = el("div", "case-row version-row");
          row.dataset.commit = version.commit;
          row.append(
            el("div", "case-name", version.subject),
            el(
              "div",
              "version-meta",
              `${when(version.date)} · ${version.author} · ${version.commit.slice(0, 7)}${at === 0 ? " · latest" : ""}${
                swapped?.kind === "commit" && swapped.commit === version.commit ? " · swapped in" : ""
              }`,
            ),
          );
          if (blocked === null) {
            row.append(actions(...versionButtons(block, { ref: { commit: version.commit }, row: version.commit, label: version.subject })));
          }
          rowNote(row, block.path, version.commit);
          if (shown?.row === version.commit) row.append(comparison(block, shown.value, shown.at));
          return row;
        }),
      ),
    );
  } else {
    node.append(
      el(
        "p",
        "bench-note",
        `No commit holds ${block.name} yet. Its git history starts at the first commit that does, and FRAGMENTOR.md asks your agent to commit each time it finishes a block.`,
      ),
    );
  }

  // Only what is shown changes, so this never waits for anything running.
  if (versions.length > FOLDED) {
    const fold = el("button", "btn quiet tiny", all ? "Show fewer" : more ? `Show the newest ${versions.length}` : `Show all ${versions.length}`);
    fold.addEventListener("click", () => {
      if (all) unfolded.delete(block.path);
      else unfolded.add(block.path);
      redraw();
    });
    node.append(fold);
  }
  if (more) node.append(el("p", "bench-note", "Only the newest 100 commits are listed."));
  return node;
}

/** What can be done with a version of either kind that could be swapped in. */
function versionButtons(block: SnapshotBlock, version: VersionRow): HTMLButtonElement[] {
  return [
    button("Compare", `Run the saved tests of both versions against ${block.name} as it is now and as it was then.`, () =>
      compareWith(block, version),
    ),
    button("Swap to this", `Make ${block.name} as it was in this version. Undo swap returns it to how it is now.`, () =>
      swapOrUndo(block, version),
    ),
  ];
}

function button(label: string, title: string, act: () => void | Promise<void>, className?: string): HTMLButtonElement {
  const pressed = el("button", className, label);
  pressed.type = "button";
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
  if (!note) return;
  if (note.untilSaved && unsavedUnder(blockPath) === undefined) {
    notes.delete(noteKey(blockPath, key));
    return;
  }
  row.append(el("p", note.bad ? "bench-note bad" : "bench-note", note.text));
}

/** A block, or one of its parts, whose code has unsaved changes in the editor. */
function unsavedUnder(blockPath: string): string | undefined {
  return [...ui.edits.keys()].find((path) => under(blockPath, path));
}

/**
 * Asks for unsaved code under a block to be saved or reverted first, and says
 * so on the row that asked, until it has been. True when there was some.
 */
function refuseUnsaved(block: SnapshotBlock, row: string, because: string): boolean {
  const unsaved = unsavedUnder(block.path);
  if (unsaved === undefined) return false;
  const text = `Save or revert the unsaved changes to ${ui.snapshot?.blocks[unsaved]?.name ?? unsaved}'s code first: ${because}.`;
  ui.status = { text, tone: "bad" };
  notes.set(noteKey(block.path, row), { text, bad: true, untilSaved: true });
  redrawAll();
  return true;
}

/** Sets what a row says, or takes it away, and draws the panel again. */
function say(blockPath: string, row: string, text: string | null, bad = false): void {
  if (text === null) notes.delete(noteKey(blockPath, row));
  else notes.set(noteKey(blockPath, row), { text, bad });
  redraw();
}

/**
 * Saves the block as it is now, as the form names it. The editor's unsaved
 * code is not on disk, so the version would be saved without it.
 */
async function saveThis(block: SnapshotBlock): Promise<void> {
  const dir = ui.dir;
  const draft = drafts.get(block.path);
  if (!dir || !draft) return;

  notes.clear();
  if (refuseUnsaved(block, "save", "the version would not include them")) return;

  const mine = session;
  busy = true;
  say(block.path, "save", "Saving…");
  const result = await window.fragmentor.saveVersion(dir, block.path, draft.name, draft.description);
  if (session !== mine) return;
  busy = false;
  notes.clear();

  if (result.ok) {
    drafts.delete(block.path);
    ui.status =
      result.value.ignored === null
        ? { text: `Saved “${result.value.name}” as a version of ${block.name}. It is shared once the project is next committed.`, tone: "good" }
        : {
            text: `Saved “${result.value.name}” as a version of ${block.name}, but this project's git ignores it (${result.value.ignored}), so it stays on this computer.`,
            tone: "info",
          };
  } else {
    const text = `Could not save ${block.name} as a version: ${result.error}`;
    notes.set(noteKey(block.path, "save"), { text, bad: true });
    ui.status = { text, tone: "bad" };
  }
  // Read whatever came of it: nothing watches where saved versions are kept,
  // and a refusal can be for one saved elsewhere since the list was read.
  await refreshVersions();
  redrawAll();
}

/** Deletes a saved version, once the person has said yes to the question on its row. */
async function deleteSaved(block: SnapshotBlock, version: SavedVersion): Promise<void> {
  const dir = ui.dir;
  if (!dir) return;

  const mine = session;
  busy = true;
  notes.clear();
  say(block.path, version.id, "Deleting…");
  const result = await window.fragmentor.deleteSavedVersion(dir, block.path, version.id);
  if (session !== mine) return;
  busy = false;
  notes.clear();

  if (result.ok) {
    // A comparison with it is with a version that is no longer there.
    if (comparisons.get(block.path)?.row === version.id) comparisons.delete(block.path);
    ui.status = { text: `Deleted the saved version “${version.name}”.`, tone: "good" };
  } else {
    const text = `Could not delete the saved version “${version.name}”: ${result.error}`;
    notes.set(noteKey(block.path, version.id), { text, bad: true });
    ui.status = { text, tone: "bad" };
  }
  await refreshVersions();
  redrawAll();
}

async function compareWith(block: SnapshotBlock, version: VersionRow): Promise<void> {
  const dir = ui.dir;
  if (!dir) return;

  const mine = session;
  busy = true;
  notes.clear();
  say(block.path, version.row, "Comparing: running the saved tests against both versions…");
  const result = await window.fragmentor.compareVersion(dir, block.path, version.ref);
  if (session !== mine) return;
  busy = false;

  if (!result.ok) {
    say(block.path, version.row, `Could not compare: ${result.error}`, true);
    return;
  }
  comparisons.set(block.path, { row: version.row, at: new Date(), value: result.value });
  say(block.path, version.row, null);
  // Only if this block is still on screen: reading its list would take the
  // place of a list being read for whichever block is.
  await refreshVersions();
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
async function swapOrUndo(block: SnapshotBlock, version: VersionRow | null): Promise<void> {
  const dir = ui.dir;
  if (!dir) return;
  const { path: blockPath, name } = block;
  const row = version?.row ?? "now";

  notes.clear();
  if (refuseUnsaved(block, row, `${version === null ? "undoing the swap" : "swapping"} would replace that file`)) return;

  const mine = session;
  busy = true;
  say(blockPath, row, version === null ? "Undoing the swap…" : "Swapping…");
  const result =
    version === null ? await window.fragmentor.undoSwap(dir, blockPath) : await window.fragmentor.swapVersion(dir, blockPath, version.ref);
  if (session !== mine) return;
  busy = false;
  notes.clear();

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
      ui.status = { text: `Swapped ${name} to the version “${version.label}”. Undo swap is under Versions in its panel.`, tone: "good" };
    }
  }

  // The list is from before the swap, and so is any read of it still under
  // way, so whichever section is shown next reads its own afresh: for the
  // swap Undo swap now reverses, if it is this block's.
  listed = null;
  reading = null;
  await reloadProject();
  redrawAll();
}
