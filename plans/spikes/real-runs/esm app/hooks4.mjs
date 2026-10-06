import { register } from "node:module";
const seen = [];
globalThis.__ft = { wrap(name, fn) { const w = function (...a) { seen.push(name); return fn.apply(this, a); }; Object.defineProperty(w, "length", { value: fn.length }); Object.defineProperty(w, "name", { value: fn.name }); return w; } };
register("./loader4.mjs", import.meta.url);
process.on("exit", () => console.log("seen:", seen.join(","), "missed:", globalThis.__ft.missed));
