import { getPack } from "../lang/index.js";
import { checkValue } from "../model/types.js";
import type { PortType } from "../model/types.js";
import { loadProject, systemOf } from "../project/project.js";
import type { LoadedBlock, LoadedSystem, Project } from "../project/project.js";
import type { LanguagePack } from "../lang/pack.js";
import { compileSystem, runCompiledBlock } from "./typescript.js";
import type { CompiledSystem } from "./typescript.js";
import { hasExpectation, loadCases } from "./cases.js";
import type { TestCase } from "./cases.js";
import { compareValues } from "./compare.js";

/**
 * Running blocks.
 *
 * The contract is enforced on both sides here rather than inside the block:
 * the input is checked before anything runs, so a mistyped value is a message
 * instead of a crash, and the output is checked afterwards, so a block that
 * quietly returns the wrong shape is caught rather than believed.
 */

export interface RunRequest {
  projectDir: string;
  blockPath: string;
  input: unknown;
  timeoutMs?: number;
}

export interface RunOutcome {
  ok: boolean;
  output?: unknown;
  error?: string;
  /** Why the input was refused, if it was. Nothing ran in that case. */
  inputProblems: string[];
  /** Ways the result did not match the block's declared outputs. */
  outputProblems: string[];
  logs: string[];
  durationMs: number;
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
  return { ok: false, error, inputProblems: [], outputProblems: [], logs: [], durationMs: 0, ...extra };
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

/** One execution against an already-compiled system. */
async function executeOnce(
  prepared: Prepared,
  compiled: CompiledSystem,
  blockPath: string,
  input: unknown,
  timeoutMs: number,
): Promise<RunOutcome> {
  const { node, pack, project } = prepared;

  const inputProblems = checkValue(input, portsAsType(node.block.inputs), "input");
  if (inputProblems.length > 0) {
    return failure("The values given do not match what this block accepts.", { inputProblems });
  }

  const started = Date.now();
  const result = await runCompiledBlock({
    compiledDir: compiled.dir,
    blockPath,
    functionName: pack.functionName(node.block.id),
    capabilities: Object.entries(node.block.capabilities).map(([name, cap]) => ({
      name,
      capability: cap.capability,
    })),
    projectDir: project.dir,
    input,
    timeoutMs,
  });

  const durationMs = Date.now() - started;
  if (!result.ok) {
    return {
      ok: false,
      error: result.error ?? "The block failed.",
      inputProblems: [],
      outputProblems: [],
      logs: result.logs,
      durationMs,
    };
  }

  return {
    ok: true,
    output: result.output,
    inputProblems: [],
    outputProblems: checkValue(result.output, portsAsType(node.block.outputs), "output"),
    logs: result.logs,
    durationMs,
  };
}

export async function runBlock(request: RunRequest): Promise<RunOutcome> {
  const prepared = await prepare(request.projectDir, request.blockPath);
  if ("error" in prepared) return failure(prepared.error);

  const compiled = await compileSystem(prepared.project, prepared.system.rootBlock);
  try {
    return await executeOnce(prepared, compiled, request.blockPath, request.input, request.timeoutMs ?? 15_000);
  } finally {
    await compiled.dispose();
  }
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
  const outcome = await executeOnce(prepared, compiled, blockPath, testCase.input, 15_000);

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
