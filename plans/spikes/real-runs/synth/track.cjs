const Module = require("node:module");
const orig = Module.prototype._compile;
globalThis.__t = (n, f) => { const w = function (...a) { console.log("call", n, a); return Reflect.apply(f, this, a); }; Object.defineProperty(w, "name", { value: f.name }); Object.defineProperty(w, "length", { value: f.length }); return w; };
Module.prototype._compile = function (src, file) {
  if (file.endsWith("lib.js")) {
    const m = /^(\s*(?:(["'])use strict\2;?))/.exec(src);
    const at = m ? m[1].length : 0;
    src = src.slice(0, at) + "try{a=__t('a',a)}catch{}try{b=__t('b',b)}catch{}" + src.slice(at);
  }
  return orig.call(this, src, file);
};
