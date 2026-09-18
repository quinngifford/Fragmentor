import { describe, expect, it } from "vitest";
import {
  activates,
  enters,
  isInside,
  nextStep,
  place,
  placeEvent,
  project,
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

const edgesOf = (trace: Trace, at: View) =>
  Object.fromEntries([...project(trace, at).edges.values()].map((edge) => [edge.key, edge.interactions.length]));

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

describe("drawing the same trace at every resolution", () => {
  it("zoomed right out: client, API and infrastructure", () => {
    expect(edgesOf(chat, view("app"))).toEqual({
      "(outside)->app/client": 1,
      "app/client->app/api": 1,
      "app/api->app/infrastructure": 2,
    });
  });

  it("inside the API: router, messaging, and the infrastructure it reaches", () => {
    expect(edgesOf(chat, view("app", "app/api"))).toEqual({
      "(outside)->app/client": 1,
      "app/client->app/api/router": 1,
      "app/api/router->app/api/messaging": 2,
      "app/api/messaging->app/infrastructure": 2,
    });
  });

  it("inside messaging, with the infrastructure open as well", () => {
    expect(edgesOf(chat, view("app", "app/api", "app/api/messaging", "app/infrastructure"))).toEqual({
      "(outside)->app/client": 1,
      "app/client->app/api/router": 1,
      "app/api/router->app/api/messaging/save-message": 1,
      "app/api/messaging/save-message->app/infrastructure/database": 1,
      "app/api/router->app/api/messaging/notify-recipient": 1,
      "app/api/messaging/notify-recipient->app/infrastructure/queue": 1,
    });
  });

  it("fully open, down to the entries", () => {
    const edges = edgesOf(
      chat,
      view("app", "app/api", "app/api/messaging", "app/infrastructure", "app/infrastructure/database", "app/infrastructure/queue"),
    );
    expect(edges["app/api/messaging/notify-recipient->app/infrastructure/queue.publish"]).toBe(1);
    expect(edges["app/api/messaging/save-message->app/infrastructure/database.messages"]).toBe(1);
  });

  it("expands one region without having to expand the one beside it", () => {
    expect(edgesOf(chat, view("app", "app/infrastructure"))).toEqual({
      "(outside)->app/client": 1,
      "app/client->app/api": 1,
      "app/api->app/infrastructure/database": 1,
      "app/api->app/infrastructure/queue": 1,
    });
  });

  it("keeps what happens inside a collapsed component as activity within it", () => {
    const projection = project(chat, view("app"));
    expect(projection.inside.get("app/client")?.map((each) => each.id)).toEqual(["to-state"]);
    expect(projection.inside.get("app/api")?.map((each) => each.id)).toEqual(["save", "notify"]);
  });

  it("puts every event somewhere, whatever is expanded", () => {
    const views = [
      view(),
      view("app"),
      view("app", "app/api"),
      view("app", "app/infrastructure"),
      view("app", "app/client", "app/client/ui", "app/api", "app/api/messaging", "app/infrastructure", "app/infrastructure/queue"),
    ];
    for (const at of views) {
      const projection = project(chat, at);
      const drawn = [
        ...[...projection.edges.values()].flatMap((edge) => edge.interactions),
        ...[...projection.inside.values()].flat(),
        ...[...projection.effects.values()].flat(),
      ].map((each) => each.id);
      expect(drawn.sort()).toEqual(chat.events.filter((event) => event.type !== "return").map((event) => event.id).sort());

      // A return lands where the interaction it completes was drawn.
      for (const event of chat.events.filter((each): each is Return => each.type === "return")) {
        const completes = chat.events.find((each) => each.id === event.of)!;
        expect(placeEvent(event, at)).toEqual(placeEvent(completes, at));
      }
    }
  });

  it("never changes the trace it draws", () => {
    const before = JSON.stringify(chat);
    project(chat, view("app"));
    project(chat, view("app", "app/api", "app/api/messaging"));
    expect(JSON.stringify(chat)).toBe(before);
  });

  it("puts effects on the component responsible, at whatever resolution", () => {
    expect([...project(chat, view("app")).effects.get("app/infrastructure")!].map((each) => each.kind)).toEqual([
      "row-changed",
      "message-published",
    ]);
    const open = project(chat, view("app", "app/infrastructure", "app/infrastructure/queue"));
    expect(open.effects.get("app/infrastructure/queue.publish")?.map((each) => each.id)).toEqual(["published"]);
    expect(open.effects.get("app/infrastructure/database")?.map((each) => each.id)).toEqual(["row-changed"]);
  });

  it("marks what was involved at this resolution, so the rest can be dimmed", () => {
    expect([...project(chat, view("app")).involved].sort()).toEqual(["app/api", "app/client", "app/infrastructure"]);
    // Auth is on screen once the API is open, and nothing happened in it.
    expect([...project(chat, view("app", "app/api")).involved].sort()).toEqual([
      "app/api/messaging",
      "app/api/router",
      "app/client",
      "app/infrastructure",
    ]);
  });

  it("stops part way through, for playing a trace back", () => {
    expect(Object.keys(edgesOf({ ...chat, events: chat.events.slice(0, 3) }, view("app")))).toEqual([
      "(outside)->app/client",
      "app/client->app/api",
    ]);
    expect([...project(chat, view("app"), 2).edges.keys()]).toEqual(["(outside)->app/client", "app/client->app/api"]);
  });

  it("draws nothing before the first event, however far back it is asked for", () => {
    expect(project(chat, view("app"), -1).edges.size).toBe(0);
    expect(project(chat, view("app"), -5).edges.size).toBe(0);
  });

  it("keeps outside the system apart from a block that happens to be called outside", () => {
    const trace: Trace = {
      source: "declared",
      execution: "x",
      events: [interaction("t", null, "outside", "trigger", null), interaction("c", "outside", "app", "call", "t")],
    };
    expect(edgesOf(trace, view())).toEqual({ "(outside)->outside": 1, "outside->app": 1 });
    expect(nextStep(trace, view(), -1)).toBe(0);
  });
});

describe("whether anything travelled", () => {
  it("is false for a trigger that carries nothing", () => {
    expect(project(chat, view("app")).edges.get("(outside)->app/client")?.carriesData).toBe(false);
  });

  it("is true for a payload one way", () => {
    expect(project(chat, view("app")).edges.get("app/client->app/api")?.carriesData).toBe(true);
  });

  it("is true for a response coming back along an edge that sent nothing", () => {
    const read = interaction("read", "app/api", "app/db.users", "read", null);
    const trace: Trace = { source: "recorded", execution: "x", events: [read, returned(read, { id: "u1" })] };
    const edge = project(trace, view("app")).edges.get("app/api->app/db");
    expect(edge?.interactions.map((each) => each.id)).toEqual(["read"]);
    expect(edge?.carriesData).toBe(true);
  });
});

describe("a service's own entry", () => {
  const press = interaction("press", null, "app/client", "trigger", null);
  const request = interaction("request", "app/client", "app/api.sendMessage", "call", "press");
  const handle = interaction("handle", "app/api.sendMessage", "app/api/router", "call", "request");
  const trace: Trace = { source: "declared", execution: "x", events: [press, request, handle] };

  it("is the service itself while it is collapsed", () => {
    expect(edgesOf(trace, view("app"))).toEqual({ "(outside)->app/client": 1, "app/client->app/api": 1 });
    expect(project(trace, view("app")).inside.get("app/api")?.map((each) => each.id)).toEqual(["handle"]);
  });

  it("stays one place while the service shows its operations, so what it does with a call is inside it", () => {
    const showing: View = { expanded: new Set(["", "app"]), entries: new Set(["app/api"]) };
    expect(edgesOf(trace, showing)).toEqual({ "(outside)->app/client": 1, "app/client->app/api.sendMessage": 1 });
    expect(project(trace, showing).inside.get("app/api")?.map((each) => each.id)).toEqual(["handle"]);
    expect(nextStep(trace, showing, 1)).toBeNull();
  });

  it("is the edge of its frame once it is expanded, and the call carries on to what answers it", () => {
    expect(edgesOf(trace, view("app", "app/api"))).toEqual({
      "(outside)->app/client": 1,
      "app/client->app/api.sendMessage": 1,
      "app/api.sendMessage->app/api/router": 1,
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
