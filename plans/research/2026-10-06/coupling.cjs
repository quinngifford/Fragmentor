// Read-only: computes Ca, Ce, I from block.json access lines (+ optional extra edges).
const fs = require("fs"), path = require("path");
const [root, extraArg] = process.argv.slice(2);
const blocks = {};
(function walk(dir, rel) {
  const f = path.join(dir, "block.json");
  if (fs.existsSync(f)) blocks[rel] = JSON.parse(fs.readFileSync(f, "utf8"));
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name);
})(root, "");
delete blocks[""];
const role = (p) => blocks[p].role || "function";
// resolve: own parts, then beside, then above (look outward)
function resolve(from, resource) {
  let base = from;
  while (true) {
    const cand = base ? `${base}/${resource}` : resource;
    if (blocks[cand]) return cand;
    if (!base) return null;
    base = base.includes("/") ? base.slice(0, base.lastIndexOf("/")) : "";
  }
}
const edges = new Set();
for (const [p, b] of Object.entries(blocks)) for (const a of b.access || []) {
  const parts = a.trim().split(/ +/); const target = parts[parts.length - 1];
  const res = target.includes(".") ? target.slice(0, target.lastIndexOf(".")) : target;
  const to = resolve(p, res); if (!to) { console.log("UNRESOLVED", p, a); continue; }
  edges.add(`${p}>${to}`);
}
if (extraArg) for (const e of extraArg.split(",")) edges.add(e);
const E = [...edges].map((e) => e.split(">"));
const inside = (x, r) => x === r || x.startsWith(r + "/");
console.log(`blocks=${Object.keys(blocks).length} edges=${E.length}`);
console.log("path".padEnd(42), "role".padEnd(10), "Ca Ce  I");
for (const p of Object.keys(blocks).sort()) {
  const ca = new Set(E.filter(([f, t]) => inside(t, p) && !inside(f, p)).map(([f]) => f)).size;
  const ce = new Set(E.filter(([f, t]) => inside(f, p) && !inside(t, p)).map(([, t]) => t)).size;
  const I = ca + ce === 0 ? "-" : (ce / (ca + ce)).toFixed(2);
  console.log(p.padEnd(42), role(p).padEnd(10), String(ca).padStart(2), String(ce).padStart(2), I);
}
