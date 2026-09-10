import { getPack } from "../lang/index.js";
import { checkValue } from "../model/types.js";
import type { PortType } from "../model/types.js";
import { loadProject, systemOf } from "../project/project.js";
import { compileSystem, runCompiledBlock } from "./typescript.js";

/**
 * Running one block against values a person typed.
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

export async function runBlock(request: RunRequest): Promise<RunOutcome> {
  const project = await loadProject(request.projectDir);
  const node = project.byPath.get(request.blockPath);
  if (!node) return failure(`There is no block at ${request.blockPath}.`);

  const system = systemOf(project, request.blockPath);
  if (!system) return failure(`${request.blockPath} does not belong to any system in this project.`);

  const pack = getPack(system.language);
  if (!pack.canRun) {
    return failure(`Fragmentor cannot run ${pack.displayName} blocks yet, so this one can only be read.`);
  }

  const inputProblems = checkValue(request.input, portsAsType(node.block.inputs), "input");
  if (inputProblems.length > 0) {
    return failure("The values given do not match what this block accepts.", { inputProblems });
  }

  const capabilities = Object.entries(node.block.capabilities).map(([name, cap]) => ({
    name,
    capability: cap.capability,
  }));

  const started = Date.now();
  const compiled = await compileSystem(project, system.rootBlock);

  try {
    const result = await runCompiledBlock({
      compiledDir: compiled.dir,
      blockPath: request.blockPath,
      functionName: pack.functionName(node.block.id),
      capabilities,
      projectDir: project.dir,
      input: request.input,
      timeoutMs: request.timeoutMs ?? 15_000,
    });

    const durationMs = Date.now() - started;
    if (!result.ok) {
      return { ok: false, error: result.error ?? "The block failed.", inputProblems: [], outputProblems: [], logs: result.logs, durationMs };
    }

    const outputProblems = checkValue(result.output, portsAsType(node.block.outputs), "output");
    return { ok: true, output: result.output, inputProblems: [], outputProblems, logs: result.logs, durationMs };
  } finally {
    await compiled.dispose();
  }
}
