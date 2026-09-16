import type { RunEvent, RunOutcome } from "../../src/run/run.js";
import type { SnapshotBlock } from "../../src/project/snapshot.js";
import type { Result, RunCommand } from "../ipc.js";
import {
  applyBreakpoints,
  applyRunOverlay,
  applySelection,
  graphInView,
  onBreakpointToggle,
  onCanvasDrawn,
  openDiagram,
} from "./canvas.js";
import type { RunOverlay } from "./canvas.js";
import type { Bus, Graph, Signal } from "./graph.js";
import { requireSnapshot, ui } from "./state.js";
import type { Watch, WatchedCall } from "./state.js";
import { el, section, subsection } from "./dom.js";
import { codeBlock } from "./highlight.js";

/**
 * Watching a run on the diagram.
 *
 * A watched run reports every block call beneath the block that was run. A
 * whole run usually takes a few milliseconds, so the calls are played back at
 * a pace a person can follow, and everything shown is derived from the calls
 * played so far: which blocks are running or done, the value on each wire,
 * and where the run is held at a breakpoint. The diagram on screen can be any
 * part of the run; opening another block simply shows another part of it.
 */

let notify: () => void = () => {};
export function onWatchChange(callback: () => void): void {
  notify = callback;
}

const parentOf = (blockPath: string) => blockPath.split("/").slice(0, -1).join("/");
const idOf = (blockPath: string) => blockPath.split("/").at(-1)!;

/** A block's calls in the run so far, in the order they were made. */
function callsOf(watch: Watch, blockPath: string): WatchedCall[] {
  return [...watch.calls.values()].filter((call) => call.block === blockPath);
}

/** The call of a block whose inside is shown, for a block that ran more than once. */
function frameOf(watch: Watch, blockPath: string): WatchedCall | null {
  const calls = callsOf(watch, blockPath);
  if (calls.length === 0) return null;
  return calls[Math.min(watch.frames.get(blockPath) ?? 0, calls.length - 1)]!;
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

function field(value: unknown, port: string): unknown {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>)[port] : undefined;
}

type Carried = { known: true; value: unknown } | { known: false };

/** The calls of each block drawn in the diagram on screen, within the call of the diagram's own block being shown. */
function childCalls(watch: Watch, graph: Graph, frame: WatchedCall | null): Map<string, WatchedCall[]> {
  const children = new Map<string, WatchedCall[]>();
  for (const call of watch.calls.values()) {
    if (parentOf(call.block) !== ui.view) continue;
    if (frame && call.parent !== frame.id) continue;
    const key = idOf(call.block);
    if (!graph.nodes.has(key)) continue;
    children.set(key, [...(children.get(key) ?? []), call]);
  }
  return children;
}

/** What a wire on screen carried. Unknown until whatever drives it has finished. */
function carried(signal: Signal, frame: WatchedCall, children: Map<string, WatchedCall[]>, graph: Graph): Carried {
  if (signal.source === "input") return { known: true, value: field(frame.input, signal.sourcePort) };

  const calls = children.get(signal.source) ?? [];
  if (calls.some((call) => call.state !== "returned")) return { known: false };

  const child = graph.nodes.get(signal.source)?.child;
  if (child?.mode === "each" && child.eachOver) {
    // Called once per item, it produced one value per call, and the wire
    // carries them all — once every item has had its call.
    const over = graph.signals.find((each) => each.target === signal.source && each.targetPort === child.eachOver);
    const items: Carried = over ? carried(over, frame, children, graph) : { known: false };
    if (!items.known || !Array.isArray(items.value) || items.value.length !== calls.length) return { known: false };
    return { known: true, value: calls.map((call) => field(call.output, signal.sourcePort)) };
  }

  if (calls.length === 0) return { known: false };
  return { known: true, value: field(calls[0]!.output, signal.sourcePort) };
}

/** A value short enough to sit on a wire. */
export function preview(value: unknown): string {
  if (value === undefined) return "nothing";
  if (value === null || typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "string") return JSON.stringify(value.length > 16 ? `${value.slice(0, 15)}…` : value);
  if (Array.isArray(value)) return `[${value.length}]`;
  return "{…}";
}

function nodeRun(calls: WatchedCall[]): { state: "running" | "paused" | "done" | "failed" | "stopped"; note: string } {
  const finished = calls.filter((call) => call.state === "returned").length;
  const has = (state: WatchedCall["state"]) => calls.some((call) => call.state === state);
  const state = has("paused") ? "paused" : has("threw") ? "failed" : has("stopped") ? "stopped" : has("running") ? "running" : "done";
  if (state === "paused" || state === "failed" || state === "stopped") return { state, note: state };
  return { state, note: calls.length > 1 ? `${finished} of ${calls.length}` : state };
}

function overlayFor(watch: Watch, graph: Graph): RunOverlay {
  const frame = frameOf(watch, ui.view);
  const children = childCalls(watch, graph, frame);
  const overlay: RunOverlay = { nodes: new Map(), buses: new Map() };

  for (const [key, calls] of children) overlay.nodes.set(key, nodeRun(calls));
  if (!frame) return overlay;

  if (graph.nodes.has("input")) overlay.nodes.set("input", { state: "done", note: "" });
  if (graph.nodes.has("output") && frame.state !== "running" && frame.state !== "paused") {
    const state = frame.state === "returned" ? "done" : frame.state === "stopped" ? "stopped" : "failed";
    overlay.nodes.set("output", { state, note: "" });
  }

  for (const bus of graph.buses.values()) {
    const values = bus.signals.map((signal) => carried(signal, frame, children, graph));
    if (!values.every((value) => value.known)) continue;
    const only = values.length === 1 ? (values[0] as { value: unknown }) : null;
    overlay.buses.set(bus.id, only ? `${bus.signals[0]!.targetPort} = ${preview(only.value)}` : `${bus.signals.length} signals`);
  }
  return overlay;
}

/** The buses a call's data travels along, for a call that can be seen from here. */
function pulsesFor(event: RunEvent, watch: Watch, graph: Graph): string[] {
  const frame = frameOf(watch, ui.view);
  const into = (key: string) => [...graph.buses.values()].filter((bus) => bus.target === key).map((bus) => bus.id);

  if (event.type === "call") {
    const call = watch.calls.get(event.id);
    if (!call || parentOf(call.block) !== ui.view || (frame && call.parent !== frame.id)) return [];
    return into(idOf(call.block));
  }
  if (event.type === "return" && frame && event.id === frame.id) return into("output");
  return [];
}

/** The call the run is really stopped at, waiting for the person. Null once it has moved on. */
function heldCall(watch: Watch | null): WatchedCall | null {
  if (!watch || watch.outcome || watch.heldId === null) return null;
  const call = watch.calls.get(watch.heldId);
  return call?.state === "paused" ? call : null;
}

function paint(pulses: string[] = []): void {
  const graph = graphInView();
  applyRunOverlay(ui.watch && graph ? overlayFor(ui.watch, graph) : null, pulses, heldCall(ui.watch) !== null);
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
  const from = ui.view;
  settle = window.setTimeout(() => {
    settle = undefined;
    if (ui.watch !== watch) return;
    // Still catching up: ask again once the events on hand have been shown.
    if (watch.played < watch.events.length) {
      followWhenSettled(watch);
      return;
    }
    // The person opened another diagram while the run was settling. They are
    // looking at something; the run has waited this long and can wait.
    if (ui.view !== from) return;
    const call = heldCall(watch);
    if (call) follow(watch, call.id);
  }, SETTLE_MS);
}

/** How long to linger on an event: long enough to see it, if it can be seen from the diagram on screen. */
function pace(event: RunEvent, watch: Watch): number {
  if (event.type === "paused" || event.type === "resumed") return 0;
  const block = event.type === "call" ? event.block : watch.calls.get(event.id)?.block;
  if (!block || (parentOf(block) !== ui.view && block !== ui.view)) return 0;
  return event.type === "call" ? 280 : 140;
}

/** Brings a call held at a breakpoint into view and selects it, so what is about to go into it can be read. */
function follow(watch: Watch, id: number): void {
  const call = watch.calls.get(id);
  if (!call) return;

  // Inside a block that ran more than once, show the run this call belongs to.
  const parent = call.parent === null ? undefined : watch.calls.get(call.parent);
  if (parent) watch.frames.set(parent.block, callsOf(watch, parent.block).indexOf(parent));

  const select = () => {
    ui.selection.clear();
    ui.selection.add(idOf(call.block));
    ui.selectedBus = null;
  };
  const diagram = parentOf(call.block);
  if (diagram !== ui.view) {
    openDiagram(diagram, select);
    return;
  }
  select();
  applySelection();
  paint();
  notify();
}

/** Plays the next event, and any after it that cannot be seen from here and so need no time. */
function playNext(watch: Watch): void {
  const graph = graphInView();
  const pulses: string[] = [];
  let played = 0;

  do {
    const event = watch.events[watch.played]!;
    watch.played += 1;
    played += 1;
    play(watch, event);
    if (graph) pulses.push(...pulsesFor(event, watch, graph));
  } while (watch.played < watch.events.length && pace(watch.events[watch.played]!, watch) === 0 && played < 500);

  paint(pulses);
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
  const delay = pace(watch.events[watch.played]!, watch) / Math.max(1, behind / 12);
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
 * Runs a block with the diagram following along. A composite is watched from
 * inside, where its children can be seen taking their turns. Resolves with
 * the outcome once the run ends.
 */
export async function runWatched(block: SnapshotBlock, input: unknown): Promise<Result<RunOutcome>> {
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
  if (block.kind === "composite" && ui.view !== block.path) openDiagram(block.path);
  else paint();

  const result = await window.fragmentor.watchRun({
    runId: watch.runId,
    dir: requireSnapshot().dir,
    blockPath: block.path,
    input,
    breakpoints: [...ui.breakpoints],
  });

  if (ui.watch === watch) {
    watch.outcome = result.ok
      ? result.value
      : { ok: false, error: result.error, inputProblems: [], outputProblems: [], logs: [], durationMs: 0 };
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
      el("p", "bench-note", watch ? "This block has not run in the run on the diagram." : "Run a block to watch the values flow through its diagram."),
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

/** What each wire of a bus carried in the run on the diagram. */
export function busWatchSection(bus: Bus, graph: Graph): HTMLElement | null {
  const watch = ui.watch;
  const frame = watch ? frameOf(watch, ui.view) : null;
  if (!watch || !frame) return null;

  const children = childCalls(watch, graph, frame);
  const node = section("In the run on the diagram", "watch-section");
  for (const signal of bus.signals) {
    const value = carried(signal, frame, children, graph);
    const part = subsection(`${signal.sourcePort} → ${signal.targetPort}`);
    part.append(
      value.known ? codeBlock(json(value.value), "json") : el("p", "bench-note", "Nothing has come down this wire yet."),
    );
    node.append(part);
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
