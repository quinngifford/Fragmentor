import { activates, enters, formatAddress, isInside } from "../model/trace.js";
import type { Address, Effect, Interaction, InteractionKind, Return, Trace, TraceEvent, TraceSource } from "../model/trace.js";
import { compareValues } from "./compare.js";

/**
 * Tests over what happened, rather than over what came back.
 *
 * A run does not have to return anything to be worth testing. Logging out
 * returns nothing; what matters is that the session was removed, the browser
 * was sent to the login page, and the payment service was never touched.
 * So a test says which interactions must happen, which effects must be left
 * behind, which parts must never be touched, and what the stores must hold at
 * the end — and it works the same for a component with no parameters and no
 * result as for one with both.
 *
 * Everything is matched by address, and an address without an entry stands
 * for everything inside that component. A test written against `app/api`
 * therefore does not change meaning when the blocks inside it are
 * rearranged.
 *
 * Expected interactions and effects may happen in any order, each matched to
 * a different event, and the order they are written in makes no difference to
 * whether they pass. Order is left out until a test needs it: with branches
 * that run side by side, the order they interleave in is not something a test
 * should depend on.
 */

export interface InteractionExpectation {
  from?: Address;
  to?: Address;
  kind?: InteractionKind;
  /** Compared partially: the fields named must match, others may be there too. */
  payload?: unknown;
  /** What came back, compared the same way. */
  response?: unknown;
}

export interface EffectExpectation {
  at?: Address;
  kind?: string;
  /** Compared partially. */
  detail?: unknown;
}

export interface Expectations {
  /** Parts the run must cross into from outside them. */
  entered: Address[];
  interactions: InteractionExpectation[];
  effects: EffectExpectation[];
  /** Parts in which nothing may happen at all. */
  never: Address[];
  /**
   * What stores must hold when the run ends, by target. A store holds
   * exactly the keys given, so a test can say a row is gone by leaving it
   * out; each row is compared partially.
   */
  state: Record<string, unknown>;
}

export interface ExpectationResult {
  passed: boolean;
  failures: string[];
  /**
   * Where the trace came from. A declared trace passing its expectations
   * only says that what was written down agrees with itself, never that the
   * code behaves that way, so the source travels with the result.
   */
  source: TraceSource;
}

const nameOf = (address: Address | null) => (address === null ? "outside" : formatAddress(address));

function describeWanted(wanted: InteractionExpectation): string {
  const what = wanted.kind ? `A ${wanted.kind}` : "An interaction";
  return `${what}${wanted.from ? ` from ${formatAddress(wanted.from)}` : ""}${wanted.to ? ` to ${formatAddress(wanted.to)}` : ""}`;
}

function describeWantedEffect(wanted: EffectExpectation): string {
  return `${wanted.kind ? `A "${wanted.kind}" effect` : "An effect"}${wanted.at ? ` at ${formatAddress(wanted.at)}` : ""}`;
}

export function describeEvent(event: TraceEvent): string {
  if (event.type === "effect") return `a "${event.kind}" effect at ${formatAddress(event.at)}`;
  if (event.type === "return") return `${formatAddress(event.to)} returning to ${nameOf(event.from)}`;
  return `a ${event.kind} from ${nameOf(event.from)} to ${formatAddress(event.to)}`;
}

function endsMatch(interaction: Interaction, wanted: InteractionExpectation): boolean {
  if (wanted.kind !== undefined && interaction.kind !== wanted.kind) return false;
  if (wanted.to !== undefined && !isInside(interaction.to, wanted.to)) return false;
  if (wanted.from !== undefined && (interaction.from === null || !isInside(interaction.from, wanted.from))) return false;
  return true;
}

/** How what an interaction carried differs from what was wanted. Empty when it matches. */
function carriedDifferences(interaction: Interaction, returned: Return | undefined, wanted: InteractionExpectation): string[] {
  const differences: string[] = [];
  if (wanted.payload !== undefined) {
    differences.push(
      ...(interaction.payload === undefined
        ? ["it carried nothing."]
        : compareValues(interaction.payload, wanted.payload, "payload", true)),
    );
  }
  if (wanted.response !== undefined) {
    differences.push(
      ...(returned?.response === undefined
        ? ["nothing came back."]
        : compareValues(returned.response, wanted.response, "response", true)),
    );
  }
  return differences;
}

/**
 * Gives each expectation an event of its own, if there is any way to.
 *
 * Taking the first event that fits would let a loose expectation, such as
 * "something reached the sessions store", use up the one event a stricter
 * expectation after it needed, so a test would pass or fail depending on the
 * order it was written in. Instead an event already given to one expectation
 * is moved to another that could use it, whenever that frees one up.
 *
 * Where nothing fits, the closest miss is reported: "it happened, but with
 * the wrong row" is the more useful thing to be told.
 */
function matchEach<E extends { id: string }, W>(
  candidates: E[],
  expectations: W[],
  endsMatch: (event: E, wanted: W) => boolean,
  differences: (event: E, wanted: W) => string[],
  describe: (wanted: W) => string,
): string[] {
  const fitting = expectations.map((wanted) =>
    candidates.filter((event) => endsMatch(event, wanted) && differences(event, wanted).length === 0),
  );
  const givenTo = new Map<string, number>();

  const give = (wanted: number, tried: Set<string>): boolean => {
    for (const event of fitting[wanted]!) {
      if (tried.has(event.id)) continue;
      tried.add(event.id);
      const holder = givenTo.get(event.id);
      if (holder === undefined || give(holder, tried)) {
        givenTo.set(event.id, wanted);
        return true;
      }
    }
    return false;
  };

  const failures: string[] = [];
  expectations.forEach((wanted, index) => {
    if (give(index, new Set())) return;

    const times = fitting[index]!.length;
    if (times > 0) {
      failures.push(
        `${describe(wanted)} happened ${times === 1 ? "once" : `${times} times`}, which is not enough for every expectation asking for it.`,
      );
      return;
    }
    const near = candidates.find((event) => endsMatch(event, wanted));
    failures.push(
      near
        ? `${describe(wanted)} happened, but not as expected: ${differences(near, wanted).join(" ")}`
        : `${describe(wanted)} never happened.`,
    );
  });

  return failures;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** A store's keys compared exactly, so a missing row is a difference; each row compared partially. */
function stateDifferences(actual: unknown, wanted: unknown, target: string): string[] {
  const differences = compareValues(actual, wanted, target, true);
  if (isPlainObject(actual) && isPlainObject(wanted)) {
    for (const key of Object.keys(actual)) {
      if (!(key in wanted)) differences.push(`${target}.${key} was not expected.`);
    }
  }
  return differences;
}

export function evaluate(trace: Trace, expected: Expectations): ExpectationResult {
  const failures: string[] = [];
  const interactions = trace.events.filter((event): event is Interaction => event.type === "interaction");
  const effects = trace.events.filter((event): event is Effect => event.type === "effect");
  const returns = new Map(
    trace.events.filter((event): event is Return => event.type === "return").map((event) => [event.of, event]),
  );

  for (const within of expected.entered) {
    if (!trace.events.some((event) => enters(event, within))) {
      failures.push(`Nothing crossed into ${formatAddress(within)}.`);
    }
  }

  failures.push(
    ...matchEach(
      interactions,
      expected.interactions,
      endsMatch,
      (event, wanted) => carriedDifferences(event, returns.get(event.id), wanted),
      describeWanted,
    ),
  );

  failures.push(
    ...matchEach(
      effects,
      expected.effects,
      (event, wanted) =>
        (wanted.kind === undefined || event.kind === wanted.kind) && (wanted.at === undefined || isInside(event.at, wanted.at)),
      (event, wanted) =>
        wanted.detail === undefined
          ? []
          : event.detail === undefined
            ? ["it said nothing more."]
            : compareValues(event.detail, wanted.detail, "detail", true),
      describeWantedEffect,
    ),
  );

  for (const within of expected.never) {
    const offending = trace.events.find((event) => activates(event, within));
    if (offending) failures.push(`Nothing should have happened in ${formatAddress(within)}, but there was ${describeEvent(offending)}.`);
  }

  const targets = Object.entries(expected.state);
  if (targets.length > 0 && trace.state === undefined) {
    failures.push(
      `This trace does not say what the stores held at the end, so what they should hold cannot be checked. Only a recorded run knows.`,
    );
  } else {
    for (const [target, wanted] of targets) {
      failures.push(...stateDifferences(trace.state![target], wanted, target));
    }
  }

  return { passed: failures.length === 0, failures, source: trace.source };
}
