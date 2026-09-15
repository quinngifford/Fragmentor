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

export interface HarnessResult {
  ok: boolean;
  output?: unknown;
  error?: string;
  logs: string[];
}

export interface SpawnOptions {
  compiledDir: string;
  /** Path of the block within the blocks root, e.g. `rank-jobs/load-postings`. */
  blockPath: string;
  functionName: string;
  capabilities: { name: string; capability: string }[];
  projectDir: string;
  input: unknown;
  timeoutMs: number;
}

export async function runCompiledBlock(options: SpawnOptions): Promise<HarnessResult> {
  const implPath = path.join(options.compiledDir, ...options.blockPath.split("/"), "impl.js");

  return new Promise<HarnessResult>((resolve) => {
    // Electron's binary is Node underneath; this makes it behave as Node so the
    // application does not need a separate runtime installed alongside it.
    const child = spawn(
      process.execPath,
      [harnessPath(), implPath, options.functionName, JSON.stringify(options.capabilities), options.projectDir],
      {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          // The compiled copy sits in a temporary folder, so the packages a
          // block imports are looked for where the project installed them.
          NODE_PATH: [path.join(options.projectDir, "node_modules"), process.env.NODE_PATH].filter(Boolean).join(path.delimiter),
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result: HarnessResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, error: `The block did not finish within ${options.timeoutMs / 1000} seconds.`, logs: [] });
    }, options.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

    child.on("error", (error) => finish({ ok: false, error: error.message, logs: [] }));

    child.on("close", () => {
      if (!stdout.trim()) {
        finish({ ok: false, error: stderr.trim() || "The block produced no result.", logs: [] });
        return;
      }
      try {
        finish(JSON.parse(stdout) as HarnessResult);
      } catch {
        finish({ ok: false, error: `Could not read the result: ${stdout.slice(0, 400)}`, logs: [] });
      }
    });

    child.stdin.end(JSON.stringify(options.input ?? {}));
  });
}
