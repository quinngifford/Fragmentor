import { register } from "node:module";
globalThis.__track = (name, fn) => { const w = function (...a) { console.log("call", name, JSON.stringify(a)); const r = fn.apply(this, a); console.log("return", name, JSON.stringify(r)); return r; }; return w; };
globalThis.__unseen = (name, why) => console.log("unseen", name, why);
register("./hooks.mjs", import.meta.url);
