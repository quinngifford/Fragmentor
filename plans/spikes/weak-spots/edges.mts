import { loadProject } from "file:///C:/Users/quinn/OneDrive/CS%20Projects/Fragmentor/src/project/project.ts";
import { readAllCode } from "file:///C:/Users/quinn/OneDrive/CS%20Projects/Fragmentor/src/project/code.ts";
import { readProjectReach } from "file:///C:/Users/quinn/OneDrive/CS%20Projects/Fragmentor/src/project/reach.ts";
const project = await loadProject(process.argv[2]!);
const t0 = performance.now();
const reach = await readProjectReach(project, await readAllCode(project));
console.log("ms", Math.round(performance.now() - t0));
for (const e of reach.edges) if (e.from.includes("client") || e.to.includes("client")) console.log(e.from, "->", e.to, "|", e.evidence, e.approximate ? "(approx)" : "");
