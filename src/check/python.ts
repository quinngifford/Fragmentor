import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPack } from "../lang/index.js";
import type { BlockCode } from "../project/code.js";
import type { Project } from "../project/project.js";
import { findPython } from "../run/python.js";
import type { CodeProblem } from "./typescript.js";

/**
 * Checking a Python system's code against its diagram.
 *
 * Two passes over the bound files, and only the bound files, exactly as the
 * TypeScript checker compiles only what imports a contract. First `rules.py`,
 * an ast pass run with the project's own Python, holds each file to the form
 * everything else relies on: the block is a plain top-level `async def`
 * annotated from its contract, contracts are imported for types only, and
 * nothing reaches out except through capabilities. Then pyright, which
 * Fragmentor bundles the way it bundles the TypeScript compiler, typechecks
 * the files against the generated contracts, so a function returning the
 * wrong shape fails here before anything runs.
 *
 * pyright is pointed at a config written outside the project, so nothing the
 * project itself carries — a pyrightconfig.json, a pyproject.toml — can
 * quietly weaken the check; `rules.py` refuses the `# pyright:` comments
 * that could. It runs from the CLI's own Node, since `fragmentor check` is
 * the only caller.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const RULES = path.join(here, "rules.py");
const PYRIGHT = createRequire(import.meta.url).resolve("pyright");

function run(
  command: string,
  args: string[],
  options: { cwd?: string; input?: string },
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    // Decoded as streams, not chunk by chunk, so a character split across
    // two pipe chunks is held together rather than corrupted.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end(options.input ?? "");
  });
}

/** One problem standing for a run that told us nothing, so a broken checker is never a clean report. */
function opaque(what: string, detail: string): CodeProblem {
  return { file: "", line: 0, column: 0, message: `${what} did not answer: ${detail.trim().slice(0, 400) || "no output"}` };
}

interface BoundBlock {
  file: string;
  function: string;
  types: [string, string, string];
  contract: string;
}

/** The system's bound blocks, as rules.py and pyright are told about them. */
function boundBlocks(project: Project, rootBlock: string, code: Map<string, BlockCode>): BoundBlock[] {
  const pack = getPack("python");
  const blocks: BoundBlock[] = [];
  for (const [blockPath, found] of code) {
    if (blockPath !== rootBlock && !blockPath.startsWith(`${rootBlock}/`)) continue;
    if (!found.bound || found.location === null || found.contract === null) continue;
    const id = project.byPath.get(blockPath)!.block.id;
    blocks.push({
      file: found.location.file,
      function: found.functionName ?? pack.functionName(id),
      types: [pack.typeName(id, "Input"), pack.typeName(id, "Caps"), pack.typeName(id, "Output")],
      contract: found.contract,
    });
  }
  return blocks;
}

async function runRules(project: Project, blocks: BoundBlock[], interpreter: string): Promise<CodeProblem[]> {
  const spec = JSON.stringify({
    project: project.dir,
    blocks: blocks.map(({ file, function: name, types }) => ({ file, function: name, types })),
  });
  // -X utf8, because the spec on stdin is UTF-8 and isolated mode ignores
  // every encoding environment variable.
  const ran = await run(interpreter, ["-I", "-B", "-X", "utf8", RULES], { input: spec });
  try {
    return JSON.parse(ran.stdout) as CodeProblem[];
  } catch {
    return [opaque("Fragmentor's Python rules", ran.stderr || ran.stdout)];
  }
}

async function runPyright(project: Project, blocks: BoundBlock[], interpreter: string): Promise<CodeProblem[]> {
  const configDir = await mkdtemp(path.join(tmpdir(), "fragmentor-pyright-"));
  try {
    const files = [
      ...new Set([...blocks.map((block) => block.file), ...blocks.map((block) => block.contract), "blocks/capabilities.py"]),
    ].map((file) => path.join(project.dir, ...file.split("/")));
    // The files go on the command line, where pyright takes them absolute; an
    // "include" entry must be relative to the config's folder, which no path
    // on another drive can be. "pythonPath" is likewise command-line only.
    const config = {
      executionEnvironments: [{ root: project.dir }],
      typeCheckingMode: "standard",
      reportMissingImports: "error",
      enableTypeIgnoreComments: false,
    };
    const configFile = path.join(configDir, "pyrightconfig.json");
    await writeFile(configFile, JSON.stringify(config), "utf8");

    const ran = await run(
      process.execPath,
      [PYRIGHT, "--outputjson", "--project", configFile, "--pythonpath", interpreter, ...files],
      { cwd: configDir },
    );
    let report: {
      generalDiagnostics: { file: string; severity: string; message: string; range?: { start: { line: number; character: number } } }[];
      summary?: { filesAnalyzed?: number };
    };
    try {
      report = JSON.parse(ran.stdout);
    } catch {
      return [opaque("pyright", ran.stderr || ran.stdout)];
    }
    // A report over nothing is not a clean report: something kept every file out.
    if ((report.summary?.filesAnalyzed ?? 0) === 0) {
      return [opaque("pyright", `it analyzed no files. ${ran.stderr}`)];
    }
    return report.generalDiagnostics
      .filter((diagnostic) => diagnostic.severity === "error")
      .map((diagnostic) => ({
        file: path.relative(project.dir, diagnostic.file).split(path.sep).join("/"),
        line: diagnostic.range ? diagnostic.range.start.line + 1 : 0,
        column: diagnostic.range ? diagnostic.range.start.character + 1 : 0,
        message: diagnostic.message.split("\n").map((line) => line.trim()).join(" "),
      }));
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
}

/**
 * Holds a Python system's bound code to its contracts and to the form rules,
 * and says which interpreter did it, so the report can name it.
 */
export async function checkPythonSystem(
  project: Project,
  rootBlock: string,
  code: Map<string, BlockCode>,
): Promise<{ problems: CodeProblem[]; interpreter: string | null }> {
  const blocks = boundBlocks(project, rootBlock, code);
  if (blocks.length === 0) return { problems: [], interpreter: null };

  const python = findPython(project.dir);
  if (!python.ok) return { problems: [{ file: "", line: 0, column: 0, message: python.problem }], interpreter: null };

  const problems = [
    ...(await runRules(project, blocks, python.executable)),
    ...(await runPyright(project, blocks, python.executable)),
  ];
  return { problems, interpreter: python.executable };
}
