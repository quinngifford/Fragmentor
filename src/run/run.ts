import { getPack } from "../lang/index.js";
import { isArchitecture } from "../model/roles.js";
import { checkValue } from "../model/types.js";
import type { PortType } from "../model/types.js";
import { loadProject, systemOf } from "../project/project.js";
import { storesForRun } from "../project/stores.js";
import type { LoadedBlock, LoadedSystem, Project } from "../project/project.js";
import type { LanguagePack } from "../lang/pack.js";
import { compileSystem, startCompiledBlock } from "./typescript.js";
import type { CompiledRun, CompiledSystem, RunEvent } from "./typescript.js";
import { hasExpectation, loadCases } from "./cases.js";
import type { TestCase } from "./cases.js";
import { compareValues } from "./compare.js";

export type { RunEvent } from "./typescript.js";

/**
 * Running blocks.
 *
 * The contract is enforced on both sides here rather than inside the block:
 * the input is checked before anything runs, so a mistyped value is a message
 * instead of a crash, and the output is checked afterwards, so a block that
 * quietly returns the wrong shape is caught rather than believed.
 *
 * A run can also be watched. Every block call the run makes, anywhere in the
 * system, is reported as it happens along with the call that made it, and a
 * call can be held at a breakpoint until the person lets it go on.
 */

export interface RunRequest {
  projectDir: string;
  blockPath: string;
  input: unknown;
  /**
   * What each store the block reaches holds before it runs, by target and
   * then by key. A store left out starts empty.
   */
  stores?: StoreSeeds;
  timeoutMs?: number;
  /** Hears every block call as it happens. Without it nothing is recorded, and breakpoints are ignored. */
  onEvent?: (event: RunEvent) => void;
  /** Blocks to pause before, by path. */
  breakpoints?: string[];
}

/** Steers a run that is under way. */
export interface RunControl {
  /**
   * Lets the call held at a breakpoint go on. With "step", the next block to
   * start is held too; with "block", every call of the same block that is
   * waiting its turn goes as well.
   */
  resume(mode: "continue" | "step" | "block"): void;
  setBreakpoints(paths: string[]): void;
  /** Ends the run where it is. */
  stop(): void;
}

/** What the stores a block reaches hold before it runs: target -> key -> row. */
export type StoreSeeds = Record<string, Record<string, unknown>>;

/** What a store was left holding, or a channel was given, by the time a run ended. */
export type StoreEffect =
  | { kind: "store"; rows: Record<string, unknown> }
  | { kind: "queue"; sent: unknown[] };

export interface RunOutcome {
  ok: boolean;
  output?: unknown;
  error?: string;
  /** Why the input was refused, if it was. Nothing ran in that case. */
  inputProblems: string[];
  /** Ways the result did not match the block's declared outputs. */
  outputProblems: string[];
  /**
   * What each store the block reaches was left holding, by target.
   *
   * A block that writes is as worth watching as one that returns: a run that
   * puts an alert on a queue does its whole job through the store, and
   * without this the test bench would report it as having produced nothing.
   */
  stores: Record<string, StoreEffect>;
  logs: string[];
  durationMs: number;
  /** True when the run was stopped before it finished. */
  stopped?: boolean;
}

export type CaseStatus = "passed" | "failed" | "unchecked" | "error";

export interface CaseResult {
  name: string;
  status: CaseStatus;
  /** How the result differed from what the case expected. */
  differences: string[];
  inputProblems: string[];
  error?: string;
  output?: unknown;
  logs: string[];
  durationMs: number;
}

/** A block's ports as one object type, which is what its function receives. */
function portsAsType(ports: Record<string, { type: PortType }>): PortType {
  return {
    kind: "object",
    fields: Object.fromEntries(Object.entries(ports).map(([name, port]) => [name, { type: port.type }])),
  };
}

function failure(error: string, extra: Partial<RunOutcome> = {}): RunOutcome {
  return { ok: false, error, inputProblems: [], outputProblems: [], stores: {}, logs: [], durationMs: 0, ...extra };
}

interface Prepared {
  project: Project;
  node: LoadedBlock;
  system: LoadedSystem;
  pack: LanguagePack;
}

/** Everything needed to run a block, or the reason it cannot be run. */
async function prepare(projectDir: string, blockPath: string): Promise<Prepared | { error: string }> {
  const project = await loadProject(projectDir);
  if (project.manifest.mode === "visual") {
    return { error: "This is a visual project: Fragmentor draws its code but never runs it." };
  }

  const node = project.byPath.get(blockPath);
  if (!node) return { error: `There is no block at ${blockPath}.` };

  const system = systemOf(project, blockPath);
  if (!system) return { error: `${blockPath} does not belong to any system in this project.` };

  const pack = getPack(system.language);
  if (!pack.canRun) {
    return { error: `Fragmentor cannot run ${pack.displayName} blocks yet, so this one can only be read.` };
  }

  return { project, node, system, pack };
}

interface Watching {
  onEvent: ((event: RunEvent) => void) | undefined;
  breakpoints: string[];
  /** Hands over the run once it has started, so it can be steered. */
  attach(run: CompiledRun): void;
}

/** One execution against an already-compiled system. */
async function executeOnce(
  prepared: Prepared,
  compiled: CompiledSystem,
  blockPath: string,
  input: unknown,
  seeds: StoreSeeds,
  timeoutMs: number,
  watching?: Watching,
): Promise<RunOutcome> {
  const { node, pack, project } = prepared;

  const inputProblems = checkValue(input, portsAsType(node.block.inputs), "input");
  if (inputProblems.length > 0) {
    return failure("The values given do not match what this block accepts.", { inputProblems });
  }

  // Rows are checked before anything runs for the same reason the input is:
  // a row of the wrong shape is a mistake in the test, and finding it here
  // says so plainly instead of failing somewhere inside the block.
  const stores = storesForRun(project, blockPath);
  const seedProblems = stores.flatMap((store) => {
    const seeded = seeds[store.target];
    if (!seeded || store.shape === null) return [];
    return Object.entries(seeded).flatMap(([key, row]) =>
      checkValue(row, store.shape!, `${store.resourceName} · ${store.entry}[${JSON.stringify(key)}]`),
    );
  });
  if (seedProblems.length > 0) {
    return failure("The rows given do not match what these stores hold.", { inputProblems: seedProblems });
  }

  // A run held at a breakpoint is waiting for the person, so that time is not
  // part of how long it took.
  let heldFor = 0;
  let heldSince: number | null = null;
  const hear = watching?.onEvent;
  const onEvent = hear
    ? (event: RunEvent) => {
        if (event.type === "paused" && heldSince === null) heldSince = Date.now();
        if (event.type === "resumed" && heldSince !== null) {
          heldFor += Date.now() - heldSince;
          heldSince = null;
        }
        hear(event);
      }
    : undefined;

  const started = Date.now();
  const run = startCompiledBlock({
    compiledDir: compiled.dir,
    blockPath,
    functionName: pack.functionName(node.block.id),
    // Every function in the system, not only those inside the block being
    // run: code calls whatever block it needs, wherever that block sits.
    blocks: [...project.byPath.values()]
      .filter((each) => systemOf(project, each.path) === prepared.system && !each.block.planned && !isArchitecture(each.block.role))
      .map((each) => ({ path: each.path, functionName: pack.functionName(each.block.id) })),
    capabilities: Object.entries(node.block.capabilities).map(([name, cap]) => {
      const bound = stores.find((store) => store.port === name);
      return {
        name,
        capability: cap.capability,
        ...(bound ? { target: bound.target, seed: seeds[bound.target] ?? {} } : {}),
      };
    }),
    projectDir: project.dir,
    input,
    timeoutMs,
    onEvent,
    breakpoints: watching?.breakpoints,
  });
  watching?.attach(run);
  const result = await run.result;

  const ended = Date.now();
  const durationMs = ended - started - heldFor - (heldSince === null ? 0 : ended - heldSince);
  if (!result.ok) {
    return {
      ok: false,
      error: result.error ?? "The block failed.",
      inputProblems: [],
      outputProblems: [],
      // A block that failed halfway may already have written, and what it
      // wrote is often the clue to why.
      stores: result.stores ?? {},
      logs: result.logs,
      durationMs,
      ...(result.stopped ? { stopped: true } : {}),
    };
  }

  // A block that declares no outputs returns nothing, and whatever its code
  // happens to hand back is not part of its contract, so it is not held to one.
  const declaresOutputs = Object.keys(node.block.outputs).length > 0;
  return {
    ok: true,
    output: result.output,
    inputProblems: [],
    outputProblems: declaresOutputs ? checkValue(result.output, portsAsType(node.block.outputs), "output") : [],
    stores: result.stores ?? {},
    logs: result.logs,
    durationMs,
  };
}

/**
 * Starts a run and hands back the means to steer it: resume it from a
 * breakpoint, change its breakpoints, or stop it. The outcome arrives when the
 * run ends, however it ends.
 */
export function startRun(request: RunRequest): { control: RunControl; outcome: Promise<RunOutcome> } {
  let run: CompiledRun | null = null;
  let stopped = false;
  let breakpoints = request.breakpoints ?? [];

  const control: RunControl = {
    resume: (mode) => run?.resume(mode),
    setBreakpoints: (paths) => {
      breakpoints = paths;
      run?.setBreakpoints(paths);
    },
    stop: () => {
      stopped = true;
      run?.stop();
    },
  };

  const outcome = (async (): Promise<RunOutcome> => {
    const prepared = await prepare(request.projectDir, request.blockPath);
    if ("error" in prepared) return failure(prepared.error);

    const compiled = await compileSystem(prepared.project, prepared.system.rootBlock);
    try {
      if (stopped) return failure("The run was stopped before it started.", { stopped: true });
      return await executeOnce(prepared, compiled, request.blockPath, request.input, request.stores ?? {}, request.timeoutMs ?? 15_000, {
        onEvent: request.onEvent,
        breakpoints,
        attach: (started) => {
          run = started;
        },
      });
    } finally {
      await compiled.dispose();
    }
  })();

  return { control, outcome };
}

export async function runBlock(request: RunRequest): Promise<RunOutcome> {
  return startRun(request).outcome;
}

/**
 * Runs every saved test for a block. The system is compiled once and reused,
 * so running twenty cases costs one compilation rather than twenty.
 */
export async function runCases(projectDir: string, blockPath: string): Promise<CaseResult[]> {
  const cases = await loadCases(projectDir, blockPath);
  if (cases.length === 0) return [];

  const prepared = await prepare(projectDir, blockPath);
  if ("error" in prepared) {
    return cases.map((testCase) => ({
      name: testCase.name,
      status: "error" as const,
      differences: [],
      inputProblems: [],
      error: prepared.error,
      logs: [],
      durationMs: 0,
    }));
  }

  const compiled = await compileSystem(prepared.project, prepared.system.rootBlock);
  try {
    const results: CaseResult[] = [];
    for (const testCase of cases) {
      results.push(await runOneCase(prepared, compiled, blockPath, testCase));
    }
    return results;
  } finally {
    await compiled.dispose();
  }
}

async function runOneCase(
  prepared: Prepared,
  compiled: CompiledSystem,
  blockPath: string,
  testCase: TestCase,
): Promise<CaseResult> {
  const outcome = await executeOnce(prepared, compiled, blockPath, testCase.input, testCase.stores ?? {}, 15_000);

  const base = {
    name: testCase.name,
    inputProblems: outcome.inputProblems,
    logs: outcome.logs,
    durationMs: outcome.durationMs,
  };

  if (!outcome.ok) {
    return { ...base, status: "error", differences: [], error: outcome.error ?? "The block failed." };
  }

  // A block that breaks its own contract has failed, whatever the case expected.
  if (outcome.outputProblems.length > 0) {
    return { ...base, status: "failed", differences: outcome.outputProblems, output: outcome.output };
  }

  if (!hasExpectation(testCase)) {
    return { ...base, status: "unchecked", differences: [], output: outcome.output };
  }

  const differences = compareValues(outcome.output, testCase.expected);
  return {
    ...base,
    status: differences.length === 0 ? "passed" : "failed",
    differences,
    output: outcome.output,
  };
}
