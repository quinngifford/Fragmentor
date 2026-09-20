import type { RunEvent, RunOutcome, StoreSeeds } from "../../src/run/run.js";
import type { SnapshotBlock } from "../../src/project/snapshot.js";
import type { Result, RunCommand } from "../ipc.js";
import {
  applyBreakpoints,
  applyRunOverlay,
  onBreakpointToggle,
  onCanvasDrawn,
  revealBlock,
  treeInView,
} from "./canvas.js";
import type { RunOverlay } from "./canvas.js";
import type { Tree } from "./tree.js";
import { requireSnapshot, ui } from "./state.js";
import type { Watch, WatchedCall } from "./state.js";
import { el, section, subsection } from "./dom.js";
import { codeBlock } from "./highlight.js";

/**
 * Watching a run on the diagram.
 *
 * A watched run reports every block call it makes, wherever in the system
 * the block sits. A whole run usually takes a few milliseconds, so the calls
 * are played back at a pace a person can follow, and everything shown is
 * derived from the calls played so far: which blocks are running or done, and
 * where the run is held at a breakpoint. A block on screen shows what is
 * happening anywhere inside it, so the diagram on screen can be any part of
 * the architecture; opening another block simply shows the run in more detail.
 */

let notify: () => void = () => {};
export function onWatchChange(callback: () => void): void {
  notify = callback;
}

const isWithin = (blockPath: string, ancestor: string) =>
  ancestor === "" || blockPath === ancestor || blockPath.startsWith(`${ancestor}/`);

/** A block's calls in the run so far, in the order they were made. */
function callsOf(watch: Watch, blockPath: string): WatchedCall[] {
  return [...watch.calls.values()].filter((call) => call.block === blockPath);
}

/** Shows one more event. */
function play(watch: Watch, event: RunEvent): void {
  if (event.type === "call") {
    watch.calls.set(event.id, { id: event.id, parent: event.parent, block: event.block, input: event.input, state: "running" });
    return;
  }
  const call = watch.calls.get(event.id);
  if (!call) return;
  if (event.type === "return") {
    call.output = event.output;
    call.state = "returned";
  } else if (event.type === "throw") {
    call.error = event.error;
    call.state = "threw";
  } else if (event.type === "paused") {
    call.state = "paused";
    watch.heldId = event.id;
  } else {
    call.state = "running";
    if (watch.heldId === event.id) watch.heldId = null;
  }
}

/**
 * Once a run has ended and been shown to the end, a call still running or
 * held never finished: the run was stopped, or failed around it.
 */
function settleUnfinished(watch: Watch): void {
  watch.heldId = null;
  for (const call of watch.calls.values()) {
    if (call.state === "running" || call.state === "paused") call.state = "stopped";
  }
}

/* -------------------------------------------------------------------------- */
/* What the diagram on screen shows                                            */
/* -------------------------------------------------------------------------- */

function nodeRun(calls: WatchedCall[]): { state: "running" | "paused" | "done" | "failed" | "stopped"; note: string } {
  const finished = calls.filter((call) => call.state === "returned").length;
  const has = (state: WatchedCall["state"]) => calls.some((call) => call.state === state);
  const state = has("paused") ? "paused" : has("threw") ? "failed" : has("stopped") ? "stopped" : has("running") ? "running" : "done";
  if (state === "paused" || state === "failed" || state === "stopped") return { state, note: state };
  return { state, note: calls.length > 1 ? `${finished} of ${calls.length}` : state };
}

/**
 * How each block on screen is doing: the calls made to it, or to anything
 * inside it, from wherever they came.
 */
function overlayFor(watch: Watch, tree: Tree): RunOverlay {
  const overlay: RunOverlay = { nodes: new Map() };
  for (const node of tree.nodes.values()) {
    const path = node.path;
    const inside = [...watch.calls.values()].filter((call) => isWithin(call.block, path));
    if (inside.length === 0) continue;
    // A block that was called says how its own calls went; the calls made
    // inside it are its own business, and counting them would make one call
    // read as several. A group of parts is never called, so it says how many
    // calls happened inside it instead.
    const own = inside.filter((call) => call.block === path);
    const run = nodeRun(own.length > 0 ? own : inside);
    overlay.nodes.set(path, own.length > 0 || run.state !== "done" ? run : { state: "done", note: `${inside.length} inside` });
  }
  return overlay;
}

/** The call the run is really stopped at, waiting for the person. Null once it has moved on. */
function heldCall(watch: Watch | null): WatchedCall | null {
  if (!watch || watch.outcome || watch.heldId === null) return null;
  const call = watch.calls.get(watch.heldId);
  return call?.state === "paused" ? call : null;
}

function paint(): void {
  const tree = treeInView();
  applyRunOverlay(ui.watch && tree ? overlayFor(ui.watch, tree) : null);
  renderRunBar();
}

/* -------------------------------------------------------------------------- */
/* Playback                                                                    */
/* -------------------------------------------------------------------------- */

let timer: number | undefined;

/**
 * How long the run must stay where it is before the canvas goes to it.
 *
 * Several calls can be held at once, and letting one go hands the breakpoint
 * to the next in the queue for a moment, before the step lands where it was
 * actually going. Following each of those in turn zoomed the canvas in and
 * straight back out. Waiting for the run to stop moving means the canvas makes
 * one move, to where the run came to rest.
 */
const SETTLE_MS = 420;
let settle: number | undefined;

function stopPlayback(): void {
  if (timer !== undefined) window.clearTimeout(timer);
  timer = undefined;
  if (settle !== undefined) window.clearTimeout(settle);
  settle = undefined;
}

function followWhenSettled(watch: Watch): void {
  if (settle !== undefined) window.clearTimeout(settle);
  settle = window.setTimeout(() => {
    settle = undefined;
    if (ui.watch !== watch) return;
    // Still catching up: ask again once the events on hand have been shown.
    if (watch.played < watch.events.length) {
      followWhenSettled(watch);
      return;
    }
    const call = heldCall(watch);
    if (call) follow(watch, call.id);
  }, SETTLE_MS);
}

/** How long to linger on an event: long enough to see a block light up. */
function pace(event: RunEvent): number {
  if (event.type === "paused" || event.type === "resumed") return 0;
  return event.type === "call" ? 280 : 140;
}

/** Brings a call held at a breakpoint into view and picks it out, so what is about to go into it can be read. */
function follow(watch: Watch, id: number): void {
  const call = watch.calls.get(id);
  if (!call) return;
  revealBlock(call.block);
  paint();
  notify();
}

/** Plays the next event, and any after it that cannot be seen from here and so need no time. */
function playNext(watch: Watch): void {
  let played = 0;

  do {
    const event = watch.events[watch.played]!;
    watch.played += 1;
    played += 1;
    play(watch, event);
  } while (watch.played < watch.events.length && pace(watch.events[watch.played]!) === 0 && played < 500);

  paint();
  // Follow the run to where it is held, once it has settled there. A replay of
  // a finished run stays where the person put it.
  if (heldCall(watch)) followWhenSettled(watch);
}

function schedule(): void {
  const watch = ui.watch;
  if (!watch || timer !== undefined) return;

  if (watch.played >= watch.events.length) {
    // Shown to the end. Once the run itself has ended too, whatever never
    // finished was cut short, and the panels can show how it all came out.
    if (watch.outcome) {
      settleUnfinished(watch);
      paint();
      notify();
    } else {
      renderRunBar();
    }
    return;
  }

  // A long run catches up faster, rather than keeping the person waiting.
  const behind = watch.events.length - watch.played;
  const delay = pace(watch.events[watch.played]!) / Math.max(1, behind / 12);
  timer = window.setTimeout(() => {
    timer = undefined;
    if (ui.watch !== watch) return;
    playNext(watch);
    schedule();
  }, delay);
}

function command(watch: Watch, instruction: RunCommand): void {
  void window.fragmentor.controlRun(watch.runId, instruction);
}

function skip(watch: Watch): void {
  stopPlayback();
  while (watch.played < watch.events.length) play(watch, watch.events[watch.played++]!);
  settleUnfinished(watch);
  paint();
  notify();
}

function replay(watch: Watch): void {
  stopPlayback();
  watch.played = 0;
  watch.calls = new Map();
  watch.heldId = null;
  paint();
  schedule();
}

function clear(): void {
  stopPlayback();
  ui.watch = null;
  paint();
  notify();
}

let runs = 0;

/**
 * Runs a block with the diagram following along, wherever the person is
 * looking: every block on screen shows what the run does inside it. Resolves
 * with the outcome once the run ends.
 */
export async function runWatched(block: SnapshotBlock, input: unknown, stores: StoreSeeds = {}): Promise<Result<RunOutcome>> {
  const previous = ui.watch;
  if (previous && !previous.outcome) command(previous, { type: "stop" });
  stopPlayback();

  const watch: Watch = {
    runId: `${Date.now()}-${++runs}`,
    blockPath: block.path,
    events: [],
    played: 0,
    calls: new Map(),
    heldId: null,
    outcome: null,
    frames: new Map(),
  };
  ui.watch = watch;
  paint();

  const result = await window.fragmentor.watchRun({
    runId: watch.runId,
    dir: requireSnapshot().dir,
    blockPath: block.path,
    input,
    stores,
    breakpoints: [...ui.breakpoints],
  });

  if (ui.watch === watch) {
    watch.outcome = result.ok
      ? result.value
      : { ok: false, error: result.error, inputProblems: [], outputProblems: [], stores: {}, logs: [], durationMs: 0 };
    schedule();
  }
  return result;
}

/** Whether a watched run pauses before a block. A run under way hears about the change at once. */
export function toggleBreakpoint(blockPath: string): void {
  if (ui.breakpoints.has(blockPath)) ui.breakpoints.delete(blockPath);
  else ui.breakpoints.add(blockPath);
  applyBreakpoints();

  const watch = ui.watch;
  if (watch && !watch.outcome) command(watch, { type: "breakpoints", paths: [...ui.breakpoints] });
}

/** A project was opened: nothing about the last one's runs carries over. */
export function resetWatching(): void {
  const watch = ui.watch;
  if (watch && !watch.outcome) command(watch, { type: "stop" });
  stopPlayback();
  ui.watch = null;
  ui.breakpoints.clear();
  renderRunBar();
}

/* -------------------------------------------------------------------------- */
/* Controls                                                                    */
/* -------------------------------------------------------------------------- */

function barButton(label: string, title: string, action: () => void): HTMLButtonElement {
  const button = el("button", "run-btn", label);
  button.type = "button";
  button.title = title;
  button.addEventListener("click", action);
  return button;
}

function renderRunBar(): void {
  const bar = document.getElementById("run-bar");
  if (!bar) return;
  const watch = ui.watch;
  bar.replaceChildren();
  bar.hidden = watch === null;
  if (!watch) return;

  const blocks = ui.snapshot?.blocks ?? {};
  const name = blocks[watch.blockPath]?.name ?? watch.blockPath;
  // Only a run that is still going can be held; a replay shows pauses as they were.
  const held = heldCall(watch);
  const state = el("span", "run-state");
  const buttons: HTMLButtonElement[] = [];

  if (held) {
    const turns = callsOf(watch, held.block);
    const which = turns.length > 1 ? ` (call ${turns.indexOf(held) + 1} of ${turns.length})` : "";
    state.textContent = `Paused before ${blocks[held.block]?.name ?? held.block}${which}`;
    state.dataset.tone = "paused";
    buttons.push(
      barButton("Continue", "Run on to the next breakpoint", () => command(watch, { type: "resume", mode: "continue" })),
    );
    // A block run once per item is called for every item at once, and every
    // call is held. Continue would let them go one at a time.
    if (turns.length > 1) {
      buttons.push(
        barButton(
          "Continue all",
          "Let go of every call of this block that is waiting, rather than one at a time",
          () => command(watch, { type: "resume", mode: "block" }),
        ),
      );
    }
    buttons.push(
      barButton("Step", "Run until the next block starts", () => command(watch, { type: "resume", mode: "step" })),
      barButton("Stop", "End the run here", () => command(watch, { type: "stop" })),
    );
  } else if (!watch.outcome) {
    state.textContent = `Running ${name}…`;
    buttons.push(barButton("Stop", "End the run here", () => command(watch, { type: "stop" })));
  } else if (watch.played < watch.events.length) {
    state.textContent = `Showing how ${name} ran…`;
    buttons.push(barButton("Skip to the end", "Show the finished run at once", () => skip(watch)));
  } else {
    const outcome = watch.outcome;
    state.textContent = outcome.stopped
      ? `${name} was stopped`
      : outcome.ok
        ? `${name} finished in ${outcome.durationMs} ms`
        : `${name} failed: ${outcome.error ?? "no reason was given"}`;
    if (!outcome.stopped) state.dataset.tone = outcome.ok ? "good" : "bad";
    buttons.push(
      barButton("Replay", "Watch the run again", () => replay(watch)),
      barButton("Clear", "Take the run off the diagram", clear),
    );
  }

  bar.append(state, ...buttons);
}

/* -------------------------------------------------------------------------- */
/* Inspector                                                                   */
/* -------------------------------------------------------------------------- */

/** Only TypeScript blocks in a structured project run, so only they can be watched or paused. */
export function canWatch(block: SnapshotBlock): boolean {
  return ui.snapshot?.mode === "structured" && block.language === "typescript";
}

function json(value: unknown): string {
  const text = JSON.stringify(value, null, 2) ?? "nothing";
  return text.length > 4000 ? `${text.slice(0, 4000)}\n…` : text;
}

const STILL_GOING: Partial<Record<WatchedCall["state"], string>> = {
  paused: "Held at its breakpoint. Use Continue or Step above the diagram.",
  running: "Still running.",
  stopped: "The run ended before this call finished.",
};

/** Pausing at a block, and what it received and returned in the run on the diagram. */
export function watchSection(block: SnapshotBlock): HTMLElement | null {
  if (!canWatch(block)) return null;

  const node = section("Watching", "watch-section");

  const toggle = el("label", "watch-toggle");
  const box = el("input");
  box.type = "checkbox";
  box.checked = ui.breakpoints.has(block.path);
  box.addEventListener("change", () => {
    toggleBreakpoint(block.path);
    notify();
  });
  toggle.append(box, el("span", undefined, "Pause a run before this block, to see what reaches it"));
  node.append(toggle);

  const watch = ui.watch;
  const calls = watch ? callsOf(watch, block.path) : [];
  if (!watch || calls.length === 0) {
    node.append(
      el("p", "bench-note", watch ? "This block has not run in the run on the diagram." : "Run a block to watch it, and whatever it calls, on the diagram."),
    );
    return node;
  }

  const index = Math.min(watch.frames.get(block.path) ?? 0, calls.length - 1);
  const call = calls[index]!;

  if (calls.length > 1) {
    const move = (to: number) => {
      watch.frames.set(block.path, to);
      paint();
      notify();
    };
    const before = el("button", "run-btn", "‹");
    before.title = "The call before";
    before.disabled = index === 0;
    before.addEventListener("click", () => move(index - 1));
    const after = el("button", "run-btn", "›");
    after.title = "The next call";
    after.disabled = index === calls.length - 1;
    after.addEventListener("click", () => move(index + 1));
    const picker = el("div", "call-picker");
    picker.append(before, el("span", undefined, `call ${index + 1} of ${calls.length}`), after);
    node.append(picker);
  }

  const received = subsection(call.state === "paused" ? "About to receive" : "Received");
  received.append(codeBlock(json(call.input), "json"));
  node.append(received);

  if (call.state === "returned") {
    const returned = subsection("Returned", "good");
    returned.append(codeBlock(json(call.output), "json"));
    node.append(returned);
  } else if (call.state === "threw") {
    const failed = subsection("Failed", "bad");
    failed.append(el("pre", "code", call.error ?? ""));
    node.append(failed);
  } else {
    node.append(el("p", "bench-note", STILL_GOING[call.state] ?? ""));
  }
  return node;
}

/** Called once, as the window starts. */
export function setUpWatching(): void {
  window.fragmentor.onRunEvent((runId, event) => {
    const watch = ui.watch;
    if (!watch || watch.runId !== runId) return;
    watch.events.push(event);
    schedule();
  });
  onCanvasDrawn(() => paint());
  onBreakpointToggle((blockPath) => {
    toggleBreakpoint(blockPath);
    notify();
  });
}
