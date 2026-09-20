import { describe, expect, it } from "vitest";
import {
  activates,
  enters,
  isInside,
  nextStep,
  place,
  placeEvent,
} from "./trace.js";
import { parseAddress } from "../project/executions.js";
import type { Address, Effect, Interaction, InteractionKind, Return, Trace, View } from "./trace.js";

const a = (text: string): Address => {
  const parsed = parseAddress(text);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.address;
};

const interaction = (
  id: string,
  from: string | null,
  to: string,
  kind: InteractionKind,
  cause: string | null,
  payload?: unknown,
): Interaction => ({
  type: "interaction",
  id,
  cause,
  from: from === null ? null : a(from),
  to: a(to),
  kind,
  ...(payload === undefined ? {} : { payload }),
});

const returned = (of: Interaction, response?: unknown): Return => ({
  type: "return",
  id: `${of.id}.returned`,
  of: of.id,
  from: of.from,
  to: of.to,
  ...(response === undefined ? {} : { response }),
});

const effect = (id: string, at: string, kind: string, cause: string): Effect => ({ type: "effect", id, cause, at: a(at), kind });

const view = (...expanded: string[]): View => ({ expanded: new Set(expanded) });

/**
 * The person's own example: sending a chat message.
 *
 *   app
 *   ├── client        ui/button, ui/chat-view, state
 *   ├── api           router, auth, messaging/save-message, messaging/notify-recipient
 *   └── infrastructure  database (messages), queue (publish)
 *
 * The router hands the message to saveMessage, which writes the database,
 * and then — as a second branch from the router, not from the database —
 * to notifyRecipient, which publishes to the queue.
 */
const click = interaction("click", null, "app/client/ui/button", "trigger", null);
const toState = interaction("to-state", "app/client/ui/button", "app/client/state", "call", "click", { text: "hi" });
const toRouter = interaction("to-router", "app/client/state", "app/api/router", "call", "to-state", { text: "hi", to: "bo" });
const save = interaction("save", "app/api/router", "app/api/messaging/save-message", "call", "to-router", { text: "hi" });
const write = interaction("write", "app/api/messaging/save-message", "app/infrastructure/database.messages", "write", "save", {
  id: "m1",
  text: "hi",
});
const rowChanged = effect("row-changed", "app/infrastructure/database.messages", "row-changed", "write");
const saved = returned(save, { id: "m1" });
const notify = interaction("notify", "app/api/router", "app/api/messaging/notify-recipient", "call", "to-router", { id: "m1" });
const publish = interaction("publish", "app/api/messaging/notify-recipient", "app/infrastructure/queue.publish", "send", "notify", {
  to: "bo",
});
const published = effect("published", "app/infrastructure/queue.publish", "message-published", "publish");

const chat: Trace = {
  source: "recorded",
  execution: "send-a-message",
  events: [click, toState, toRouter, save, write, rowChanged, saved, notify, publish, published],
};

describe("addresses", () => {
  it("reads a component, and a component with one of its entries", () => {
    expect(parseAddress("app/api/messaging")).toEqual({ ok: true, address: { path: "app/api/messaging", entry: null } });
    expect(parseAddress("app/infrastructure/queue.publish")).toEqual({
      ok: true,
      address: { path: "app/infrastructure/queue", entry: "publish" },
    });
  });

  it("refuses what is not an address", () => {
    expect(parseAddress("App/Api").ok).toBe(false);
    expect(parseAddress("app//api").ok).toBe(false);
    expect(parseAddress("app/queue.9lives").ok).toBe(false);
    expect(parseAddress("").ok).toBe(false);
  });

  it("matches everything inside a component, or exactly one entry", () => {
    expect(isInside(a("app/api/messaging/save-message"), a("app/api"))).toBe(true);
    expect(isInside(a("app/api"), a("app/api"))).toBe(true);
    expect(isInside(a("app/apis"), a("app/api"))).toBe(false);
    expect(isInside(a("app/infrastructure/queue.publish"), a("app/infrastructure"))).toBe(true);
    expect(isInside(a("app/infrastructure/queue.publish"), a("app/infrastructure/queue.publish"))).toBe(true);
    expect(isInside(a("app/infrastructure/queue"), a("app/infrastructure/queue.publish"))).toBe(false);
  });
});

describe("placing an address", () => {
  it("draws it at the deepest visible component that contains it", () => {
    expect(place(a("app/api/messaging/save-message"), view())).toEqual(a("app"));
    expect(place(a("app/api/messaging/save-message"), view("app"))).toEqual(a("app/api"));
    expect(place(a("app/api/messaging/save-message"), view("app", "app/api"))).toEqual(a("app/api/messaging"));
    expect(place(a("app/api/messaging/save-message"), view("app", "app/api", "app/api/messaging"))).toEqual(
      a("app/api/messaging/save-message"),
    );
  });

  it("keeps an entry only when its component is expanded to show it", () => {
    expect(place(a("app/infrastructure/queue.publish"), view("app", "app/infrastructure"))).toEqual(a("app/infrastructure/queue"));
    expect(place(a("app/infrastructure/queue.publish"), view("app", "app/infrastructure", "app/infrastructure/queue"))).toEqual(
      a("app/infrastructure/queue.publish"),
    );
  });

  it("keeps the entries of a component that shows them without opening it", () => {
    const withTables = { expanded: new Set(["app", "app/api"]), entries: new Set(["app/api", "app/infrastructure"]) };
    // The service shows its operations, and is still closed to what is inside it.
    expect(place(a("app/api.sendMessage"), { expanded: new Set(["app"]), entries: new Set(["app/api"]) })).toEqual(a("app/api.sendMessage"));
    expect(place(a("app/api/router"), { expanded: new Set(["app"]), entries: new Set(["app/api"]) })).toEqual(a("app/api"));
    // Entries of something not drawn are not drawn either.
    expect(place(a("app/infrastructure/queue.publish"), withTables)).toEqual(a("app/infrastructure"));
  });

  it("does not open a component because something deeper inside it is marked expanded", () => {
    expect(place(a("app/api/messaging/save-message"), view("app", "app/api/messaging"))).toEqual(a("app/api"));
  });
});

describe("a service's own entry", () => {
  const press = interaction("press", null, "app/client", "trigger", null);
  const request = interaction("request", "app/client", "app/api.sendMessage", "call", "press");
  const handle = interaction("handle", "app/api.sendMessage", "app/api/router", "call", "request");
  const trace: Trace = { source: "declared", execution: "x", events: [press, request, handle] };

  it("is the service itself while it is collapsed", () => {
    expect(placeEvent(request, view("app"))).toMatchObject({ on: "edge", key: "app/client->app/api" });
    // What the service then does with the call is inside the service.
    expect(placeEvent(handle, view("app"))).toMatchObject({ on: "inside", key: "app/api" });
  });

  it("stays one place while the service shows its operations, so what it does with a call is inside it", () => {
    const showing: View = { expanded: new Set(["", "app"]), entries: new Set(["app/api"]) };
    expect(placeEvent(request, showing)).toMatchObject({ on: "edge", key: "app/client->app/api.sendMessage" });
    expect(placeEvent(handle, showing)).toMatchObject({ on: "inside", key: "app/api" });
    expect(nextStep(trace, showing, 1)).toBeNull();
  });

  it("is the edge of its frame once it is expanded, and the call carries on to what answers it", () => {
    expect(placeEvent(handle, view("app", "app/api"))).toMatchObject({
      on: "edge",
      key: "app/api.sendMessage->app/api/router",
    });
  });
});

describe("entering and activating", () => {
  it("activates a component when something happens inside it, whether or not it crossed in", () => {
    expect(activates(save, a("app/api"))).toBe(true);
    expect(enters(save, a("app/api"))).toBe(false);
  });

  it("enters a component when the run crosses into it from outside", () => {
    expect(enters(save, a("app/api/messaging"))).toBe(true);
    expect(enters(toRouter, a("app/api"))).toBe(true);
    expect(enters(click, a("app/client"))).toBe(true);
  });

  it("activates where a call leaves from without entering it", () => {
    expect(activates(write, a("app/api/messaging"))).toBe(true);
    expect(enters(write, a("app/api/messaging"))).toBe(false);
    expect(enters(write, a("app/infrastructure"))).toBe(true);
  });

  it("does not count a response coming back as entering", () => {
    expect(activates(saved, a("app/api/router"))).toBe(true);
    expect(enters(saved, a("app/api/router"))).toBe(false);
  });

  it("activates where an effect lands", () => {
    expect(activates(published, a("app/infrastructure/queue"))).toBe(true);
    expect(activates(published, a("app/api"))).toBe(false);
  });
});

describe("stepping", () => {
  const zoomedOut = view("app");

  it("steps to the next thing that changes what is drawn, passing over activity hidden inside", () => {
    expect(nextStep(chat, zoomedOut, -1)).toBe(0); // the click arrives at the client
    expect(nextStep(chat, zoomedOut, 0)).toBe(2); // button -> state stays inside the client
    expect(nextStep(chat, zoomedOut, 2)).toBe(4); // router -> saveMessage stays inside the API
    expect(nextStep(chat, zoomedOut, 4)).toBe(5); // the row changing is an effect, and is drawn
    expect(nextStep(chat, zoomedOut, 5)).toBe(8); // the return and the second call stay inside the API
    expect(nextStep(chat, zoomedOut, 9)).toBeNull();
    expect(nextStep(chat, zoomedOut, -7)).toBe(0);
  });

  it("steps into every event when asked", () => {
    expect(nextStep(chat, zoomedOut, 0, true)).toBe(1);
    expect(nextStep(chat, zoomedOut, 2, true)).toBe(3);
  });

  it("steps more finely the more is open", () => {
    expect(nextStep(chat, view("app", "app/client", "app/api", "app/api/messaging"), 0)).toBe(1);
  });
});
