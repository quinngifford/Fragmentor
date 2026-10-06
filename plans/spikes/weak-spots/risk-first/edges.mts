// Read-only: prints code reach edges and unpointed files for a project copy.
import { loadProject } from "file:///C:/Users/quinn/OneDrive/CS%20Projects/Fragmentor/src/project/project.ts";
import { readAllCode } from "file:///C:/Users/quinn/OneDrive/CS%20Projects/Fragmentor/src/project/code.ts";
import { readProjectReach } from "file:///C:/Users/quinn/OneDrive/CS%20Projects/Fragmentor/src/project/reach.ts";
const project = await loadProject(process.argv[2]!);
const reach = await readProjectReach(project, await readAllCode(project));
for (const e of reach.edges) console.log(e.from, "->", e.to, "|", e.evidence, e.approximate ? "(approx)" : "");
console.log("unpointed", reach.unpointed, "systemsRead", reach.systemsRead);
