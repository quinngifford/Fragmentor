
import path from "node:path";
import { fileURLToPath } from "node:url";
import { proposeDecomposition } from "../src/ai/decompose.js";
import { ScriptedModelClient } from "../src/ai/modelClient.js";
import { createProject, loadProject, validateProject, writeDecomposition } from "../src/project/project.js";
import { emitProject } from "../src/codegen/emit.js";
import type { Proposal } from "../src/ai/decompose.js";
import type { Block, Manifest } from "../src/project/project.js";
import {
  embedPostingsProposal,
  embedPostingsSeed,
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
 * proposals, then generates their code. Everything under `examples/` is
 * produced by the real pipeline rather than written by hand.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

interface Step {
  /** The block to decompose, by its path from the blocks root. */
  blockPath: string;
  proposal: Proposal;
  depth: number;
}

async function build(dir: string, manifest: Manifest, seeds: Block[], steps: Step[]): Promise<void> {
  // Deliberately not cleared first. Implementations live in these folders and
  // are the one thing here that was written by hand rather than generated;
  // wiping the directory to rebuild the diagram would throw them away.
  const target = path.join(here, "..", "examples", dir);
  await createProject(target, manifest, seeds);

  // Each step decomposes a block produced by an earlier step, or a seed.
  const known = new Map<string, Block>(seeds.map((seed) => [seed.id, seed]));

  for (const step of steps) {
    const parent = known.get(step.blockPath);
    if (!parent) throw new Error(`No block at ${step.blockPath} to decompose.`);

    const result = await proposeDecomposition({
      parent,
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
      for (const error of errors) console.error(`  ${error.message}`);
      process.exitCode = 1;
      return;
    }

    await writeDecomposition(target, step.blockPath, result.parent, result.children);
    for (const child of result.children) known.set(`${step.blockPath}/${child.id}`, child);
  }

  const project = await loadProject(target);
  const diagnostics = validateProject(project);
  const emitted = await emitProject(project);

  console.log(`\n${manifest.name}  (examples/${dir})`);
  for (const system of project.systems) {
    console.log(`  ${system.rootBlock}  [${system.language}]`);
    for (const blockPath of [...project.byPath.keys()].sort()) {
      if (blockPath !== system.rootBlock && !blockPath.startsWith(`${system.rootBlock}/`)) continue;
      const block = project.byPath.get(blockPath)!.block;
      console.log(`    ${block.kind === "composite" ? "+" : "-"} ${blockPath}`);
    }
  }
  console.log(`  generated ${emitted.written.length} files, kept ${emitted.skipped.length} existing implementations`);

  for (const problem of emitted.problems) {
    console.error(`  [emit] ${problem}`);
    process.exitCode = 1;
  }
  for (const diagnostic of diagnostics) {
    console.error(`  [${diagnostic.severity}] ${diagnostic.blockPath}: ${diagnostic.message}`);
    if (diagnostic.severity === "error") process.exitCode = 1;
  }
  if (diagnostics.length === 0 && emitted.problems.length === 0) console.log("  validates cleanly");
}

await build("job-ranker", jobRankerManifest, [rankJobsSeed, embedPostingsSeed], [
  { blockPath: "rank-jobs", proposal: rankJobsProposal, depth: 0 },
  { blockPath: "rank-jobs/score-posting", proposal: scorePostingProposal, depth: 1 },
  { blockPath: "embed-postings", proposal: embedPostingsProposal, depth: 0 },
]);

await build("contract-generator", contractGeneratorManifest, [generateContractSeed], [
  { blockPath: "generate-contract", proposal: generateContractProposal, depth: 0 },
]);
