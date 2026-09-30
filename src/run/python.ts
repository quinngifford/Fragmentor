import { spawnSync } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import path from "node:path";

/**
 * Finding the Python that runs and checks a project's blocks.
 *
 * The project's own `.venv` comes first, looked for on every call so one the
 * agent has just created is picked up at once, and a `.venv` that will not do
 * is reported rather than quietly passed over for a Python without the
 * project's packages. Then `python`, `py -3` and `python3` from PATH, each
 * probed by running it, because a name on PATH says nothing about what it is:
 * the Microsoft Store ships a `python.exe` that is really an app-store ad.
 * Fragmentor needs 3.11 or later, which is where `typing.NotRequired` landed.
 *
 * Only successful probes are cached, keyed by what was run, so a miss —
 * Python not installed yet, or too old — is asked again next time and an
 * install is noticed without restarting anything.
 */

export type PythonLookup =
  | { ok: true; executable: string; version: string }
  | { ok: false; problem: string };

const PROBE = "import sys; print(sys.executable); print('%d.%d.%d' % sys.version_info[:3])";

const cache = new Map<string, { executable: string; version: string }>();

/** Where a command would be found on this PATH, as a spawn would find it, or null. */
function onPath(command: string, env: NodeJS.ProcessEnv): string | null {
  const dirs = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  const extensions =
    process.platform === "win32"
      ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((each) => each.toLowerCase())
      : [""];
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = path.join(dir, command + extension);
      // lstat, not exists: the Microsoft Store's python.exe alias is a link
      // whose target cannot be read, and yet a spawn runs it.
      if (lstatSync(candidate, { throwIfNoEntry: false })) return candidate;
    }
  }
  return null;
}

function probe(executable: string, args: string[], env: NodeJS.ProcessEnv): { executable: string; version: string } | { miss: string } {
  const key = [executable, ...args].join("\0");
  const hit = cache.get(key);
  if (hit && existsSync(hit.executable)) return hit;

  // -X utf8, because the probe's answer is a path this side reads as UTF-8,
  // and isolated mode ignores every encoding environment variable.
  const ran = spawnSync(executable, [...args, "-I", "-X", "utf8", "-c", PROBE], { env, encoding: "utf8", timeout: 10_000, windowsHide: true });
  if (ran.error) return { miss: (ran.error as NodeJS.ErrnoException).code === "ENOENT" ? "is not there" : ran.error.message };
  const [exe, version] = (ran.stdout ?? "").trim().split(/\r?\n/);
  if (ran.status !== 0 || !version || !exe) {
    const said = (ran.stderr || ran.stdout || "").trim().split(/\r?\n/)[0] ?? "";
    return { miss: `did not run (exit ${ran.status}${said ? `: "${said.slice(0, 80)}"` : ""})` };
  }
  const [major = 0, minor = 0] = version.split(".").map(Number);
  if (major < 3 || (major === 3 && minor < 11)) {
    return { miss: `is Python ${version}, and Fragmentor needs 3.11 or later` };
  }
  const found = { executable: exe, version };
  cache.set(key, found);
  return found;
}

/** The Python to check and run this project's blocks with, or the sentence saying why there is none. */
export function findPython(dir: string, env: NodeJS.ProcessEnv = process.env): PythonLookup {
  for (const parts of [[".venv", "Scripts", "python.exe"], [".venv", "bin", "python"]]) {
    const venv = path.join(dir, ...parts);
    if (!existsSync(venv)) continue;
    const found = probe(venv, [], env);
    if (!("miss" in found)) return { ok: true, ...found };
    // The .venv is the project's own choice, holding its packages: one that
    // will not do is reported, never quietly passed over for a Python
    // without them.
    return { ok: false, problem: `The project's ${parts.slice(1).join("/")} under .venv ${found.miss}.` };
  }

  const looked: string[] = ["the project has no .venv"];
  for (const [command, ...args] of [["python"], ["py", "-3"], ["python3"]] as const) {
    const where = onPath(command, env);
    if (!where) {
      looked.push(`\`${[command, ...args].join(" ")}\` is not on PATH`);
      continue;
    }
    const found = probe(where, [...args], env);
    if (!("miss" in found)) return { ok: true, ...found };
    looked.push(`\`${[command, ...args].join(" ")}\` (${where}) ${found.miss}`);
  }
  return { ok: false, problem: `Fragmentor found no Python 3.11 or later: ${looked.join("; ")}.` };
}
