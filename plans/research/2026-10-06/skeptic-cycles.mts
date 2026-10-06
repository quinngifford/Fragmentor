// Read-only skeptic check: code-reach edges only, then declared+code; Tarjan SCC for cycles of any length
// between blocks where neither contains the other, after lifting each edge to the sibling level.
import { loadProject, resolveAccess } from "file:///C:/Users/quinn/OneDrive/CS%20Projects/Fragmentor/src/project/project.ts";
import { readAllCode } from "file:///C:/Users/quinn/OneDrive/CS%20Projects/Fragmentor/src/project/code.ts";
import { readProjectReach } from "file:///C:/Users/quinn/OneDrive/CS%20Projects/Fragmentor/src/project/reach.ts";
const dir = process.argv[2]!;
const project = await loadProject(dir);
const reach = await readProjectReach(project, await readAllCode(project));
const code = reach.edges.map((e: any) => [e.from, e.to] as [string, string]);
const decl: [string, string][] = [];
for (const [p, node] of project.byPath) for (const a of node.block.access) { const t = resolveAccess(project, p, a.resource)?.path; if (t) decl.push([p, t]); }
console.log("sample edge", JSON.stringify(reach.edges[0]));
function sccs(edges: [string, string][]) {
  // lift to the pair of ancestors that are siblings
  const lifted = new Set<string>();
  for (const [a, b] of edges) {
    if (a === b || b.startsWith(a + "/") || a.startsWith(b + "/")) continue;
    const as = a.split("/"), bs = b.split("/"); let i = 0; while (as[i] === bs[i]) i++;
    lifted.add(`${as.slice(0, i + 1).join("/")}>${bs.slice(0, i + 1).join("/")}`);
  }
  const adj = new Map<string, string[]>();
  for (const e of lifted) { const [a, b] = e.split(">"); (adj.get(a!) ?? adj.set(a!, []).get(a!)!).push(b!); if (!adj.has(b!)) adj.set(b!, []); }
  let idx = 0; const index = new Map<string, number>(), low = new Map<string, number>(), stack: string[] = [], on = new Set<string>(), out: string[][] = [];
  const visit = (v: string) => { index.set(v, idx); low.set(v, idx++); stack.push(v); on.add(v);
    for (const w of adj.get(v)!) { if (!index.has(w)) { visit(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)); } else if (on.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!)); }
    if (low.get(v) === index.get(v)) { const c: string[] = []; let w; do { w = stack.pop()!; on.delete(w); c.push(w); } while (w !== v); if (c.length > 1) out.push(c); } };
  for (const v of adj.keys()) if (!index.has(v)) visit(v);
  return { lifted: lifted.size, cycles: out };
}
console.log("code edges", code.length, JSON.stringify(sccs(code)));
console.log("code+declared", JSON.stringify(sccs([...code, ...decl])));
const fanIn = new Map<string, Set<string>>();
for (const [a, b] of [...code, ...decl]) { const t = b.split(".")[0]!; (fanIn.get(t) ?? fanIn.set(t, new Set()).get(t)!).add(a); }
console.log("top fan-in", JSON.stringify([...fanIn].map(([k, v]) => [k, v.size]).sort((x, y) => y[1] - x[1]).slice(0, 5)));
