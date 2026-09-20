import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v4";
import { blockIdPattern, nameFromId } from "../model/block.js";
import { identifierPattern } from "../model/types.js";
import { INTERACTION_KINDS, isInside } from "../model/trace.js";
import type { Address, Effect, Interaction, InteractionKind, Return, Trace, TraceEvent } from "../model/trace.js";
import type { Expectations } from "../run/expect.js";
import type { Project } from "./project.js";

/**
 * Executions: the things that can set a system going, and what follows.
 *
 * Each lives in its own file under `executions/`, beside `blocks/` rather
 * than inside it, because an execution crosses the whole architecture and
 * belongs to no one block in it.
 *
 *   executions/
 *     borrow-a-book.json
 *
 * A file names a trigger and the conditions it happens under. It may also
 * hold a trace an agent wrote down after reading the code, which is kept as
 * `declared` and never passed off as something Fragmentor saw run, and it may
 * hold expectations, which is what makes it a test.
 */

/** Reads an address as a file writes it: `app/api/messaging`, or `app/infrastructure/queue.publish`. */
export function parseAddress(text: string): { ok: true; address: Address } | { ok: false; error: string } {
  const dot = text.indexOf(".");
  const path = dot === -1 ? text : text.slice(0, dot);
  const entry = dot === -1 ? null : text.slice(dot + 1);

  if (path === "" || !path.split("/").every((segment) => blockIdPattern.test(segment))) {
    return {
      ok: false,
      error: `"${text}" is not an address: it should be block ids joined by "/", such as "app/api/messaging", optionally followed by "." and an entry.`,
    };
  }
  if (entry !== null && !identifierPattern.test(entry)) {
    return { ok: false, error: `"${entry}" in "${text}" is not a valid entry name.` };
  }
  return { ok: true, address: { path, entry } };
}

/** What sets an execution going. */
export type TriggerKind =
  /** A person does something: clicks, submits, types a command. */
  | "action"
  /** A request arrives, such as an HTTP call. */
  | "request"
  /** A clock fires: a cron job, a scheduled task. */
  | "schedule"
  /** A message arrives on a queue or topic. */
  | "message"
  /** Another system calls in to say something happened. */
  | "webhook";

export const TRIGGER_KINDS: TriggerKind[] = ["action", "request", "schedule", "message", "webhook"];

export interface Trigger {
  at: Address;
  kind: TriggerKind;
  /** What sets the system going, in the words of whoever wrote the trace down. */
  description?: string;
  /** The code it arrives at, written as a block's `code` is. */
  code?: string;
  payload?: unknown;
}

export interface Execution {
  /** The file's name, which is how everything else refers to it. */
  id: string;
  name: string;
  description: string | null;
  trigger: Trigger;
  /** What each store holds before it starts, by target and then by key. */
  given: Record<string, Record<string, unknown>>;
  /** The trace an agent wrote down, when there is one. Always `declared`. */
  declared: Trace | null;
  expect: Expectations | null;
}

export const EXECUTIONS_DIR = "executions";

const addressSchema = z.string().transform((value, ctx): Address => {
  const parsed = parseAddress(value);
  if (!parsed.ok) {
    ctx.addIssue({ code: "custom", message: parsed.error });
    return z.NEVER;
  }
  return parsed.address;
});

/**
 * A step's own name, for another step to give as its cause. Letters first,
 * and no dots or `#`, so it can never collide with a name Fragmentor makes up.
 */
const stepId = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]*$/, "a step's id starts with a letter and holds only letters, digits, - and _");

/**
 * What a step follows from, when the list does not make it plain: the id an
 * earlier step was given, or `trigger`. A step without an id has no name to
 * refer to, because a number taken from its position would quietly come to
 * mean a different step as soon as one was added before it.
 */
const causeId = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]*$/, `name the step this follows from by the id you gave it, or "trigger"`);

/** The trigger is the execution's own, so no step inside it is one. */
const STEP_KINDS = INTERACTION_KINDS.filter((kind) => kind !== "trigger");

/** What a step is, and the code that makes it: written for every step of a trace. */
const stepDescription = z.string().min(1, "say what this step is, in a sentence");
const stepCode = z
  .string()
  .min(1, 'name the code that makes it, as a block does: "src/api/router.ts#handleSend"');

const interactionStepSchema = z
  .object({
    id: stepId.optional(),
    cause: causeId.optional(),
    description: stepDescription.optional(),
    code: stepCode.optional(),
    from: addressSchema,
    to: addressSchema,
    kind: z.enum(STEP_KINDS as [InteractionKind, ...InteractionKind[]], {
      error: `must be one of ${STEP_KINDS.join(", ")}. What sets the execution going is its "trigger", written once.`,
    }),
    payload: z.unknown().optional(),
    response: z.unknown().optional(),
  })
  .strict();

const effectStepSchema = z
  .object({
    id: stepId.optional(),
    cause: causeId.optional(),
    description: stepDescription.optional(),
    code: stepCode.optional(),
    effect: z.string().min(1, "say what kind of effect it is, such as row-changed or message-published"),
    at: addressSchema,
    detail: z.unknown().optional(),
  })
  .strict();

type InteractionStep = z.infer<typeof interactionStepSchema>;
type EffectStep = z.infer<typeof effectStepSchema>;

const expectSchema = z
  .object({
    entered: z.array(addressSchema).default([]),
    interactions: z
      .array(
        z
          .object({
            from: addressSchema.optional(),
            to: addressSchema.optional(),
            kind: z.enum(INTERACTION_KINDS as [InteractionKind, ...InteractionKind[]]).optional(),
            payload: z.unknown().optional(),
            response: z.unknown().optional(),
          })
          .strict(),
      )
      .default([]),
    effects: z
      .array(
        z
          .object({ at: addressSchema.optional(), kind: z.string().min(1).optional(), detail: z.unknown().optional() })
          .strict(),
      )
      .default([]),
    never: z.array(addressSchema).default([]),
    state: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

const executionFileSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    trigger: z
      .object({
        at: addressSchema,
        kind: z.enum(TRIGGER_KINDS as [TriggerKind, ...TriggerKind[]], {
          error: `must be one of ${TRIGGER_KINDS.join(", ")}`,
        }),
        description: stepDescription.optional(),
        code: stepCode.optional(),
        payload: z.unknown().optional(),
      })
      .strict(),
    given: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
    trace: z.array(z.unknown()).optional(),
    expect: expectSchema.optional(),
  })
  .strict();

const issuesOf = (error: z.ZodError, prefix = "") =>
  error.issues.map((issue) => `${[prefix, ...issue.path].filter((part) => part !== "").join(".") || "(root)"}: ${issue.message}`);

/** The id every trace gives the trigger that starts it. */
export const TRIGGER_ID = "trigger";

/**
 * The event a step is most likely a consequence of: the latest interaction
 * that arrived where this step starts, or at something containing it.
 *
 * It is the call-stack reading of a list. Written one after another, "the
 * router calls saveMessage, saveMessage writes the database, the router
 * calls notifyRecipient" reads as three steps in a row, but the third starts
 * at the router, so it follows from whatever reached the router — not from
 * the database. That is what makes the list a graph with two branches, and
 * it is why a step rarely has to name its cause.
 *
 * Failing that, a step written more coarsely than the one before it — from
 * `app/api` after a call arrived at `app/api/router` — follows from that call.
 *
 * A list cannot say everything. After something calls back into the block
 * that called it, whether that block's next step happens inside the callback
 * or after it is not written anywhere, and the callback is assumed. A step
 * that means otherwise says so with `cause`.
 */
function inferCause(events: (Interaction | Effect)[], start: Address): string {
  const component = { path: start.path, entry: null };
  const arrivedAt = (event: Interaction | Effect) => (event.type === "interaction" ? { path: event.to.path, entry: null } : null);

  for (const within of [true, false]) {
    for (let at = events.length - 1; at >= 0; at -= 1) {
      const arrived = arrivedAt(events[at]!);
      if (arrived && (within ? isInside(component, arrived) : isInside(arrived, component))) return events[at]!.id;
    }
  }
  return TRIGGER_ID;
}

/**
 * Turns the steps an agent wrote into a trace.
 *
 * A step that says what came back gets a return, placed after the work it
 * set off inside the component it called: the response to a request arrives
 * once the work it asked for is done, not before. Something it led to
 * elsewhere, after control was back with the caller, does not hold it up.
 */
function declaredTrace(
  id: string,
  trigger: Trigger,
  raw: unknown[],
): { ok: true; trace: Trace } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const first: Interaction = {
    type: "interaction",
    id: TRIGGER_ID,
    cause: null,
    from: null,
    to: trigger.at,
    kind: "trigger",
    ...(trigger.description === undefined ? {} : { description: trigger.description }),
    ...(trigger.code === undefined ? {} : { code: trigger.code }),
    ...(trigger.payload === undefined ? {} : { payload: trigger.payload }),
  };
  const events: (Interaction | Effect)[] = [first];
  const responses = new Map<string, unknown>();

  raw.forEach((value, index) => {
    const where = `trace.${index}`;
    const isEffect = typeof value === "object" && value !== null && "effect" in value;
    const parsed = (isEffect ? effectStepSchema : interactionStepSchema).safeParse(value);
    if (!parsed.success) {
      problems.push(...issuesOf(parsed.error, where));
      return;
    }

    const step = parsed.data as InteractionStep | EffectStep;
    const stepIdOf = step.id ?? `#${index + 1}`;
    if (events.some((event) => event.id === stepIdOf)) {
      problems.push(`${where}.id: "${stepIdOf}" is already the id of an earlier step.`);
      return;
    }
    if (step.cause !== undefined && !events.some((event) => event.id === step.cause)) {
      problems.push(`${where}.cause: there is no earlier step called "${step.cause}". A step can only follow from one before it.`);
      return;
    }

    if ("effect" in step) {
      events.push({
        type: "effect",
        id: stepIdOf,
        cause: step.cause ?? inferCause(events, step.at),
        at: step.at,
        kind: step.effect,
        ...(step.description === undefined ? {} : { description: step.description }),
        ...(step.code === undefined ? {} : { code: step.code }),
        ...(step.detail === undefined ? {} : { detail: step.detail }),
      });
      return;
    }

    events.push({
      type: "interaction",
      id: stepIdOf,
      cause: step.cause ?? inferCause(events, step.from),
      from: step.from,
      to: step.to,
      kind: step.kind,
      ...(step.description === undefined ? {} : { description: step.description }),
      ...(step.code === undefined ? {} : { code: step.code }),
      ...(step.payload === undefined ? {} : { payload: step.payload }),
    });
    if (step.response !== undefined) responses.set(stepIdOf, step.response);
  });

  if (problems.length > 0) return { ok: false, problems };

  // The last event of the work each interaction set off inside what it
  // called. An event counts towards an interaction when the step leading
  // from that interaction towards it began inside the component called — or
  // was written at a level containing it, the same reading `inferCause`
  // gives such a step. Causes always point backwards, so walking up ends.
  const byId = new Map(events.map((event) => [event.id, event]));
  const startOf = (event: Interaction | Effect) => (event.type === "effect" ? event.at : event.from);
  const overlap = (one: Address, other: Address) => {
    const [a, b] = [{ path: one.path, entry: null }, { path: other.path, entry: null }];
    return isInside(a, b) || isInside(b, a);
  };
  const lastSetOff = new Map<string, number>();
  events.forEach((event, index) => {
    lastSetOff.set(event.id, index);
    for (let step = event, cause = byId.get(event.cause ?? ""); cause; step = cause, cause = byId.get(cause.cause ?? "")) {
      const start = startOf(step);
      if (cause.type === "interaction" && start !== null && overlap(start, cause.to)) lastSetOff.set(cause.id, index);
    }
  });

  const returnsAfter = new Map<number, Return[]>();
  events.forEach((event) => {
    if (event.type !== "interaction" || !responses.has(event.id)) return;
    const after = lastSetOff.get(event.id)!;
    returnsAfter.set(after, [
      ...(returnsAfter.get(after) ?? []),
      { type: "return", id: `${event.id}.returned`, of: event.id, from: event.from, to: event.to, response: responses.get(event.id) },
    ]);
  });

  // Where several finish at once, the one that started last finishes first.
  const woven: TraceEvent[] = [];
  events.forEach((event, index) => {
    woven.push(event);
    woven.push(...(returnsAfter.get(index) ?? []).reverse());
  });

  return { ok: true, trace: { source: "declared", execution: id, events: woven } };
}

/** Reads the contents of `executions/<id>.json`. Each problem says where it is. */
export function parseExecutionFile(raw: unknown, id: string): { ok: true; execution: Execution } | { ok: false; problems: string[] } {
  if (!blockIdPattern.test(id)) {
    return { ok: false, problems: [`the file name "${id}" must be kebab-case, such as "borrow-a-book"`] };
  }

  const parsed = executionFileSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, problems: issuesOf(parsed.error) };

  const file = parsed.data;
  const trigger: Trigger = {
    at: file.trigger.at,
    kind: file.trigger.kind,
    ...(file.trigger.description === undefined ? {} : { description: file.trigger.description }),
    ...(file.trigger.code === undefined ? {} : { code: file.trigger.code }),
    ...(file.trigger.payload === undefined ? {} : { payload: file.trigger.payload }),
  };

  let declared: Trace | null = null;
  if (file.trace !== undefined) {
    const built = declaredTrace(id, trigger, file.trace);
    if (!built.ok) return built;
    declared = built.trace;
  }

  return {
    ok: true,
    execution: {
      id,
      name: file.name ?? nameFromId(id),
      description: file.description ?? null,
      trigger,
      given: file.given,
      declared,
      expect: (file.expect as Expectations | undefined) ?? null,
    },
  };
}

/**
 * Every execution in a project, and what was wrong with the files that could
 * not be read. A missing folder just means there are none yet.
 */
export async function loadExecutions(
  projectDir: string,
): Promise<{ executions: Execution[]; problems: { file: string; problems: string[] }[] }> {
  const dir = path.join(projectDir, EXECUTIONS_DIR);
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { executions: [], problems: [] };
    throw error;
  }

  const executions: Execution[] = [];
  const problems: { file: string; problems: string[] }[] = [];

  for (const name of names) {
    const file = `${EXECUTIONS_DIR}/${name}`;
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(path.join(dir, name), "utf8"));
    } catch (error) {
      problems.push({ file, problems: [`it is not valid JSON: ${error instanceof Error ? error.message : String(error)}`] });
      continue;
    }
    const parsed = parseExecutionFile(raw, name.slice(0, -".json".length));
    if (parsed.ok) executions.push(parsed.execution);
    else problems.push({ file, problems: parsed.problems });
  }

  return { executions, problems };
}

/** Every component in a project, by path, with the names of its entries. */
export type Architecture = ReadonlyMap<string, readonly string[]>;

export function architectureOf(project: Project): Architecture {
  return new Map([...project.byPath.values()].map((node) => [node.path, Object.keys(node.block.exposes)]));
}

/**
 * Whether everything an execution names is really there: the component, and
 * the entry when one is named. A trace that points at a block which has since
 * moved is exactly the drift this is for.
 */
export function checkExecution(execution: Execution, architecture: Architecture): string[] {
  const problems: string[] = [];

  const check = (address: Address, where: string) => {
    const entries = architecture.get(address.path);
    if (!entries) {
      problems.push(`${where}: there is no block at "${address.path}".`);
    } else if (address.entry !== null && !entries.includes(address.entry)) {
      problems.push(
        `${where}: "${address.path}" has no entry called "${address.entry}"${
          entries.length > 0 ? `. Its entries are: ${entries.join(", ")}.` : ", and exposes no entries at all."
        }`,
      );
    }
  };

  /** A store's contents are kept per entry, so a target has to name one. */
  const checkTarget = (target: string, where: string) => {
    const parsed = parseAddress(target);
    if (!parsed.ok) problems.push(`${where}: ${parsed.error}`);
    else if (parsed.address.entry === null) {
      problems.push(`${where}: "${target}" names a block but not which of its entries, as in "${target}.<entry>".`);
    } else check(parsed.address, where);
  };

  check(execution.trigger.at, "trigger.at");
  // What sets the system going is a step like any other: it says what it is,
  // and where the run arrives in the code.
  if (execution.trigger.description === undefined) problems.push('trigger: say what sets this going, with "description".');
  if (execution.trigger.code === undefined) {
    problems.push('trigger: name the code it arrives at, with "code", as in "src/client/ui/sendButton.ts#onSendPressed".');
  }
  for (const target of Object.keys(execution.given)) checkTarget(target, `given.${target}`);

  for (const event of execution.declared?.events ?? []) {
    if (event.id === TRIGGER_ID || event.type === "return") continue;
    const where = `trace step ${event.id.startsWith("#") ? event.id : `"${event.id}"`}`;
    if (event.type === "effect") {
      check(event.at, `${where}, at`);
    } else {
      if (event.from) check(event.from, `${where}, from`);
      check(event.to, `${where}, to`);
      // A step is only worth stepping through if it says what it is and
      // where the code that does it lives.
      if (event.description === undefined) {
        problems.push(`${where}: say what this step is, with "description".`);
      }
      if (event.code === undefined) {
        problems.push(`${where}: name the code that makes it, with "code", as in "src/api/router.ts#handleSend".`);
      }
    }
  }

  const expected = execution.expect;
  if (expected) {
    expected.entered.forEach((address, i) => check(address, `expect.entered.${i}`));
    expected.interactions.forEach((wanted, i) => {
      if (wanted.from) check(wanted.from, `expect.interactions.${i}.from`);
      if (wanted.to) check(wanted.to, `expect.interactions.${i}.to`);
    });
    expected.effects.forEach((wanted, i) => {
      if (wanted.at) check(wanted.at, `expect.effects.${i}.at`);
    });
    expected.never.forEach((address, i) => check(address, `expect.never.${i}`));
    for (const target of Object.keys(expected.state)) checkTarget(target, `expect.state.${target}`);
  }

  return problems;
}

