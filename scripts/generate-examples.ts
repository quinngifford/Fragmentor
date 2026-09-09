import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { proposeDecomposition } from "../src/ai/decompose.js";
import { ScriptedModelClient } from "../src/ai/modelClient.js";
import { createProject, loadProject, validateProject, writeDecomposition } from "../src/project/project.js";
import { emitProject } from "../src/codegen/emit.js";
import type { Proposal } from "../src/ai/decompose.js";
import type { Block, Manifest } from "../src/project/project.js";
import {
  jobRankerManifest,
  rankJobsProposal,
  rankJobsSeed,
  scorePostingProposal,
} from "../src/examples/jobRanker.js";
import {
  contractGeneratorManifest,
  generateContractProposal,
  generateContractSeed,
} from "../src/examples/contractGenerator.js";

/**
 * Rebuilds the example projects from their seed blocks and decomposition
 * proposals, then generates their contract sources. Everything on disk under
 * `examples/` is produced by the real pipeline.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

interface Step {
  blockPath: string;
  proposal: Proposal;
  depth: number;
}

async function build(dir: string, manifest: Manifest, seed: Block, steps: Step[]): Promise<void> {
  const target = path.join(here, "..", "examples", dir);
  await rm(target, { recursive: true, force: true });
  await createProject(target, manifest, seed);

  let current: Block = seed;
  for (const step of steps) {
    const result = await proposeDecomposition({
      parent: current,
      projectGoal: manifest.goal,
      blockPath: step.blockPath,
      granularity: manifest.granularity,
      depth: step.depth,
      client: new ScriptedModelClient([JSON.stringify(step.proposal)]),
      maxAttempts: 1,
    });

    const errors = result.diagnostics.filter((d) => d.severity === "error");
    if (errors.length > 0) {
      console.error(`\n${dir}: the proposal for ${step.blockPath} does not hold together:`);
      for (const e of errors) console.error(`  ${e.message}`);
      process.exitCode = 1;
      return;
    }

    await writeDecomposition(target, step.blockPath, result.parent, result.children);
    const next = result.children.find((c) => steps.some((s) => s.blockPath === `${step.blockPath}/${c.id}`));
    if (next) current = next;
  }

  const project = await loadProject(target);
  const diagnostics = validateProject(project);
  const emitted = await emitProject(project);

  console.log(`\n${manifest.name}  (examples/${dir})`);
  for (const blockPath of [...project.byPath.keys()].sort()) {
    const block = project.byPath.get(blockPath)!.block;
    console.log(`  ${block.kind === "composite" ? "+" : "-"} ${blockPath}`);
  }
  console.log(`  generated ${emitted.written.length} files, kept ${emitted.skipped.length} existing implementations`);

  for (const problem of emitted.problems) {
    console.error(`  [emit] ${problem}`);
    process.exitCode = 1;
  }
  for (const d of diagnostics) {
    console.error(`  [${d.severity}] ${d.blockPath}: ${d.message}`);
    if (d.severity === "error") process.exitCode = 1;
  }
  if (diagnostics.length === 0 && emitted.problems.length === 0) console.log("  validates cleanly");
}

await build("job-ranker", jobRankerManifest, rankJobsSeed, [
  { blockPath: "rank-jobs", proposal: rankJobsProposal, depth: 0 },
  { blockPath: "rank-jobs/score-posting", proposal: scorePostingProposal, depth: 1 },
]);

await build("contract-generator", contractGeneratorManifest, generateContractSeed, [
  { blockPath: "generate-contract", proposal: generateContractProposal, depth: 0 },
]);
