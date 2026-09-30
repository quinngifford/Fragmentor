import { checkValue } from "../model/types.js";
import type { PortType } from "../model/types.js";
import { loadProject, systemOf } from "../project/project.js";
import { packFor, readAllCode } from "../project/code.js";
import type { BlockCode } from "../project/code.js";
import { boundStores, storeEntries, storesForRun } from "../project/stores.js";
import type { LoadedBlock, LoadedSystem, Project } from "../project/project.js";
import type { LanguagePack } from "../lang/pack.js";
import * as typescript from "./typescript.js";
import * as python from "./python.js";
import type { CompiledRun, CompiledSystem, RunEvent, SpawnOptions } from "./typescript.js";
import { hasExpectation, loadCases, storeKeyProblems } from "./cases.js";
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
  /** True when a watched run made more calls than are recorded, so not all of it was heard. */
  truncated?: boolean;
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

/** The two halves of running one language: the throwaway copy, and the harness over it. */
interface Runner {
  compileSystem(project: Project, systemRoot: string, code: Map<string, BlockCode>): Promise<CompiledSystem>;
  startCompiledBlock(options: SpawnOptions): CompiledRun;
}

interface Prepared {
  project: Project;
  node: LoadedBlock;
  system: LoadedSystem;
  pack: LanguagePack;
  runner: Runner;
  /** Where every block's code is, and which of them are held to a contract. */
  code: Map<string, BlockCode>;
  /** The project this folder is a copy of, whose files a run reads when the copy does not hold them, and whose packages it uses. */
  copyOf?: string;
}

/** A project, and where every block's code is. */
interface Loaded {
  project: Project;
  code: Map<string, BlockCode>;
}

/** Reads a project once, however many of its blocks are then run. */
async function load(projectDir: string): Promise<Loaded> {
  const project = await loadProject(projectDir);
  return { project, code: await readAllCode(project) };
}

/**
 * Why a block cannot be run, or null when it can.
 *
 * Fragmentor calls a block with a value and `caps` and holds what comes back to
 * its contract, so the only code it can run is code written to be called that
 * way — which is the code that imports its contract. Anything else is drawn and
 * read, and says so here rather than failing inside the harness.
 */
export function whyNotRunnable(project: Project, code: Map<string, BlockCode>, blockPath: string): string | null {
  const node = project.byPath.get(blockPath);
  if (!node) return `There is no block at ${blockPath}.`;

  const system = systemOf(project, blockPath);
  if (!system) return `${blockPath} does not belong to any system in this project.`;

  const pack = packFor(project, blockPath);
  if (pack === null) {
    return `Fragmentor has no language pack for ${system.language || "this system's language"}, so it draws this code but cannot run it.`;
  }
  if (!pack.canRun) return `Fragmentor cannot run ${pack.displayName} blocks yet, so this one can only be read.`;

  const own = code.get(blockPath)!;
  if (own.problem !== null) return `"${node.block.name}" points at code that is not there: ${own.problem}`;
  if (!own.bound) return own.drawnBecause ?? `Fragmentor does not hold "${node.block.name}" to a contract, so it cannot run it.`;
  return null;
}

/** Everything needed to run a block, or the reason it cannot be run. */
function prepare({ project, code }: Loaded, blockPath: string): Prepared | { error: string } {
  const why = whyNotRunnable(project, code, blockPath);
  if (why !== null) return { error: why };
  const pack = packFor(project, blockPath)!;
  return {
    project,
    node: project.byPath.get(blockPath)!,
    system: systemOf(project, blockPath)!,
    pack,
    runner: pack.id === "python" ? python : typescript,
    code,
  };
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
  const run = prepared.runner.startCompiledBlock({
    compiledDir: compiled.dir,
    blockPath,
    functionName: prepared.code.get(blockPath)!.functionName!,
    // Every block of the system Fragmentor can run, not only those inside the
    // one being run: code calls whatever block it needs, wherever it sits.
    blocks: [...compiled.files].map(([each, file]) => ({
      path: each,
      functionName: prepared.code.get(each)!.functionName!,
      file,
    })),
    capabilities: Object.entries(node.block.capabilities).map(([name, cap]) => {
      const bound = stores.find((store) => store.port === name);
      return {
        name,
        capability: cap.capability,
        ...(bound ? { target: bound.target, seed: seeds[bound.target] ?? {} } : {}),
      };
    }),
    projectDir: project.dir,
    copyOf: prepared.copyOf,
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
      ...(result.truncated ? { truncated: true } : {}),
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
    ...(result.truncated ? { truncated: true } : {}),
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
    const prepared = prepare(await load(request.projectDir), request.blockPath);
    if ("error" in prepared) return failure(prepared.error);

    const compiled = await prepared.runner.compileSystem(prepared.project, prepared.system.rootBlock, prepared.code);
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
 *
 * Given `cases`, it runs those instead of what is saved, which is how one list
 * of tests is run against two versions of a block. `copyOf` is as runManyCases
 * takes it.
 */
export async function runCases(
  projectDir: string,
  blockPath: string,
  options: { cases?: TestCase[]; copyOf?: string } = {},
): Promise<CaseResult[]> {
  const cases = options.cases ?? (await loadCases(projectDir, blockPath));
  if (cases.length === 0) return [];
  return (await runManyCases(projectDir, new Map([[blockPath, cases]]), { copyOf: options.copyOf })).get(blockPath)!;
}

/**
 * Runs several blocks' tests, by block path, reading the project once and
 * compiling each system once, however many of its blocks are run. A block
 * that cannot be run gets each of its tests back as an error saying why.
 *
 * Given `copyOf`, this folder is a copy of that project. What the tests write
 * stays in the copy; a file the copy does not hold is read from that project,
 * and never written there; and its installed packages are used.
 */
export async function runManyCases(
  projectDir: string,
  lists: Map<string, TestCase[]>,
  options: { copyOf?: string } = {},
): Promise<Map<string, CaseResult[]>> {
  const loaded = await load(projectDir);
  const compiled = new Map<string, CompiledSystem>();
  const results = new Map<string, CaseResult[]>();
  try {
    for (const [blockPath, cases] of lists) {
      if (cases.length === 0) {
        results.set(blockPath, []);
        continue;
      }
      const prepared = prepare(loaded, blockPath);
      if ("error" in prepared) {
        results.set(blockPath, cases.map((testCase) => refused(testCase, prepared.error)));
        continue;
      }

      const root = prepared.system.rootBlock;
      if (!compiled.has(root)) compiled.set(root, await prepared.runner.compileSystem(prepared.project, root, prepared.code));
      const entries = storeEntries(prepared.project);
      const reached = boundStores(prepared.project, prepared.node);
      const ran: CaseResult[] = [];
      for (const testCase of cases) {
        // Rows a run would pass over leave the block reading an empty store,
        // and the test failing on something that is not why.
        const misplaced = storeKeyProblems([testCase], entries, reached);
        ran.push(
          misplaced.length > 0
            ? refused(testCase, misplaced.join(" "))
            : await runOneCase({ ...prepared, copyOf: options.copyOf }, compiled.get(root)!, blockPath, testCase),
        );
      }
      results.set(blockPath, ran);
    }
    return results;
  } finally {
    for (const each of compiled.values()) await each.dispose();
  }
}

/** A test that was not run, and why. */
function refused(testCase: TestCase, error: string): CaseResult {
  return { name: testCase.name, status: "error", differences: [], inputProblems: [], error, logs: [], durationMs: 0 };
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
