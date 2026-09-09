import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { proposeDecomposition } from "../src/ai/decompose.js";
import { ScriptedModelClient } from "../src/ai/modelClient.js";
import { createProject, loadProject, validateProject, writeDecomposition } from "../src/project/project.js";
import {
  jobRankerManifest,
  rankJobsProposal,
  rankJobsSeed,
  scorePostingProposal,
} from "../src/examples/jobRanker.js";

/**
 * Regenerates `examples/job-ranker` from the worked example, so the sample
 * project on disk is always something the real pipeline produced rather than
 * something written by hand.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(here, "..", "examples", "job-ranker");

await rm(target, { recursive: true, force: true });
await createProject(target, jobRankerManifest, rankJobsSeed);

const root = await proposeDecomposition({
  parent: rankJobsSeed,
  projectGoal: jobRankerManifest.goal,
  blockPath: "rank-jobs",
  granularity: jobRankerManifest.granularity,
  depth: 0,
  client: new ScriptedModelClient([JSON.stringify(rankJobsProposal)]),
});
await writeDecomposition(target, "rank-jobs", root.parent, root.children);

const scorer = root.children.find((c) => c.id === "score-posting");
if (!scorer) throw new Error("The example root decomposition no longer contains score-posting.");

const nested = await proposeDecomposition({
  parent: scorer,
  projectGoal: jobRankerManifest.goal,
  blockPath: "rank-jobs/score-posting",
  granularity: jobRankerManifest.granularity,
  depth: 1,
  client: new ScriptedModelClient([JSON.stringify(scorePostingProposal)]),
});
await writeDecomposition(target, "rank-jobs/score-posting", nested.parent, nested.children);

const project = await loadProject(target);
const diagnostics = validateProject(project);

console.log(`Wrote ${project.byPath.size} blocks to ${path.relative(process.cwd(), target)}`);
for (const blockPath of [...project.byPath.keys()].sort()) {
  const block = project.byPath.get(blockPath)!.block;
  console.log(`  ${block.kind === "composite" ? "+" : "-"} ${blockPath}`);
}

if (diagnostics.length > 0) {
  console.error("\nProblems found:");
  for (const d of diagnostics) console.error(`  [${d.severity}] ${d.blockPath}: ${d.message}`);
  process.exitCode = 1;
} else {
  console.log("\nThe project validates cleanly.");
}
