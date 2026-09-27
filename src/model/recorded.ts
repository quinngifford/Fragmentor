import { formatAddress, isInside } from "./trace.js";
import type { Address, Interaction, Trace, TraceEvent } from "./trace.js";
import { describeWanted, describeWantedEffect, evaluate } from "../run/expect.js";
import type { EffectExpectation, Expectations, InteractionExpectation } from "../run/expect.js";

/**
 * A recording: what Fragmentor saw when it ran the code an execution leads to,
 * and how that compares with what was written down about it.
 *
 * Fragmentor runs the function block that answers an execution's trigger,
 * with the trigger's payload as its input and the execution's starting rows in
 * stand-in stores, and hears every call between the blocks it ran and every
 * read, write, remove and send on those stores. That is all a recording ever
 * holds. It starts at the block it ran, so nothing that led there is in it,
 * and nothing is filled in from the diagram: where the run could not see, the
 * comparison says so rather than counting it either way.
 *
 * This is kept free of anything but other plain modules, so the window can
 * turn a run into a trace and compare it without asking the main process.
 */

/** One report from the harness about a watched run, as a recording reads it. `src/run/harness.cjs` sends them. */
export type HeardEvent =
  | { type: "call"; id: number; parent: number | null; block: string; input: unknown }
  | { type: "return"; id: number; output: unknown }
  | { type: "throw"; id: number; error: string }
  | {
      type: "store";
      id: number;
      parent: number | null;
      target: string;
      op: "read" | "list" | "write" | "remove" | "send";
      key?: string;
      value: unknown;
    }
  | { type: "paused" | "resumed"; id: number };

/** What the stores were left holding when the run ended, by target, as a run reports it. */
export interface HeardOutcome {
  stores: Record<string, { kind: "store"; rows: Record<string, unknown> } | { kind: "queue"; sent: unknown[] }>;
}

/**
 * What one recording could see, as plain data. Everything is named as an
 * address is written: `tickets/booking-api/book-seats`, `tickets/tickets-db.events`.
 */
export interface RecordingScope {
  /** The function block the run starts at: the one answering the trigger. */
  runs: string;
  /** Every function block whose calls the run could see, with the code it is: `src/booking/reserve.ts#reserve`. */
  blocks: Record<string, string>;
  /** Every store and queue entry the run stood in for. */
  stores: string[];
  /** The operations `runs` answers. What it returns is their response, by the diagram's own definition. */
  answers: string[];
  /**
   * Everything on the diagram the run could not see: function blocks it did
   * not run, entries it did not stand in for, and parts with nothing in them
   * to see. Something not happening there proves nothing.
   */
  unseen: string[];
}

/** The id a trace gives the trigger that starts it. */
const TRIGGER = "trigger";

const INTERACTION_OF = { read: "read", list: "read", write: "write", remove: "remove", send: "send" } as const;
const EFFECT_OF: Partial<Record<keyof typeof INTERACTION_OF, string>> = {
  write: "row-changed",
  remove: "row-removed",
  send: "message-published",
};

/** The only effects a recording can leave. Any other kind, such as `ui-changed`, it can never see. */
const RECORDED_EFFECTS = ["row-changed", "row-removed", "message-published", "response"];

/** Reads an address as it is written: the first dot, if any, is where the entry begins. */
function addressOf(text: string): Address {
  const dot = text.indexOf(".");
  return dot === -1 ? { path: text, entry: null } : { path: text.slice(0, dot), entry: text.slice(dot + 1) };
}

const blockAt = (path: string): Address => ({ path, entry: null });

/**
 * Turns what the harness heard into a trace.
 *
 * The first call is the trigger: Fragmentor, from outside, calling the block
 * it ran, since nobody pressed anything. Every other call is an interaction
 * from the block whose call made it, so what led to what is exact rather than
 * inferred. A store used is an interaction from the call that was running when
 * it was used, and a write, remove or send also leaves the effect the guide
 * names it by. What the block run returns is the response, left at that block.
 *
 * Ids are `@` and a number, which a step written down can never be given.
 */
export function recordedTrace(execution: string, scope: RecordingScope, heard: readonly HeardEvent[], outcome: HeardOutcome): Trace {
  const events: TraceEvent[] = [];
  const calls = new Map<number, Interaction>();
  const codeOf = (path: string) => (scope.blocks[path] === undefined ? {} : { code: scope.blocks[path] });
  let triggered = false;

  for (const event of heard) {
    if (event.type === "call") {
      const parent = event.parent === null ? undefined : calls.get(event.parent);
      const first = !triggered && event.parent === null;
      triggered = true;
      const from = first ? null : (parent?.to ?? blockAt(scope.runs));
      const interaction: Interaction = {
        type: "interaction",
        id: first ? TRIGGER : `@${event.id}`,
        cause: first ? null : (parent?.id ?? TRIGGER),
        from,
        to: blockAt(event.block),
        kind: first ? "trigger" : "call",
        // The code a step names is the code that makes it: for the trigger,
        // the code it arrives at, as a written trigger says.
        ...codeOf(from === null ? event.block : from.path),
        ...(event.input === undefined ? {} : { payload: event.input }),
      };
      calls.set(event.id, interaction);
      events.push(interaction);
    } else if (event.type === "return" || event.type === "throw") {
      const call = calls.get(event.id);
      if (!call) continue;
      events.push({
        type: "return",
        id: `${call.id}.returned`,
        of: call.id,
        from: call.from,
        to: call.to,
        ...(event.type === "throw" ? { error: event.error } : event.output === undefined ? {} : { response: event.output }),
      });
      if (call.id === TRIGGER && event.type === "return") {
        events.push({
          type: "effect",
          id: `${TRIGGER}.response`,
          cause: TRIGGER,
          at: call.to,
          kind: "response",
          ...codeOf(call.to.path),
          ...(event.output === undefined ? {} : { detail: event.output }),
        });
      }
    } else if (event.type === "store") {
      const parent = event.parent === null ? undefined : calls.get(event.parent);
      const from = parent?.to ?? blockAt(scope.runs);
      const carried =
        event.op === "read" || event.op === "remove" ? { key: event.key } : event.op === "list" ? undefined : event.value;
      const interaction: Interaction = {
        type: "interaction",
        id: `@${event.id}`,
        cause: parent?.id ?? TRIGGER,
        from,
        to: addressOf(event.target),
        kind: INTERACTION_OF[event.op],
        ...codeOf(from.path),
        ...(carried === undefined ? {} : { payload: carried }),
      };
      events.push(interaction);
      if (event.op === "read" || event.op === "list") {
        events.push({ type: "return", id: `${interaction.id}.returned`, of: interaction.id, from, to: interaction.to, response: event.value });
      }
      const effect = EFFECT_OF[event.op];
      // A remove of a row that was not there took nothing away.
      if (effect && !(event.op === "remove" && event.value === null)) {
        events.push({
          type: "effect",
          id: `${interaction.id}.effect`,
          cause: interaction.id,
          at: interaction.to,
          kind: effect,
          ...codeOf(from.path),
          detail: event.value,
        });
      }
    }
  }

  const state = Object.fromEntries(
    Object.entries(outcome.stores).map(([target, held]) => [target, held.kind === "store" ? held.rows : held.sent]),
  );
  return { source: "recorded", execution, events, state };
}

/* -------------------------------------------------------------------------- */
/* Comparing with what was written down                                        */
/* -------------------------------------------------------------------------- */

/** What an execution says, as far as comparing a recording with it goes. */
export interface WrittenExecution {
  given: Record<string, unknown>;
  declared: Trace | null;
  expect: Expectations | null;
}

/**
 * What a recording says about one step written down.
 *
 * `not-seen` is a contradiction: the run could see where the step happens
 * and it did not happen, or not as written. `unchecked` means the run could
 * not see there at all, which is never counted as agreeing.
 */
export interface StepVerdict {
  id: string;
  verdict: "seen" | "not-seen" | "unchecked";
  /** Why, for anything but `seen`. */
  reason: string | null;
}

export interface RecordingCheck {
  expectations: {
    failures: string[];
    /** Expectations this recording could not judge, each with why. None of them counts as met. */
    setAside: { expectation: string; why: string }[];
  };
  /** One for every step written down, in the order written. */
  steps: StepVerdict[];
  /** Interactions the run made that no written step accounts for. */
  unwrittenCount: number;
  /** Stores the execution gives starting rows for that the run had no way into, so it started without them. */
  notSeeded: string[];
}

const STOPPED = "The recording ends before the run did, so this may not have happened yet.";

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** `a`, `a and b`, `a, b and c`, or the first three and how many more. */
function listed(items: string[]): string {
  const shown = items.length > 3 ? [...items.slice(0, 3), `${items.length - 3} more`] : items;
  return shown.length === 1 ? shown[0]! : `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
}

const unseenIn = (scope: RecordingScope, within: Address) => scope.unseen.filter((each) => isInside(addressOf(each), within));
const seenIn = (scope: RecordingScope, within: Address) =>
  [...Object.keys(scope.blocks), ...scope.stores].filter((each) => isInside(addressOf(each), within));

/** Why this run could not have seen everything at these places, or null when it could. */
function outOfSight(scope: RecordingScope, places: Address[]): string | null {
  const unseen = [...new Set(places.flatMap((place) => unseenIn(scope, place)))];
  if (unseen.length === 0) return null;
  return `${listed(unseen)} ${unseen.length === 1 ? "is" : "are"} not part of what ran.`;
}

/**
 * Why a call between two blocks cannot be seen, when they are in one file.
 * A recording sees a call by standing in for the block's export, and a
 * function calling another in its own file never goes through the export.
 */
function oneFile(scope: RecordingScope, from: Address | undefined, to: Address | undefined): string | null {
  if (!from || !to || from.entry !== null || to.entry !== null || from.path === to.path) return null;
  const [one, other] = [scope.blocks[from.path]?.split("#")[0], scope.blocks[to.path]?.split("#")[0]];
  return one !== undefined && one === other
    ? `${from.path} and ${to.path} are both in ${one}, and a call inside one file is not seen.`
    : null;
}

/** Why a recording could never show an interaction like this one, or null when it could. */
function unrecordableInteraction(scope: RecordingScope, wanted: InteractionExpectation): string | null {
  if (wanted.kind === "deliver") return "Fragmentor does not record a channel handing a message on.";
  if (wanted.kind === "trigger") return `The recording starts at ${scope.runs}, so it cannot see what set the execution going.`;
  return null;
}

/** Why an interaction not being in this recording proves nothing, or null when it proves it did not happen. */
function interactionOutOfReach(scope: RecordingScope, wanted: InteractionExpectation): string | null {
  if (wanted.from === undefined) return "It does not say where it comes from, and not everything that could have made it ran.";
  return outOfSight(scope, wanted.to ? [wanted.from, wanted.to] : [wanted.from]) ?? oneFile(scope, wanted.from, wanted.to);
}

/**
 * Where a recording would have left an expected effect. An operation's
 * response is what the block answering it returns, so a response expected at
 * an operation the block run answers is looked for at that block.
 */
function asRecorded(scope: RecordingScope, wanted: EffectExpectation): EffectExpectation {
  return wanted.at !== undefined && wanted.kind === "response" && scope.answers.includes(formatAddress(wanted.at))
    ? { ...wanted, at: blockAt(scope.runs) }
    : wanted;
}

/** Why a recording could never show an effect like this one, or null when it could. */
function unrecordableEffect(scope: RecordingScope, wanted: EffectExpectation): string | null {
  if (wanted.kind !== undefined && !RECORDED_EFFECTS.includes(wanted.kind)) {
    return `Fragmentor does not record "${wanted.kind}" effects.`;
  }
  if (wanted.kind === "response" && wanted.at !== undefined && !isInside(blockAt(scope.runs), wanted.at)) {
    return `Fragmentor records a response only from ${scope.runs}, the block it runs.`;
  }
  return null;
}

function effectOutOfReach(scope: RecordingScope, wanted: EffectExpectation): string | null {
  if (wanted.at === undefined) return "It does not say where, and not everything that could have left it ran.";
  return outOfSight(scope, [wanted.at]);
}

/**
 * A read or a remove written with one field, `{ "id": "gig" }`, names its row
 * by that field's value, and a recording names it by the key the code used, so
 * the two agree when the values do. Any other payload says how a row was
 * looked for, such as a scan by email, which a recording has no words for. It
 * is left out, and the step is judged by its ends and what came back.
 */
function inRecordedWords(wanted: InteractionExpectation, trace: Trace): InteractionExpectation {
  if ((wanted.kind !== "read" && wanted.kind !== "remove") || wanted.payload === undefined) return wanted;
  const { payload, ...rest } = wanted;
  const values = isPlainObject(payload) ? Object.values(payload) : [];
  const key = values.length === 1 && ["string", "number", "boolean"].includes(typeof values[0]) ? String(values[0]) : undefined;
  // Listing a store names no key, so there is nothing to hold a written one to.
  const listing = trace.events.some(
    (event) =>
      event.type === "interaction" &&
      event.kind === wanted.kind &&
      event.payload === undefined &&
      (wanted.to === undefined || isInside(event.to, wanted.to)) &&
      (wanted.from === undefined || (event.from !== null && isInside(event.from, wanted.from))),
  );
  return key === undefined || listing ? rest : { ...rest, payload: { key } };
}

const only = (partial: Partial<Expectations>): Expectations => ({
  entered: [],
  interactions: [],
  effects: [],
  never: [],
  state: {},
  ...partial,
});

/**
 * Holds what an execution says to what a recording of it saw.
 *
 * Something found in the recording counts wherever it is. Something missing
 * from it counts only where the run could see everything that could have done
 * it, and only once the run has finished; anywhere else the expectation is set
 * aside with the reason, and a written step is `unchecked`. So a recording is
 * never taken as agreeing about a place it could not see.
 *
 * It keeps nothing, and is cheap, so it is simply asked again whenever what
 * was written down changes.
 */
export function checkRecording(
  execution: WrittenExecution,
  trace: Trace,
  scope: RecordingScope,
  complete: boolean,
): RecordingCheck {
  return {
    expectations: execution.expect ? checkExpectations(execution.expect, trace, scope, complete) : { failures: [], setAside: [] },
    steps: execution.declared ? checkSteps(execution.declared, trace, scope, complete) : [],
    unwrittenCount: unwritten(execution.declared, trace),
    notSeeded: Object.keys(execution.given).filter((target) => !scope.stores.includes(target)),
  };
}

function checkExpectations(expected: Expectations, trace: Trace, scope: RecordingScope, complete: boolean): RecordingCheck["expectations"] {
  const judged = only({});
  const setAside: { expectation: string; why: string }[] = [];
  const failures: string[] = [];

  /**
   * Judged with the others where the run saw everything that could have
   * done it. Anywhere else it is still met by being found, and is otherwise
   * set aside, never counted either way.
   */
  const judge = (expectation: string, alone: Expectations, why: string | null, include: () => void) => {
    if (why === null) include();
    else if (!evaluate(trace, alone).passed) setAside.push({ expectation, why });
  };

  for (const within of expected.entered) {
    const why = outOfSight(scope, [within]) ?? (complete ? null : STOPPED);
    judge(`Something crosses into ${formatAddress(within)}`, only({ entered: [within] }), why, () => judged.entered.push(within));
  }

  for (const written of expected.interactions) {
    const wanted = inRecordedWords(written, trace);
    const never = unrecordableInteraction(scope, wanted);
    const why = never ?? interactionOutOfReach(scope, wanted) ?? (complete ? null : STOPPED);
    if (never !== null) setAside.push({ expectation: describeWanted(written), why: never });
    else judge(describeWanted(written), only({ interactions: [wanted] }), why, () => judged.interactions.push(wanted));
  }

  for (const written of expected.effects) {
    const wanted = asRecorded(scope, written);
    const never = unrecordableEffect(scope, wanted);
    const why = never ?? effectOutOfReach(scope, wanted) ?? (complete ? null : STOPPED);
    if (never !== null) setAside.push({ expectation: describeWantedEffect(written), why: never });
    else judge(describeWantedEffect(written), only({ effects: [wanted] }), why, () => judged.effects.push(wanted));
  }

  // Something happening where nothing should is found like anything else. Its
  // not happening counts only where the run saw everything there was to see.
  for (const within of expected.never) {
    const result = evaluate(trace, only({ never: [within] }));
    if (!result.passed) {
      failures.push(...result.failures);
      continue;
    }
    const seen = seenIn(scope, within);
    const why = outOfSight(scope, [within]);
    const expectation = `Nothing happens in ${formatAddress(within)}`;
    if (why !== null) setAside.push({ expectation, why: seen.length > 0 ? `Checked only for ${listed(seen)}.` : why });
    else if (!complete) setAside.push({ expectation, why: STOPPED });
  }

  for (const [target, wanted] of Object.entries(expected.state)) {
    const why = !scope.stores.includes(target) ? `${target} is not part of what ran.` : complete ? null : STOPPED;
    if (why === null) judged.state[target] = wanted;
    else setAside.push({ expectation: `What ${target} holds at the end`, why });
  }

  failures.unshift(...evaluate(trace, judged).failures);
  return { failures, setAside };
}

function checkSteps(declared: Trace, trace: Trace, scope: RecordingScope, complete: boolean): StepVerdict[] {
  const responses = new Map(
    declared.events.flatMap((event) => (event.type === "return" && event.response !== undefined ? [[event.of, event.response]] : [])),
  );

  return declared.events.flatMap((step): StepVerdict[] => {
    if (step.id === TRIGGER || step.type === "return") return [];
    const unchecked = (reason: string): StepVerdict[] => [{ id: step.id, verdict: "unchecked", reason }];

    let alone: Expectations;
    let reach: string | null;
    if (step.type === "interaction") {
      const wanted = inRecordedWords(
        {
          from: step.from ?? undefined,
          to: step.to,
          kind: step.kind,
          ...(step.payload === undefined ? {} : { payload: step.payload }),
          ...(responses.has(step.id) ? { response: responses.get(step.id) } : {}),
        },
        trace,
      );
      const never = unrecordableInteraction(scope, wanted);
      if (never !== null) return unchecked(never);
      alone = only({ interactions: [wanted] });
      reach = interactionOutOfReach(scope, wanted);
    } else {
      const wanted = asRecorded(scope, { at: step.at, kind: step.kind, ...(step.detail === undefined ? {} : { detail: step.detail }) });
      const never = unrecordableEffect(scope, wanted);
      if (never !== null) return unchecked(never);
      alone = only({ effects: [wanted] });
      reach = effectOutOfReach(scope, wanted);
    }

    const result = evaluate(trace, alone);
    if (result.passed) return [{ id: step.id, verdict: "seen", reason: null }];
    if (reach !== null) return unchecked(reach);
    return [{ id: step.id, verdict: "not-seen", reason: complete ? result.failures.join(" ") : STOPPED }];
  });
}

/**
 * How many of the run's interactions no written step accounts for: a step
 * accounts for every recorded one of its kind whose ends lie within its own,
 * so one step can stand for a call made five times.
 */
function unwritten(declared: Trace | null, trace: Trace): number {
  const written = (declared?.events ?? []).filter((event): event is Interaction => event.type === "interaction");
  return trace.events.filter(
    (event): event is Interaction =>
      event.type === "interaction" &&
      event.kind !== "trigger" &&
      !written.some(
        (step) =>
          step.kind === event.kind &&
          step.from !== null &&
          event.from !== null &&
          isInside(event.from, step.from) &&
          isInside(event.to, step.to),
      ),
  ).length;
}
