import Module from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
const ROOT = path.resolve("cjs");
// pointers as blocks write them: source file relative to project root
const MAP = { "src/router.ts": [["route", "app/router"], ["inner", "app/inner"], ["arrow", "app/arrow"]], "src/auth.ts": [["checkSession", "app/auth/check-session"]] };
function sourceOf(file) {
  const rel = path.relative(ROOT, file).replaceAll("\\", "/");
  if (MAP[rel]) return rel;
  const map = file + ".map";
  if (!existsSync(map)) return null;
  const sources = JSON.parse(readFileSync(map, "utf8")).sources ?? [];
  for (const s of sources) { const r = path.relative(ROOT, path.resolve(path.dirname(file), s)).replaceAll("\\", "/"); if (MAP[r]) return r; }
  return null;
}
const within = new AsyncLocalStorage(); let calls = 0; const t0 = performance.now();
globalThis.__fragmentorTrack = (block, fn) => function tracked(...args) {
  const id = ++calls; const parent = within.getStore() ?? null; const at = () => +(performance.now() - t0).toFixed(3);
  console.log(JSON.stringify({ type: "call", id, parent, block, at: at() }));
  const done = (o) => { console.log(JSON.stringify({ type: "return", id, output: o, at: at() })); return o; };
  let r; try { r = within.run(id, () => Reflect.apply(fn, this, args)); } catch (e) { console.log(JSON.stringify({type:"throw",id})); throw e; }
  return r instanceof Promise ? r.then(done) : done(r);
};
const compile = Module.prototype._compile;
Module.prototype._compile = function (content, filename) {
  const src = sourceOf(filename);
  if (src) {
    for (const [fn, block] of MAP[src]) {
      content = content.replace(new RegExp(String.raw`\bconst\s+` + fn + String.raw`\s*=`), `let ${fn} =`);
      content += `\n{ const o = ${fn}; ${fn} = globalThis.__fragmentorTrack(${JSON.stringify(block)}, o); if (typeof exports === "object" && exports !== null && exports.${fn} === o) exports.${fn} = ${fn}; }`;
    }
  }
  return compile.call(this, content, filename);
};
