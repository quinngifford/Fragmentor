import { addressesOf, nextStep, placeEvent, project } from "../../src/model/trace.js";
import type { Address, Interaction, InteractionKind, Trace, TraceEvent } from "../../src/model/trace.js";
import type { SnapshotExecution } from "../../src/project/snapshot.js";
import type { TriggerKind } from "../../src/project/executions.js";
import { applyExecutionOverlay, fitToView, graphInView, openDiagram } from "./canvas.js";
import type { ExecutionEnd, ExecutionOverlay } from "./canvas.js";
import { PROJECT_VIEW, drawnAt } from "./graph.js";
import type { Graph } from "./graph.js";
import { selectedExecution, ui } from "./state.js";
import { el } from "./dom.js";

/**
 * An execution on the diagram.
 *
 * One execution is picked at a time, and it stays picked whichever diagram is
 * open: it is drawn at whatever resolution the canvas shows, each event at the
 * deepest block on screen that holds where it really happened. Stepping goes
 * to the next event that changes what is drawn, passing over what happens out
 * of sight inside a block, the way stepping over a call passes over what
 * happens inside it. Stepping in goes to the very next event, whatever it is,
 * and opens the diagram that shows it.
 */

let notify: () => void = () => {};
/** Called when picking an execution changes what the diagram has to draw. */
export function onExecutionChange(callback: () => void): void {
  notify = callback;
}

const parentOf = (path: string) => path.split("/").slice(0, -1).join("/");

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

/** What travelled, short enough for one line. The whole is in the detail. */
function carried(value: unknown, most = 70): string {
  if (value === undefined) return "";
  const text = JSON.stringify(value) ?? "";
  return `: ${text.length > most ? `${text.slice(0, most - 1)}…` : text}`;
}

const words = (kind: string) => kind.replace(/-/g, " ");

/** One event in words: the caption says it of the current step, and a line's detail of each step it stands for. */
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

/* -------------------------------------------------------------------------- */
/* On the diagram                                                              */
/* -------------------------------------------------------------------------- */

/**
 * An execution as the diagram on screen draws it, up to and including the
 * event at `at`, which is the current step; everything, with no current step,
 * when `at` is null.
 *
 * Every event the projection placed is given to whatever is drawn for its
 * place: a line between two nodes, a count on a node for what happened out of
 * sight inside it, or a chip for what it left behind. Several events between
 * the same two places on screen are one line with their number on it.
 */
export function overlayOf(graph: Graph, execution: SnapshotExecution, trace: Trace, at: number | null): ExecutionOverlay {
  const through = at ?? trace.events.length - 1;
  const projection = project(trace, graph.view, through);
  const currentEvent = at === null ? null : (trace.events[at] ?? null);
  const current = currentEvent ? placeEvent(currentEvent, graph.view) : null;
  const trigger = execution.trigger.kind;
  const say = (event: TraceEvent) => describeStep(event, trigger, 120);

  const overlay: ExecutionOverlay = {
    lines: [],
    effects: new Map(),
    inside: new Map(),
    involved: new Set(),
    current: new Set(),
    trigger,
  };

  // Lines are grouped by what is drawn at each end, not by where the
  // projection put them. A frame tile shows no rows, so two operations of the
  // block it stands for are one place on screen, and one line to it.
  const endKey = (end: ExecutionEnd | null) => (end === null ? "(outside)" : end.entry === null ? end.key : `${end.key}.${end.entry}`);
  const lineKey = (from: Address | null, to: Address) => {
    const drawnFrom = from === null ? null : drawnAt(graph, from);
    const drawnTo = drawnAt(graph, to);
    return drawnTo && (from === null || drawnFrom) ? { key: `${endKey(drawnFrom)}->${endKey(drawnTo)}`, from: drawnFrom, to: drawnTo } : null;
  };
  const currentLine = current?.on === "edge" ? (lineKey(current.from, current.to)?.key ?? null) : null;
  const order = new Map(trace.events.map((event, i) => [event, i]));

  const gathered = new Map<string, { from: ExecutionEnd | null; to: ExecutionEnd; interactions: Interaction[]; data: boolean }>();
  for (const edge of projection.edges.values()) {
    const ends = lineKey(edge.from, edge.to);
    if (!ends) continue;
    const line = gathered.get(ends.key) ?? { from: ends.from, to: ends.to, interactions: [], data: false };
    line.interactions.push(...edge.interactions);
    line.data ||= edge.carriesData;
    gathered.set(ends.key, line);
  }

  for (const [id, line] of gathered) {
    const interactions = line.interactions.sort((a, b) => order.get(a)! - order.get(b)!);
    const only = interactions.length === 1 ? interactions[0]! : null;
    overlay.lines.push({
      id,
      from: line.from,
      to: line.to,
      data: line.data,
      // What set it going is written at the mark it comes from, so its line needs no word of its own.
      label: only ? (only.kind === "trigger" ? "" : only.kind) : `×${interactions.length}`,
      detail: interactions.map(say).join("\n"),
      current: id === currentLine ? (currentEvent?.type === "return" ? "back" : "out") : null,
    });
  }

  for (const events of projection.inside.values()) {
    const placed = placeEvent(events[0]!, graph.view);
    const end = placed.on === "inside" ? drawnAt(graph, placed.at) : null;
    if (!end) continue;
    overlay.inside.set(end.key, {
      count: events.length,
      detail: events.map(say).join("\n"),
      current: current?.on === "inside" && current.key === placed.key,
    });
  }

  for (const effects of projection.effects.values()) {
    const placed = placeEvent(effects[0]!, graph.view);
    const end = placed.on === "effect" ? drawnAt(graph, placed.at) : null;
    if (!end) continue;
    const isCurrent = current?.on === "effect" && current.key === placed.key;
    const existing = overlay.effects.get(end.key) ?? { labels: [], detail: "", current: false };
    for (const effect of effects) {
      const label = words(effect.kind);
      if (!existing.labels.includes(label)) existing.labels.push(label);
    }
    existing.detail = [existing.detail, ...effects.map(say)].filter(Boolean).join("\n");
    existing.current ||= isCurrent;
    overlay.effects.set(end.key, existing);
  }

  for (const path of projection.involved) {
    const end = drawnAt(graph, { path, entry: null });
    if (end) overlay.involved.add(end.key);
  }

  if (current) {
    const places = current.on === "edge" ? [current.from, current.to] : [current.at];
    for (const place of places) {
      const end = place ? drawnAt(graph, place) : null;
      if (end) overlay.current.add(end.key);
    }
  }

  return overlay;
}

/**
 * The diagram that shows an event at the blocks it really happened at: the
 * one holding both its ends, so each is a block of its own there, or the one
 * holding the single place it happened.
 */
export function diagramFor(event: TraceEvent): string {
  const [first, second] = addressesOf(event).map((address) => address.path) as [string, string | undefined];
  if (second !== undefined && second !== first) {
    const a = first.split("/");
    const b = second.split("/");
    let shared = 0;
    while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared += 1;
    return a.slice(0, shared).join("/");
  }
  // Two entries of one block are both on its own diagram, where it is the frame.
  const block = ui.snapshot?.blocks[first];
  return second !== undefined && block && block.children.length > 0 ? first : parentOf(first) || PROJECT_VIEW;
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

/** Lays the execution over whatever diagram is on screen now, and brings its controls up to date. */
export function paintExecution(): void {
  const graph = graphInView();
  const shown = picked();
  // A project read again may have lost the execution, or events of it.
  if (ui.execution && !shown) ui.execution = null;
  if (ui.execution && shown?.trace && ui.execution.at !== null && ui.execution.at >= shown.trace.events.length) {
    ui.execution.at = null;
  }
  applyExecutionOverlay(graph && shown?.trace && ui.execution ? overlayOf(graph, shown.execution, shown.trace, ui.execution.at) : null);
  renderBar();
}

let playing: number | undefined;
const PLAY_MS = 900;

function stopPlaying(): void {
  if (playing !== undefined) window.clearInterval(playing);
  playing = undefined;
}

function choose(id: string | null): void {
  stopPlaying();
  ui.execution = id === null ? null : { id, at: null };
  // The block in focus may need its frame now, or no longer.
  notify();
  paintExecution();
  // Where it comes in from outside, and what it leaves, can reach past the blocks.
  if (!ui.userAdjusted) fitToView(true);
}

/** The event a step from here goes to, or null at the end. */
function following(into: boolean): number | null {
  const graph = graphInView();
  const trace = picked()?.trace;
  if (!graph || !trace || !ui.execution) return null;
  if (ui.execution.at === null) return 0;
  return nextStep(trace, graph.view, ui.execution.at, into);
}

function step(into: boolean): void {
  const trace = picked()?.trace;
  const graph = graphInView();
  const next = following(into);
  if (!trace || !graph || !ui.execution || next === null) return;
  ui.execution.at = next;
  // Stepping in to something hidden inside a block goes in far enough to see it.
  const event = trace.events[next]!;
  if (into && placeEvent(event, graph.view).on === "inside") openDiagram(diagramFor(event));
  paintExecution();
}

function play(): void {
  if (playing !== undefined) {
    stopPlaying();
    renderBar();
    return;
  }
  if (!ui.execution) return;
  if (following(false) === null || ui.execution.at === null) ui.execution.at = 0;
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

function jump(at: number | null): void {
  stopPlaying();
  if (!ui.execution) return;
  ui.execution.at = at;
  paintExecution();
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
  all: HTMLButtonElement;
  count: HTMLElement;
  caption: HTMLElement;
  reveal: HTMLButtonElement;
}

/** The bar as built, and what it was built for: the executions offered, and the one picked. */
let bar: { key: string; select: HTMLSelectElement; steps: StepControls | null } | null = null;
/** Where Show where goes, for the step on screen. */
let revealTo = PROJECT_VIEW;

/**
 * The bar above the diagram. It is built afresh only when what it offers
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
  select.title = "An execution to draw over the diagram: one run of the system, from what set it going";
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
    step: barButton("Step", "On to the next thing that changes on this diagram", () => {
      stopPlaying();
      step(false);
    }),
    into: barButton("Step into", "On to the very next thing that happened, going in to see it if it is out of sight", () => {
      stopPlaying();
      step(true);
    }),
    play: barButton("Play", "Step through it by itself", play),
    all: barButton("Show all", "Everything it did at once", () => jump(null)),
    count: el("span", "exec-count"),
    caption: el("span", "exec-caption-text"),
    reveal: barButton("Show where", "Open the diagram that shows this at the blocks it happened at", () => openDiagram(revealTo)),
  };
  steps.reveal.className = "exec-reveal";
  controls.append(steps.source, steps.restart, steps.step, steps.into, steps.play, steps.all, steps.count);
  const caption = el("div", "exec-caption");
  caption.append(steps.caption, steps.reveal);
  host.append(caption);
  return { key, select, steps };
}

function updateBar(built: NonNullable<typeof bar>, shown: ReturnType<typeof picked>): void {
  built.select.value = ui.execution?.id ?? "";
  const { steps } = built;
  const trace = shown?.trace;
  if (!steps || !shown || !trace || !ui.execution) return;

  steps.source.textContent = trace.source;
  steps.source.title = SOURCE_NOTES[trace.source];
  steps.source.dataset.source = trace.source;

  const at = ui.execution.at;
  steps.restart.disabled = at === 0;
  steps.step.disabled = at !== null && following(false) === null;
  steps.into.disabled = at !== null && following(true) === null;
  steps.play.textContent = playing === undefined ? "Play" : "Pause";
  steps.all.disabled = at === null;
  steps.count.textContent = at === null ? `${trace.events.length} steps` : `${at + 1} of ${trace.events.length}`;

  if (at === null) {
    steps.caption.textContent = shown.execution.description ?? `${shown.execution.name}, all of it.`;
    steps.caption.title = "";
    steps.reveal.hidden = true;
    return;
  }
  const event = trace.events[at]!;
  steps.caption.textContent = describeStep(event, shown.execution.trigger.kind);
  steps.caption.title = describeStep(event, shown.execution.trigger.kind, 4000);
  revealTo = diagramFor(event);
  steps.reveal.hidden = revealTo === ui.view;
}

/** A project was opened: nothing about the last one's executions carries over. */
export function resetExecutions(): void {
  stopPlaying();
  ui.execution = null;
  ui.expanded.clear();
}
