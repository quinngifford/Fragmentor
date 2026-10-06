import { registerHooks } from "node:module";
const seen = [];
globalThis.__ft = { wrap(name, fn) { const w = function (...a) { seen.push(name); return fn.apply(this, a); }; Object.defineProperty(w, "length", { value: fn.length }); Object.defineProperty(w, "name", { value: fn.name }); return w; } };
registerHooks({
  load(url, context, nextLoad) {
    const r = nextLoad(url, context);
    if (url.endsWith("/lib.js")) {
      const src = String(r.source);
      return { ...r, source: src + "\n;inner = globalThis.__ft.wrap('inner', inner); outer = globalThis.__ft.wrap('outer', outer);\n" };
    }
    return r;
  },
});
process.on("exit", () => console.log("seen:", seen.join(",")));
