import type { BlockChange, ProjectChanges } from "../../src/project/changes.js";
import { changesBetween, changesText } from "../../src/project/changes.js";
import type { ChangePoints, ProjectAt } from "../../src/project/history.js";
import type { ProjectSnapshot, SnapshotBlock } from "../../src/project/snapshot.js";
import { revealBlock } from "./canvas.js";
import { interfaceSection, reachesSection } from "./detail.js";
import { el, section, subsection } from "./dom.js";
import { openWindow } from "./popup.js";
import { ui } from "./state.js";
import { actOnVersion, compareSinceWith, onVersionsRead, sinceVersionOf } from "./versions.js";

/**
 * What the agent did since the person last looked, in words.
 *
 * "Last looked" is the moment Mark as seen was pressed. Within a session the
 * comparison is with exactly the drawing on screen then, held here in memory,
 * uncommitted work included. After the window is closed it is with the commit
 * that was newest then, whose hash is kept in this computer's profile — never
 * in the project, whose past git alone remembers.
 *
 * The differences themselves come from the kernel's changesBetween, over the
 * snapshot on screen and the one last seen, or one read back from a commit.
 * Nothing here touches files or git: main is asked for the git facts and for
 * the project as it was, and the rest is computed from snapshots the window
 * already holds — so a project that stops reading halfway keeps its last
 * good list, as it keeps its last good drawing.
 *
 * The bar above the drawing says nothing until something has changed, and
 * stays away while the waiting card or the first-steps window is up, so a
 * first project starts with nothing extra on screen.
 */

let redrawAll: () => void = () => {};
export function onChangesChange(callback: () => void): void {
  redrawAll = callback;
}

/** Where the person last looked: the commit that was newest then. Before any commit there is no bookmark at all. */
interface Bookmark {
  commit: string;
  date: string;
}

const bookmarkKey = (dir: string) => `fragmentor.lastLooked:${dir}`;

function readBookmark(dir: string): Bookmark | null {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(bookmarkKey(dir)) ?? "null");
    if (raw === null || typeof raw !== "object" || !("commit" in raw)) return null;
    const commit = (raw as { commit: unknown }).commit;
    // An older Fragmentor could bookmark a project before its first commit,
    // and such a mark would list the whole project as new for ever.
    if (typeof commit !== "string") return null;
    return { commit, date: String((raw as { date?: unknown }).date ?? "") };
  } catch {
    return null;
  }
}

function writeBookmark(dir: string, mark: Bookmark): void {
  try {
    localStorage.setItem(bookmarkKey(dir), JSON.stringify(mark));
  } catch {
    // The profile may not store anything; the bookmark then lasts the session.
  }
}

/** The two points the list can start from. */
type Point = "looked" | "commit";

/** The git facts last read for the open project, or null while none have been. */
let facts: { unavailable: string } | ChangePoints | null = null;
let bookmark: Bookmark | null = null;
/** Exactly what was on screen at Mark as seen, held for this session only. */
let seenSnapshot: ProjectSnapshot | null = null;
let point: Point = "looked";
/** Whether the person has opened the list, which is when the drawing dots the changed blocks. */
let listOpen = false;
/** Whether every commit since is listed, rather than the newest few. */
let allCommitsShown = false;
/** The project as it was at a commit, by hash, at most a few: the bookmark and the newest commit are all that is asked for. */
const atCommit = new Map<string, ProjectAt | "reading">();
/** Something read for a project that has been closed must not touch the next one. */
let session = 0;
/** Only the newest read of the git facts counts. */
let latestRead = 0;
/** One diff per point, remade only when either side is a different snapshot. */
const memo = new Map<Point, { now: ProjectSnapshot; then: ProjectSnapshot | null; changes: ProjectChanges }>();

const REWRITTEN = "The commit you last looked at is no longer in the project's history: it was rewritten since, usually by an amend or a rebase.";

/** Everything kept about one project's changes, for a project that has closed. */
export function forgetChanges(): void {
  session += 1;
  latestRead += 1;
  facts = null;
  bookmark = null;
  seenSnapshot = null;
  point = "looked";
  listOpen = false;
  allCommitsShown = false;
  atCommit.clear();
  memo.clear();
}

/**
 * Reads the git facts again: on opening a project, when its files change,
 * and when the window gets the focus back, because a commit touches only
 * .git, which nothing watches.
 */
export async function refreshChanges(): Promise<void> {
  const dir = ui.dir;
  if (dir === null || ui.snapshot === null) return;
  if (bookmark === null) bookmark = readBookmark(dir);
  const firstEver = bookmark === null;
  const ticket = ++latestRead;
  const result = await window.fragmentor.changePoints(dir, bookmark?.commit ?? null);
  if (ticket !== latestRead || ui.dir !== dir || ui.snapshot === null) return;

  const before = JSON.stringify(facts);
  facts = result.ok ? result.value : { unavailable: `What changed cannot be read: ${result.error}` };
  // The first time this folder is ever opened, what is on screen is what the
  // person has seen, so looking starts here rather than at everything new.
  // Before the first commit there is no look to keep: a bookmark without a
  // commit would list the whole project as new after a restart.
  let startedLooking = false;
  if (firstEver && facts.unavailable === null && facts.head !== null) {
    bookmark = { commit: facts.head.hash, date: new Date().toISOString() };
    seenSnapshot = ui.snapshot;
    writeBookmark(dir, bookmark);
    // The commits were read against no bookmark at all, which is the whole
    // history; nothing is since the look that has only just begun.
    facts = { ...facts, since: [], more: false };
    startedLooking = true;
  }
  if (startedLooking || JSON.stringify(facts) !== before) redrawAll();
}

/** Holds what is on screen now as the new "then", and remembers the newest commit for after a restart. Nothing is written into the project. */
function markSeen(): void {
  const dir = ui.dir;
  if (dir === null || ui.snapshot === null || facts === null || facts.unavailable !== null || facts.head === null) return;
  seenSnapshot = ui.snapshot;
  bookmark = { commit: facts.head.hash, date: new Date().toISOString() };
  writeBookmark(dir, bookmark);
  listOpen = false;
  redrawAll();
  // The commits listed as since start again from the new bookmark.
  void refreshChanges();
}

/** After a rewritten history, looking starts again from the newest commit. */
function startFromHead(): void {
  const dir = ui.dir;
  if (dir === null || facts === null || facts.unavailable !== null || facts.head === null) return;
  bookmark = { commit: facts.head.hash, date: new Date().toISOString() };
  writeBookmark(dir, bookmark);
  redrawAll();
  void refreshChanges();
}

/** One side of the comparison: a snapshot (null is before the project existed), still being read, or a sentence saying why there is none. */
type ThenSide = { snapshot: ProjectSnapshot | null } | { pending: true } | { problem: string };

function readAt(dir: string, commit: string): void {
  atCommit.set(commit, "reading");
  const mine = session;
  void window.fragmentor.projectAt(dir, commit).then((result) => {
    if (mine !== session || ui.dir !== dir) return;
    atCommit.set(commit, result.ok ? result.value : { snapshot: null, unreadable: result.error });
    for (const held of [...atCommit.keys()]) {
      if (atCommit.size <= 4) break;
      if (held !== commit) atCommit.delete(held);
    }
    redrawAll();
  });
}

function fromCommit(commit: string): ThenSide {
  const dir = ui.dir;
  if (dir === null) return { pending: true };
  const held = atCommit.get(commit);
  if (held === undefined) {
    readAt(dir, commit);
    return { pending: true };
  }
  if (held === "reading") return { pending: true };
  if (held.unreadable !== null) return { problem: held.unreadable };
  return { snapshot: held.snapshot };
}

function thenFor(which: Point): ThenSide {
  if (facts === null) return { pending: true };
  if (facts.unavailable !== null) return { problem: facts.unavailable };
  if (which === "looked") {
    if (seenSnapshot !== null) return { snapshot: seenSnapshot };
    if (bookmark === null) return { snapshot: null };
    if (!facts.baseKnown) return { problem: REWRITTEN };
    return fromCommit(bookmark.commit);
  }
  if (facts.head === null) return { snapshot: null };
  return fromCommit(facts.head.hash);
}

function changesFor(which: Point): { then: ProjectSnapshot | null; changes: ProjectChanges } | { pending: true } | { problem: string } {
  const now = ui.snapshot;
  if (now === null) return { pending: true };
  const side = thenFor(which);
  if (!("snapshot" in side)) return side;
  const held = memo.get(which);
  if (held !== undefined && held.now === now && held.then === side.snapshot) return held;
  const made = { now, then: side.snapshot, changes: changesBetween(side.snapshot, now) };
  memo.set(which, made);
  return made;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** "2 new · 1 built · 3 changed · 1 removed · 1 execution", leaving out whatever there is none of. */
function summary(changes: ProjectChanges): string {
  const count = (test: (change: BlockChange) => boolean) => changes.blocks.filter(test).length;
  const parts = (
    [
      [count((change) => change.kind === "new"), "new"],
      [count((change) => change.built), "built"],
      [count((change) => change.kind === "moved" && !change.built), "moved"],
      [count((change) => change.kind === "changed" && !change.built), "changed"],
      [count((change) => change.kind === "removed"), "removed"],
    ] as const
  )
    .filter(([n]) => n > 0)
    .map(([n, word]) => `${n} ${word}`);
  if (changes.executions.length > 0) parts.push(plural(changes.executions.length, "execution"));
  return parts.join(" · ");
}

/**
 * The bar above the drawing once something has changed: the counts, leading
 * to the list, and Mark as seen. Nothing while nothing has changed, while
 * the project is waiting for its agent, while git cannot say, or before
 * anything has been committed, when there is no history to say it from.
 */
export function renderChangesBar(): void {
  const bar = document.getElementById("changes-bar");
  if (!bar) return;
  bar.replaceChildren();
  bar.hidden = true;
  if (ui.dir === null || ui.snapshot === null || ui.waiting) return;
  if (facts === null || facts.unavailable !== null || facts.head === null) return;
  // The first minutes of a new project belong to the first-steps window.
  const firstSteps = document.querySelector<HTMLElement>("dialog.first-steps[open]");
  if (firstSteps) {
    if (firstSteps.dataset.changesWaiting === undefined) {
      firstSteps.dataset.changesWaiting = "true";
      firstSteps.addEventListener("close", () => redrawAll(), { once: true });
    }
    return;
  }
  const state = changesFor("looked");
  if (!("changes" in state)) return;
  const counts = summary(state.changes);
  if (counts === "") return;

  bar.hidden = false;
  const open = el("button", "changes-open", `Since you last looked: ${counts}`);
  open.type = "button";
  open.title = "Show the changes listed in words.";
  open.addEventListener("click", () => {
    listOpen = true;
    point = "looked";
    ui.selection.clear();
    ui.selectedLink = null;
    ui.showInspector = true;
    redrawAll();
    document.querySelector("#inspector [data-project-changes]")?.scrollIntoView({ block: "start" });
  });
  const seen = el("button", "run-btn", "Mark as seen");
  seen.type = "button";
  seen.title = "Start over from what is on screen now. Nothing is written into the project.";
  seen.addEventListener("click", markSeen);
  bar.append(open, seen);
}

/** The changed blocks the drawing dots while the person has the list open, by path, with what each dot says. */
export function markedOnDrawing(): Map<string, string> | null {
  if (!listOpen || ui.snapshot === null || ui.waiting) return null;
  const state = changesFor(point);
  if (!("changes" in state)) return null;
  const since = point === "looked" ? "since you last looked" : "since the last commit";
  const dots = new Map<string, string>();
  for (const change of state.changes.blocks) {
    if (change.kind === "removed") continue;
    const word = change.built ? "Built" : change.kind === "new" ? "New" : change.kind === "moved" ? "Moved" : "Changed";
    dots.set(change.path, `${word} ${since}. The Changes list has the details.`);
  }
  return dots.size === 0 ? null : dots;
}

/** One change as a row: the block, where it is, and each difference on a line of its own. */
function changeRow(change: BlockChange, then: ProjectSnapshot | null): HTMLElement {
  const goes = change.kind !== "removed" && Boolean(ui.snapshot?.blocks[change.path]);
  const row = el(goes ? "button" : "div", "change-row");
  if (row instanceof HTMLButtonElement) {
    row.type = "button";
    row.title = "Show this block";
    row.addEventListener("click", () => revealBlock(change.path));
  }
  row.append(el("span", "change-head", change.name));
  const where = change.from === undefined ? change.path : `${change.from} → ${change.path}`;
  row.append(el("span", "change-where", change.by === undefined ? where : `${where} (${change.by})`));
  for (const line of change.lines) row.append(el("span", "change-line", line));
  if (change.kind === "removed") {
    const old = then?.blocks[change.path];
    if (old !== undefined) {
      const see = el("button", "btn quiet tiny", "See it as it was");
      see.type = "button";
      see.addEventListener("click", () => openAsItWas(old));
      row.append(see);
    }
  }
  return row;
}

/** A removed block, read again in a window: what it was for, offered and reached. */
function openAsItWas(block: SnapshotBlock): void {
  const body = el("div", "window-sections");
  body.append(el("p", "responsibility", block.responsibility));
  body.append(interfaceSection(block));
  const reaches = reachesSection(block);
  if (reaches) body.append(reaches);
  openWindow(block.name, `as it was — ${block.path}`, body);
}

/**
 * The Changes section of the project's panel: the point compared with, what
 * was committed in between, and every change grouped the way the bar counts
 * them, each row leading to its block.
 */
export function projectChangesSection(): HTMLElement {
  const node = section("Changes");
  node.dataset.projectChanges = "true";
  if (facts === null) {
    node.append(el("p", "bench-note", "Reading what changed…"));
    return node;
  }
  if (facts.unavailable !== null) {
    node.append(el("p", "bench-note", facts.unavailable));
    return node;
  }
  // A repository with no commits yet has no history to read changes from,
  // said in the same voice as a folder with no git at all.
  if (facts.head === null) {
    node.append(el("p", "bench-note", "Changes come from the project's git history, and nothing has been committed yet. Ask your agent to commit."));
    return node;
  }

  // Which point the list starts from: the two the person can mean.
  const pick = el("div", "changes-point");
  const label = el("label", undefined, "Compared with");
  const select = el("select");
  select.id = "changes-point";
  label.htmlFor = select.id;
  for (const [value, words] of [
    ["looked", "When you last looked"],
    ["commit", "The last commit"],
  ] as const) {
    const option = el("option", undefined, words);
    option.value = value;
    select.append(option);
  }
  select.value = point;
  select.addEventListener("change", () => {
    point = select.value === "commit" ? "commit" : "looked";
    redrawAll();
  });
  pick.append(label, select);
  node.append(pick);

  if (point === "looked" && seenSnapshot === null && bookmark !== null && !facts.baseKnown) {
    node.append(el("p", "bench-note", REWRITTEN));
    const restart = el("button", "btn quiet", "Start again from the last commit");
    restart.type = "button";
    restart.addEventListener("click", startFromHead);
    node.append(restart);
    return node;
  }

  const state = changesFor(point);
  if ("problem" in state) {
    node.append(el("p", "bench-note", state.problem));
    return node;
  }
  if ("pending" in state) {
    node.append(el("p", "bench-note", "Reading the project as it was then…"));
    return node;
  }
  const { then, changes } = state;
  const since = point === "looked" ? "since you last looked" : "since the last commit";

  // What was committed in between, by its commit messages, the newest few.
  if (point === "looked" && facts.since.length > 0) {
    const committed = subsection("Committed since you last looked");
    for (const each of allCommitsShown ? facts.since : facts.since.slice(0, 5)) committed.append(el("div", "change-line", each.subject));
    if (facts.since.length > 5) {
      const fold = el(
        "button",
        "btn quiet tiny",
        allCommitsShown ? "Show fewer" : facts.more ? `Show the newest ${facts.since.length}` : `Show all ${facts.since.length}`,
      );
      fold.type = "button";
      fold.addEventListener("click", () => {
        allCommitsShown = !allCommitsShown;
        redrawAll();
      });
      committed.append(fold);
    }
    node.append(committed);
  }

  if (changes.blocks.length === 0 && changes.executions.length === 0) {
    node.append(el("p", "bench-note", point === "looked" ? "Nothing has changed since you last looked." : "No changes since the last commit."));
    return node;
  }

  // A restart lets the exact drawing marked as seen go, so the comparison
  // starts at the commit marked instead, and uncommitted work shows again.
  if (point === "looked" && seenSnapshot === null && bookmark !== null) {
    node.append(el("p", "bench-note", "After a restart the comparison is with the commit you marked, so work not committed yet shows again."));
  }

  const group = (title: string, rows: BlockChange[]) => {
    if (rows.length === 0) return;
    const part = subsection(`${title} (${rows.length})`);
    const list = el("div", "problems");
    for (const change of rows) list.append(changeRow(change, then));
    part.append(list);
    node.append(part);
  };
  group("New", changes.blocks.filter((change) => change.kind === "new"));
  group("Built", changes.blocks.filter((change) => change.built));
  group("Moved", changes.blocks.filter((change) => change.kind === "moved" && !change.built));
  group("Changed", changes.blocks.filter((change) => change.kind === "changed" && !change.built));
  group("Removed", changes.blocks.filter((change) => change.kind === "removed"));

  if (changes.executions.length > 0) {
    const part = subsection(`Executions (${changes.executions.length})`);
    const list = el("div", "problems");
    for (const change of changes.executions) {
      const row = el("div", "change-row");
      row.append(el("span", "change-head", `${change.name}: ${change.kind}`));
      row.append(el("span", "change-where", `set going by ${change.trigger}`));
      for (const line of change.lines) row.append(el("span", "change-line", line));
      list.append(row);
    }
    part.append(list);
    node.append(part);
  }

  const actions = el("div", "changes-actions");
  const seen = el("button", "btn quiet", "Mark as seen");
  seen.type = "button";
  seen.title = "Start over from what is on screen now. Nothing is written into the project.";
  seen.addEventListener("click", markSeen);
  const copy = el("button", "btn quiet", "Copy as text");
  copy.type = "button";
  copy.title = "Put the list on the clipboard, to paste into a note or a message.";
  copy.addEventListener("click", () => {
    void window.fragmentor.copyText(changesText(changes, since)).then((result) => {
      if (result.ok) copy.textContent = "Copied";
    });
  });
  actions.append(seen, copy);
  node.append(actions);
  return node;
}

/**
 * One button that compares the block as it is with how it was then, through
 * the Versions section's own compare, so the two can never disagree. It is
 * offered only where Fragmentor runs the block with saved tests on both
 * sides, and only against the drawing last marked as seen, whose commit the
 * versions list knows as a row.
 */
function compareWithThen(block: SnapshotBlock, changes: ProjectChanges, then: ProjectSnapshot | null): HTMLElement[] {
  if (point !== "looked" || then === null) return [];
  const thenPath = changes.pairs[block.path];
  const was = thenPath === undefined ? undefined : then.blocks[thenPath];
  if (was === undefined) return [];
  if (!(block.runnable && block.cases.length > 0 && was.runnable && was.cases.length > 0)) return [];
  const since = sinceVersionOf(block.path);
  // The versions list is still being read; this section is drawn again once it has been.
  if (since === undefined) return [];
  if (since === null) {
    return [el("p", "bench-note", "Its versions do not reach back to then, so compare one from Versions below.")];
  }
  const compare = el("button", "btn quiet", "Compare with then");
  compare.type = "button";
  compare.title = `Run the saved tests of ${block.name} as it is now and as it was then, under Versions below.`;
  compare.addEventListener("click", () => void actOnVersion(block.path, since, "compare"));
  return [compare];
}

/**
 * The Changes section of one block's panel, only while that block is on the
 * list: what changed about it, and Compare with then where that means
 * something. A block that has not changed shows nothing at all.
 */
export function blockChangesSection(block: SnapshotBlock): HTMLElement | null {
  if (facts === null || facts.unavailable !== null || facts.head === null) return null;
  const state = changesFor(point);
  if (!("changes" in state)) return null;
  const change = state.changes.blocks.find((each) => each.path === block.path && each.kind !== "removed");
  if (change === undefined) return null;

  const node = section("Changes");
  node.dataset.blockChangesOf = block.path;
  const since = point === "looked" ? "since you last looked" : "since the last commit";
  const lead =
    change.kind === "new"
      ? `New ${since}.`
      : change.built
        ? `Built ${since}: it was planned, and now it is real.`
        : change.kind === "moved"
          ? `Moved ${since} from ${change.from} (${change.by}).`
          : `Changed ${since}.`;
  node.append(el("p", "bench-note", lead));
  if (change.lines.length > 0) {
    const row = el("div", "change-row");
    for (const line of change.lines) row.append(el("span", "change-line", line));
    const list = el("div", "problems");
    list.append(row);
    node.append(list);
  }
  node.append(...compareWithThen(block, state.changes, state.then));
  return node;
}

// Whether Compare with then can be offered waits on the block's versions
// being read, so the section is drawn again in place once they have been.
onVersionsRead(() => {
  const old = document.querySelector<HTMLElement>("#inspector [data-block-changes-of]");
  const block = old ? ui.snapshot?.blocks[old.dataset.blockChangesOf ?? ""] : undefined;
  if (!old || !block) return;
  const fresh = blockChangesSection(block);
  if (fresh) old.replaceWith(fresh);
});

// The versions list names the row the block was on when the person last
// looked, which is this module's bookmark.
compareSinceWith(() => bookmark?.commit ?? null);
