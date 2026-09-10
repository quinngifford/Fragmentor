"use strict";

// Runs one block and reports what happened, as JSON on stdout.
//
// This is deliberately a separate process. A block is code Fragmentor did not
// write, and it should not be able to hang the window, read outside the
// project, or reach the network without that being a decision.
//
// argv: <implPath> <functionName> <capabilitiesJson> <projectDir>
// stdin: the block's input, as JSON.

const fs = require("node:fs/promises");
const path = require("node:path");

const [implPath, functionName, capabilitiesJson, projectDir] = process.argv.slice(2);
const logs = [];

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

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function report(result) {
  process.stdout.write(JSON.stringify({ ...result, logs }));
}

async function main() {
  const input = JSON.parse((await readStdin()) || "{}");
  const caps = buildCapabilities(JSON.parse(capabilitiesJson));

  const module = require(implPath);
  const block = module[functionName];
  if (typeof block !== "function") {
    throw new Error(`${path.basename(implPath)} does not export a function called ${functionName}.`);
  }

  report({ ok: true, output: await block(input, caps) });
}

main().catch((error) => {
  report({ ok: false, error: error && error.message ? error.message : String(error) });
});
