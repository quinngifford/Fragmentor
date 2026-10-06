const Module = require("node:module");
const wrap = (name, fn) => function (...a) { console.log("call", name, JSON.stringify(a)); const r = fn.apply(this, a); console.log("return", name, JSON.stringify(r)); return r; };
globalThis.__track = wrap;
const compile = Module.prototype._compile;
Module.prototype._compile = function (content, filename) {
  if (filename.endsWith("auth.cjs")) {
    content += ["logIn", "logOut", "route"].map((n) => `\n;try { ${n} = globalThis.__track(${JSON.stringify(n)}, ${n}); if (exports.${n} !== undefined) exports.${n} = ${n}; } catch (e) { console.log("unseen", ${JSON.stringify(n)}, e.message); }`).join("");
  }
  return compile.call(this, content, filename);
};
