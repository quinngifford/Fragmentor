import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { blocksRoot } from "../project/project.js";
import type { LoadedBlock, Project } from "../project/project.js";

/**
 * Running a TypeScript block.
 *
 * The implementations are compiled into a throwaway copy rather than run from
 * the project, so nothing is written into the user's folders and a half-built
 * project cannot leave stray files behind. Only implementations are compiled:
 * a block imports its contract with `import type`, which disappears when the
 * types are stripped, so the schema library never has to be resolved to run
 * anything.
 */

const HARNESS = "harness.cjs";

function harnessPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), HARNESS);
}

export interface CompiledSystem {
  /** Throwaway directory holding the compiled implementations. */
  dir: string;
  dispose(): Promise<void>;
}

/** Compiles every implementation in one system into a runnable copy. */
export async function compileSystem(project: Project, systemRoot: string): Promise<CompiledSystem> {
  const dir = await mkdtemp(path.join(tmpdir(), "fragmentor-run-"));

  // Plain .js files in this tree are CommonJS, which is what the harness
  // requires and what the compiler is asked to emit.
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ type: "commonjs" }), "utf8");

  const root = blocksRoot(project.dir);
  const blocks = [...project.byPath.values()].filter(
    (node) => node.path === systemRoot || node.path.startsWith(`${systemRoot}/`),
  );

  for (const node of blocks) {
    const source = await readSource(node);
    if (source === null) continue;

    const compiled = ts.transpileModule(source, {
      fileName: path.join(node.dir, "impl.ts"),
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
      },
    });

    const relative = path.relative(root, node.dir);
    const target = path.join(dir, relative, "impl.js");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, compiled.outputText, "utf8");
  }

  return {
    dir,
    dispose: () => rm(dir, { recursive: true, force: true }),
  };
}

async function readSource(node: LoadedBlock): Promise<string | null> {
  try {
    return await readFile(path.join(node.dir, "impl.ts"), "utf8");
  } catch {
    return null;
  }
}

/** What the harness reports about the block calls in a traced run, as they happen. */
export type RunEvent =
  | { type: "call"; id: number; parent: number | null; block: string; input: unknown; at: number }
  | { type: "return"; id: number; output: unknown; at: number }
  | { type: "throw"; id: number; error: string; at: number }
  | { type: "paused"; id: number }
  | { type: "resumed"; id: number };

export interface HarnessResult {
  ok: boolean;
  output?: unknown;
  error?: string;
  logs: string[];
  /** True when the run was stopped before it finished. */
  stopped?: boolean;
}

export interface SpawnOptions {
  compiledDir: string;
  /** Path of the block within the blocks root, e.g. `rank-jobs/load-postings`. */
  blockPath: string;
  functionName: string;
  /** The block being run and everything beneath it, each wrapped so its calls can be seen. */
  blocks: { path: string; functionName: string }[];
  capabilities: { name: string; capability: string }[];
  projectDir: string;
  input: unknown;
  timeoutMs: number;
  /** Hears each block call as it happens. Without it the run is not traced. */
  onEvent?: (event: RunEvent) => void;
  /** Blocks to hold before they run, by path. */
  breakpoints?: string[];
}

/** A run under way, and the means to steer it. */
export interface CompiledRun {
  result: Promise<HarnessResult>;
  resume(mode: "continue" | "step" | "block"): void;
  setBreakpoints(paths: string[]): void;
  stop(): void;
}

export function startCompiledBlock(options: SpawnOptions): CompiledRun {
  const file = (blockPath: string) => path.join(options.compiledDir, ...blockPath.split("/"), "impl.js");

  // Electron's binary is Node underneath; this makes it behave as Node so the
  // application does not need a separate runtime installed alongside it. The
  // harness reports over the IPC channel, so what a block prints is not read.
  const child = spawn(process.execPath, [harnessPath()], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      // The compiled copy sits in a temporary folder, so the packages a
      // block imports are looked for where the project installed them.
      NODE_PATH: [path.join(options.projectDir, "node_modules"), process.env.NODE_PATH].filter(Boolean).join(path.delimiter),
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });

  const tell = (message: object) => {
    if (child.connected) child.send(message);
  };

  // The time limit counts only time spent running. A run held at a
  // breakpoint is waiting for the person, not stuck.
  let remaining = options.timeoutMs;
  let since = 0;
  let timer: NodeJS.Timeout | undefined;
  const startClock = () => {
    if (timer) return;
    since = Date.now();
    timer = setTimeout(
      () => settle({ ok: false, error: `The block did not finish within ${options.timeoutMs / 1000} seconds.`, logs: [] }),
      remaining,
    );
  };
  const stopClock = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = undefined;
    remaining -= Date.now() - since;
  };

  let settle: (result: HarnessResult) => void = () => {};
  const result = new Promise<HarnessResult>((resolve) => {
    let settled = false;
    settle = (value) => {
      if (settled) return;
      settled = true;
      stopClock();
      resolve(value);
      child.kill();
    };
  });

  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

  child.on("message", (message: { type?: string } & Record<string, unknown>) => {
    if (message.type === "result") {
      settle({
        ok: message.ok === true,
        output: message.output,
        error: typeof message.error === "string" ? message.error : undefined,
        logs: Array.isArray(message.logs) ? (message.logs as string[]) : [],
      });
      return;
    }
    if (message.type === "paused") stopClock();
    if (message.type === "resumed") startClock();
    options.onEvent?.(message as unknown as RunEvent);
  });

  child.on("error", (error) => settle({ ok: false, error: error.message, logs: [] }));
  child.on("close", () => settle({ ok: false, error: stderr.trim() || "The block stopped without reporting what happened.", logs: [] }));

  tell({
    type: "start",
    spec: {
      file: file(options.blockPath),
      functionName: options.functionName,
      blocks: options.blocks.map((block) => ({ ...block, file: file(block.path) })),
      trace: Boolean(options.onEvent),
      breakpoints: options.breakpoints ?? [],
      capabilities: options.capabilities,
      projectDir: options.projectDir,
      input: options.input ?? {},
    },
  });
  startClock();

  return {
    result,
    resume: (mode) => tell({ type: "resume", mode }),
    setBreakpoints: (paths) => tell({ type: "breakpoints", paths }),
    stop: () => settle({ ok: false, error: "The run was stopped before it finished.", logs: [], stopped: true }),
  };
}
