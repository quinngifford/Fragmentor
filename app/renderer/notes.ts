import { COMMANDS, NOTES_COMMAND, phraseFor, usageOf } from "../../src/codegen/commands.js";
import type { FlaggedRun, NoteAnchor, NoteMessage } from "../../src/project/notes.js";
import type { SnapshotBlock, SnapshotNote } from "../../src/project/snapshot.js";
import type { CaseResult } from "../../src/run/run.js";
import type { Result } from "../ipc.js";
import { revealBlock } from "./canvas.js";
import { el, keepingFocus, section, subsection } from "./dom.js";
import { goToStep } from "./execution.js";
import { closeWindow, openCodeAt, openWindow } from "./popup.js";
import { ui } from "./state.js";
import { actOnVersion, onVersionsRead, versionBefore } from "./versions.js";

/**
 * Notes on blocks: the person and their coding agent, asking and answering
 * each other beside the part of the system they are about.
 *
 * Fragmentor does none of the work a note asks for. It keeps the notes, shows
 * them on the blocks, and tells the person the words that set their agent to
 * work on them, because those words are typed into the agent rather than
 * clicked here. Whose turn it is comes with each note in the snapshot.
 *
 * Notes arrive with the snapshot, so the agent answering one redraws the
 * window as any change of its does. What is kept here is only what the
 * person is in the middle of: what they have typed, which form is open, and
 * what the last thing they pressed said.
 */

/** What the person types to their agent to have it work through the notes. */
export const NOTES_PHRASE = phraseFor(NOTES_COMMAND);

let redrawAll: () => void = () => {};
let reloadProject: () => Promise<void> = async () => {};
/** `all` draws everything; `reload` reads the project again and shows it, once a note has been written. */
export function onNotesChange(callbacks: { all: () => void; reload: () => Promise<void> }): void {
  redrawAll = callbacks.all;
  reloadProject = callbacks.reload;
}

/** What is typed into a form, by block and "new", or by block and the note replied to. */
const drafts = new Map<string, string>();
/** Which form is open in a block's section: "new", or the id of the note being replied to. One at a time. */
const forms = new Map<string, string>();
/** What the note being written on a block is about, when it is some lines of its code or one of its steps. */
const pendingOn = new Map<string, NoteAnchor>();
/**
 * What the last thing pressed on a note said, or the question it asks: by
 * block and "new", or by block and note. Each goes when the next thing is pressed.
 */
const said = new Map<string, { text: string; confirm?: boolean }>();
/** Runs from the bench that have been flagged, as the outcomes they came to, so none is flagged twice. */
let flaggedRuns = new WeakSet<object>();
/**
 * What running a note's flagged run again came to, by note: how many
 * messages the note had then, so an answer after it runs it again, and the
 * result, or why there is none, or that it is still running.
 */
const reruns = new Map<string, { upTo: number; code: string; state: "running" | CaseResult | { error: string } }>();
/** Flagged runs whose details the person has unfolded, by note and message, so drawing the note again keeps them open. */
const openRuns = new Set<string>();
/** Blocks whose resolved notes are unfolded. */
const unfolded = new Set<string>();
/** Which note the bar's Show went to last, so pressing it again goes on to the next. */
let shownLast = -1;
/** One thing at a time: while a note is written, nothing else here can be pressed. */
let busy = false;
/** Which project this is for, counted, so a write finishing after the project closed touches nothing. */
let session = 0;

const key = (blockPath: string, row: string) => `${blockPath}\n${row}`;

export function forgetNotes(): void {
  session += 1;
  busy = false;
  drafts.clear();
  forms.clear();
  pendingOn.clear();
  said.clear();
  reruns.clear();
  unfolded.clear();
  openRuns.clear();
  flaggedRuns = new WeakSet();
  shownLast = -1;
}

// A note answered by a commit offers the version before it, which is known
// once the block's versions have been read.
onVersionsRead(() => {
  const old = document.querySelector<HTMLElement>("#inspector [data-notes-of]");
  if (old) redrawSection();
});

/** The block a note is on, as a note needs it: by path, and called something. One that has gone is called by its path. */
type Where = Pick<SnapshotBlock, "path" | "name">;

function when(date: string): string {
  return new Date(date).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

function allNotes(): SnapshotNote[] {
  return ui.snapshot?.notes ?? [];
}

/** Who a message is from, as the person reads it. */
function fromWord(message: NoteMessage): string {
  return message.from === "person" ? "You" : "Agent";
}

function stateWord(note: SnapshotNote): string {
  return note.waiting === "agent" ? "for your agent" : note.waiting === "person" ? "for you" : "resolved";
}

/** The newest run a note flags: the one to run again. */
function runOf(note: SnapshotNote): FlaggedRun | undefined {
  return [...note.messages].reverse().find((message) => message.run !== undefined)?.run;
}

/**
 * What running a block depends on, as far as the window can see: the code of
 * every block, since a block calls whatever it needs wherever it sits. A
 * result from before any of it changed, as when a note's own Swap back puts
 * the old code in place, is a result about other code.
 */
function codeNow(): string {
  return Object.values(ui.snapshot?.blocks ?? {})
    .map((each) => each.sources.code ?? "")
    .join("\0");
}

/** Whether a run cut short when it was flagged can no longer be run as it went. */
const cutTooMuch = (run: FlaggedRun) => (run.cut ?? []).some((part) => part === "input" || part === "stores" || part === "expected");

/**
 * Whether what a note flags can be run again as it was: on a block that is
 * there and that Fragmentor runs, with everything it was given kept whole.
 */
function canRerun(blockPath: string, run: FlaggedRun): boolean {
  return Boolean(ui.snapshot?.blocks[blockPath]?.runnable) && !cutTooMuch(run);
}

/**
 * The words a flag writes for the agent, when the person adds none of their
 * own. The note says the same in red above what was run, so they are not
 * shown twice.
 */
const FLAG_WORDS = {
  run: (run: FlaggedRun) => (run.test === null ? "This went wrong when I ran it from the bench." : `The test “${run.test}” fails.`),
  again: (run: FlaggedRun) => (run.test === null ? "It still goes wrong when I run it again." : `The test “${run.test}” still fails.`),
  problem: "Fragmentor reports a problem here. Please fix it.",
};

/** What was run, as the person calls it: a test by its name, or the run they tried from the bench. */
const runName = (run: FlaggedRun) => (run.test === null ? "Run from the bench" : `Test “${run.test}”`);

/** Whether a run came out right: a test that passes, or a run with no expectation that finished and kept its promise. */
const cameRight = (result: CaseResult) => result.status === "passed" || result.status === "unchecked";

/**
 * The words to say to the agent, with a button that copies them. Typed into
 * the agent, not into Fragmentor, so they are shown in full rather than
 * hidden behind a button that could only half do it.
 */
export function phraseLine(lead: string, phrase: string, className = "note-phrase", purpose = "to paste into your coding agent"): HTMLElement {
  const line = el("div", className);
  line.append(el("span", undefined, lead), el("code", "note-phrase-words", phrase));
  const copy = el("button", "run-btn", "Copy");
  copy.type = "button";
  copy.title = `Copy “${phrase}”, ${purpose}.`;
  copy.addEventListener("click", () => {
    void window.fragmentor.copyText(phrase).then((result) => {
      // Said on the button itself rather than by drawing anything again,
      // which would take the cursor from whatever is being typed.
      copy.textContent = result.ok ? "Copied" : "Could not copy";
      setTimeout(() => (copy.textContent = "Copy"), 1600);
    });
  });
  line.append(copy);
  return line;
}

/**
 * Shows a block's notes: brings the block into view, selects it, and
 * scrolls its panel to them.
 */
export function showNotesOf(blockPath: string): void {
  ui.showInspector = true;
  revealBlock(blockPath);
  document.querySelector("#inspector [data-notes-of]")?.scrollIntoView({ block: "start" });
}

/**
 * Starts a note on part of a block, some lines of its code or one of its
 * steps: its panel opens at a new note that says what it is on.
 */
export function noteOn(blockPath: string, on: NoteAnchor): void {
  const block = ui.snapshot?.blocks[blockPath];
  if (!block) return;
  closeWindow();
  pendingOn.set(blockPath, on);
  said.clear();
  forms.set(blockPath, "new");
  showNotesOf(blockPath);
  document.getElementById(`note-${blockPath}-new`)?.focus();
}

/* -------------------------------------------------------------------------- */
/* Writing                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Writes something through the kernel, says how it went against the row it
 * was pressed on and in the status line, and shows the project as it now is.
 * The watcher would show it too, a moment later; reading it now means the
 * person never sees their note missing.
 */
async function write<T>(row: string, work: (dir: string) => Promise<Result<T>>, done: (value: T) => string, sent?: () => void): Promise<void> {
  const dir = ui.dir;
  if (!dir || busy) return;
  const mine = session;
  said.clear();
  busy = true;
  redrawSection();
  const result = await work(dir);
  if (session !== mine) return;
  busy = false;
  if (result.ok) {
    sent?.();
    ui.status = { text: done(result.value), tone: "good" };
  } else {
    said.set(row, { text: result.error });
    ui.status = { text: result.error, tone: "bad" };
  }
  await reloadProject();
  redrawAll();
}

/** What was typed has been sent, so it and its form go. */
function sentFrom(where: Where, which: string): () => void {
  return () => {
    drafts.delete(key(where.path, which));
    if (forms.get(where.path) === which) forms.delete(where.path);
    if (which === "new") pendingOn.delete(where.path);
  };
}

async function leave(block: SnapshotBlock): Promise<void> {
  const text = drafts.get(key(block.path, "new")) ?? "";
  const on = pendingOn.get(block.path);
  await write(
    key(block.path, "new"),
    (dir) => window.fragmentor.addNote(dir, block.path, text, on === undefined ? {} : { on }),
    () => `Left a note on ${block.name}. Tell your agent “${NOTES_PHRASE}” when you are ready.`,
    sentFrom(block, "new"),
  );
}

async function reply(where: Where, note: SnapshotNote): Promise<void> {
  const text = drafts.get(key(where.path, note.id)) ?? "";
  await write(
    key(where.path, note.id),
    (dir) => window.fragmentor.replyToNote(dir, note.id, text),
    () => `Replied on ${where.name}. It is with your agent again.`,
    sentFrom(where, note.id),
  );
}

/** Where what went wrong flagging one run is said: under its own offer, not every offer on the block. */
const flagKey = (block: SnapshotBlock, run: FlaggedRun) => key(block.path, run.test === null ? "flag" : `flag ${run.test}`);

/**
 * Flags a run that went wrong for the agent: a note on the block carrying
 * what was run and what came of it, so the agent can run it again itself. A
 * saved test flagged before, which the agent has answered for, is flagged on
 * the same note, which says it still fails and goes back to the agent.
 */
async function flagRun(block: SnapshotBlock, run: FlaggedRun, outcome: object | undefined, answered: SnapshotNote | null): Promise<void> {
  await write(
    flagKey(block, run),
    (dir) =>
      answered
        ? window.fragmentor.replyToNote(dir, answered.id, FLAG_WORDS.again(run), { run })
        : window.fragmentor.addNote(dir, block.path, FLAG_WORDS.run(run), { run }),
    () => `Flagged for your agent. Tell it “${NOTES_PHRASE}” when you are ready.`,
    () => {
      if (outcome !== undefined) flaggedRuns.add(outcome);
    },
  );
}

/**
 * Where a run stands with the agent: flagged and with it, flagged and
 * answered by it (a saved test only, in the note that says so), or not
 * flagged. A saved test is known by name in the person's open notes on its
 * block. A run tried once from the bench is known only once that very run was
 * flagged: what it was given can be cut short in the note, so it could never
 * be matched against the note again.
 */
function flagged(block: SnapshotBlock, run: FlaggedRun, outcome: object | undefined): "with the agent" | SnapshotNote | null {
  if (run.test === null) return outcome !== undefined && flaggedRuns.has(outcome) ? "with the agent" : null;
  const note = allNotes().find(
    (each) =>
      each.block === block.path &&
      each.status === "open" &&
      each.messages.some((message) => message.from === "person" && message.run !== undefined && message.run.test === run.test),
  );
  return note === undefined ? null : note.waiting === "agent" ? "with the agent" : note;
}

/**
 * The question put under a run that went wrong: whether to flag it for the
 * agent. Once it is flagged, it says so instead, so it is never flagged twice;
 * once the agent has answered, it asks whether to say it still fails.
 * A run tried from the bench is known by `outcome`, the result it came to.
 */
export function flagOffer(block: SnapshotBlock, run: FlaggedRun, outcome?: object): HTMLElement {
  const now = flagged(block, run, outcome);
  if (now === "with the agent") {
    return phraseLine("Flagged for your agent. When you are ready, tell it", NOTES_PHRASE, "note-phrase flag-offer");
  }
  const offer = el("div", "flag-offer");
  offer.append(
    el(
      "span",
      undefined,
      now === null
        ? "Flag this for your coding agent? It will see what was run and what went wrong."
        : "Your agent has answered the note flagging this test, and it still fails. Tell it so?",
    ),
  );
  const flag = el("button", "run-btn", now === null ? "Flag it" : "Flag it again");
  flag.type = "button";
  flag.disabled = busy;
  flag.title = now === null ? `Leave a note on ${block.name} with this run, for your agent to fix.` : "Add this run to that note, which gives it back to your agent.";
  flag.addEventListener("click", () => void flagRun(block, run, outcome, now));
  offer.append(flag);
  const trouble = said.get(flagKey(block, run));
  if (trouble) offer.append(el("p", "bench-note bad", trouble.text));
  return offer;
}

/**
 * The button beside a problem Fragmentor reported on a block, which flags it
 * for the agent as a note carrying the problem as it is worded. A problem
 * flagged already, in a note still open, says so instead.
 */
export function problemFlag(blockPath: string, problem: string): HTMLElement | null {
  const block = ui.snapshot?.blocks[blockPath];
  if (!block) return null;
  const already = allNotes().some(
    (note) => note.block === blockPath && note.status === "open" && note.messages.some((message) => message.problem === problem),
  );
  if (already) return el("span", "problem-flagged", "flagged");
  const flag = el("button", "run-btn problem-flag", "Flag");
  flag.type = "button";
  flag.disabled = busy;
  flag.title = `Flag this for your coding agent, as a note on ${block.name}.`;
  flag.addEventListener("click", (event) => {
    event.stopPropagation();
    void write(
      key(blockPath, "problem"),
      (dir) => window.fragmentor.addNote(dir, blockPath, FLAG_WORDS.problem, { problem }),
      () => `Flagged the problem on ${block.name} for your agent. Tell it “${NOTES_PHRASE}” when you are ready.`,
    );
  });
  return flag;
}

/**
 * Runs what a note flags again, as it was flagged, and draws what came of it
 * on the note. It never touches the block's saved tests. It is marked as
 * running at once, so a panel drawn meanwhile says so and starts no other,
 * and it starts once whatever is being drawn now is done, because what
 * comes of it draws the panel again.
 */
function rerun(note: SnapshotNote): void {
  const dir = ui.dir;
  if (!dir) return;
  const mine = session;
  const upTo = note.messages.length;
  const code = codeNow();
  reruns.set(note.id, { upTo, code, state: "running" });
  setTimeout(() => {
    // The project may have been put away before it started.
    if (session !== mine) return;
    void window.fragmentor.rerunNote(dir, note.id).then((result) => {
      if (session !== mine) return;
      reruns.set(note.id, { upTo, code, state: result.ok ? result.value : { error: result.error } });
      // Drawn now only where the note is showing; anywhere else it is drawn
      // from what is kept here when its block is next looked at.
      const shown = document.querySelector<HTMLElement>("#inspector [data-notes-of]");
      if (shown?.dataset.notesOf === note.block) redrawSection();
    });
  }, 0);
}

/* -------------------------------------------------------------------------- */
/* A block's notes                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Draws the section on screen again, keeping whatever field was being typed
 * in and where. The project's panel, where notes on blocks that have gone are
 * answered, is drawn again whole.
 */
function redrawSection(): void {
  const old = document.querySelector<HTMLElement>("#inspector [data-notes-of]");
  const block = old ? ui.snapshot?.blocks[old.dataset.notesOf!] : undefined;
  if (!old || !block) {
    redrawAll();
    return;
  }
  keepingFocus(old, () => old.replaceWith(notesSection(block)));
}

function button(label: string, title: string, act: () => void, className?: string): HTMLButtonElement {
  const pressed = el("button", className, label);
  pressed.type = "button";
  pressed.title = title;
  pressed.disabled = busy;
  pressed.addEventListener("click", act);
  return pressed;
}

/** What a note is on, in words, with a button that goes there. */
function anchorLine(on: NoteAnchor): HTMLElement {
  const line = el("div", "note-on");
  if ("file" in on) {
    const [first, last] = on.lines;
    const lines = first === last ? `line ${first}` : `lines ${first}–${last}`;
    line.append(el("span", undefined, `On ${lines} of ${on.file}`));
    line.append(button("Show", "Open the file at those lines.", () => void openCodeAt(on.file, on.file, on.lines, on.text), "run-btn"));
  } else {
    const execution = ui.snapshot?.executions.find((each) => each.id === on.execution);
    line.append(el("span", undefined, `On the step “${on.description}” of ${execution?.name ?? on.execution}`));
    if (execution) {
      line.append(
        button("Show", "Go to that step.", () => {
          if (!goToStep(on.execution, on.step)) ui.status = { text: "That step is no longer in its execution.", tone: "bad" };
          redrawAll();
        }, "run-btn"),
      );
    }
  }
  return line;
}

/** A place to write, with what sending it does. Enter makes a new line; the button sends. */
function noteForm(block: Where, row: string, placeholder: string, send: string, act: () => void): HTMLElement {
  const form = el("form", "note-form");
  // A new note on part of the block says which part, and can be made a note on the whole block again.
  const on = row === "new" ? pendingOn.get(block.path) : undefined;
  if (on) {
    const line = anchorLine(on);
    line.append(
      button("×", "Make it a note on the whole block.", () => {
        pendingOn.delete(block.path);
        redrawSection();
      }, "run-btn"),
    );
    form.append(line);
  }

  const box = el("textarea");
  box.id = `note-${block.path}-${row}`;
  box.maxLength = 4000;
  box.placeholder = placeholder;
  box.value = drafts.get(key(block.path, row)) ?? "";
  box.setAttribute("aria-label", placeholder);

  const submit = el("button", "btn", send);
  submit.type = "submit";
  const ready = () => {
    submit.disabled = busy || box.value.trim() === "";
  };
  ready();
  box.addEventListener("input", () => {
    drafts.set(key(block.path, row), box.value);
    ready();
  });
  // Ctrl-Enter sends, as it does in most places a message is written.
  box.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (!submit.disabled) act();
    }
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!submit.disabled) act();
  });

  const cancel = button("Cancel", "Put this away. What you typed is kept for when you open it again.", () => {
    forms.delete(block.path);
    said.clear();
    redrawSection();
  }, "btn quiet");

  const buttons = el("div", "note-form-actions");
  buttons.append(submit, cancel);
  form.append(box, buttons);
  const trouble = said.get(key(block.path, row));
  if (trouble) form.append(el("p", "bench-note bad", trouble.text));
  return form;
}

function openForm(block: Where, row: string): void {
  said.clear();
  forms.set(block.path, row);
  redrawSection();
  document.getElementById(`note-${block.path}-${row}`)?.focus();
}

/**
 * A run flagged with a message, folded away: what was run, what was expected
 * and what came back, and why it went wrong. What the note flags can be
 * retried from here. It stays open, once opened, however often the note
 * is drawn again.
 */
function runDetail(where: Where, note: SnapshotNote, at: number, run: FlaggedRun): HTMLElement {
  const detail = el("details", "note-run");
  const opened = `${note.id}#${at}`;
  detail.open = openRuns.has(opened);
  detail.addEventListener("toggle", () => {
    if (detail.open) openRuns.add(opened);
    else openRuns.delete(opened);
  });
  detail.append(el("summary", undefined, run.test === null ? "View failed run" : "View failed test"));
  // Whichever of them is opened, it runs the newest, which is the one to run again.
  if (note.status === "open" && canRerun(where.path, runOf(note) ?? run)) {
    const retry = el("div", "note-retry");
    const running = reruns.get(note.id)?.state === "running";
    retry.append(
      button(running ? "Retrying…" : run.test === null ? "Retry run" : "Retry test", "Run it again, as it was flagged, and say below how it went. The block's saved tests are not touched.", () => {
        rerun(note);
        redrawSection();
      }, "run-btn"),
    );
    if (running) retry.querySelector("button")!.disabled = true;
    detail.append(retry);
  }
  const shown = (label: string, value: unknown) => {
    const part = subsection(label);
    part.append(el("pre", "code", JSON.stringify(value, null, 2) ?? "nothing"));
    detail.append(part);
  };
  if (run.problems.length > 0) {
    const wrong = subsection("What went wrong", "bad");
    const list = el("ul");
    for (const problem of run.problems) list.append(el("li", undefined, problem));
    wrong.append(list);
    detail.append(wrong);
  }
  shown("Input", run.input);
  if (run.stores !== undefined) shown("Stores before", run.stores);
  if (run.expected !== undefined) shown("Expected", run.expected);
  if (run.output !== undefined) shown("Came back", run.output);
  if (run.logs.length > 0) {
    const logged = subsection("Logged");
    logged.append(el("pre", "code", run.logs.join("\n")));
    detail.append(logged);
  }
  if (run.cut?.length) {
    const parts = { input: "the input", stores: "the rows in the stores", expected: "what was expected", output: "what came back" };
    detail.append(el("p", "bench-note", `Too large to keep whole with this note, so cut short or left out: ${run.cut.map((part) => parts[part]).join(", ")}.`));
  }
  return detail;
}

/**
 * The commit the agent answered with, and what can be done with it from
 * here: comparing the block with how it was before, or putting it back.
 * Both are the block's Versions section's own, and what comes of them is
 * shown there, on the row of the version before.
 */
function commitLine(where: Where, hash: string, subject: string): HTMLElement {
  const line = el("div", "note-commit");
  line.append(el("span", undefined, "In the commit "), el("code", undefined, hash.slice(0, 7)), el("span", undefined, ` “${subject}”`));
  if (!ui.snapshot?.blocks[where.path]) return line;
  const before = versionBefore(where.path, hash);
  if (before === null) {
    line.append(el("span", "bench-note", "Finding the version before it…"));
  } else if (typeof before === "string") {
    line.append(el("span", "bench-note", before));
  } else {
    const actions = el("div", "case-actions");
    actions.append(
      button("Compare with before", "Run the saved tests against the block as it is and as it was before this commit. Nothing is changed.", () => {
        void actOnVersion(where.path, before.commit, "compare");
      }),
      button("Swap back to before", "Put the block back as it was before this commit. Undo swap puts it back again.", () => {
        void actOnVersion(where.path, before.commit, "swap");
      }),
    );
    line.append(actions);
  }
  return line;
}

/**
 * What running the flagged run again came to, once the agent has answered:
 * whether what the person flagged is put right, so they need not take the
 * agent's word for it. Still wrong, it offers to say so on the note.
 */
function rerunLine(where: Where, note: SnapshotNote, run: FlaggedRun): HTMLElement | null {
  const line = el("div", "note-rerun");
  // A result about code that has since changed says nothing about the code now.
  const kept = reruns.get(note.id);
  const done = kept && (kept.state === "running" || kept.code === codeNow()) ? kept : undefined;

  if (done === undefined) return null;
  if (done.state === "running") {
    line.append(el("span", undefined, run.test === null ? "Running it again…" : "Running the test again…"));
    return line;
  }
  if ("error" in done.state) {
    line.dataset.tone = "bad";
    line.append(el("span", undefined, `It could not be run again: ${done.state.error}`));
    return line;
  }
  const result = done.state;
  if (cameRight(result)) {
    line.dataset.tone = "good";
    line.append(el("span", undefined, run.test === null ? "Ran it again: it finishes now, and keeps its promise." : `Ran it again: “${run.test}” passes now.`));
    return line;
  }
  line.dataset.tone = "bad";
  const problems = result.differences.length > 0 ? result.differences : [result.error ?? "It failed."];
  line.append(el("span", undefined, `Ran it again: it still fails. ${[...problems, ...result.inputProblems].join(" ")}`));
  if (note.waiting === "person" && ui.snapshot?.blocks[where.path]) {
    const still: FlaggedRun = {
      test: run.test,
      input: run.input,
      ...(run.stores === undefined ? {} : { stores: run.stores }),
      ...(run.expected === undefined ? {} : { expected: run.expected }),
      ...(result.output === undefined ? {} : { output: result.output }),
      problems: [...problems, ...result.inputProblems],
      logs: result.logs,
    };
    line.append(
      button("Tell your agent", "Reply that it still fails, with this run, which gives the note back to your agent.", () => {
        void write(
          key(where.path, note.id),
          (dir) => window.fragmentor.replyToNote(dir, note.id, FLAG_WORDS.again(run), { run: still }),
          () => `Told your agent it still fails. Tell it “${NOTES_PHRASE}” when you are ready.`,
        );
      }, "run-btn"),
    );
  }
  return line;
}

function noteCard(block: Where, note: SnapshotNote, gone = false): HTMLElement {
  const card = el("div", "note-card");
  card.dataset.note = note.id;
  card.dataset.waiting = note.waiting ?? "none";
  if (note.working !== undefined && note.waiting === "agent") card.dataset.working = "true";

  const head = el("div", "note-head");
  head.append(el("span", "note-state", stateWord(note)), el("span", "note-when", when(note.messages.at(-1)!.at)));
  card.append(head);
  if (note.on) card.append(anchorLine(note.on));
  if (card.dataset.working) card.append(el("p", "note-working", `Your agent started on this at ${when(note.working!)}.`));

  note.messages.forEach((message, at) => {
    const line = el("div", "note-message");
    line.dataset.from = message.from;
    line.append(el("span", "note-from", fromWord(message)));
    // Something that went wrong says so first, in red. The words a flag
    // writes for the agent say the same, so only the person's own are shown.
    const error = (words: string) => {
      const said = el("p", "note-error");
      said.append(el("span", "note-error-word", "ERROR:"), document.createTextNode(words));
      return said;
    };
    if (message.run) line.append(error(`${runName(message.run)}${at > 0 ? " still fails" : ""}`));
    if (message.problem) {
      const said = error(message.problem);
      said.classList.add("note-problem");
      line.append(said);
    }
    const flagWords = [message.run ? FLAG_WORDS.run(message.run) : "", message.run ? FLAG_WORDS.again(message.run) : "", message.problem ? FLAG_WORDS.problem : ""];
    if (!flagWords.includes(message.text)) line.append(el("p", "note-text", message.text));
    if (message.run) line.append(runDetail(block, note, at, message.run));
    if (message.commit) line.append(commitLine(block, message.commit.hash, message.commit.subject));
    card.append(line);
  });

  // Once the agent has answered a note flagging a run, what was flagged is
  // run again, so whether it is put right is seen rather than taken on trust.
  const run = runOf(note);
  if (run && note.status === "open") {
    const result = canRerun(block.path, run) ? rerunLine(block, note, run) : null;
    if (result) card.append(result);
    else if (cutTooMuch(run)) card.append(el("p", "bench-note", "What this note flags was too large to keep whole, so it cannot be run again as it was."));
  }

  const row = key(block.path, note.id);
  const asking = said.get(row)?.confirm === true;
  if (asking) {
    card.append(el("p", "bench-note bad", said.get(row)!.text));
    const actions = el("div", "case-actions");
    actions.append(
      button("Delete it", "Delete this note, for everyone once the project is committed.", () => {
        void write(row, (dir) => window.fragmentor.deleteNote(dir, note.id), () => `Deleted a note on ${block.name}.`);
      }),
      button("Keep", "Keep it.", () => {
        said.delete(row);
        redrawSection();
      }),
    );
    card.append(actions);
    return card;
  }

  if (forms.get(block.path) === note.id) {
    card.append(
      noteForm(
        block,
        note.id,
        note.status === "resolved" ? "What is still wrong? Sending this opens the note again." : "Your reply",
        note.status === "resolved" ? "Reopen" : "Reply",
        () => void reply(block, note),
      ),
    );
    return card;
  }

  const trouble = said.get(row);
  if (trouble) card.append(el("p", "bench-note bad", trouble.text));

  const actions = el("div", "case-actions");
  actions.append(
    button(
      note.status === "resolved" ? "Reopen" : "Reply",
      note.status === "resolved" ? "Say what is still wrong, which gives the note back to your agent." : "Add to this note. It goes to your agent.",
      () => openForm(block, note.id),
    ),
  );
  if (note.status === "open" && !gone) {
    actions.append(
      button("Resolve", "Mark this done. It stays here, folded away, until you delete it.", () => {
        void write(row, (dir) => window.fragmentor.resolveNote(dir, note.id), () => `Resolved a note on ${block.name}.`);
      }),
    );
  }
  actions.append(
    button("Delete", "Delete this note.", () => {
      said.clear();
      said.set(row, { text: "Delete this note? It goes for everyone once the project is next committed.", confirm: true });
      redrawSection();
    }),
  );
  card.append(actions);
  return card;
}

/**
 * A block's notes, in its panel: those still open, a place to leave another,
 * the words that set the agent to work on them, and the resolved ones folded
 * away.
 */
export function notesSection(block: SnapshotBlock): HTMLElement {
  const node = section("Notes");
  node.dataset.notesOf = block.path;

  const mine = allNotes().filter((note) => note.block === block.path);
  const open = mine.filter((note) => note.status === "open");
  const resolved = mine.filter((note) => note.status === "resolved");

  // A note the agent has answered since its run was last run again is run
  // again now, for a block Fragmentor can run.
  // Once more after anything it depends on changes, so what it says is
  // about the code as it is now.
  for (const note of open) {
    const run = runOf(note);
    if (note.waiting !== "person" || run === undefined || !canRerun(block.path, run)) continue;
    const last = reruns.get(note.id);
    if (last?.state === "running") continue;
    if (last === undefined || last.upTo !== note.messages.length || last.code !== codeNow()) rerun(note);
  }

  if (open.length === 0 && forms.get(block.path) !== "new") {
    node.append(el("p", "bench-note", "Leave a note here for your coding agent: something to change, fix or look into on this block. It can leave you notes here too."));
  }
  for (const note of open) node.append(noteCard(block, note));

  if (forms.get(block.path) === "new") {
    node.append(noteForm(block, "new", "What should change, or what should your agent look at?", "Leave note", () => void leave(block)));
  } else {
    const leaveOne = button("Leave a note", `Leave a note on ${block.name} for your coding agent.`, () => openForm(block, "new"), "btn quiet");
    leaveOne.classList.add("note-leave");
    node.append(leaveOne);
  }

  if (open.some((note) => note.waiting === "agent")) {
    node.append(phraseLine("When you are ready, tell your agent", NOTES_PHRASE));
    // The agent takes the words to mean the block and everything inside it.
    const which = block.children.length === 0 ? "this block" : "this block and its parts";
    node.append(phraseLine(`or, for ${which} only,`, phraseFor(NOTES_COMMAND, block.path), "note-phrase quiet"));
  }
  const more = button("Every command for this block…", `What else you can ask your agent to do with ${block.name}.`, () => openCommandsWindow(block.path), "btn quiet tiny");
  more.classList.add("note-commands");
  node.append(more);

  if (resolved.length > 0) {
    const showing = unfolded.has(block.path);
    const toggle = button(showing ? `Hide ${plural(resolved.length, "resolved note")}` : plural(resolved.length, "resolved note"), showing ? "Fold them away." : "Show the notes that are done.", () => {
      if (showing) unfolded.delete(block.path);
      else unfolded.add(block.path);
      redrawSection();
    }, "btn quiet tiny");
    toggle.classList.add("note-resolved-toggle");
    node.append(toggle);
    if (showing) for (const note of [...resolved].reverse()) node.append(noteCard(block, note));
  }

  return node;
}

/* -------------------------------------------------------------------------- */
/* Every block's notes                                                         */
/* -------------------------------------------------------------------------- */

/** One open note as a row that leads to its block, as a problem does. */
function noteRow(note: SnapshotNote, block: SnapshotBlock): HTMLElement {
  const row = el("button", "problem note-row");
  row.dataset.waiting = note.waiting ?? "none";
  row.append(el("span", "problem-level", stateWord(note)), el("span", "problem-where", note.block));
  const last = note.messages.at(-1)!;
  row.append(el("span", "problem-text", `${fromWord(last)}: ${last.text.split("\n")[0]}`));
  row.title = `Show the notes on ${block.name}`;
  row.addEventListener("click", () => showNotesOf(note.block));
  return row;
}

/** Open notes whose block is still there, which are the ones anything can lead to. */
function openOnBlocks(): { note: SnapshotNote; block: SnapshotBlock }[] {
  return allNotes().flatMap((note) => {
    const block = ui.snapshot?.blocks[note.block];
    return note.status === "open" && block ? [{ note, block }] : [];
  });
}

/**
 * Every open note in the project, for the panel shown when no block is
 * picked out, with what to tell the agent. It is there when there are none,
 * too, since that is where someone looking for how to leave one will look.
 */
export function projectNotesSection(): HTMLElement {
  const node = section("Notes");
  node.dataset.projectNotes = "";
  const open = openOnBlocks();
  // A note on a block that has gone has nowhere to be answered but here.
  const gone = allNotes().filter((note) => note.status === "open" && !ui.snapshot?.blocks[note.block]);

  if (open.length === 0 && gone.length === 0) {
    node.append(el("p", "bench-note", "Select a block and leave a note on it for your coding agent: something to change, fix or look into. Your agent can leave you notes on blocks too."));
  }
  for (const [title, whose] of [["For you", "person"], ["For your agent", "agent"]] as const) {
    const rows = open.filter(({ note }) => note.waiting === whose);
    if (rows.length === 0) continue;
    const part = subsection(`${title} (${rows.length})`);
    const list = el("div", "problems");
    for (const { note, block } of rows) list.append(noteRow(note, block));
    part.append(list);
    node.append(part);
  }
  if (gone.length > 0) {
    const part = subsection(`On blocks no longer there (${gone.length})`);
    part.append(el("p", "bench-note", "If a block moved, reply and your agent will move its notes with it. If it is gone, delete them."));
    for (const note of gone) part.append(noteCard({ path: note.block, name: note.block }, note, true));
    node.append(part);
  }

  const say = subsection("What to tell your agent");
  say.append(
    phraseLine("To work through every note waiting for it:", NOTES_PHRASE),
    phraseLine("For one block and its parts only:", `${NOTES_PHRASE} <block path>`, "note-phrase quiet"),
    el("p", "bench-note", "It answers each note here when it is done, and the note comes back to you to resolve, or to reply to if it is not right yet."),
  );
  const every = button("Every command…", "Everything you can ask your agent to do with the diagram.", () => openCommandsWindow(null), "btn quiet tiny");
  every.classList.add("note-commands");
  say.append(every);
  node.append(say);
  return node;
}

/**
 * The bar above the drawing while notes are open: how many are with the
 * agent, and the words to send it there, and how many have come back.
 */
export function renderNotesBar(): void {
  const bar = document.getElementById("notes-bar");
  if (!bar) return;
  bar.replaceChildren();
  const open = ui.snapshot && !ui.waiting ? allNotes().filter((note) => note.status === "open") : [];
  bar.hidden = open.length === 0;
  if (open.length === 0) return;

  // The agent is told about a note on a block that has gone as about any
  // other; the person answers it from the project's panel, having no block to go to.
  const forAgent = open.filter((note) => note.waiting === "agent");
  const forYou = open.filter((note) => note.waiting === "person" && ui.snapshot?.blocks[note.block]);
  const gone = open.filter((note) => note.waiting === "person" && !ui.snapshot?.blocks[note.block]).length;
  if (forAgent.length > 0) {
    const working = forAgent.filter((note) => note.working !== undefined).length;
    const lead = `${plural(forAgent.length, "note")} for your agent${working > 0 ? `, ${working} being worked on` : ""}. Tell it`;
    bar.append(phraseLine(lead, NOTES_PHRASE, "notes-bar-part"));
  }
  if (forYou.length > 0) {
    const part = el("div", "notes-bar-part");
    part.dataset.waiting = "person";
    part.append(el("span", undefined, `${plural(forYou.length, "note")} for you`));
    // Block by block, since a block's panel shows all of its notes at once.
    const blocks = [...new Set(forYou.map((note) => note.block))];
    const show = el("button", "run-btn", "Show");
    show.type = "button";
    show.title = blocks.length === 1 ? "Show them." : "Show the next block with notes for you.";
    show.addEventListener("click", () => {
      shownLast = (shownLast + 1) % blocks.length;
      showNotesOf(blocks[shownLast]!);
    });
    part.append(show);
    bar.append(part);
  }
  if (gone > 0) {
    const part = el("div", "notes-bar-part");
    part.dataset.waiting = "person";
    part.append(el("span", undefined, `${plural(gone, "note")} for you on a block no longer there`));
    const show = el("button", "run-btn", "Show");
    show.type = "button";
    show.title = "Show the project's notes, where they are answered.";
    show.addEventListener("click", () => {
      ui.selection.clear();
      ui.selectedLink = null;
      ui.showInspector = true;
      redrawAll();
      document.querySelector("#inspector [data-project-notes]")?.scrollIntoView({ block: "start" });
    });
    part.append(show);
    bar.append(part);
  }
}

/* -------------------------------------------------------------------------- */
/* Every command                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Everything the person can ask their agent to do, in one window: each
 * command, what it does, and the words to send it, with the block picked out
 * filled in where one can be named. Opened from the top bar and from notes.
 */
export function openCommandsWindow(blockPath: string | null): void {
  const block = blockPath === null ? undefined : ui.snapshot?.blocks[blockPath];
  // An agent learns these from its guide and its slash commands, which a
  // project from before they existed has not been given yet.
  if (ui.dir) void window.fragmentor.refreshAgentFiles(ui.dir);
  const body = el("div", "window-sections commands");
  body.append(
    el(
      "p",
      "bench-note",
      "Type these to your coding agent, in the folder this project is in. Each starts with “fragmentor”, and one that names a block means that block and its parts. In Claude Code, each is also a slash command.",
    ),
  );

  for (const command of COMMANDS) {
    const part = section(command.title);
    part.dataset.command = command.name;
    part.append(el("p", "command-summary", command.summary));
    part.append(phraseLine("Say", phraseFor(command)));
    // Explaining a block is asked by naming it, as the commands that take one are.
    if (block && (command.takes === "block" || command.name === "explain")) {
      part.append(phraseLine(`For ${block.name}:`, phraseFor(command, block.path), "note-phrase quiet"));
    }
    part.append(el("p", "bench-note command-usage", `${usageOf(command)} · in Claude Code, /fragmentor-${command.name}`));
    body.append(part);
  }
  openWindow("Commands for your agent", block ? `with ${block.name} picked out` : "for the whole diagram, or a block you name", body);
}
