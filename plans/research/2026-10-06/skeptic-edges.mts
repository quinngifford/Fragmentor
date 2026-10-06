import { loadProject } from "file:///C:/Users/quinn/OneDrive/CS%20Projects/Fragmentor/src/project/project.ts";
import { readAllCode } from "file:///C:/Users/quinn/OneDrive/CS%20Projects/Fragmentor/src/project/code.ts";
import { readProjectReach } from "file:///C:/Users/quinn/OneDrive/CS%20Projects/Fragmentor/src/project/reach.ts";
const project = await loadProject(process.argv[2]!);
const reach = await readProjectReach(project, await readAllCode(project));
for (const e of reach.edges as any[]) if (e.from.startsWith("app/client") ) console.log(JSON.stringify(e));
for (const [p, n] of project.byPath) if (p.startsWith("app/client")) console.log(p, JSON.stringify(n.block.access.map((a: any) => a.resource ?? a)));
