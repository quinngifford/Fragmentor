import { addressesOf, nextStep, placeEvent, travelOf } from "../../src/model/trace.js";
import type { Address, InteractionKind, Trace, TraceEvent, View } from "../../src/model/trace.js";
import { addressOf, checkRecording } from "../../src/model/recorded.js";
import type { StepVerdict } from "../../src/model/recorded.js";
import type { SnapshotExecution } from "../../src/project/snapshot.js";
import type { TriggerKind } from "../../src/project/executions.js";
import type { NoteAnchor } from "../../src/project/notes.js";
import { applyExecutionMark, keepInView, onFlowWanted, onStepChosen, revealBlock, treeInView } from "./canvas.js";
import type { ExecutionMark } from "./canvas.js";
import { buildFlow, words } from "./flow.js";
import { shownAt } from "./tree.js";
import { recordingOf, requireSnapshot, selectedExecution, ui } from "./state.js";
import type { Recording } from "./state.js";
import { el, section, subsection } from "./dom.js";
import { codeBlock } from "./highlight.js";

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

/** What `ui.selectedLink` holds while the inspector is showing the step on screen. */
export const STEP_LINK = "step";

let notify: (options: { redraw: boolean }) => void = () => {};
/**
 * Called when picking an execution, or stepping it, changes what the panels
 * say. `redraw` is set only when the drawing itself has to be built again —
 * a different drawing, or blocks unfolded — because rebuilding it under the
 * pointer loses a click, a double-click and whatever had the keyboard.
 */
export function onExecutionChange(callback: (options: { redraw: boolean }) => void): void {
  notify = callback;
}

/* -------------------------------------------------------------------------- */
/* In words                                                                    */
/* -------------------------------------------------------------------------- */

function nameOfPlace(address: Address | null): string {
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

/**
 * Who set a trace going: what its trigger says for one written down, and null
 * for a recording, which Fragmentor started itself by running the code the
 * trigger leads to. Nobody pressed anything.
 */
type Start = TriggerKind | null;

const startOf = (execution: SnapshotExecution, trace: Trace): Start => (trace.source === "recorded" ? null : execution.trigger.kind);

/** What travelled, short enough for one line. The whole of it is on the step's own page. */
function carried(value: unknown, most = 70): string {
  if (value === undefined) return "";
  const text = JSON.stringify(value) ?? "";
  return `: ${text.length > most ? `${text.slice(0, most - 1)}…` : text}`;
}


/** One event in words, as the bar says it while stepping. */
export function describeStep(event: TraceEvent, start: Start, most?: number): string {
  // What a recording starts from, and answers at the end, is Fragmentor itself.
  const named = (address: Address | null) => (address === null && start === null ? "Fragmentor" : nameOfPlace(address));
  if (event.type === "effect") return `${words(event.kind)} at ${named(event.at)}${carried(event.detail, most)}`;
  if (event.type === "return") {
    if (event.error !== undefined) return `${named(event.to)} throws to ${named(event.from)}${carried(event.error, most)}`;
    return event.response === undefined
      ? `${named(event.to)} finishes for ${named(event.from)}`
      : `${named(event.to)} gives back to ${named(event.from)}${carried(event.response, most)}`;
  }
  if (event.from === null && start === null) {
    return `Fragmentor runs ${named(event.to)}${event.payload === undefined ? "" : ` with${carried(event.payload, most).slice(1)}`}`;
  }
  if (event.from === null) return `${ARRIVALS[start!]} ${named(event.to)}${carried(event.payload, most)}`;
  return `${named(event.from)} ${VERBS[event.kind]} ${named(event.to)}${carried(event.payload, most)}`;
}

/** A word for the arrow itself: what kind of step it is. */
function stepWord(event: TraceEvent, start: Start): string {
  if (event.type === "return") return event.error === undefined ? "gives back" : "throws";
  if (event.type === "effect") return words(event.kind);
  return event.from === null ? (start ?? "runs") : event.kind;
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
export function markFor(event: TraceEvent, trigger: Start): ExecutionMark | null {
  const tree = treeInView();
  if (!tree) return null;
  const view = shownView();
  const placement = placeEvent(event, view);
  const label = stepWord(event, trigger);
  // What it is in the agent's words, over what it does in Fragmentor's.
  const said = event.type === "return" ? undefined : event.description;
  const title = [said, describeStep(event, trigger, 400)].filter(Boolean).join("\n\n");

  // Something the run left behind, or a step whose two ends are both folded
  // away into one block: a mark at that block is all there is to show.
  if (placement.on !== "edge") {
    const at = shownAt(tree, placement.at.path);
    if (!at) return null;
    const effect = placement.on === "effect" ? label : `${label}, inside`;
    return { from: null, to: at.path, label, title, data: false, back: false, effect };
  }

  // The arrow runs the way the step does, so the block it points at is the one
  // the step arrives at. For an answer that is whoever asked, not whoever was
  // called, and `travelOf` is the one place that says so.
  const runs = travelOf(event);
  if (!runs) return null;
  const at = (address: Address | null) => (address === null ? null : shownAt(tree, address.path));
  const from = at(runs.from);
  const to = at(runs.to);
  if ((runs.from !== null && !from) || (runs.to !== null && !to)) return null;
  const carriedSomething =
    (event.type === "interaction" && event.payload !== undefined) ||
    (event.type === "return" && event.response !== undefined);

  return {
    from: from?.path ?? null,
    to: to?.path ?? null,
    label,
    title,
    data: carriedSomething,
    back: event.type === "return",
    effect: null,
  };
}

/* -------------------------------------------------------------------------- */
/* Stepping                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The execution picked, with the trace there is to show of it: the one asked
 * for, written down or recorded, or the other when there is only that.
 */
function picked(): { execution: SnapshotExecution; trace: Trace | null; written: Trace | null; recording: Recording | null } | null {
  const execution = selectedExecution();
  if (!execution) return null;
  const written = execution.declared && execution.declared.events.length > 0 ? execution.declared : null;
  const recording = recordingOf(execution);
  const trace = ui.execution?.trace === "recorded" ? (recording?.trace ?? written) : (written ?? recording?.trace ?? null);
  return { execution, trace, written, recording };
}

/** The step showing now, if an execution is being stepped through. */
export function currentStep(): { execution: SnapshotExecution; trace: Trace; at: number; event: TraceEvent } | null {
  const shown = picked();
  if (!shown?.trace || !ui.execution) return null;
  const at = Math.min(ui.execution.at, shown.trace.events.length - 1);
  const event = shown.trace.events[at];
  return event ? { execution: shown.execution, trace: shown.trace, at, event } : null;
}

let drawnMark: ExecutionMark | null = null;

/** The step as it was last drawn, for anything that has to know where it landed. */
function currentMark(): ExecutionMark | null {
  return drawnMark;
}

/** Lays the step showing over the tree, and brings its controls up to date. */
export function paintExecution(): void {
  const shown = picked();
  // A project read again may have lost the execution it was showing, and the
  // flow is a drawing of one: without it there is nothing to draw and no bar
  // to pick another from, so the tree comes back.
  if (ui.execution && !shown) {
    ui.execution = null;
    ui.shows = "tree";
  }
  const step = currentStep();
  if (step && ui.execution) ui.execution.at = step.at;

  // The flow is a drawing of the execution itself, so the step is marked on
  // it rather than laid over it.
  drawnMark = step && ui.shows === "tree" ? markFor(step.event, startOf(step.execution, step.trace)) : null;
  applyExecutionMark(drawnMark);
  renderBar();
}

/** Starts a recording of an execution, which the window hands in as it starts. Null where nothing can be recorded. */
let record: ((execution: SnapshotExecution) => void) | null = null;

/**
 * Called once, as the window starts: the canvas asks for the flow when it is
 * showing one. `recordIt` is how the bar's Record button records, which this
 * module cannot do itself, since it asks nothing of the main process. A page
 * that runs nothing passes null, and the bar then offers no recording at all.
 */
export function setUpExecutions(recordIt: ((execution: SnapshotExecution) => void) | null): void {
  record = recordIt;
  onFlowWanted(() => {
    const step = currentStep();
    if (!step) return null;
    const start = startOf(step.execution, step.trace);
    const verdicts = step.trace.source === "declared" ? verdictsOf(step.execution) : null;
    const notSeen = new Set(
      step.trace.events.flatMap((event, at) => (verdicts?.contradicted && verdicts.byStep.get(event.id)?.verdict === "not-seen" ? [at] : [])),
    );
    return {
      flow: buildFlow(step.trace, (event) => stepWord(event, start)),
      at: step.at,
      notSeen,
      // A recording starts with Fragmentor running the code, not with anything outside.
      name: (path) => (path === null ? (start === null ? "Fragmentor" : "Outside") : (ui.snapshot?.blocks[path]?.name ?? path)),
    };
  });
  onStepChosen((at) => {
    jump(at);
  });
}

let playing: number | undefined;
const PLAY_MS = 1100;

function stopPlaying(): void {
  if (playing !== undefined) window.clearInterval(playing);
  playing = undefined;
}

function choose(id: string | null): void {
  stopPlaying();
  const wasFlow = ui.shows === "flow";
  ui.execution = id === null ? null : { id, at: 0, trace: "declared" };
  // Nothing to draw a flow of without an execution.
  if (id === null) ui.shows = "tree";
  showStep();
  // The flow is a drawing of the execution picked, so picking another is a
  // different drawing, and picking none takes it away for the tree.
  notify({ redraw: wasFlow });
  paintExecution();
}

/** Puts the step itself in the inspector, which is what someone stepping through is reading. */
export function showStep(): void {
  if (!ui.execution) {
    if (ui.selectedLink === STEP_LINK) ui.selectedLink = null;
    return;
  }
  ui.selection.clear();
  ui.selectedLink = STEP_LINK;
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

  showStep();
  arrive(shown.trace.events[next]!, into);
}

/**
 * Shows the step just landed on: unfolding whatever hides it when asked to,
 * which is the one thing about stepping that changes the drawing, and
 * bringing the blocks it joins into view.
 */
function arrive(event: TraceEvent, unfold: boolean): void {
  let unfolded = false;
  if (unfold) {
    for (const address of addressesOf(event)) {
      const segments = address.path.split("/");
      for (let depth = 1; depth <= segments.length; depth += 1) {
        if (ui.folded.delete(segments.slice(0, depth).join("/"))) unfolded = true;
      }
    }
  }
  notify({ redraw: unfolded || ui.shows === "flow" });
  paintExecution();
  keepStepInView();
}

/** Brings the blocks the step showing joins into view, when they are off screen. */
export function keepStepInView(): void {
  const mark = currentMark();
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

/**
 * Goes to one step of an execution from anywhere: a note left on that step,
 * the first step a recording contradicts, or the recorded step a written one
 * was seen as. The step is found by its id, which outlives steps added
 * before it, and whatever folds hide it are opened. False when the execution
 * or the step is no longer there.
 */
export function goToStep(executionId: string, stepId: string, trace: "declared" | "recorded" = "declared"): boolean {
  const execution = ui.snapshot?.executions.find((each) => each.id === executionId);
  const events = (execution && (trace === "declared" ? execution.declared : recordingOf(execution)?.trace))?.events ?? [];
  const at = events.findIndex((each) => each.id === stepId);
  if (at === -1) return false;
  stopPlaying();
  ui.execution = { id: executionId, at, trace };
  ui.showInspector = true;
  showStep();
  arrive(events[at]!, true);
  return true;
}

/**
 * A recording of an execution has just been made. The bar turns to it, from
 * its first step, if the person is still on that execution; otherwise it is
 * there for when they come back to it.
 */
export function showRecording(id: string): void {
  if (ui.execution?.id !== id) {
    renderBar();
    return;
  }
  stopPlaying();
  ui.execution = { id, at: 0, trace: "recorded" };
  showStep();
  notify({ redraw: ui.shows === "flow" });
  paintExecution();
}

/** Shows the other trace of the execution picked, from its first step: the two are different runs, step for step. */
function showTrace(trace: "declared" | "recorded"): void {
  if (!ui.execution || ui.execution.trace === trace) return;
  stopPlaying();
  ui.execution = { ...ui.execution, at: 0, trace };
  showStep();
  notify({ redraw: ui.shows === "flow" });
  paintExecution();
}

function jump(at: number): void {
  stopPlaying();
  if (!ui.execution) return;
  ui.execution.at = at;
  showStep();
  notify({ redraw: ui.shows === "flow" });
  paintExecution();
}

/* -------------------------------------------------------------------------- */
/* Controls                                                                    */
/* -------------------------------------------------------------------------- */

export function barButton(label: string, title: string, action: () => void): HTMLButtonElement {
  const button = el("button", "run-btn", label);
  button.type = "button";
  button.title = title;
  button.addEventListener("click", action);
  return button;
}

const SOURCE_NOTES = {
  declared: "Written down by the agent from reading the code. Fragmentor has not seen it run.",
  recorded:
    "What Fragmentor saw when it ran the code answering this execution's trigger, with stores of its own standing in for the real ones. It starts at that code: nothing before it ran.",
};

const SOURCE_WORDS = { declared: "Written down", recorded: "Recorded" };

/** The controls for stepping through a trace, kept so they can be brought up to date rather than replaced. */
interface StepControls {
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
  const key = JSON.stringify([
    executions.map((each) => [each.id, each.name, each.records, each.unrecordable]),
    ui.execution?.id ?? null,
    shown?.trace?.source ?? null,
    Boolean(shown?.written),
    shown?.recording?.at ?? null,
    ui.shows,
    // What the recording says of the steps written down changes as the agent edits them.
    shown ? agreementOf(shown.execution) : null,
  ]);
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
  // An invitation to pick one, not a report that none is picked.
  select.append(new Option("Executions…", ""));
  for (const execution of executions) select.append(new Option(execution.name, execution.id));
  select.addEventListener("change", () => choose(select.value === "" ? null : select.value));
  controls.append(select);
  host.append(controls);

  if (!shown) return { key, select, steps: null };

  // Offered whatever is written down, and most of all where nothing is.
  const { execution } = shown;
  const runs = execution.records === null ? null : (ui.snapshot?.blocks[execution.records]?.name ?? execution.records);
  const recordButton = barButton(
    shown.recording ? "Record again" : "Record",
    runs === null
      ? (execution.unrecordable ?? "")
      : `Run ${runs} with what this execution starts from, and see what the code really does. Nothing is saved.`,
    // The file can change without the bar being built again, and a recording
    // of what it said before would be let go of as soon as it was made.
    () => {
      const now = selectedExecution();
      if (now) record?.(now);
    },
  );
  recordButton.disabled = runs === null;
  const recording = record !== null;
  // Why not is said where it can be read, not only when the button is hovered.
  if (recording && execution.unrecordable) host.append(el("div", "exec-why", execution.unrecordable));

  if (!shown.trace) {
    if (recording) controls.append(recordButton);
    controls.append(el("span", "exec-count", "nothing written down for it yet"));
    return { key, select, steps: null };
  }

  // Either drawing: the architecture with the step on it, or the execution
  // itself from beginning to end.
  const shows = el("div", "exec-shows");
  for (const [mode, label, title] of [
    ["tree", "Tree", "The architecture, with this step drawn on it"],
    ["flow", "Flow", "This execution from beginning to end, as its own drawing"],
  ] as const) {
    const chip = el("button", "chip", label);
    chip.type = "button";
    chip.title = title;
    chip.setAttribute("aria-pressed", String(ui.shows === mode));
    chip.addEventListener("click", () => {
      if (ui.shows === mode) return;
      ui.shows = mode;
      // The other drawing has to be built.
      notify({ redraw: true });
    });
    shows.append(chip);
  }
  controls.append(shows);

  // Which trace is on screen: the agent's, or what Fragmentor saw. Never left
  // to be guessed — so where nothing can be recorded, the one chip still says
  // the trace was written down.
  const sources = el("div", "exec-shows");
  for (const trace of recording ? (["declared", "recorded"] as const) : (["declared"] as const)) {
    const there = trace === "declared" ? shown.written !== null : shown.recording !== null;
    const chip = el("button", "chip exec-source", SOURCE_WORDS[trace]);
    chip.type = "button";
    chip.dataset.source = trace;
    chip.title = there ? SOURCE_NOTES[trace] : trace === "declared" ? "Nothing is written down for it yet." : "Press Record to see what the code really does.";
    chip.disabled = !there;
    chip.setAttribute("aria-pressed", String(shown.trace.source === trace));
    chip.addEventListener("click", () => showTrace(trace));
    sources.append(chip);
  }
  controls.append(sources);
  if (recording) controls.append(recordButton);
  const agreement = agreementOf(execution);
  if (agreement) controls.append(agreementPill(agreement));

  const steps: StepControls = {
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
  controls.append(steps.restart, steps.step, steps.into, steps.play, steps.count);
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

  steps.restart.disabled = step.at === 0;
  steps.step.disabled = following(false) === null;
  steps.into.disabled = following(true) === null;
  steps.play.textContent = playing === undefined ? "Play" : "Pause";
  steps.count.textContent = `${step.at + 1} of ${step.trace.events.length}`;

  const start = startOf(step.execution, step.trace);
  steps.caption.textContent = describeStep(step.event, start);
  steps.caption.title = describeStep(step.event, start, 4000);
}

/**
 * How the steps written down came out against the recording, for the bar:
 * what it says, the counts behind it, and the first step it contradicts.
 * Null unless there is both a trace written down and a recording of it.
 */
interface Agreement {
  execution: string;
  text: string;
  title: string;
  /** Whether the recording saw any step written down at all: with none, nothing it says reads as agreeing. */
  anySeen: boolean;
  /** The first step written down that the recording contradicts, if any. */
  first: string | null;
  /** Anything else wrong that only the recording's own page shows: an expectation it failed. */
  failed: number;
}

const counted = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

function agreementOf(execution: SnapshotExecution): Agreement | null {
  const verdicts = verdictsOf(execution);
  if (!verdicts) return null;
  const { check, contradicted } = verdicts;
  const count = (verdict: string) => check.steps.filter((step) => step.verdict === verdict).length;
  // What set the execution going is never in a recording, and its page says
  // it cannot be checked, so it is counted here as its page counts it.
  const triggers = execution.declared!.events.filter((event) => event.type === "interaction" && event.kind === "trigger").length;
  const seen = count("seen");
  // A step missing from a run that was cut short may just not have happened yet.
  const notSeen = contradicted ? count("not-seen") : 0;
  const unchecked = triggers + count("unchecked") + (contradicted ? 0 : count("not-seen"));
  const failed = check.expectations.failures.length;

  const wrong = [
    notSeen > 0 ? `${counted(notSeen, "step")} not seen` : "",
    failed > 0 ? `${counted(failed, "expectation")} failed` : "",
  ].filter(Boolean);
  // Agreeing is said only of steps the recording saw: with none seen, the
  // recording has confirmed nothing, whatever else it did.
  const text =
    wrong.length > 0
      ? wrong.join(", ")
      : seen === 0
        ? contradicted
          ? "Nothing written down could be checked from this run"
          : "The recording stopped before it saw any step"
        : !contradicted
          ? "Agrees as far as the recording went"
          : "Agrees with the recording, where it could see";
  // Answers go with the calls they answer, and their pages repeat their calls' verdicts, so they are not counted twice.
  const title = [
    `Of the ${counted(seen + notSeen + unchecked, "step")} written down, not counting answers, ${seen} seen, ${notSeen} not seen, and ${unchecked} that cannot be checked from this run.`,
    notSeen > 0
      ? "Click to go to the first step not seen."
      : failed > 0
        ? "Click to see the recording, whose page says what failed."
        : "Each step's own page says what the recording saw of it.",
  ].join(" ");
  const first = contradicted ? (check.steps.find((step) => step.verdict === "not-seen")?.id ?? null) : null;
  return { execution: execution.id, text, title, anySeen: seen > 0, first, failed };
}

/**
 * The verdict on the bar: quiet when the recording agrees, dim when it saw
 * nothing to agree with, and red and a way to the trouble when it disagrees.
 */
function agreementPill(agreement: Agreement): HTMLElement {
  if (agreement.first === null && agreement.failed === 0) {
    const quiet = el("span", "exec-verdict", agreement.text);
    quiet.title = agreement.title;
    if (!agreement.anySeen) quiet.dataset.none = "true";
    return quiet;
  }
  const { execution, first } = agreement;
  const pill = el("button", "chip exec-verdict", agreement.text);
  pill.type = "button";
  pill.dataset.bad = "true";
  pill.title = agreement.title;
  pill.addEventListener("click", () => (first === null ? showTrace("recorded") : goToStep(execution, first)));
  return pill;
}

/* -------------------------------------------------------------------------- */
/* The step's own page                                                         */
/* -------------------------------------------------------------------------- */

/**
 * One step of an execution: what it is, which blocks it joins, what it
 * carried, and the code that makes it happen.
 *
 * The step is the thing being read while someone is stepping through, so it
 * has a page of its own rather than a line in the bar above the tree.
 */
export function stepPage(
  panel: HTMLElement,
  actions: {
    noteOn?: (blockPath: string, on: NoteAnchor, text?: string) => void;
    openCode?: (pointer: string, title: string) => void;
    problemsListed?: boolean;
  },
): boolean {
  const { noteOn, openCode, problemsListed } = actions;
  const step = currentStep();
  if (!step) return false;
  const snapshot = requireSnapshot();
  const { event, execution } = step;
  const recorded = step.trace.source === "recorded";
  const trigger = startOf(execution, step.trace);

  const head = el("div", "insp-head");
  head.append(
    el("h2", undefined, `Step ${step.at + 1} of ${step.trace.events.length}`),
    el("div", "insp-id", `${execution.name} · ${SOURCE_WORDS[step.trace.source].toLowerCase()}`),
  );
  panel.append(head);

  // What the agent said about this step, and failing that, what it does.
  const said = event.type === "return" ? undefined : event.description;
  panel.append(el("p", "responsibility", said ?? describeStep(event, trigger, 400)));
  if (said) panel.append(el("p", "bench-note", describeStep(event, trigger, 400)));
  if (event.type === "return" && event.error !== undefined) panel.append(el("p", "bench-note bad", `Threw: ${event.error}`));

  // A note on a step goes on the block the step leaves, whose code makes it,
  // as the guide tells the agent a step's code is. A recorded step is in no
  // file the agent could find it by, so a note is left on a written one.
  const ends = event.type === "effect" ? null : (travelOf(event) ?? event);
  const leaves = event.type === "effect" ? event.at : (ends?.from ?? ends?.to ?? null);
  const verdict = recorded ? null : verdictOn(execution, event);
  // A step a recording contradicts is what a note is most often for, so the
  // note starts off with what the recording found, for the agent to read.
  const contradiction =
    verdict?.verdict.verdict === "not-seen" && verdict.contradicted
      ? `When Fragmentor recorded this execution, this step was not seen. ${verdict.verdict.reason ?? ""}`.trim()
      : undefined;
  if (noteOn && !recorded && leaves && snapshot.blocks[leaves.path]) {
    const note = el("button", "btn quiet tiny", "Leave a note on this step");
    note.title = `A note for your coding agent about this step, on ${snapshot.blocks[leaves.path]!.name}.`;
    note.addEventListener("click", () =>
      noteOn(
        leaves.path,
        { execution: execution.id, step: event.id, description: said ?? describeStep(event, trigger, 200) },
        contradiction,
      ),
    );
    panel.append(note);
  }
  if (verdict) panel.append(verdictSection(execution.id, verdict));

  // "Where", not "between": an effect happens at one block rather than
  // between two, and this is the section that says so for both.
  const where = section("Where");
  const list = el("div", "ports");
  let missing = false;
  const place = (label: string, address: { path: string; entry: string | null } | null) => {
    const row = el("div", "port-row");
    row.append(el("div", "pname", label));
    if (address === null) {
      // Nobody set a recording going: Fragmentor ran the code, in place of whatever does.
      row.append(el("div", "ptype", recorded ? "Fragmentor, from outside the system" : "outside the system"));
    } else {
      if (!snapshot.blocks[address.path]) missing = true;
      const block = snapshot.blocks[address.path];
      const where = el("div", "pwhere");
      where.append(
        el("span", "ptype", address.entry === null ? (block?.name ?? address.path) : `${block?.name ?? address.path} · ${address.entry}`),
      );
      const show = el("button", "btn quiet tiny", "Show");
      show.addEventListener("click", () => revealBlock(address.path));
      where.append(show);
      row.append(where);
    }
    list.append(row);
  };

  if (event.type === "effect") {
    place("at", event.at);
  } else {
    // The same way round as the arrow on the drawing and the words under it:
    // an answer leaves whoever was called and arrives at whoever asked.
    const runs = travelOf(event) ?? event;
    place("from", runs.from);
    place("to", runs.to);
    const kind = el("div", "port-row");
    kind.append(el("div", "pname", "kind"), el("div", "ptype", event.type === "return" ? "gives back" : event.kind));
    list.append(kind);
  }
  where.append(list);
  panel.append(where);

  // Nothing is drawn for a step whose block has been taken out of the
  // project, and the tree saying nothing would be the only sign of it.
  if (missing) {
    panel.append(
      el(
        "p",
        "bench-note bad",
        `This step names a block that is not in the project, so there is nothing to draw it between.${problemsListed ? " The problems list says which." : ""}`,
      ),
    );
  }

  const carried =
    event.type === "effect" ? event.detail : event.type === "return" ? event.response : event.payload;
  if (carried !== undefined) {
    const what = section(event.type === "return" ? "What came back" : "What it carried");
    what.append(codeBlock(JSON.stringify(carried, null, 2) ?? "", "json"));
    panel.append(what);
  }

  // An answer comes back out of the call it answers, so that call's function
  // is the one it returns from.
  const answers = event.type === "return" ? step.trace.events.find((each) => each.id === event.of) : undefined;
  const pointer = event.type === "return" ? (answers?.type === "interaction" ? answers.code : undefined) : event.code;
  const code = section("Code");
  if (pointer === undefined) {
    code.append(el("p", "bench-note", "This step does not say which function makes it."));
  } else {
    code.append(el("div", "code-where", pointer));
    code.append(
      el("p", "bench-note", event.type === "return" ? "The function this answer comes back from." : "The function that makes this step."),
    );
    if (openCode) {
      const open = el("button", "btn", "Open the code");
      open.addEventListener("click", () => openCode(pointer, `Step ${step.at + 1}: ${execution.name}`));
      code.append(open);
    }
  }
  panel.append(code);

  if (step.trace.source === "declared") {
    panel.append(
      el(
        "p",
        "bench-note",
        verdict
          ? "Written down by the agent from reading the code. What Fragmentor saw when it ran the code is above."
          : "Written down by the agent from reading the code. Fragmentor has not seen it run.",
      ),
    );
  }
  const recording = recorded ? recordingOf(execution) : null;
  if (recording) panel.append(recordingSection(execution, recording));
  return true;
}

/** What sets an execution going, in words, with no full stop. */
function triggerWords(execution: SnapshotExecution): string {
  if (execution.trigger.description) return execution.trigger.description.replace(/\.$/, "");
  return `${ARRIVALS[execution.trigger.kind]} ${nameOfPlace(addressOf(execution.trigger.at))}`;
}

/**
 * Each recording held to the execution as it was last read. The page is drawn
 * again at every step, and holding a long recording to it every time would
 * slow stepping through it; a project read again gives the execution new
 * objects, so the check is worked out again whenever the file changes.
 */
const checks = new WeakMap<Recording, { of: SnapshotExecution; check: ReturnType<typeof checkRecording> }>();

function checkOf(execution: SnapshotExecution, recording: Recording): ReturnType<typeof checkRecording> {
  const kept = checks.get(recording);
  if (kept?.of === execution) return kept.check;
  const check = checkRecording(execution, recording.trace, recording.scope, recording.complete);
  checks.set(recording, { of: execution, check });
  return check;
}

/**
 * What the recording of an execution says of each step written down about
 * it, or null unless there are both. `contradicted` is false for a recording
 * that ended before the run did, where a step not seen may just not have
 * happened yet, and so is no contradiction.
 */
function verdictsOf(
  execution: SnapshotExecution,
): { check: ReturnType<typeof checkRecording>; byStep: Map<string, StepVerdict>; contradicted: boolean; recording: Recording } | null {
  const recording = recordingOf(execution);
  if (!recording || !execution.declared || execution.declared.events.length === 0) return null;
  const check = checkOf(execution, recording);
  return { check, byStep: new Map(check.steps.map((step) => [step.id, step])), contradicted: recording.complete, recording };
}

/**
 * What the recording says of one step written down, in words: seen, not
 * seen and why, or cannot be checked and why. An answer is held to the
 * recording with the call it answers, and what set the execution going is
 * never in a recording, which starts at the code it runs.
 */
function verdictOn(execution: SnapshotExecution, event: TraceEvent): { verdict: StepVerdict; answer: boolean; contradicted: boolean } | null {
  const verdicts = verdictsOf(execution);
  if (!verdicts) return null;
  const { byStep, contradicted, recording } = verdicts;
  if (event.type === "interaction" && event.kind === "trigger") {
    // The kernel's own reason for a trigger it is asked to find, worded with
    // the block's name rather than its path; the two should say the same.
    const runs = nameOfPlace({ path: recording.scope.runs, entry: null });
    const reason = `The recording starts at ${runs}, so it cannot see what set the execution going.`;
    return { verdict: { id: event.id, verdict: "unchecked", reason }, answer: false, contradicted };
  }
  const verdict = byStep.get(event.type === "return" ? event.of : event.id);
  return verdict ? { verdict, answer: event.type === "return", contradicted } : null;
}

/**
 * On a step written down, what the recording says of it, in one line: the
 * person reading the step is told whether the code really does it, and where
 * the run could not see, that it cannot say, rather than anything that reads
 * as agreeing.
 */
function verdictSection(executionId: string, on: NonNullable<ReturnType<typeof verdictOn>>): HTMLElement {
  const node = section("In the recording");
  const { verdict, answer, contradicted } = on;
  // An answer has no verdict of its own: it was held to the recording with its call.
  const lead = answer ? "With the call it answers: " : "";
  const line = (text: string, bad = false) => {
    const p = el("p", bad ? "bench-note bad" : "bench-note", `${lead}${text}`);
    p.dataset.verdict = verdict.verdict;
    return p;
  };
  if (verdict.verdict === "seen") {
    node.append(line("Seen. The code really did this when Fragmentor ran it."));
    const seenAs = verdict.seenAs;
    if (seenAs !== undefined) {
      const show = el("button", "btn quiet tiny", "Show in the recording");
      show.title = "Go to the step Fragmentor saw that this one is.";
      show.addEventListener("click", () => goToStep(executionId, seenAs, "recorded"));
      node.append(show);
    }
  } else if (verdict.verdict === "not-seen") {
    node.append(contradicted ? line(`Not seen. ${verdict.reason ?? ""}`.trim(), true) : line(`Not seen yet. ${verdict.reason ?? ""}`.trim()));
  } else {
    node.append(line(`Cannot be checked from this run, so it counts neither as seen nor as not seen. ${verdict.reason ?? ""}`.trim()));
  }
  return node;
}

/**
 * How a recording was made and how it came out: what it started from, how
 * the run ended, and what the execution says must happen held to it.
 *
 * What was written down can change after the recording was made, so this is
 * held to the execution as it is now, never as it was when the recording was made.
 */
function recordingSection(execution: SnapshotExecution, recording: Recording): HTMLElement {
  const node = section("Recording");
  const runs = nameOfPlace({ path: recording.scope.runs, entry: null });
  const check = checkOf(execution, recording);
  const note = (text: string, bad = false) => el("p", bad ? "bench-note bad" : "bench-note", text);

  node.append(
    note(
      `Made at ${new Date(recording.at).toLocaleTimeString()} by running ${runs} with what this execution starts from. The stores it used were Fragmentor's own, standing in for the real ones, and nothing is saved.`,
    ),
    note(`It starts at ${runs}, in place of what sets it going: ${triggerWords(execution)}. Nothing before ${runs} ran.`),
  );
  if (check.notSeeded.length > 0) {
    node.append(note(`Starting rows it had no way to put in, so it ran without them: ${check.notSeeded.join(", ")}.`));
  }

  const first = recording.trace.events[0];
  const ended = recording.trace.events.find((event) => event.type === "return" && first !== undefined && event.of === first.id);
  if (recording.stopped) node.append(note("It was stopped before the run ended, so what did not happen may just not have happened yet."));
  else if (recording.truncated) node.append(note("The run made more calls than are recorded, so the end of it was not heard."));
  else if (ended?.type === "return" && ended.error !== undefined) node.append(note(`${runs} threw: ${ended.error}`, true));
  else node.append(note(`${runs} returned.`));

  if (execution.expect === null) {
    node.append(note("This execution does not say what must happen, so there is nothing to hold the recording to."));
    return node;
  }
  const { met, failures, setAside } = check.expectations;
  if (failures.length > 0) {
    const failed = subsection("Failed", "bad");
    failed.append(...failures.map((failure) => note(failure, true)));
    node.append(failed);
  }
  if (met.length > 0) {
    const shown = subsection("Met", "good");
    shown.append(...met.map((each) => note(each)));
    node.append(shown);
  }
  if (setAside.length > 0) {
    const aside = subsection("Set aside");
    aside.append(note("What this recording could not see. None of it counts as met."));
    aside.append(...setAside.map(({ expectation, why }) => note(`${expectation}: ${why}`)));
    node.append(aside);
  }
  return node;
}

/** A project was opened: nothing about the last one's executions carries over, its recordings included. */
export function resetExecutions(): void {
  stopPlaying();
  ui.execution = null;
  ui.recordings.clear();
  ui.folded.clear();
  ui.shows = "tree";
}
