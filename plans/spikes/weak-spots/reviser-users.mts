import { loadProject, resolveAccess } from "file:///C:/Users/quinn/OneDrive/CS%20Projects/Fragmentor/src/project/project.ts";
import { readAllCode } from "file:///C:/Users/quinn/OneDrive/CS%20Projects/Fragmentor/src/project/code.ts";
import { readProjectReach } from "file:///C:/Users/quinn/OneDrive/CS%20Projects/Fragmentor/src/project/reach.ts";
const dir = process.argv[2]!;
const project = await loadProject(dir);
const code = await readAllCode(project);
const reach = await readProjectReach(project, code);
const under = (r: string, p: string) => p === r || p.startsWith(r + "/");
const nested = reach.edges.filter((e) => under(e.from, e.to) || under(e.to, e.from));
console.log("edges between a block and its own parent/part:", nested.map((e) => `${e.from}->${e.to} [${e.evidence}]${e.approximate ? " approx" : ""}`).join("; ") || "none");
const edges: { from: string; to: string; how: string }[] = [];
for (const e of reach.edges) if (!e.approximate) edges.push({ from: e.from, to: e.to, how: "code" });
for (const [p, node] of project.byPath) for (const a of node.block.access) { const t = resolveAccess(project, p, a.resource)?.path; if (t) edges.push({ from: p, to: t, how: "decl" }); }
for (const target of ["tickets/tickets-db", "app/infrastructure/database"]) {
  if (!project.byPath.has(target)) continue;
  const users = [...new Set(edges.filter((e) => e.to === target && !under(target, e.from) && !under(e.from, target)).map((e) => e.from))].sort();
  console.log(target, users.map((u) => `${u}${project.byPath.get(u)!.block.planned ? " (planned)" : ""} via ${[...new Set(edges.filter((e) => e.from === u && e.to === target).map((e) => e.how))].join("+")}`).join(", "));
}
console.log("JSON size of reach edges:", JSON.stringify(reach.edges).length, "count", reach.edges.length);
