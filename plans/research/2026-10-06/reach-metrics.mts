// Read-only: loads a COPY of a project with Fragmentor's own kernel and prints
// code-derived reach edges, per-block fan-in/fan-out, and any block-level cycles.
import { loadProject, resolveAccess } from "file:///C:/Users/quinn/OneDrive/CS%20Projects/Fragmentor/src/project/project.ts";
import { readAllCode } from "file:///C:/Users/quinn/OneDrive/CS%20Projects/Fragmentor/src/project/code.ts";
import { readProjectReach } from "file:///C:/Users/quinn/OneDrive/CS%20Projects/Fragmentor/src/project/reach.ts";

const dir = process.argv[2]!;
const project = await loadProject(dir);
const code = await readAllCode(project);
const reach = await readProjectReach(project, code);
const blocks = [...project.byPath.keys()];
const fns = blocks.filter((p) => (project.byPath.get(p)!.block.role ?? "function") === "function");
console.log(`blocks ${blocks.length}, functions ${fns.length}, code reach edges ${reach.edges.length} (approx ${reach.edges.filter((e) => e.approximate).length})`);
console.log("systemsRead", JSON.stringify(reach.systemsRead));
const pairs = new Set<string>();
for (const e of reach.edges) pairs.add(`${e.from} > ${e.to}`);
let declared = 0;
for (const [p, node] of project.byPath) for (const a of node.block.access) { const t = resolveAccess(project, p, a.resource)?.path; if (t) { pairs.add(`${p} > ${t}`); declared++; } }
console.log(`declared access lines ${declared}; distinct block pairs (code + declared) ${pairs.size}`);
const fanIn = new Map<string, number>(), fanOut = new Map<string, number>();
for (const pr of pairs) { const [a, b] = pr.split(" > "); fanOut.set(a!, (fanOut.get(a!) ?? 0) + 1); fanIn.set(b!, (fanIn.get(b!) ?? 0) + 1); }
const rows = blocks.map((p) => ({ p, in: fanIn.get(p) ?? 0, out: fanOut.get(p) ?? 0 })).filter((r) => r.in + r.out > 0).sort((x, y) => y.in + y.out - (x.in + x.out));
for (const r of rows.slice(0, 8)) console.log(`  ${r.p}  in ${r.in}  out ${r.out}  I=${(r.out / (r.in + r.out)).toFixed(2)}`);
// cycles between distinct blocks (neither inside the other)
const adj = new Map<string, string[]>();
for (const pr of pairs) { const [a, b] = pr.split(" > "); if (b!.startsWith(a! + "/") || a!.startsWith(b! + "/")) continue; (adj.get(a!) ?? adj.set(a!, []).get(a!)!).push(b!); }
const two = [...pairs].filter((pr) => { const [a, b] = pr.split(" > "); return pairs.has(`${b} > ${a}`) && a! < b!; });
console.log("mutual pairs", JSON.stringify(two));
