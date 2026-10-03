import { formatAddress } from "../model/trace.js";
import type { Address, Trace } from "../model/trace.js";
import { isArchitecture } from "../model/roles.js";
import { recordedTrace } from "../model/recorded.js";
import type { HeardEvent, RecordingScope } from "../model/recorded.js";
import { answeringRoute, loadProject, systemOf } from "../project/project.js";
import type { Project } from "../project/project.js";
import { boundBlocks, readAllCode } from "../project/code.js";
import type { BlockCode } from "../project/code.js";
import { loadExecutions } from "../project/executions.js";
import type { Execution } from "../project/executions.js";
import { storesForRun } from "../project/stores.js";
import { startRun, whyNotRunnable } from "./run.js";
import type { RunControl, RunEvent, RunOutcome } from "./run.js";

/**
 * Recording an execution: running the code it leads to and keeping what
 * happened as a trace.
 *
 * What runs is the function block that answers the execution's trigger, run
 * exactly as the test bench runs it, with the trigger's payload as its input
 * and the execution's starting rows in the stores. So a recording can be made
 * of whatever the bench can run, which is code that imports its contract, and
 * it sees what the bench sees: every call between those blocks, and every use
 * of the stores it stands in for. Turning that into a trace, and holding what
 * was written down to it, is `src/model/recorded.ts`.
 */

/**
 * The function block that answers what sets an execution going, or why there
 * is none Fragmentor can run: the route ends somewhere that is not code, or at
 * code it only draws.
 */
export function answeringBlock(project: Project, code: Map<string, BlockCode>, address: Address): { block: string } | { why: string } {
  const last = answeringRoute(project, address.path, address.entry).at(-1);
  if (!last) return { why: `There is no block at ${address.path}.` };

  const node = project.byPath.get(last.path)!;
  // An operation answered by an anonymous handler names no block, and that is
  // the codebase's shape rather than a gap in the diagram, so it is said as
  // one: agents reading the general sentence below took it for a fault. Only
  // code that was already here has such handlers. Code built from the diagram
  // names a block for each operation, and a planned service has no handler
  // yet, so in either the missing block is a gap and the general sentence
  // stands.
  const exposed = last.entry === null ? undefined : node.block.exposes[last.entry];
  const anonymous = project.manifest.existingCode && !node.block.planned && node.block.role === "service";
  if (anonymous && exposed !== undefined && exposed.block === undefined) {
    const operation = formatAddress(last);
    return {
      why:
        last.path === address.path
          ? `its operation ${operation} names no block that answers it, as with an anonymous handler.`
          : `it leads to the operation ${operation}, which names no block that answers it, as with an anonymous handler.`,
    };
  }
  if (isArchitecture(node.block.role)) {
    return {
      why:
        last.path === address.path
          ? `Nothing on the diagram says which code answers ${formatAddress(address)}.`
          : `Nothing on the diagram says which code answers ${formatAddress(address)}: following it ends at ${formatAddress(last)}.`,
    };
  }

  const why = whyNotRunnable(project, code, last.path);
  if (why !== null) return { why: `"${node.block.name}" answers ${formatAddress(address)}, but cannot be recorded: ${why.replace(/\.?$/, ".")}` };
  return { block: last.path };
}

/**
 * What a recording that runs `block` can see, and what it cannot.
 *
 * It can see every block of the system the bench compiles, because it stands
 * in for each one's export, and every store and queue entry the block run is
 * given a way into. Everything else on the diagram it cannot: code only drawn,
 * entries it has no way into, and parts that hold nothing it could see.
 */
export function scopeOf(project: Project, code: Map<string, BlockCode>, block: string): RecordingScope {
  const root = systemOf(project, block)?.rootBlock;
  const blocks = Object.fromEntries(
    (root === undefined ? [] : boundBlocks(project, root, code)).map((each) => [each.path, `${each.file}#${each.functionName}`]),
  );

  const stores = [...new Set(storesForRun(project, block).map((store) => store.target))];
  const answers: string[] = [];
  const unseen: string[] = [];
  for (const node of project.byPath.values()) {
    for (const [entry, exposed] of Object.entries(node.block.exposes)) {
      const target = `${node.path}.${entry}`;
      if (exposed.block !== undefined && `${node.path}/${exposed.block}` === block) answers.push(target);
      if (!stores.includes(target)) unseen.push(target);
    }
    const empty = Object.keys(node.block.exposes).length === 0 && node.children.length === 0;
    if (isArchitecture(node.block.role) ? empty : blocks[node.path] === undefined) unseen.push(node.path);
  }

  return { runs: block, blocks, stores, answers, unseen };
}

/** An execution recorded, with what the recording could see. */
export interface Recorded {
  execution: Execution;
  trace: Trace;
  scope: RecordingScope;
  /** False when the run was stopped, or made more calls than are recorded: then what did not happen may just not have happened yet. */
  complete: boolean;
  outcome: RunOutcome;
}

/**
 * Records one execution.
 *
 * Gives back `why` when there is nothing Fragmentor can run for it, and
 * `couldNotRecord` when the run never got going or never ended: the payload
 * or the starting rows were refused by the contract, the code would not load,
 * or it ran out of time. Neither is ever passed off as a trace.
 */
export async function recordExecution(
  projectDir: string,
  id: string,
  watching: { onEvent?: (event: RunEvent) => void; started?: (control: RunControl) => void; breakpoints?: string[] } = {},
): Promise<Recorded | { why: string } | { couldNotRecord: string }> {
  const project = await loadProject(projectDir);
  const code = await readAllCode(project);
  const execution = (await loadExecutions(projectDir)).executions.find((each) => each.id === id);
  if (!execution) return { why: `There is no execution called ${id} that Fragmentor can read.` };

  const answering = answeringBlock(project, code, execution.trigger.at);
  if ("why" in answering) return answering;
  const scope = scopeOf(project, code, answering.block);

  const heard: HeardEvent[] = [];
  const { control, outcome: running } = startRun({
    projectDir,
    blockPath: answering.block,
    input: execution.trigger.payload ?? {},
    stores: execution.given,
    breakpoints: watching.breakpoints,
    onEvent: (event) => {
      heard.push(event);
      watching.onEvent?.(event);
    },
  });
  watching.started?.(control);
  const outcome = await running;

  if (outcome.inputProblems.length > 0) {
    return { couldNotRecord: [outcome.error, ...outcome.inputProblems].filter(Boolean).join(" ") };
  }
  // A run whose first call was never heard did not load, or was stopped
  // before it began; one whose first call never came back, and that nobody
  // stopped, ran out of time. There is nothing of either to show.
  const first = heard.find((event) => event.type === "call" && event.parent === null);
  const ended = first !== undefined && heard.some((event) => (event.type === "return" || event.type === "throw") && event.id === first.id);
  if (first === undefined || (!ended && !outcome.stopped)) {
    return { couldNotRecord: outcome.error ?? "The run ended without saying why." };
  }

  return {
    execution,
    trace: recordedTrace(execution.id, scope, heard, outcome),
    scope,
    complete: !outcome.stopped && !outcome.truncated,
    outcome,
  };
}
