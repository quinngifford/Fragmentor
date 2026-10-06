import { loadProject, resolveAccess } from "file:///C:/Users/quinn/OneDrive/CS%20Projects/Fragmentor/src/project/project.ts";
import { readAllCode } from "file:///C:/Users/quinn/OneDrive/CS%20Projects/Fragmentor/src/project/code.ts";
import { readProjectReach } from "file:///C:/Users/quinn/OneDrive/CS%20Projects/Fragmentor/src/project/reach.ts";
const dir = process.argv[2]!;
const project = await loadProject(dir);
const code = await readAllCode(project);
const reach = await readProjectReach(project, code);
const under = (r: string, p: string) => p === r || p.startsWith(r + "/");
const edges: { from: string; to: string; how: string }[] = [];
for (const e of reach.edges) if (!e.approximate) edges.push({ from: e.from, to: e.to, how: "code:" + e.evidence });
for (const [p, node] of project.byPath) for (const a of node.block.access) { const t = resolveAccess(project, p, a.resource)?.path; if (t) edges.push({ from: p, to: t, how: "decl" }); }
const rows: [string, number, number][] = [];
for (const p of project.byPath.keys()) {
  const withParts = new Set(edges.filter((e) => under(p, e.to) && !under(p, e.from) && !under(e.from, p)).map((e) => e.from));
  const direct = new Set(edges.filter((e) => e.to === p && !under(p, e.from) && !under(e.from, p)).map((e) => e.from));
  rows.push([p, withParts.size, direct.size]);
}
rows.sort((a, b) => b[1] - a[1]);
for (const r of rows.slice(0, 6)) console.log("withParts", r[1], "direct", r[2], r[0]);
const fe = edges.filter((e) => under("tickets/booking-api/find-event", e.to) || e.to === "app/client/ui/chat-view");
for (const e of fe) console.log(" ", e.from, "->", e.to, e.how);
console.log("approx", reach.edges.filter((e) => e.approximate).map((e) => `${e.from}->${e.to}`).join(", "));
