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
// along the way.
//
// Tracing wraps every block beneath the one being run before anything runs. A
// composite reaches a child through the child module's exports at the moment
// it calls it, so replacing the export is enough to see every call, which is
// how the diagram shows what flowed along each wire, and to hold a call back
// at a breakpoint.

const fs = require("node:fs/promises");
const path = require("node:path");
const { AsyncLocalStorage } = require("node:async_hooks");

const logs = [];
let projectDir = "";

/** Nothing a block does may touch a file outside the project it belongs to. */
function insideProject(target) {
  const root = path.resolve(projectDir);
  const resolved = path.resolve(root, target);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${target} is outside the project, so the test bench will not open it.`);
  }
  return resolved;
}

const CAPABILITIES = {
  FileSystem: () => ({
    async readFile(target) {
      return fs.readFile(insideProject(target), "utf8");
    },
    async writeFile(target, contents) {
      await fs.writeFile(insideProject(target), contents, "utf8");
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
    caps[entry.name] = make();
  }
  return caps;
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

/** Past this many calls a run carries on, but stops being recorded. */
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
const started = Date.now();
let calls = 0;

let breakpoints = new Set();
let stepping = false;

/**
 * Calls held at a breakpoint. Several can arrive at once — a child run once
 * per item is called for every item together — so they wait their turn, and
 * only the first is reported as paused.
 */
const held = [];

function hold(id) {
  return new Promise((release) => {
    held.push({ id, release });
    if (held.length === 1) send({ type: "paused", id });
  });
}

function releaseNext(mode) {
  const next = held.shift();
  if (!next) return;
  stepping = mode === "step";
  send({ type: "resumed", id: next.id });
  next.release();
  if (held.length > 0) send({ type: "paused", id: held[0].id });
}

function traced(blockPath, fn) {
  return async function tracedBlock(input, caps) {
    const id = ++calls;
    const recorded = id <= MOST_CALLS_RECORDED;
    const at = () => Date.now() - started;

    if (recorded) {
      send({ type: "call", id, parent: within.getStore() ?? null, block: blockPath, input: recordable(input), at: at() });
      if (stepping || breakpoints.has(blockPath)) {
        stepping = false;
        await hold(id);
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
  breakpoints = new Set(spec.breakpoints || []);
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
  try {
    send({ type: "result", ...result, logs });
  } catch (error) {
    send({ type: "result", ok: false, error: `The block returned something that cannot be sent back: ${messageOf(error)}`, logs });
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
