"use strict";

// Runs one block and reports what happened.
//
// This is deliberately a separate process. A block is code Fragmentor did not
// write, and it should not be able to hang the window, read outside the
// project, or reach the network without that being a decision.
//
// It talks to Fragmentor over the IPC channel rather than stdout, so nothing a
// block or a package prints can be mistaken for a report. Fragmentor sends one
// "start" message holding everything needed, and the harness answers with a
// "result" — and, when the run is traced, with an event for every block call
// along the way and every read, write, remove and send on the stores it was
// given.
//
// Tracing wraps every function in the system before anything runs. Code
// reaches another block through that block module's exports at the moment it
// calls it, so replacing the export is enough to see every call, whoever makes
// it, and to hold a call back at a breakpoint.

const fs = require("node:fs/promises");
const path = require("node:path");
const { AsyncLocalStorage } = require("node:async_hooks");

const logs = [];
let projectDir = "";
/** The project `projectDir` is a copy of, when it is one, or null. */
let copyOf = null;

/** Nothing a block does may touch a file outside the project it belongs to. */
function insideProject(target, project = projectDir) {
  const root = path.resolve(project);
  const resolved = path.resolve(root, target);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${target} is outside the project, so the test bench will not open it.`);
  }
  return resolved;
}

/**
 * What the stores this run reaches are holding, by the name the run keeps each
 * under. Seeded before anything runs and reported back at the end, so a test
 * can put rows in and see what the block left behind.
 *
 * A store lives here rather than in the substitute itself because two ports
 * can be ways into the same thing — a block that reads a table and another
 * that writes it — and a write through one has to be visible through the
 * other, exactly as it would be in the real system.
 */
const stores = new Map();

function storeState(target, kind) {
  let state = stores.get(target);
  if (!state) {
    state = kind === "queue" ? { kind: "queue", sent: [] } : { kind: "store", rows: {} };
    stores.set(target, state);
  }
  return state;
}

/** A copy, so nothing a block keeps a reference to can change what the store holds behind its back. */
function copy(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

const CAPABILITIES = {
  Store: (port) => {
    const state = storeState(port.target, "store");
    Object.assign(state.rows, copy(port.seed) ?? {});
    return {
      async read(key) {
        const row = Object.hasOwn(state.rows, String(key)) ? copy(state.rows[String(key)]) : null;
        reportStore(port.target, "read", String(key), row);
        return row;
      },
      async list() {
        const rows = Object.values(state.rows).map(copy);
        reportStore(port.target, "list", undefined, rows);
        return rows;
      },
      async write(key, row) {
        state.rows[String(key)] = copy(row);
        reportStore(port.target, "write", String(key), row);
      },
      // What a remove took away is read first, so a run can be seen to have
      // removed the row it meant to, and not merely to have asked.
      async remove(key) {
        const removed = Object.hasOwn(state.rows, String(key)) ? state.rows[String(key)] : null;
        delete state.rows[String(key)];
        reportStore(port.target, "remove", String(key), removed);
      },
    };
  },
  Queue: (port) => {
    const state = storeState(port.target, "queue");
    return {
      async send(message) {
        state.sent.push(copy(message));
        reportStore(port.target, "send", undefined, message);
      },
    };
  },
  // A copy holds only the blocks and their code, so a file it does not hold
  // is read from the project it copies. What a run writes stays in the copy,
  // in a folder made for it where the copy has none, and is what it reads
  // back.
  FileSystem: () => ({
    async readFile(target) {
      const file = insideProject(target);
      try {
        return await fs.readFile(file, "utf8");
      } catch (error) {
        if (copyOf === null || error.code !== "ENOENT") throw error;
        return fs.readFile(insideProject(target, copyOf), "utf8");
      }
    },
    async writeFile(target, contents) {
      const file = insideProject(target);
      if (copyOf !== null) await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, contents, "utf8");
    },
  }),
  Logger: () => ({
    log(message) {
      logs.push(String(message));
    },
  }),
  Clock: () => ({
    now() {
      return Date.now();
    },
  }),
  Random: () => ({
    next() {
      return Math.random();
    },
  }),
  Http: () => ({
    async get() {
      throw new Error("The test bench does not provide network access. Substitute this capability to test the block.");
    },
  }),
};

function buildCapabilities(spec) {
  const caps = {};
  for (const entry of spec) {
    const make = CAPABILITIES[entry.capability];
    if (!make) throw new Error(`No test-bench substitute for the capability "${entry.capability}".`);
    caps[entry.name] = make(entry);
  }
  return caps;
}

/** What every store this run touched was left holding, for the bench to show. */
function storeEffects() {
  return Object.fromEntries(stores);
}

function messageOf(error) {
  return error && error.message ? error.message : String(error);
}

function send(message) {
  if (process.connected) process.send(message);
}

/* -------------------------------------------------------------------------- */
/* Tracing                                                                     */
/* -------------------------------------------------------------------------- */

/** Past this many calls and store uses a run carries on, but stops being recorded, and says so. */
const MOST_CALLS_RECORDED = 2000;
/** A value larger than this, as JSON, is described rather than sent. */
const LARGEST_VALUE_RECORDED = 200000;

function recordable(value) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    return "(a value that cannot be written as JSON)";
  }
  if (text === undefined) return null;
  return text.length > LARGEST_VALUE_RECORDED ? `(a value too large to record: ${text.length} characters of JSON)` : value;
}

/** The call the code running now belongs to, carried across awaits. */
const within = new AsyncLocalStorage();
/** The finest clock there is: whole milliseconds would round most calls here to nothing. */
const now = () => (typeof performance === "undefined" ? Date.now() : performance.now());
const started = now();
/** Block calls and store uses so far, counted together, so each has an id of its own. */
let calls = 0;
/** Whether anyone is watching: set once the run starts. */
let tracing = false;

/**
 * What a block did to a store or a queue, reported after it was done, as the
 * call that was running did it. A stand-in store is the one place a run's
 * reads and writes can be seen, so a recording of the run learns them here.
 */
function reportStore(target, op, key, value) {
  // A port that is a way into nothing on the diagram has nowhere to be drawn.
  if (!tracing || target === undefined) return;
  const id = ++calls;
  if (id > MOST_CALLS_RECORDED) return;
  send({
    type: "store",
    id,
    parent: within.getStore() ?? null,
    target,
    op,
    ...(key === undefined ? {} : { key }),
    value: recordable(value),
    at: now() - started,
  });
}

let breakpoints = new Set();
let stepping = false;

/**
 * Calls held at a breakpoint. Several can arrive at once — a child run once
 * per item is called for every item together — so they wait their turn. The
 * first is the one reported as paused and the one a resume lets go, and each
 * time a different call comes first, that is reported.
 */
const held = [];

function reportFirst() {
  if (held.length > 0) send({ type: "paused", id: held[0].id });
}

function hold(id, blockPath, ahead) {
  return new Promise((release) => {
    const entry = { id, blockPath, release };
    // A step goes into the call it let go, so what that call starts comes
    // next, ahead of the calls still waiting their turn.
    if (ahead) held.unshift(entry);
    else held.push(entry);
    if (ahead || held.length === 1) reportFirst();
  });
}

function letGo(entry) {
  send({ type: "resumed", id: entry.id });
  entry.release();
}

function releaseNext(mode) {
  const next = held.shift();
  if (!next) return;
  stepping = mode === "step";
  letGo(next);
  if (mode !== "step") {
    // Calls held by an earlier step, or at a breakpoint that has since been
    // taken away, have nothing left to wait for.
    for (const entry of held.filter((each) => !breakpoints.has(each.blockPath))) {
      held.splice(held.indexOf(entry), 1);
      letGo(entry);
    }
  }
  if (mode === "block") {
    // A block run once per item is called for every item at once, so its
    // calls would otherwise have to be let go one at a time. This lets the
    // whole block through, and leaves the breakpoint where it is.
    for (const entry of held.filter((each) => each.blockPath === next.blockPath)) {
      held.splice(held.indexOf(entry), 1);
      letGo(entry);
    }
  }
  reportFirst();
}

function traced(blockPath, fn) {
  return async function tracedBlock(input, caps) {
    const id = ++calls;
    const recorded = id <= MOST_CALLS_RECORDED;
    const at = () => now() - started;

    if (recorded) {
      send({ type: "call", id, parent: within.getStore() ?? null, block: blockPath, input: recordable(input), at: at() });
      if (stepping || breakpoints.has(blockPath)) {
        const ahead = stepping;
        stepping = false;
        await hold(id, blockPath, ahead);
      }
    }

    try {
      const output = await within.run(id, () => fn(input, caps));
      if (recorded) send({ type: "return", id, output: recordable(output), at: at() });
      return output;
    } catch (error) {
      if (recorded) send({ type: "throw", id, error: messageOf(error), at: at() });
      throw error;
    }
  };
}

/* -------------------------------------------------------------------------- */
/* Running                                                                     */
/* -------------------------------------------------------------------------- */

async function run(spec) {
  projectDir = spec.projectDir;
  copyOf = spec.copyOf ?? null;
  breakpoints = new Set(spec.breakpoints || []);
  tracing = Boolean(spec.trace);
  const caps = buildCapabilities(spec.capabilities);

  if (spec.trace) {
    for (const block of spec.blocks) {
      try {
        const exports = require(block.file);
        const fn = exports[block.functionName];
        if (typeof fn === "function") exports[block.functionName] = traced(block.path, fn);
      } catch {
        // A block that will not load, or whose export cannot be replaced,
        // simply goes unseen. If the run needs it, requiring the block being
        // run reports the real reason.
      }
    }
  }

  const target = require(spec.file);
  const block = target[spec.functionName];
  if (typeof block !== "function") {
    throw new Error(`${path.basename(spec.file)} does not export a function called ${spec.functionName}.`);
  }
  return block(spec.input, caps);
}

function report(result) {
  // A run that went past the most calls recorded carried on unseen, and
  // whoever reads the recording has to know it is not the whole run.
  const truncated = calls > MOST_CALLS_RECORDED ? { truncated: true } : {};
  try {
    send({ type: "result", ...result, stores: storeEffects(), logs, ...truncated });
  } catch (error) {
    send({
      type: "result",
      ok: false,
      error: `The block returned something that cannot be sent back: ${messageOf(error)}`,
      stores: storeEffects(),
      logs,
      ...truncated,
    });
  }
}

process.on("message", (message) => {
  if (!message || typeof message !== "object") return;
  if (message.type === "start") {
    run(message.spec).then(
      (output) => report({ ok: true, output }),
      (error) => report({ ok: false, error: messageOf(error) }),
    );
  } else if (message.type === "resume") {
    releaseNext(message.mode);
  } else if (message.type === "breakpoints") {
    breakpoints = new Set(message.paths);
  }
});

// If Fragmentor goes away, there is no one left to report to.
process.on("disconnect", () => process.exit(0));
