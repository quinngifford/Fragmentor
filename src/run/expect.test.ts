import { describe, expect, it } from "vitest";
import { parseAddress } from "../model/trace.js";
import type { Address, Effect, Interaction, Trace } from "../model/trace.js";
import { compareValues } from "./compare.js";
import { evaluate } from "./expect.js";
import type { Expectations } from "./expect.js";

const a = (text: string): Address => {
  const parsed = parseAddress(text);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.address;
};

const expecting = (partial: Partial<Expectations>): Expectations => ({
  entered: [],
  interactions: [],
  effects: [],
  never: [],
  state: {},
  ...partial,
});

/**
 * Logging out: nothing is passed in and nothing is returned, and still there
 * is plenty to test.
 */
const press: Interaction = { type: "interaction", id: "trigger", cause: null, from: null, to: a("app/web.logout"), kind: "trigger" };
const handle: Interaction = {
  type: "interaction",
  id: "handle",
  cause: "trigger",
  from: a("app/web.logout"),
  to: a("app/auth/logout"),
  kind: "call",
};
const remove: Interaction = {
  type: "interaction",
  id: "remove",
  cause: "handle",
  from: a("app/auth/logout"),
  to: a("app/sessions.sessions"),
  kind: "remove",
  payload: { key: "s-1" },
};
const removed: Effect = { type: "effect", id: "removed", cause: "remove", at: a("app/sessions.sessions"), kind: "row-removed", detail: { key: "s-1" } };
const redirect: Effect = {
  type: "effect",
  id: "redirect",
  cause: "handle",
  at: a("app/auth/logout"),
  kind: "response",
  detail: { status: 302, redirect: "/login" },
};

const logout: Trace = {
  source: "recorded",
  execution: "logout",
  events: [press, handle, remove, removed, redirect],
  state: { "app/sessions.sessions": { "s-2": { user: "bo" } } },
};

const logoutTest = expecting({
  entered: [a("app/auth")],
  interactions: [{ to: a("app/auth/logout") }, { to: a("app/sessions.sessions"), kind: "remove", payload: { key: "s-1" } }],
  effects: [{ at: a("app/sessions"), kind: "row-removed" }, { kind: "response", detail: { redirect: "/login" } }],
  never: [a("app/payments")],
  state: { "app/sessions.sessions": { "s-2": { user: "bo" } } },
});

describe("evaluating expectations against a trace", () => {
  it("passes a test of something that takes nothing and returns nothing", () => {
    expect(evaluate(logout, logoutTest)).toEqual({ passed: true, failures: [], source: "recorded" });
  });

  it("says when a part that should have been left alone was touched, and by what", () => {
    const charged: Trace = {
      ...logout,
      events: [
        ...logout.events,
        { type: "interaction", id: "charge", cause: "handle", from: a("app/auth/logout"), to: a("app/payments.refund"), kind: "call" },
      ],
    };
    expect(evaluate(charged, logoutTest).failures).toEqual([
      "Nothing should have happened in app/payments, but there was a call from app/auth/logout to app/payments.refund.",
    ]);
  });

  it("says how an interaction differed when one of the right kind happened", () => {
    const result = evaluate(
      logout,
      expecting({ interactions: [{ to: a("app/sessions.sessions"), kind: "remove", payload: { key: "s-9" } }] }),
    );
    expect(result.failures).toEqual([
      'A remove to app/sessions.sessions happened, but not as expected: payload.key was "s-1", expected "s-9".',
    ]);
  });

  it("says when an interaction never happened", () => {
    expect(evaluate(logout, expecting({ interactions: [{ from: a("app/auth"), to: a("app/audit") }] })).failures).toEqual([
      "An interaction from app/auth to app/audit never happened.",
    ]);
  });

  it("matches each expectation to a different event", () => {
    const twice = expecting({ interactions: [{ to: a("app/sessions") }, { to: a("app/sessions") }] });
    expect(evaluate(logout, twice).failures).toEqual([
      "An interaction to app/sessions happened once, which is not enough for every expectation asking for it.",
    ]);
  });

  it("does not depend on the order expectations are written in", () => {
    const read: Interaction = {
      type: "interaction",
      id: "read",
      cause: "handle",
      from: a("app/auth/logout"),
      to: a("app/sessions.tokens"),
      kind: "read",
    };
    const trace: Trace = { ...logout, events: [press, handle, remove, read] };
    const loose = { to: a("app/sessions") };
    const strict = { to: a("app/sessions.sessions"), kind: "remove" as const };
    expect(evaluate(trace, expecting({ interactions: [loose, strict] })).failures).toEqual([]);
    expect(evaluate(trace, expecting({ interactions: [strict, loose] })).failures).toEqual([]);
  });

  it("says when nothing crossed into a part", () => {
    expect(evaluate(logout, expecting({ entered: [a("app/payments")] })).failures).toEqual(["Nothing crossed into app/payments."]);
  });

  it("does not count a call inside a part as crossing into it", () => {
    expect(evaluate(logout, expecting({ entered: [a("app/auth/logout")] })).passed).toBe(true);
    const inside: Trace = { ...logout, events: [handle, remove].map((event) => ({ ...event, from: a("app/auth/logout/x") })) };
    expect(evaluate(inside, expecting({ entered: [a("app/auth/logout")] })).failures).toEqual([
      "Nothing crossed into app/auth/logout.",
    ]);
  });

  it("checks what came back along an interaction", () => {
    const read: Interaction = { type: "interaction", id: "read", cause: null, from: a("app/api"), to: a("app/db.users"), kind: "read" };
    const trace: Trace = {
      source: "recorded",
      execution: "x",
      events: [read, { type: "return", id: "read.returned", of: "read", from: read.from, to: read.to, response: { name: "Ada" } }],
    };
    expect(evaluate(trace, expecting({ interactions: [{ kind: "read", response: { name: "Ada" } }] })).passed).toBe(true);
    expect(evaluate(trace, expecting({ interactions: [{ kind: "read", response: { name: "Bo" } }] })).failures).toEqual([
      'A read happened, but not as expected: response.name was "Ada", expected "Bo".',
    ]);
  });

  it("checks an effect's detail partially", () => {
    expect(evaluate(logout, expecting({ effects: [{ kind: "response", detail: { redirect: "/home" } }] })).failures).toEqual([
      'A "response" effect happened, but not as expected: detail.redirect was "/login", expected "/home".',
    ]);
  });

  it("checks what the stores held at the end", () => {
    const result = evaluate(logout, expecting({ state: { "app/sessions.sessions": { "s-1": { user: "ada" } } } }));
    expect(result.failures).toEqual(["app/sessions.sessions.s-1 is missing.", "app/sessions.sessions.s-2 was not expected."]);
  });

  it("can say a row is gone, by leaving it out", () => {
    const survived: Trace = { ...logout, state: { "app/sessions.sessions": { "s-1": { user: "ada" }, "s-2": { user: "bo" } } } };
    expect(evaluate(survived, logoutTest).failures).toEqual(["app/sessions.sessions.s-1 was not expected."]);
  });

  it("compares each row partially", () => {
    const more: Trace = { ...logout, state: { "app/sessions.sessions": { "s-2": { user: "bo", since: 3 } } } };
    expect(evaluate(more, logoutTest).failures).toEqual([]);
  });

  it("keeps a declared trace's provenance, and cannot check state it never recorded", () => {
    const declared: Trace = { source: "declared", execution: "logout", events: logout.events };
    const result = evaluate(declared, logoutTest);
    expect(result.source).toBe("declared");
    expect(result.failures).toEqual([
      "This trace does not say what the stores held at the end, so what they should hold cannot be checked. Only a recorded run knows.",
    ]);
  });
});

describe("comparing partially", () => {
  it("ignores fields the expectation does not name", () => {
    expect(compareValues({ a: 1, b: 2 }, { a: 1 }, "row", true)).toEqual([]);
    expect(compareValues({ a: 1, b: 2 }, { a: 1 }, "row")).toEqual(["row.b was not expected."]);
  });

  it("still compares lists item for item", () => {
    expect(compareValues([{ a: 1, b: 2 }], [{ a: 1 }, { a: 2 }], "rows", true)).toEqual(["rows has 1 items, expected 2."]);
  });
});
