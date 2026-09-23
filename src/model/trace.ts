/**
 * What happened, kept apart from what exists.
 *
 * The block tree says what a system is made of: which parts exist and what
 * owns them. It says nothing about what runs when. A trace is the other half:
 * one run of the system from one trigger, as a list of everything that
 * happened, in order, across the whole architecture. An interaction can go
 * from any part to any other, up, down or across branches, because the tree
 * only ever meant ownership.
 *
 * A trace never depends on what is on screen. Every event names the real
 * component it happened at. How much of the architecture is expanded decides
 * only how finely the trace is drawn: `project` gathers events into whatever
 * is visible, and nothing is ever dropped from the trace to do it.
 */

/**
 * A place in the architecture: a component, by its path from the blocks
 * root, and optionally one of its entries — a table, a channel, an operation.
 *
 * Written `app/api/messaging` or `app/infrastructure/queue.publish`. Block ids
 * never contain a dot, so the first dot is always where the entry begins.
 *
 * Used as a pattern, an address without an entry stands for the component
 * and everything inside it; with an entry, for exactly that entry.
 */
export interface Address {
  path: string;
  entry: string | null;
}

export function formatAddress(address: Address): string {
  return address.entry === null ? address.path : `${address.path}.${address.entry}`;
}

/** Whether a path is this one or lies anywhere inside it. */
function isWithinPath(path: string, ancestor: string): boolean {
  return path === ancestor || path.startsWith(`${ancestor}/`);
}

/** Whether an address lies within a pattern: inside its subtree, or at exactly its entry. */
export function isInside(address: Address, within: Address): boolean {
  if (within.entry !== null) return address.path === within.path && address.entry === within.entry;
  return isWithinPath(address.path, within.path);
}

/* -------------------------------------------------------------------------- */
/* Events                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * What an interaction does. `trigger` is something outside the system setting
 * it going; `deliver` is a channel handing a message to whoever consumes it.
 */
export type InteractionKind = "trigger" | "call" | "read" | "write" | "remove" | "send" | "deliver";

export const INTERACTION_KINDS: InteractionKind[] = ["trigger", "call", "read", "write", "remove", "send", "deliver"];

/**
 * One part of the system reaching another.
 *
 * There is one kind of interaction, not one for data and one for signals.
 * Some carry something and some do not: a button press is only a trigger, a
 * write carries a row. Whether anything travelled is read off `payload` and
 * the matching return's `response`, and how that is drawn is the canvas's
 * business.
 */
export interface Interaction {
  type: "interaction";
  id: string;
  /** What this step is, in the words of whoever wrote the trace down. */
  description?: string;
  /**
   * The code that makes it: a file, and the function in it, written the way a
   * block's `code` is — `src/api/router.ts#handleSend`. What actually runs at
   * this step, which is the thing a diagram can never say by itself.
   */
  code?: string;
  /** The interaction that led to this one. Siblings with one cause are branches. */
  cause: string | null;
  /** Null when it came from outside the system: a person, a clock, another company's server. */
  from: Address | null;
  to: Address;
  kind: InteractionKind;
  /** What travelled along it. Left out when nothing did. */
  payload?: unknown;
}

/**
 * An interaction finishing, and whatever came back along it.
 *
 * Its own event rather than a field of the interaction, because it happens
 * later: after everything the interaction set off. A debugger that could not
 * stop at the moment a database read came back would be missing a step.
 *
 * It repeats the ends of the interaction it completes, as that interaction
 * wrote them, so every event carries its own place in the architecture. The
 * response travels from `to` back to `from`.
 */
export interface Return {
  type: "return";
  id: string;
  of: string;
  from: Address | null;
  to: Address;
  response?: unknown;
}

/**
 * Something observable that a run left behind: a row changed, a message
 * published, a response sent, a file written.
 *
 * An effect happens at the component responsible for it, and is drawn there,
 * but it is never a part of the architecture. It belongs to this run alone.
 */
export interface Effect {
  type: "effect";
  id: string;
  /** What this consequence is, in the words of whoever wrote the trace down. */
  description?: string;
  /** The code that leaves it behind, as a block's `code` is written. */
  code?: string;
  cause: string | null;
  at: Address;
  /** `row-changed`, `message-published`, `response`, `ui-changed`, ... Free text, as a subtype is. */
  kind: string;
  detail?: unknown;
}

export type TraceEvent = Interaction | Return | Effect;

/**
 * Where a trace came from.
 *
 * `recorded` is what Fragmentor saw happen when it ran the code. `declared`
 * is what an agent wrote down after reading the code: documentation of how
 * the system behaves, never evidence that it does. The two are never
 * confused, whatever else is done with a trace.
 */
export type TraceSource = "recorded" | "declared";

export interface Trace {
  source: TraceSource;
  /** The execution this is a trace of. */
  execution: string;
  /**
   * Every event, in the order it happened, starting with the trigger.
   * Nothing is ever left out of a recorded trace. A declared one has only
   * what its agent wrote down: a call finishes in it only where the agent
   * said what came back.
   */
  events: TraceEvent[];
  /** What each store held when the run ended, by target. Only a recorded run knows. */
  state?: Record<string, unknown>;
}

/**
 * Which way a step runs: what it leaves, and what it arrives at. Null for an
 * effect, which is left at one place and goes nowhere.
 *
 * An interaction runs the way it was made. A response runs back along it, out
 * of whoever was called and into whoever asked — the one place where an
 * event's two ends and its direction are not the same thing. Every drawing of
 * a trace asks this rather than working it out again, so no two of them can
 * disagree about which way an arrow points.
 */
export function travelOf(event: TraceEvent): { from: Address | null; to: Address | null } | null {
  if (event.type === "effect") return null;
  return event.type === "return" ? { from: event.to, to: event.from } : { from: event.from, to: event.to };
}

/** Where in the architecture an event happened: both ends of an interaction, or where an effect landed. */
export function addressesOf(event: TraceEvent): Address[] {
  if (event.type === "effect") return [event.at];
  return event.from === null ? [event.to] : [event.from, event.to];
}

/**
 * Whether something happened inside `within` — at either end of an
 * interaction, or where an effect landed — whether or not the run crossed
 * into it just then.
 */
export function activates(event: TraceEvent, within: Address): boolean {
  return addressesOf(event).some((address) => isInside(address, within));
}

/**
 * Whether the run crossed into `within` from outside it. A call from one
 * block to another inside the same component activates that component
 * without entering it. A response coming back is a return, not an entry.
 */
export function enters(event: TraceEvent, within: Address): boolean {
  return (
    event.type === "interaction" && isInside(event.to, within) && (event.from === null || !isInside(event.from, within))
  );
}

/* -------------------------------------------------------------------------- */
/* Drawing a trace at a resolution                                             */
/* -------------------------------------------------------------------------- */

/**
 * How much of the architecture is open.
 *
 * An expanded component shows its children and its entries. Anything whose
 * ancestors are all expanded is visible. The root — the project itself,
 * path "" — is always expanded, so a system's top block is always visible.
 *
 * Nothing here says which component is in focus. Focusing into a block
 * expands the chain down to it, but any other region can be expanded as
 * well, and the trace is drawn the same way whatever the combination.
 */
export interface View {
  expanded: ReadonlySet<string>;
  /**
   * Components drawn with their entries showing although their parts are not:
   * a database with its tables down its middle, a service with its
   * operations. Kept apart from `expanded`, because a service drawn with its
   * operations is still closed, and what happens inside it belongs to it.
   */
  entries?: ReadonlySet<string>;
}

/**
 * Where an address is drawn: at the deepest visible component that contains
 * it. An entry is kept only when its own component shows its entries, open or
 * not; otherwise the component stands for it, as it stands for everything
 * inside.
 */
export function place(address: Address, view: View): Address {
  const segments = address.path.split("/");
  let placed = segments[0]!;
  // A system's top block sits directly under the root, which is always
  // expanded, so it is always visible: the walk starts there.
  for (let depth = 1; depth < segments.length && view.expanded.has(placed); depth += 1) {
    placed = `${placed}/${segments[depth]}`;
  }
  if (placed !== address.path) return { path: placed, entry: null };
  return view.expanded.has(placed) || view.entries?.has(placed) ? address : { path: placed, entry: null };
}

/** Where one event shows at this resolution. */
export type Placement =
  /** An interaction, or its return, between two drawn places. */
  | { on: "edge"; key: string; from: Address | null; to: Address }
  /** An interaction, or its return, that starts and ends inside one drawn place. */
  | { on: "inside"; key: string; at: Address }
  /** An effect, on the drawn place responsible for it. */
  | { on: "effect"; key: string; at: Address };

/** Stands for outside the system in an edge's key. Brackets, so it can never be a block's path. */
const OUTSIDE = "(outside)";

export function placeEvent(event: TraceEvent, view: View): Placement {
  if (event.type === "effect") {
    const at = place(event.at, view);
    return { on: "effect", key: formatAddress(at), at };
  }
  const from = event.from === null ? null : place(event.from, view);
  const to = place(event.to, view);
  // Both ends drawn at one component is activity within it, whichever of its
  // entries either names: a service showing its operations is still one place,
  // and its way in handing a call to its router happens inside it.
  if (from !== null && from.path === to.path) {
    const at = { path: to.path, entry: null };
    return { on: "inside", key: formatAddress(at), at };
  }
  const fromKey = from === null ? OUTSIDE : formatAddress(from);
  return { on: "edge", key: `${fromKey}->${formatAddress(to)}`, from, to };
}

/**
 * The event to stop at after `after`, by its position in the trace.
 *
 * Stepping normally goes to the next event that changes what is drawn at
 * this resolution — a line or an effect — and passes over activity hidden
 * inside a collapsed component, the way stepping over a call passes over
 * what happens inside it. `into` goes to the very next event instead,
 * whatever it is, and whoever is showing the trace decides how to bring it
 * into view. Either way the events stepped past are still in the trace.
 */
export function nextStep(trace: Trace, view: View, after: number, into = false): number | null {
  for (let at = Math.max(0, after + 1); at < trace.events.length; at += 1) {
    if (into || placeEvent(trace.events[at]!, view).on !== "inside") return at;
  }
  return null;
}
