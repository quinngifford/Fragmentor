import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import type { BlockCode } from "../project/code.js";
import type { Project } from "../project/project.js";

/**
 * Running a TypeScript block.
 *
 * The code is compiled into a throwaway copy rather than run from the project,
 * so nothing is written into the user's folders and a half-built project cannot
 * leave stray files behind. The copy mirrors the project's own tree, so the
 * relative imports between one block's code and another's resolve there exactly
 * as they do in the project.
 *
 * Only the files whose blocks are held to a contract are compiled: they are the
 * ones written to be called with a value and `caps`. A block imports its
 * contract with `import type`, which disappears when the types are stripped, so
 * the contract itself, which holds nothing else, is never needed to run anything.
 */

const HARNESS = "harness.cjs";

function harnessPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), HARNESS);
}

export interface CompiledSystem {
  /** Throwaway directory holding the compiled code, laid out as the project is. */
  dir: string;
  /** Where each block's code ended up, by block path. */
  files: Map<string, string>;
  dispose(): Promise<void>;
}

/**
 * The blocks of one system whose code is held to a contract, and where it is.
 * They are what a run compiles and stands in for, so they are all it hears.
 */
export function boundBlocks(
  project: Project,
  systemRoot: string,
  code: Map<string, BlockCode>,
): { path: string; file: string; functionName: string | null }[] {
  return [...project.byPath.values()].flatMap((node) => {
    if (node.path !== systemRoot && !node.path.startsWith(`${systemRoot}/`)) return [];
    const found = code.get(node.path);
    return found?.bound && found.location !== null
      ? [{ path: node.path, file: found.location.file, functionName: found.functionName }]
      : [];
  });
}

/** Compiles the code of every block in one system that is held to a contract. */
export async function compileSystem(
  project: Project,
  systemRoot: string,
  code: Map<string, BlockCode>,
): Promise<CompiledSystem> {
  const dir = await mkdtemp(path.join(tmpdir(), "fragmentor-run-"));

  // Plain .js files in this tree are CommonJS, which is what the harness
  // requires and what the compiler is asked to emit.
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ type: "commonjs" }), "utf8");

  const files = new Map<string, string>();
  const written = new Set<string>();

  for (const block of boundBlocks(project, systemRoot, code)) {
    const source = block.file;
    const target = path.join(dir, ...source.replace(/\.ts$/, ".js").split("/"));
    files.set(block.path, target);
    if (written.has(source)) continue;
    written.add(source);

    const compiled = ts.transpileModule(await readFile(path.join(project.dir, ...source.split("/")), "utf8"), {
      fileName: path.join(project.dir, ...source.split("/")),
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
      },
    });

    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, compiled.outputText, "utf8");
  }

  return {
    dir,
    files,
    dispose: () => rm(dir, { recursive: true, force: true }),
  };
}

/** What the harness reports about the block calls in a traced run, as they happen. */
export type RunEvent =
  | { type: "call"; id: number; parent: number | null; block: string; input: unknown; at: number }
  | { type: "return"; id: number; output: unknown; at: number }
  | { type: "throw"; id: number; error: string; at: number }
  /**
   * A block using a store or a queue it was given, as the call `parent` was
   * running: the row read (or null), the rows listed, the row written, the
   * row a remove took away (or null), or the message sent. `target` is the
   * name the run keeps the store under, `path.entry`.
   */
  | { type: "store"; id: number; parent: number | null; target: string; op: StoreOperation; key?: string; value: unknown; at: number }
  | { type: "paused"; id: number }
  | { type: "resumed"; id: number };

export type StoreOperation = "read" | "list" | "write" | "remove" | "send";

/** What a store was left holding, or a channel was given, by the time a run ended. */
export type StoreEffect =
  | { kind: "store"; rows: Record<string, unknown> }
  | { kind: "queue"; sent: unknown[] };

export interface HarnessResult {
  ok: boolean;
  output?: unknown;
  error?: string;
  /** What each bound store held when the run ended, by target. */
  stores?: Record<string, StoreEffect>;
  logs: string[];
  /** True when the run was stopped before it finished. */
  stopped?: boolean;
  /** True when the run made more calls than are recorded, so what was heard of it is not all of it. */
  truncated?: boolean;
}

export interface SpawnOptions {
  compiledDir: string;
  /** Path of the block within the blocks root, e.g. `rank-jobs/load-postings`. */
  blockPath: string;
  functionName: string;
  /**
   * Every block of the system Fragmentor can run, each wrapped so its calls can
   * be seen whoever makes them, with the compiled file its code is in.
   */
  blocks: { path: string; functionName: string; file: string }[];
  /**
   * The ports to build substitutes for. A port that is a way into something
   * on the diagram carries the name the run keeps that thing under, and the
   * rows it starts out holding.
   */
  capabilities: { name: string; capability: string; target?: string; seed?: Record<string, unknown> }[];
  projectDir: string;
  /**
   * The project `projectDir` is a copy of, if it is one. A file the copy does
   * not hold is read from there, and never written there; its installed
   * packages are the ones used.
   */
  copyOf?: string;
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
  // Electron's binary is Node underneath; this makes it behave as Node so the
  // application does not need a separate runtime installed alongside it. The
  // harness reports over the IPC channel, so what a block prints is not read.
  const child = spawn(process.execPath, [harnessPath()], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      // The compiled copy sits in a temporary folder, so the packages a
      // block imports are looked for where the project installed them: the
      // project a copy stands in for, when it is run from one.
      NODE_PATH: [path.join(options.copyOf ?? options.projectDir, "node_modules"), process.env.NODE_PATH].filter(Boolean).join(path.delimiter),
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
        stores: (message.stores as Record<string, StoreEffect> | undefined) ?? {},
        logs: Array.isArray(message.logs) ? (message.logs as string[]) : [],
        ...(message.truncated === true ? { truncated: true } : {}),
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
      file: options.blocks.find((block) => block.path === options.blockPath)?.file,
      functionName: options.functionName,
      blocks: options.blocks,
      trace: Boolean(options.onEvent),
      breakpoints: options.breakpoints ?? [],
      capabilities: options.capabilities,
      projectDir: options.projectDir,
      copyOf: options.copyOf ?? null,
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
