import { addressesOf, nextStep, placeEvent } from "../../src/model/trace.js";
import type { Address, InteractionKind, Trace, TraceEvent, View } from "../../src/model/trace.js";
import type { SnapshotExecution } from "../../src/project/snapshot.js";
import type { TriggerKind } from "../../src/project/executions.js";
import { applyExecutionMark, keepInView, treeInView } from "./canvas.js";
import type { ExecutionMark } from "./canvas.js";
import { shownAt } from "./tree.js";
import { selectedExecution, ui } from "./state.js";
import { el } from "./dom.js";

/**
 * An execution on the tree.
 *
 * The whole architecture is on screen, so an execution is not drawn over it
 * as a web: it is stepped through, one arrow at a time, between the two
 * blocks that step really joins. Nothing moves or opens as it goes, except
 * that a step hidden inside a folded block can be shown by unfolding it.
 *
 * The whole of an execution at once is a drawing of its own, not a diagram
 * of the architecture, so it lives somewhere else.
 */

let notify: () => void = () => {};
/** Called when picking an execution, or stepping it, changes what the panels say. */
export function onExecutionChange(callback: () => void): void {
  notify = callback;
}

/* -------------------------------------------------------------------------- */
/* In words                                                                    */
/* -------------------------------------------------------------------------- */

function placeName(address: Address | null): string {
  if (address === null) return "outside";
  const name = ui.snapshot?.blocks[address.path]?.name ?? address.path;
  return address.entry === null ? name : `${name} · ${address.entry}`;
}

const VERBS: Record<InteractionKind, string> = {
  trigger: "sets off",
  call: "calls",
  read: "reads",
  write: "writes",
  remove: "removes from",
  send: "sends to",
  deliver: "delivers to",
};

const ARRIVALS: Record<TriggerKind, string> = {
  action: "Someone uses",
  request: "A request arrives at",
  schedule: "The clock starts",
  message: "A message arrives at",
  webhook: "A webhook arrives at",
};

/** What travelled, short enough for one line. The whole of it is on the step's own page. */
function carried(value: unknown, most = 70): string {
  if (value === undefined) return "";
  const text = JSON.stringify(value) ?? "";
  return `: ${text.length > most ? `${text.slice(0, most - 1)}…` : text}`;
}

const words = (kind: string) => kind.replace(/-/g, " ");

/** One event in words, as the bar says it while stepping. */
export function describeStep(event: TraceEvent, trigger: TriggerKind, most?: number): string {
  if (event.type === "effect") return `${words(event.kind)} at ${placeName(event.at)}${carried(event.detail, most)}`;
  if (event.type === "return") {
    return event.response === undefined
      ? `${placeName(event.to)} finishes for ${placeName(event.from)}`
      : `${placeName(event.to)} gives back to ${placeName(event.from)}${carried(event.response, most)}`;
  }
  if (event.from === null) return `${ARRIVALS[trigger]} ${placeName(event.to)}${carried(event.payload, most)}`;
  return `${placeName(event.from)} ${VERBS[event.kind]} ${placeName(event.to)}${carried(event.payload, most)}`;
}

/** A word for the arrow itself: what kind of step it is. */
function stepWord(event: TraceEvent, trigger: TriggerKind): string {
  if (event.type === "return") return "gives back";
  if (event.type === "effect") return words(event.kind);
  return event.from === null ? trigger : event.kind;
}

/* -------------------------------------------------------------------------- */
/* On the tree                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * How much of the architecture is showing, in the terms the trace kernel
 * uses. Everything is expanded except what has been folded away, so an event
 * inside a folded block is gathered onto the block standing for it.
 */
export function shownView(): View {
  const paths = Object.keys(ui.snapshot?.blocks ?? {}).filter((path) => !ui.folded.has(path));
  return { expanded: new Set(["", ...paths]) };
}

/** One step of a trace as the tree draws it: an arrow between two blocks, or a mark at one. */
export function markFor(event: TraceEvent, trigger: TriggerKind): ExecutionMark | null {
  const tree = treeInView();
  if (!tree) return null;
  const placement = placeEvent(event, shownView());
  const label = stepWord(event, trigger);

  if (placement.on === "effect") {
    const at = shownAt(tree, placement.at.path);
    return at ? { from: null, to: at.path, label, data: false, back: false, effect: label } : null;
  }

  if (placement.on === "inside") {
    // Both ends are folded away into one block, which is all there is to show.
    const at = shownAt(tree, placement.at.path);
    return at ? { from: null, to: at.path, label, data: false, back: false, effect: `${label}, inside` } : null;
  }

  const to = shownAt(tree, placement.to.path);
  const from = placement.from === null ? null : shownAt(tree, placement.from.path);
  if (!to || (placement.from !== null && !from)) return null;
  const carriedSomething =
    (event.type === "interaction" && event.payload !== undefined) ||
    (event.type === "return" && event.response !== undefined);

  return {
    from: from?.path ?? null,
    to: to.path,
    label,
    data: carriedSomething,
    back: event.type === "return",
    effect: null,
  };
}

/* -------------------------------------------------------------------------- */
/* Stepping                                                                    */
/* -------------------------------------------------------------------------- */

/** The execution picked, with the trace there is to show of it. */
function picked(): { execution: SnapshotExecution; trace: Trace | null } | null {
  const execution = selectedExecution();
  if (!execution) return null;
  const trace = execution.declared && execution.declared.events.length > 0 ? execution.declared : null;
  return { execution, trace };
}

/** The step showing now, if an execution is being stepped through. */
export function currentStep(): { execution: SnapshotExecution; trace: Trace; at: number; event: TraceEvent } | null {
  const shown = picked();
  if (!shown?.trace || !ui.execution) return null;
  const at = Math.min(ui.execution.at, shown.trace.events.length - 1);
  const event = shown.trace.events[at];
  return event ? { execution: shown.execution, trace: shown.trace, at, event } : null;
}

/** Lays the step showing over the tree, and brings its controls up to date. */
export function paintExecution(): void {
  const shown = picked();
  // A project read again may have lost the execution it was showing.
  if (ui.execution && !shown) ui.execution = null;
  const step = currentStep();
  if (step && ui.execution) ui.execution.at = step.at;

  applyExecutionMark(step ? markFor(step.event, step.execution.trigger.kind) : null);
  renderBar();
}

let playing: number | undefined;
const PLAY_MS = 1100;

function stopPlaying(): void {
  if (playing !== undefined) window.clearInterval(playing);
  playing = undefined;
}

function choose(id: string | null): void {
  stopPlaying();
  ui.execution = id === null ? null : { id, at: 0 };
  paintExecution();
  notify();
}

/** The event a step from here goes to, or null at the end of the trace. */
function following(into: boolean): number | null {
  const step = currentStep();
  return step ? nextStep(step.trace, shownView(), step.at, into) : null;
}

function step(into: boolean): void {
  const next = following(into);
  const shown = picked();
  if (next === null || !shown?.trace || !ui.execution) return;
  ui.execution.at = next;

  const event = shown.trace.events[next]!;
  // Stepping in shows a step a fold has hidden, by unfolding what hides it.
  if (into) {
    for (const address of addressesOf(event)) {
      const segments = address.path.split("/");
      for (let depth = 1; depth <= segments.length; depth += 1) ui.folded.delete(segments.slice(0, depth).join("/"));
    }
  }

  notify();
  paintExecution();
  const mark = markFor(event, shown.execution.trigger.kind);
  if (mark) keepInView([mark.from, mark.to].filter((each): each is string => each !== null));
}

function play(): void {
  if (playing !== undefined) {
    stopPlaying();
    renderBar();
    return;
  }
  if (!ui.execution) return;
  if (following(false) === null) ui.execution.at = 0;
  paintExecution();
  playing = window.setInterval(() => {
    if (following(false) === null) {
      stopPlaying();
      renderBar();
      return;
    }
    step(false);
  }, PLAY_MS);
  renderBar();
}

function jump(at: number): void {
  stopPlaying();
  if (!ui.execution) return;
  ui.execution.at = at;
  paintExecution();
  notify();
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

const SOURCE_NOTES = {
  declared: "Written down by the agent from reading the code. Fragmentor has not seen it run.",
  recorded: "What Fragmentor saw happen when it ran the code.",
};

/** The controls for stepping through a trace, kept so they can be brought up to date rather than replaced. */
interface StepControls {
  source: HTMLElement;
  restart: HTMLButtonElement;
  step: HTMLButtonElement;
  into: HTMLButtonElement;
  play: HTMLButtonElement;
  count: HTMLElement;
  caption: HTMLElement;
}

/** The bar as built, and what it was built for: the executions offered, and the one picked. */
let bar: { key: string; select: HTMLSelectElement; steps: StepControls | null } | null = null;

/**
 * The bar above the tree. It is built afresh only when what it offers
 * changes; stepping, and playing above all, bring it up to date instead.
 * Replacing a button under the pointer loses the click on it, and replacing
 * the list closes it while it is open.
 */
function renderBar(): void {
  const host = document.getElementById("exec-bar");
  if (!host) return;
  const executions = ui.snapshot?.executions ?? [];
  host.hidden = executions.length === 0 || ui.waiting;
  if (host.hidden) {
    host.replaceChildren();
    bar = null;
    return;
  }

  const shown = picked();
  const key = JSON.stringify([executions.map((each) => [each.id, each.name]), ui.execution?.id ?? null, Boolean(shown?.trace)]);
  if (bar?.key !== key) bar = buildBar(host, key, executions, shown);
  updateBar(bar, shown);
}

function buildBar(
  host: HTMLElement,
  key: string,
  executions: SnapshotExecution[],
  shown: ReturnType<typeof picked>,
): NonNullable<typeof bar> {
  host.replaceChildren();
  const controls = el("div", "exec-controls");
  const select = el("select", "exec-select");
  select.title = "An execution to step through on the tree: one run of the system, from what set it going";
  select.append(new Option("No execution", ""));
  for (const execution of executions) select.append(new Option(execution.name, execution.id));
  select.addEventListener("change", () => choose(select.value === "" ? null : select.value));
  controls.append(select);
  host.append(controls);

  if (!shown) return { key, select, steps: null };
  if (!shown.trace) {
    controls.append(el("span", "exec-count", "nothing written down for it yet"));
    return { key, select, steps: null };
  }

  const steps: StepControls = {
    source: el("span", "exec-source"),
    restart: barButton("Restart", "Back to what set it going", () => jump(0)),
    step: barButton("Step", "On to the next step", () => {
      stopPlaying();
      step(false);
    }),
    into: barButton("Step into", "On to the very next thing that happened, unfolding whatever hides it", () => {
      stopPlaying();
      step(true);
    }),
    play: barButton("Play", "Step through it by itself", play),
    count: el("span", "exec-count"),
    caption: el("span", "exec-caption-text"),
  };
  controls.append(steps.source, steps.restart, steps.step, steps.into, steps.play, steps.count);
  const caption = el("div", "exec-caption");
  caption.append(steps.caption);
  host.append(caption);
  return { key, select, steps };
}

function updateBar(built: NonNullable<typeof bar>, shown: ReturnType<typeof picked>): void {
  built.select.value = ui.execution?.id ?? "";
  const { steps } = built;
  const step = currentStep();
  if (!steps || !shown?.trace || !step) return;

  steps.source.textContent = shown.trace.source;
  steps.source.title = SOURCE_NOTES[shown.trace.source];
  steps.source.dataset.source = shown.trace.source;

  steps.restart.disabled = step.at === 0;
  steps.step.disabled = following(false) === null;
  steps.into.disabled = following(true) === null;
  steps.play.textContent = playing === undefined ? "Play" : "Pause";
  steps.count.textContent = `${step.at + 1} of ${step.trace.events.length}`;

  const trigger = step.execution.trigger.kind;
  steps.caption.textContent = describeStep(step.event, trigger);
  steps.caption.title = describeStep(step.event, trigger, 4000);
}

/** A project was opened: nothing about the last one's executions carries over. */
export function resetExecutions(): void {
  stopPlaying();
  ui.execution = null;
  ui.folded.clear();
}
