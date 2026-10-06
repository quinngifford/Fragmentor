if (!require("node:worker_threads").isMainThread) return;
const { register } = require("node:module");
const { pathToFileURL } = require("node:url");
globalThis.__track = (name, fn) => function (...a) { console.log("call", name); return fn.apply(this, a); };
globalThis.__unseen = (name, why) => console.log("unseen", name, why);
register(pathToFileURL(__dirname + "/hooks.mjs"));
