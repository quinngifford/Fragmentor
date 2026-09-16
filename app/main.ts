import { mkdirSync, mkdtempSync, watch, writeFileSync } from "node:fs";
import type { FSWatcher } from "node:fs";
import { access, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, app, dialog, ipcMain, shell } from "electron";
import { CHANNELS } from "./ipc.js";
import type {
  ProjectLoad,
  Result,
  RunCommand,
  SaveCasesRequest,
  SaveLayoutRequest,
  WatchRunRequest,
  WriteImplRequest,
} from "./ipc.js";
import { projectSnapshot } from "../src/project/snapshot.js";
import { saveViewLayout } from "../src/project/layout.js";
import { blockDir, loadProject, manifestPath, systemOf } from "../src/project/project.js";
import { getPack, isKnownLanguage } from "../src/lang/index.js";
import { emitProject, startProject } from "../src/codegen/emit.js";
import type { EmitResult, NewProjectSettings } from "../src/codegen/emit.js";
import { GUIDE_FILE } from "../src/codegen/guide.js";
import { resolveInside } from "../src/project/safePath.js";
import { runCases, startRun } from "../src/run/run.js";
import type { CaseResult, RunControl, RunOutcome } from "../src/run/run.js";
import { saveCases } from "../src/run/cases.js";

/**
 * The main process owns everything with side effects: the window, the disk,
 * and the kernel. The renderer is given data and sends back requests.
 *
 * It also watches the open project, because the person is rarely the one
 * changing it: a coding agent works in the same folder, and the window has
 * to keep up with it.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const RECENT_LIMIT = 8;

/** Started to check itself rather than to be used. */
function selfChecking(): boolean {
  return Boolean(process.env.FRAGMENTOR_SMOKE) || process.argv.includes("--smoke");
}

/**
 * The self-check works in a throwaway folder with its own settings, so running
 * it never edits the examples in the repository or the user's recent projects.
 * The settings path has to be chosen before the application is ready.
 */
const selfCheck = selfChecking() ? prepareSelfCheck() : null;

function prepareSelfCheck(): { root: string; projectDir: string } {
  const root = mkdtempSync(path.join(tmpdir(), "fragmentor-self-check-"));
  const projectDir = path.join(root, "project");
  const userData = path.join(root, "user-data");
  mkdirSync(projectDir);
  mkdirSync(userData);
  // Offered on the welcome screen as a recent project, which is how the check opens it.
  writeFileSync(path.join(userData, "recent-projects.json"), JSON.stringify([projectDir]));
  app.setPath("userData", userData);
  return { root, projectDir };
}

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

function failed(error: unknown): Result<never> {
  return { ok: false, error: messageOf(error) };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function recentFile(): string {
  return path.join(app.getPath("userData"), "recent-projects.json");
}

async function readRecent(): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(recentFile(), "utf8"));
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

async function rememberProject(dir: string): Promise<void> {
  const recent = await readRecent();
  const next = [dir, ...recent.filter((entry) => entry !== dir)].slice(0, RECENT_LIMIT);
  await mkdir(path.dirname(recentFile()), { recursive: true });
  await writeFile(recentFile(), `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

/**
 * Reads a folder as a project. The ordinary states an agent leaves a folder in
 * — no system defined yet, or a file half written — are reported, not thrown.
 */
async function readProject(dir: string): Promise<ProjectLoad> {
  const resolved = path.resolve(dir);
  const info = await stat(resolved).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`${resolved} is not a folder that exists.`);

  if (!(await exists(manifestPath(resolved)))) {
    throw new Error(`There is no Fragmentor project in ${resolved}. Use New project… to start one there.`);
  }

  try {
    return { dir: resolved, snapshot: await projectSnapshot(resolved), error: null };
  } catch (error) {
    return { dir: resolved, snapshot: null, error: messageOf(error) };
  }
}

/** Whether a folder holds anything of its own. Hidden entries such as `.git` do not count. */
async function holdsFiles(dir: string): Promise<boolean> {
  return (await readdir(dir)).some((name) => !name.startsWith("."));
}

/** The settings as the window sent them. The window is not trusted to send sensible ones. */
function settingsFrom(raw: unknown): NewProjectSettings {
  const value = (raw ?? {}) as Partial<Record<keyof NewProjectSettings, unknown>>;
  if (value.mode !== "structured" && value.mode !== "visual") {
    throw new Error("Choose whether Fragmentor structures the code or only draws it.");
  }
  if (typeof value.granularity !== "number" || ![1, 2, 3, 4, 5].includes(value.granularity)) {
    throw new Error("Choose how finely to divide the work, from 1 to 5.");
  }

  if (typeof value.existingCode !== "boolean") {
    throw new Error("Choose whether you are starting from scratch or working with code you already have.");
  }
  if (value.start !== "plan" && value.start !== "build") {
    throw new Error("Choose whether to plan the architecture first or build it straight away.");
  }
  if (value.existingCode && value.start === "plan") {
    throw new Error("Code that already exists is described or rebuilt, not planned. Start from scratch to plan an architecture.");
  }

  const language = typeof value.language === "string" && value.language.trim() ? value.language.trim().slice(0, 40) : null;
  if (value.mode === "structured" && language !== null && !isKnownLanguage(language)) {
    throw new Error(`Fragmentor cannot generate ${language} code. Choose TypeScript or Python, or leave it to the agent.`);
  }

  return {
    mode: value.mode,
    granularity: value.granularity as NewProjectSettings["granularity"],
    language,
    existingCode: value.existingCode,
    start: value.start,
  };
}

/* -------------------------------------------------------------------------- */
/* Watching                                                                    */
/* -------------------------------------------------------------------------- */

/** The window is not trusted to send a mode that means anything, so anything else is a plain resume. */
function resumeMode(raw: unknown): "continue" | "step" | "block" {
  return raw === "step" || raw === "block" ? raw : "continue";
}

/** One watcher per window, on whichever project that window has open. */
const watchers = new Map<number, FSWatcher>();

/**
 * Changes that are nobody's business: the canvas layout, which this
 * application writes itself, and the folders tools keep inside a project.
 */
function ignored(filename: string): boolean {
  if (filename === "layout.json") return true;
  return filename.split(/[\\/]/).some((part) => part === "node_modules" || part === "__pycache__" || part.startsWith("."));
}

function stopWatching(id: number): void {
  watchers.get(id)?.close();
  watchers.delete(id);
}

/**
 * Tells a window whenever its project changes on disk. An agent writes files
 * in bursts, so the window hears once things go quiet, not once per file.
 */
function watchProject(contents: Electron.WebContents, dir: string): void {
  const id = contents.id;
  stopWatching(id);

  let timer: NodeJS.Timeout | undefined;
  const notify = () => {
    if (!contents.isDestroyed()) contents.send(CHANNELS.projectChanged, dir);
  };

  let watcher: FSWatcher;
  try {
    watcher = watch(dir, { recursive: true }, (_event, filename) => {
      if (filename && ignored(filename)) return;
      clearTimeout(timer);
      timer = setTimeout(notify, 300);
    });
  } catch (error) {
    // Some systems refuse to watch a very large folder. The project still
    // opens; it just has to be reloaded by hand.
    console.warn(`Fragmentor cannot watch ${dir} for changes: ${messageOf(error)}`);
    return;
  }

  // The folder was removed or became unreadable. Stop, and let the window's
  // next read say what happened.
  watcher.on("error", () => {
    if (watchers.get(id) === watcher) stopWatching(id);
    notify();
  });

  watchers.set(id, watcher);
}

async function openProject(contents: Electron.WebContents, dir: string): Promise<ProjectLoad> {
  const load = await readProject(dir);
  // Watch as soon as the folder has been read, so as little as possible can
  // change unseen in between.
  watchProject(contents, load.dir);
  await rememberProject(load.dir);
  return load;
}

async function pickFolder(contents: Electron.WebContents, options: Electron.OpenDialogOptions): Promise<string | undefined> {
  const window = BrowserWindow.fromWebContents(contents);
  const picked = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
  return picked.canceled ? undefined : picked.filePaths[0];
}

/* -------------------------------------------------------------------------- */
/* Requests from the window                                                    */
/* -------------------------------------------------------------------------- */

function registerHandlers(): void {
  ipcMain.handle(CHANNELS.chooseProject, async (event): Promise<Result<ProjectLoad | null>> => {
    try {
      const dir = await pickFolder(event.sender, { properties: ["openDirectory"], title: "Open a Fragmentor project" });
      return ok(dir ? await openProject(event.sender, dir) : null);
    } catch (error) {
      return failed(error);
    }
  });

  ipcMain.handle(CHANNELS.newProject, async (event, raw: unknown): Promise<Result<ProjectLoad | null>> => {
    try {
      const settings = settingsFrom(raw);
      const dir = await pickFolder(event.sender, {
        properties: ["openDirectory", "createDirectory"],
        title: "Choose the project's folder: an empty one, or one holding code",
        buttonLabel: "Start project here",
      });
      if (!dir) return ok(null);

      if (await exists(manifestPath(dir))) {
        throw new Error(`${dir} is already a Fragmentor project. Open it with Open project… instead.`);
      }

      const window = BrowserWindow.fromWebContents(event.sender);
      const ask = (options: Electron.MessageBoxOptions) =>
        window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options);

      // The person said where they were starting from before they chose the
      // folder, and the folder can disagree. That answer decides what the
      // agent is told, so it is worth one question rather than a wrong guide.
      const hasFiles = await holdsFiles(dir);
      if (settings.existingCode !== hasFiles) {
        const { response } = await ask({
          type: "question",
          buttons: ["Use this folder", "Choose another"],
          defaultId: 0,
          cancelId: 1,
          message: hasFiles ? "This folder already holds code" : "This folder is empty",
          detail: hasFiles
            ? `You said you were starting from scratch. Using it anyway is fine: your agent will be told the code is already here and asked to work from it${settings.start === "plan" ? ", rather than to plan an architecture from nothing" : ""}.`
            : "You said you were working with code you already have. Using it anyway is fine: your agent will be told to write the program from nothing.",
        });
        if (response !== 0) return ok(null);
        settings.existingCode = hasFiles;
        // Code that already exists is described or rebuilt, never planned,
        // which is why the window never offers that pair either.
        if (hasFiles) settings.start = "build";
      }

      // Structured mode rebuilds whatever code is already there. That is what
      // the person asked for, but it should never come as a surprise.
      if (settings.mode === "structured" && hasFiles) {
        const { response } = await ask({
          type: "warning",
          buttons: ["Rebuild it as blocks", "Cancel"],
          defaultId: 1,
          cancelId: 1,
          message: "Your agent will rebuild the code in this folder as blocks",
          detail:
            "In structured mode the agent moves this folder's code into Fragmentor blocks, and deletes the old files once the blocks pass their tests. Commit the code to version control first, so every change can be undone.\n\nTo only see how the code works, cancel and choose Visual instead. Visual mode never changes the code.",
        });
        if (response !== 0) return ok(null);
      }

      // The guide is what tells an agent opened in this folder what to do.
      const { withoutGuide } = await startProject(dir, settings);
      if (withoutGuide.length > 0) {
        // Those files are the person's, so they are left alone, but an agent
        // reading them would never learn the guide is there.
        const files = withoutGuide.join(" and ");
        await ask({
          type: "info",
          message: `Point ${files} at Fragmentor's rules`,
          detail: `This folder already had ${files}, and Fragmentor never changes files like that. Add a line so your agent reads ${GUIDE_FILE}: "@${GUIDE_FILE}" in CLAUDE.md, or "Read ${GUIDE_FILE} before changing anything." in AGENTS.md.`,
        });
      }
      return ok(await openProject(event.sender, dir));
    } catch (error) {
      return failed(error);
    }
  });

  ipcMain.handle(CHANNELS.loadProject, async (event, dir: string): Promise<Result<ProjectLoad>> => {
    try {
      return ok(await openProject(event.sender, dir));
    } catch (error) {
      return failed(error);
    }
  });

  // Going back to the start screen. Nothing is written: the window simply
  // stops hearing about a folder it is no longer showing.
  ipcMain.handle(CHANNELS.closeProject, async (event): Promise<Result<null>> => {
    stopWatching(event.sender.id);
    return ok(null);
  });

  ipcMain.handle(CHANNELS.readProject, async (_event, dir: string): Promise<Result<ProjectLoad>> => {
    try {
      return ok(await readProject(dir));
    } catch (error) {
      return failed(error);
    }
  });

  ipcMain.handle(CHANNELS.recentProjects, async (): Promise<Result<string[]>> => {
    try {
      return ok(await readRecent());
    } catch (error) {
      return failed(error);
    }
  });

  ipcMain.handle(CHANNELS.exampleProjects, async (): Promise<Result<{ dir: string; name: string }[]>> => {
    try {
      const examples = [
        { dir: path.join(repoRoot, "examples", "job-ranker"), name: "Job Relevance Ranker" },
        { dir: path.join(repoRoot, "examples", "contract-generator"), name: "Contract Generator" },
      ];
      const present: { dir: string; name: string }[] = [];
      for (const example of examples) {
        try {
          await loadProject(example.dir);
          present.push(example);
        } catch {
          // An example that will not load is simply not offered.
        }
      }
      return ok(present);
    } catch (error) {
      return failed(error);
    }
  });

  ipcMain.handle(CHANNELS.writeImpl, async (_event, request: WriteImplRequest): Promise<Result<null>> => {
    try {
      // The file name depends on the language of the system this block is in,
      // and the renderer is not trusted to say which file to write.
      const project = await loadProject(request.dir);
      const system = systemOf(project, request.blockPath);
      if (!system) throw new Error(`"${request.blockPath}" is not part of any system in this project.`);
      // Generated code is rewritten from the diagram, so an edit to it would
      // be lost, and a visual project's code is not Fragmentor's to change.
      if (project.manifest.mode === "visual") throw new Error("A visual project's code is never changed from Fragmentor.");
      if (project.byPath.get(request.blockPath)?.block.kind === "composite") {
        throw new Error(`"${request.blockPath}" has children, so its code is generated from the diagram.`);
      }

      const target = resolveInside(blockDir(request.dir, request.blockPath), getPack(system.language).implFile);
      await writeFile(target, request.contents, "utf8");
      return ok(null);
    } catch (error) {
      return failed(error);
    }
  });

  ipcMain.handle(CHANNELS.saveLayout, async (_event, request: SaveLayoutRequest): Promise<Result<null>> => {
    try {
      resolveInside(request.dir, "layout.json");
      await saveViewLayout(request.dir, request.viewPath, request.positions);
      return ok(null);
    } catch (error) {
      return failed(error);
    }
  });

  ipcMain.handle(CHANNELS.emitCode, async (_event, dir: string): Promise<Result<EmitResult>> => {
    try {
      return ok(await emitProject(await loadProject(dir)));
    } catch (error) {
      return failed(error);
    }
  });

  /** Runs being watched, so the window can steer them while they go. */
  const liveRuns = new Map<string, RunControl>();
  const paths = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

  ipcMain.handle(CHANNELS.watchRun, async (event, request: WatchRunRequest): Promise<Result<RunOutcome>> => {
    try {
      const contents = event.sender;
      const { control, outcome } = startRun({
        projectDir: request.dir,
        blockPath: request.blockPath,
        input: request.input,
        breakpoints: paths(request.breakpoints),
        onEvent: (runEvent) => {
          if (!contents.isDestroyed()) contents.send(CHANNELS.runEvent, request.runId, runEvent);
        },
      });

      // A run held at a breakpoint would otherwise wait for ever on a page
      // that has gone: closed, reloaded or crashed.
      const stop = () => control.stop();
      contents.once("destroyed", stop);
      contents.once("did-start-loading", stop);
      contents.once("render-process-gone", stop);
      liveRuns.set(request.runId, control);
      try {
        return ok(await outcome);
      } finally {
        liveRuns.delete(request.runId);
        contents.removeListener("destroyed", stop);
        contents.removeListener("did-start-loading", stop);
        contents.removeListener("render-process-gone", stop);
      }
    } catch (error) {
      return failed(error);
    }
  });

  ipcMain.handle(CHANNELS.controlRun, async (_event, runId: string, command: RunCommand): Promise<Result<null>> => {
    const control = liveRuns.get(runId);
    if (control && command && typeof command === "object") {
      if (command.type === "resume") control.resume(resumeMode(command.mode));
      else if (command.type === "stop") control.stop();
      else if (command.type === "breakpoints") control.setBreakpoints(paths(command.paths));
    }
    return ok(null);
  });

  ipcMain.handle(CHANNELS.saveCases, async (_event, request: SaveCasesRequest): Promise<Result<null>> => {
    try {
      resolveInside(blockDir(request.dir, request.blockPath), "cases.json");
      await saveCases(request.dir, request.blockPath, request.cases);
      return ok(null);
    } catch (error) {
      return failed(error);
    }
  });

  ipcMain.handle(CHANNELS.runCases, async (_event, dir: string, blockPath: string): Promise<Result<CaseResult[]>> => {
    try {
      return ok(await runCases(dir, blockPath));
    } catch (error) {
      return failed(error);
    }
  });

  ipcMain.handle(CHANNELS.revealBlock, async (_event, dir: string, blockPath: string): Promise<Result<null>> => {
    try {
      shell.showItemInFolder(resolveInside(blockDir(dir, blockPath), "block.json"));
      return ok(null);
    } catch (error) {
      return failed(error);
    }
  });

  ipcMain.handle(CHANNELS.revealCode, async (_event, dir: string, file: string): Promise<Result<null>> => {
    try {
      shell.showItemInFolder(resolveInside(dir, file));
      return ok(null);
    } catch (error) {
      return failed(error);
    }
  });
}

/* -------------------------------------------------------------------------- */
/* Self-check                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A scripted run of the real interface, started with --smoke. The main process
 * plays the agent, changing files in the project, and each step checks that
 * the window noticed on its own. In between, the script uses the controls a
 * person would. It is how this application gets checked without anyone
 * watching it.
 */

const STEP_HELPERS = `
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (test, ms = 8000) => {
    const end = Date.now() + ms;
    for (;;) {
      const value = test();
      if (value || Date.now() > end) return value;
      await wait(100);
    }
  };
  const text = (selector) => (document.querySelector(selector) || {}).textContent || "";
`;

const step = (body: string) => `(async () => {${STEP_HELPERS}\n${body}\n})()`;

/** Everything a person does with an open project, against the example. */
const INTERACTIONS = `
  const drawn = {
    projectOpen: document.body.dataset.project === "open",
    blocks: document.querySelectorAll(".block-box").length,
    buses: document.querySelectorAll(".bus-group").length,
    brackets: document.querySelectorAll(".group-bracket").length,
    treeItems: document.querySelectorAll(".tree .node").length,
    zoom: text("#zoom-level"),
    inspector: text("#inspector h2") || null,
  };

  // Editing a block's code and having it reach the disk is the whole point
  // of this being an application rather than a drawing, so check it.
  const editor = () => document.querySelector(".code-edit-input");
  const saveButton = () => document.querySelector(".code-foot .btn");
  const statusText = () => text("#status");

  const leaf = [...document.querySelectorAll(".tree .node")]
    .find((node) => node.textContent.includes("load-postings"));
  if (!leaf) return { stage: "no-leaf", drawn };
  leaf.click();

  // Its parent's diagram opens with a zoom, so wait for the block to arrive in the inspector.
  const first = await until(() => editor());
  if (!first) return { stage: "no-editor", drawn };
  const original = first.value;
  // Opening a file is not editing it, whatever line endings it was saved with.
  const startsSaved = text(".code-foot .bench-note") === "Saved.";

  const type = (value) => {
    const box = editor();
    box.value = value;
    box.dispatchEvent(new Event("input", { bubbles: true }));
  };

  // However long the file, the box keeps its own size and scrolls inside
  // itself: the coloured copy behind it must not stretch it to the whole file.
  type(original + "\\n// a very long file".repeat(300));
  const box = editor();
  const view = document.querySelector(".code-edit-view");
  const boxBounds = box.getBoundingClientRect();
  const viewBounds = view.getBoundingClientRect();
  const boxKeepsSize = boxBounds.height < 500 && box.scrollHeight > box.clientHeight;
  // The copy has to sit exactly where the box does, or the colours would drift
  // off the letters they belong to.
  const copyLinesUp =
    Math.abs(boxBounds.top - viewBounds.top) < 1 &&
    Math.abs(boxBounds.left - viewBounds.left) < 1 &&
    Math.abs(boxBounds.height - viewBounds.height) < 1 &&
    box.clientWidth === view.clientWidth;
  type(original);

  // Each save is followed by a pause long enough for the window to hear about
  // its own write and reload, so later steps do not race it.
  type(original + "// written by the self-check\\n");
  saveButton().click();
  await wait(900);
  const afterSave = statusText();

  type(original);
  saveButton().click();
  await wait(900);
  // Measured here, before anything navigates away and swaps the editor out.
  const restoredCleanly = editor().value === original && /Saved .*impl\\.ts/.test(statusText());

  // Running a block is what makes this an application rather than a viewer.
  const rankJobs = [...document.querySelectorAll(".tree .node")]
    .find((node) => node.textContent.includes("rank-jobs"));

  let ran = "no rank-jobs in the tree";
  if (rankJobs) {
    rankJobs.click();
    await wait(400);

    const skills = document.querySelector(".bench textarea");
    if (skills) {
      skills.value = JSON.stringify(["TypeScript", "testing"]);
      skills.dispatchEvent(new Event("input", { bubbles: true }));
    }

    const runButton = [...document.querySelectorAll(".bench .btn")]
      .find((button) => button.textContent === "Run block");

    if (!runButton) ran = "no run button";
    else if (runButton.disabled) ran = "run button disabled";
    else {
      runButton.click();
      await wait(8000);
      const output = document.querySelector(".run-result pre.code");
      const problems = document.querySelector(".run-problems li");
      ran = output ? output.textContent.slice(0, 200) : problems ? "PROBLEM: " + problems.textContent : "no result";
    }
  }

  // Each of these is reported rather than allowed to abort the whole check.
  const attempt = async (run) => {
    try {
      return await run();
    } catch (error) {
      return "THREW: " + (error && error.message ? error.message : String(error));
    }
  };

  const nodeOf = (key) => document.querySelector('.block-box[data-key="' + key + '"]');

  const tests = await attempt(async () => {
    const runAll = [...document.querySelectorAll(".section .btn")]
      .find((button) => button.textContent === "Run all tests");
    if (!runAll) return "no run-all button";
    if (runAll.disabled) return "run-all disabled";
    runAll.click();
    await wait(9000);
    const summary = document.querySelector(".case-summary");
    return summary ? summary.textContent : "no summary";
  });

  const dragged = await attempt(async () => {
    const target = nodeOf("load-postings");
    if (!target) return "no block to drag";
    const before = target.getAttribute("transform");
    const at = (type, x, y) =>
      new PointerEvent(type, { bubbles: true, pointerId: 7, clientX: x, clientY: y, isPrimary: true });
    target.dispatchEvent(at("pointerdown", 400, 400));
    window.dispatchEvent(at("pointermove", 480, 460));
    window.dispatchEvent(at("pointerup", 480, 460));
    await wait(400);
    const moved = before !== target.getAttribute("transform");

    target.dispatchEvent(at("pointerdown", 480, 460));
    window.dispatchEvent(at("pointermove", 400, 400));
    window.dispatchEvent(at("pointerup", 400, 400));
    await wait(400);

    const restored = before === target.getAttribute("transform");
    return moved ? (restored ? "moved" : "moved but not restored") : "DID NOT MOVE";
  });

  // Opening a composite moves into it with a zoom, and ends on its diagram.
  const openedByDoubleClick = await attempt(async () => {
    const composite = nodeOf("score-posting");
    if (!composite) return "no composite to open";
    const moving = () => document.getElementById("canvas-svg").classList.contains("moving");
    composite.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const zoomed = Boolean(await until(moving, 400));
    await until(() => !moving(), 3000);
    const crumb = text('.crumb[aria-current="true"]') || "no current crumb";
    return zoomed ? crumb : crumb + " (without zooming)";
  });

  // Finish on a block that has saved tests, scrolled to them, so the
  // screenshot this check captures shows the part worth looking at.
  const shown = await attempt(async () => {
    const withTests = () => [...document.querySelectorAll(".tree .node")]
      .find((node) => node.textContent.includes("extract-profile-keywords"));
    if (!withTests()) return "not found";
    withTests().click();
    await wait(400);

    const runAll = [...document.querySelectorAll(".section .btn")]
      .find((button) => button.textContent === "Run all tests");
    if (runAll && !runAll.disabled) {
      runAll.click();
      await wait(6000);
    }

    // Re-select after the run, since finishing redraws the panels, then
    // scroll so the captured screenshot shows the tests.
    withTests().click();
    await wait(400);

    const panel = document.getElementById("inspector-pane");
    panel.scrollTop = panel.scrollHeight;
    await wait(400);

    const name = document.querySelector(".case-row .case-name");
    const whole = name ? name.scrollWidth <= name.clientWidth + 1 : false;
    return (text("#inspector h2") || "no heading") + " / " + (text(".case-summary") || "no summary") +
      " / name shown whole: " + whole;
  });

  return {
    stage: "opened",
    bootError: text(".boot-error") || null,
    boxKeepsSize,
    copyLinesUp,
    ...drawn,
    ran,
    tests,
    dragged,
    openedByDoubleClick,
    shown,
    savedToDisk: /Saved .*impl\\.ts/.test(afterSave),
    saveMessage: afterSave.slice(-70),
    restoredCleanly,
    startsSaved,
    status: statusText().slice(0, 90),
  };
`;

type StepResult = Record<string, unknown>;

function selfCheckFailures(report: Record<string, StepResult>): string[] {
  const value = (label: string, key: string) => report[label]?.[key];

  const checks: [string, boolean][] = [
    [
      "a new project asks its questions in order, and will not go on until each that applies is answered",
      value("dialog", "blockedAtFirst") === true &&
        value("dialog", "roleUnasked") === true &&
        value("dialog", "roleAsked") === true &&
        value("dialog", "blockedWithoutStart") === true &&
        value("dialog", "blockedWithoutLevel") === true &&
        value("dialog", "ready") === true &&
        value("dialogClosed", "closed") === true,
    ],
    [
      "changing an answer clears the ones below it, and they can be given again",
      value("dialog", "startNotAskedOfExistingCode") === true &&
        value("dialog", "clearedBelow") === true &&
        value("dialog", "answerableAgain") === true,
    ],
    [
      "a planned block is drawn apart from the built ones, and nothing is asked of it",
      value("planned", "drawn") === true &&
        value("planned", "onScreen") === true &&
        value("planned", "label") === "PLANNED" &&
        value("planned", "noBreakpoint") === true &&
        value("planned", "wireIsQuiet") === true &&
        value("planned", "explained") === true &&
        value("planned", "noTesting") === true,
    ],
    ["a new project waits for its agent", value("waiting", "waiting") === true],
    ["the diagram appears once the agent writes the project", value("appeared", "appeared") === true],
    [
      "the interface draws, and nothing crashed",
      value("interface", "stage") === "opened" && !value("interface", "bootError") && Number(value("interface", "blocks")) > 0,
    ],
    ["a file that has only been opened is not reported as edited", value("interface", "startsSaved") === true],
    [
      "the code box keeps its own size and its colouring sits on the letters",
      value("interface", "boxKeepsSize") === true && value("interface", "copyLinesUp") === true,
    ],
    [
      "code saved from the window reaches the disk",
      value("interface", "savedToDisk") === true && value("interface", "restoredCleanly") === true,
    ],
    ["a block renamed on disk is redrawn without a manual reload", value("renamed", "renamed") === true],
    [
      "reloading keeps the diagram and the selection that were on screen",
      value("renamed", "keptView") === "rank-jobs" && value("renamed", "keptSelection") === "Extract Profile Keywords",
    ],
    [
      "a half-written file is reported over the last good diagram",
      value("broken", "reported") === true && Number(value("broken", "stillDrawn")) > 0,
    ],
    ["the report clears once the file is whole again", value("restored", "recovered") === true],
    ["unsaved edits warn when the agent changes the same file", value("conflict", "warned") === true],
    [
      "the inspector lists what the checks found, and the status bar counts it",
      value("problems", "listed") === true && value("problems", "counted") === true,
    ],
    [
      "a visual project hides what only generated code has, and shows the code a block points at",
      value("visual", "generateHidden") === true && value("visual", "linked") === true && value("visual", "noBench") === true,
    ],
    ["opening a block zooms into it and ends on its diagram", value("interface", "openedByDoubleClick") === "score-posting"],
    [
      "a run stops at a breakpoint with what reached the block on its wires, then runs on to the end",
      value("paused", "breakpointSet") === true &&
        value("paused", "paused") === true &&
        value("paused", "heldAt") === "score-posting" &&
        /\[4\]/.test(String(value("paused", "wire"))) &&
        value("watched", "finished") === true &&
        Number(value("watched", "done")) >= 4 &&
        Number(value("watched", "carried")) >= 5 &&
        value("cleared", "cleared") === true &&
        value("cleared", "breakpoints") === 0,
    ],
    [
      "a held run can be stopped, and the diagram shows what it cut short",
      value("stopped", "paused") === true &&
        value("stopped", "ended") === true &&
        Number(value("stopped", "cutShort")) >= 1 &&
        value("stopped", "canReplay") === true,
    ],
    [
      "a focus ring on a block can only enclose the box, not the breakpoint or the capabilities beside it",
      JSON.stringify(value("ring", "withBreakpoint")) ===
        JSON.stringify({ onlyThePlate: true, groupIsBigger: true, blockNotFocusable: true }) &&
        JSON.stringify(value("ring", "withCapability")) ===
          JSON.stringify({ onlyThePlate: true, groupIsBigger: true, blockNotFocusable: true }) &&
        value("ring", "focused") === true &&
        value("ring", "selectedBySpace") === "Score Posting",
    ],
    [
      "every call of a block held at once can be let go together",
      value("continueAll", "offered") === true &&
        value("continueAll", "finished") === true &&
        value("continueAll", "messageWhole") === true,
    ],
    [
      "a saved test's name is shown whole",
      /name shown whole: true/.test(String(value("interface", "shown"))),
    ],
    [
      "the inspector can be dragged wider",
      Number(value("widened", "to")) >= Number(value("widened", "from")) + 150,
    ],
    [
      "wires holding a value keep flowing while a run is held",
      Number(value("paused", "flowing")) >= 1,
    ],
    [
      "stepping moves the canvas into the block once, and leaves it there",
      value("stepped", "stepped") === true &&
        Number(value("stepped", "moves")) <= 1 &&
        /score-posting/.test(String(value("stepped", "ended"))),
    ],
    [
      "a project can be closed, which shows the start screen again",
      value("closed", "back") === true &&
        value("closed", "startScreen") === true &&
        value("closed", "blocks") === 0 &&
        value("closed", "closeHidden") === true,
    ],
    [
      "blocks the agent writes arrive animated, and nothing else does",
      Number(value("appeared", "arrived")) > 0 &&
        value("renamed", "arriving") === 0 &&
        JSON.stringify(value("added", "arriving")) === JSON.stringify(["audit-log"]) &&
        value("added", "inTree") === true,
    ],
  ];

  return checks.filter(([, passed]) => !passed).map(([name]) => name);
}

/**
 * Saves what the window shows to dist/<name>.png, for a person to look over.
 * A screenshot is a record, not a check, so one that cannot be taken is
 * reported and the check carries on.
 */
async function capture(window: BrowserWindow, name: string): Promise<void> {
  const shot = path.join(repoRoot, "dist", `${name}.png`);

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    // The window needs a moment to composite what the script just did, or the
    // capture shows a frame from before it.
    window.webContents.invalidate();
    await new Promise((resolve) => setTimeout(resolve, 900));
    try {
      await writeFile(shot, (await window.webContents.capturePage()).toPNG());
      console.log(`Screenshot: ${shot}`);
      return;
    } catch (error) {
      if (attempt === 3) console.warn(`Could not capture ${name}: ${messageOf(error)}`);
    }
  }
}

// Electron exits with 0 on app.quit() whatever process.exitCode says, so the
// self-check exits explicitly, or a failed check would pass as a command.
function attachSelfCheck(window: BrowserWindow, check: { root: string; projectDir: string }): void {
  window.webContents.on("did-fail-load", (_event, code, description) => {
    console.error(`The window failed to load: ${description} (${code})`);
    app.exit(1);
  });

  // Anything the window complains about belongs in the check's output; a
  // renderer that throws on the way up would otherwise just look inert.
  window.webContents.on("console-message", (event) => {
    if (event.level === "error") console.error(`Window: ${event.message} (${event.sourceId}:${event.lineNumber})`);
  });

  window.webContents.once("did-finish-load", () => {
    void (async () => {
      // The page can finish loading before the window is shown, and a window
      // that has never been shown cannot be captured.
      if (!window.isVisible()) await new Promise<void>((resolve) => window.once("show", () => resolve()));

      const report: Record<string, StepResult> = {};
      const run = async (label: string, body: string) => {
        report[label] = (await window.webContents.executeJavaScript(step(body))) as StepResult;
      };
      const inProject = (...parts: string[]) => path.join(check.projectDir, ...parts);

      try {
        // The person asks for a new project. The questions are asked as a
        // tree: each answer reveals the next, and the form will not go on
        // until every question that applies has one. It is cancelled before
        // the folder picker, which the check cannot answer.
        await run("dialog", `
          document.getElementById("new-project").click();
          const dialog = await until(() => document.querySelector("dialog.new-project[open]"));
          if (!dialog) return { opened: false };
          const create = [...dialog.querySelectorAll(".dialog-actions .btn")].find((b) => b.textContent.startsWith("Choose folder"));
          const blockedAtFirst = create.disabled;
          const roleUnasked = dialog.querySelectorAll('input[name="mode"]').length === 0;
          dialog.querySelector('input[name="starting-point"][value="false"]').click();
          const roleAsked = dialog.querySelectorAll('input[name="mode"]').length === 2;
          dialog.querySelector('input[name="mode"][value="visual"]').click();
          const blockedWithoutStart = create.disabled;
          dialog.querySelector('input[name="start"][value="plan"]').click();
          const blockedWithoutLevel = create.disabled;
          dialog.querySelector('input[name="granularity"][value="3"]').click();
          const ready = !create.disabled;

          // Code that already exists is described or rebuilt, never planned,
          // so that question is not asked of it at all.
          dialog.querySelector('input[name="starting-point"][value="true"]').click();
          dialog.querySelector('input[name="mode"][value="structured"]').click();
          const startNotAskedOfExistingCode = dialog.querySelector('input[name="start"]').closest("fieldset").hidden;

          // Going back clears the answers below, and they can be given again.
          // A radio left checked for a cleared answer could not be re-chosen:
          // clicking the one already checked raises no event at all.
          dialog.querySelector('input[name="starting-point"][value="false"]').click();
          const clearedBelow = ![...dialog.querySelectorAll('input[name="start"]')].some((i) => i.checked);
          dialog.querySelector('input[name="mode"][value="visual"]').click();
          dialog.querySelector('input[name="start"][value="plan"]').click();

          return {
            opened: true,
            blockedAtFirst,
            roleUnasked,
            roleAsked,
            blockedWithoutStart,
            blockedWithoutLevel,
            ready,
            startNotAskedOfExistingCode,
            clearedBelow,
            answerableAgain: !create.disabled,
            languageIsFree: Boolean(dialog.querySelector(".language-slot input[list]")),
            levelText: text("dialog.new-project .dialog-note"),
          };
        `);
        await capture(window, "self-check-dialog");
        await run("dialogClosed", `
          [...document.querySelectorAll("dialog.new-project .btn")].find((b) => b.textContent === "Cancel").click();
          await wait(200);
          return { closed: !document.querySelector("dialog.new-project") };
        `);

        // New project: what the person chose, and no system for the agent to have defined yet.
        await startProject(check.projectDir, {
          mode: "structured",
          granularity: 3,
          language: "typescript",
          existingCode: false,
          start: "build",
        });
        await run("waiting", `
          await wait(400);
          const link = [...document.querySelectorAll(".welcome-link")].find((b) => b.title === ${JSON.stringify(check.projectDir)});
          if (!link) return { waiting: false, links: [...document.querySelectorAll(".welcome-link")].map((b) => b.title || b.textContent) };
          link.click();
          const waiting = await until(() => /FRAGMENTOR\\.md/.test(text(".canvas-empty")));
          return { waiting, note: text(".canvas-empty").slice(0, 120) };
        `);
        await capture(window, "self-check-waiting");

        // The agent defines and builds the system — here, all at once.
        await cp(path.join(repoRoot, "examples", "job-ranker"), check.projectDir, { recursive: true });
        await run("appeared", `
          const blocks = await until(() => document.querySelectorAll(".block-box").length);
          // Everything in a project the agent has only just written is new, so it arrives.
          return { appeared: blocks > 0, blocks, arrived: document.querySelectorAll(".block-body.appearing").length };
        `);

        await run("interface", INTERACTIONS);
        await capture(window, "self-check");
        // A browser draws its focus ring around everything in a group, so the
        // part of a block that can be focused has to be the box and not the
        // group holding the breakpoint and the capability dots as well.
        await run("ring", `
          const measure = (key) => {
            const block = document.querySelector('.block-box[data-key="' + key + '"]');
            if (!block) return null;
            const plate = block.querySelector(".block-plate");
            const focusable = [...block.querySelectorAll('[tabindex="0"]')];
            const group = block.getBoundingClientRect();
            const box = plate.getBoundingClientRect();
            return {
              onlyThePlate: focusable.length === 1 && focusable[0] === plate,
              groupIsBigger: Math.round(group.width - box.width) > 0 || Math.round(group.height - box.height) > 0,
              blockNotFocusable: !block.hasAttribute("tabindex"),
            };
          };
          // Moving what can be focused onto the plate must not take the
          // keyboard with it: the keys are still answered by the block.
          const plate = document.querySelector('.block-box[data-key="score-posting"] .block-plate');
          plate.focus();
          const focused = document.activeElement === plate;
          plate.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
          await wait(200);
          const selectedBySpace = text("#inspector h2");

          return {
            // One with a breakpoint beside it, and one with a capability below it.
            withBreakpoint: measure("score-posting"),
            withCapability: measure("load-postings"),
            focused,
            selectedBySpace,
          };
        `);

        // The edge between the diagram and the inspector is dragged, to make
        // room for code.
        await run("widened", `
          const pane = document.getElementById("inspector-pane");
          const handle = document.getElementById("inspector-splitter");
          const from = pane.getBoundingClientRect().width;
          const edge = window.innerWidth - from;
          const at = (type, x, target) => target.dispatchEvent(
            new PointerEvent(type, { bubbles: true, pointerId: 7, clientX: x, clientY: 400, isPrimary: true }),
          );
          at("pointerdown", edge, handle);
          at("pointermove", edge - 170, window);
          at("pointerup", edge - 170, window);
          await wait(120);
          return { from: Math.round(from), to: Math.round(pane.getBoundingClientRect().width) };
        `);

        // The person sets a breakpoint and watches a run of the system stop there.
        await run("paused", `
          const root = [...document.querySelectorAll(".tree .node")]
            .find((node) => (node.querySelector(".label") || {}).textContent === "rank-jobs");
          if (!root) return { paused: false, stage: "no rank-jobs in the tree" };
          root.click();
          await wait(300);

          const toggle = await until(() => document.querySelector('.block-box[data-key="score-posting"] .breakpoint-hit'));
          if (!toggle) return { paused: false, stage: "no breakpoint to set" };
          toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          const breakpointSet = document.querySelector('.block-box[data-key="score-posting"]').dataset.breakpoint === "true";

          const runButton = await until(() => [...document.querySelectorAll(".bench .btn")]
            .find((button) => button.textContent === "Run block" && !button.disabled));
          if (!runButton) return { breakpointSet, paused: false, stage: "no run button" };
          runButton.click();

          const paused = Boolean(await until(() => /Paused before Score Posting/.test(text("#run-bar")), 20000));
          const held = document.querySelector('.block-box[data-run="paused"]');
          return {
            breakpointSet,
            paused,
            heldAt: held ? held.dataset.key : null,
            wire: text('.bus-group[data-bus="load-postings->score-posting"] .bus-count'),
            inspector: text("#inspector h2"),
            runBar: text("#run-bar"),
            // A paused diagram still shows where the data is.
            flowing: document.querySelectorAll(".bus-pulse.held").length,
          };
        `);
        await capture(window, "self-check-paused");

        // Stepping goes into the block that was held, once, and stays there.
        // Letting one held call go hands the breakpoint to the next in the
        // queue for a moment, which used to drag the canvas in and back out.
        await run("stepped", `
          const step = [...document.querySelectorAll("#run-bar button")].find((button) => button.textContent === "Step");
          if (!step) return { stepped: false };
          const seen = [text("#crumbs")];
          step.click();
          for (let i = 0; i < 50; i += 1) {
            await wait(60);
            const now = text("#crumbs");
            if (now !== seen[seen.length - 1]) seen.push(now);
          }
          return { stepped: true, moves: seen.length - 1, ended: seen[seen.length - 1] };
        `);

        // A block run once per item holds every call at once. "Continue all"
        // lets the whole block through instead of one call at a time.
        await run("continueAll", `
          const button = (label) => [...document.querySelectorAll("#run-bar button")].find((b) => b.textContent === label);
          // Back out of the block the step went into, to where its calls wait.
          for (let i = 0; i < 6; i += 1) {
            if (/Paused before Score Posting/.test(text("#run-bar"))) break;
            const on = button("Continue");
            if (!on) break;
            on.click();
            await wait(600);
          }
          const at = text("#run-bar");
          const all = button("Continue all");
          if (!all) return { offered: false, at };
          all.click();
          // The bar has to say where the run is held, not eat the message to
          // make room for its own buttons.
          const state = document.querySelector(".run-state");
          const messageWhole = state.scrollWidth <= state.clientWidth + 1;
          return {
            offered: true,
            at,
            messageWhole,
            finished: Boolean(await until(() => /finished/.test(text("#run-bar")), 20000)),
            runBar: text("#run-bar"),
          };
        `);

        await run("watched", `
          const next = () => [...document.querySelectorAll("#run-bar button")].find((button) => button.textContent === "Continue");
          for (let i = 0; i < 24; i += 1) {
            const button = next();
            if (button) {
              button.click();
              await wait(500);
              continue;
            }
            if (/finished|failed|stopped/.test(text("#run-bar"))) break;
            await wait(300);
          }
          const finished = Boolean(await until(() => /finished/.test(text("#run-bar")), 20000));
          return {
            finished,
            runBar: text("#run-bar"),
            done: document.querySelectorAll('.block-box[data-run="done"]').length,
            carried: document.querySelectorAll('.bus-group[data-carried="true"]').length,
          };
        `);
        await capture(window, "self-check-watched");

        // The person runs it again, and stops it while it is held.
        await run("stopped", `
          const root = [...document.querySelectorAll(".tree .node")]
            .find((node) => (node.querySelector(".label") || {}).textContent === "rank-jobs");
          if (!root) return { paused: false, stage: "no rank-jobs in the tree" };
          root.click();
          await wait(300);

          const runButton = await until(() => [...document.querySelectorAll(".bench .btn")]
            .find((button) => button.textContent === "Run block" && !button.disabled));
          if (!runButton) return { paused: false, stage: "no run button" };
          runButton.click();

          const paused = Boolean(await until(() => /Paused before/.test(text("#run-bar")), 20000));
          const stop = [...document.querySelectorAll("#run-bar button")].find((button) => button.textContent === "Stop");
          if (stop) stop.click();
          const ended = Boolean(await until(() => /was stopped/.test(text("#run-bar")), 10000));
          return {
            paused,
            ended,
            runBar: text("#run-bar"),
            cutShort: document.querySelectorAll('.block-box[data-run="stopped"]').length,
            canReplay: [...document.querySelectorAll("#run-bar button")].some((button) => button.textContent === "Replay"),
          };
        `);

        // Take the run and the breakpoint off again, and go back to the block
        // the later steps expect, so nothing after this depends on them.
        await run("cleared", `
          const clear = [...document.querySelectorAll("#run-bar button")].find((button) => button.textContent === "Clear");
          if (clear) clear.click();
          const toggle = document.querySelector('.block-box[data-key="score-posting"] .breakpoint-hit');
          if (toggle) toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          const keywords = [...document.querySelectorAll(".tree .node")].find((node) => node.textContent.includes("extract-profile-keywords"));
          if (keywords) keywords.click();
          await wait(300);
          return {
            cleared: document.getElementById("run-bar").hidden,
            breakpoints: document.querySelectorAll('.block-box[data-breakpoint="true"]').length,
          };
        `);

        // The agent renames a block.
        const loadPostings = inProject("blocks", "rank-jobs", "load-postings", "block.json");
        const renamed = { ...JSON.parse(await readFile(loadPostings, "utf8")), name: "Load Postings (renamed on disk)" };
        await writeFile(loadPostings, JSON.stringify(renamed, null, 2), "utf8");
        await run("renamed", `
          const renamed = await until(() => text('.block-box[data-key="load-postings"] .block-name') === "Load Postings (renamed on disk)");
          return {
            renamed,
            keptView: text('.crumb[aria-current="true"]'),
            keptSelection: text("#inspector h2"),
            // A block that was already there is not new, whatever changed about it.
            arriving: document.querySelectorAll(".block-body.appearing").length,
          };
        `);

        // The agent adds a block to the diagram on screen. It has no ports, so
        // the diagram stays free of errors for the steps that count them.
        const auditLog = inProject("blocks", "rank-jobs", "audit-log");
        await mkdir(auditLog, { recursive: true });
        await writeFile(path.join(auditLog, "block.json"), JSON.stringify({ responsibility: "Record what was ranked." }), "utf8");
        const rankJobsFile = inProject("blocks", "rank-jobs", "block.json");
        const withAudit = JSON.parse(await readFile(rankJobsFile, "utf8")) as { children: unknown[] };
        withAudit.children.push("audit-log");
        await writeFile(rankJobsFile, JSON.stringify(withAudit, null, 2), "utf8");
        await run("added", `
          const added = Boolean(await until(() => document.querySelector('.block-box[data-key="audit-log"]')));
          return {
            added,
            arriving: [...document.querySelectorAll(".block-body.appearing")].map((body) => body.parentElement.dataset.key),
            inTree: [...document.querySelectorAll(".tree .node.appearing")].some((node) => node.textContent.includes("audit-log")),
          };
        `);
        await capture(window, "self-check-added");

        // The agent turns that block into a plan: drawn and explained, loosely
        // wired to what it will eventually read, and built into nothing. One
        // of its inputs is left with nothing on it, and the wire that does
        // reach it comes from a real typed output, so the diagram stays free
        // of errors only if nothing is asked of a planned block.
        await writeFile(
          path.join(auditLog, "block.json"),
          JSON.stringify(
            {
              responsibility: "Record what was ranked, so a later run can be compared against it.",
              planned: true,
              inputs: { entries: "the ranked postings", runId: "some identifier, not decided yet" },
              outputs: { written: "whether it was recorded" },
            },
            null,
            2,
          ),
          "utf8",
        );
        const withPlan = JSON.parse(await readFile(rankJobsFile, "utf8")) as { wires: string[] };
        withPlan.wires.push("rank-results.ranked -> audit-log.entries");
        await writeFile(rankJobsFile, JSON.stringify(withPlan, null, 2), "utf8");
        await run("planned", `
          if (!(await until(() => document.querySelector('.block-box[data-key="audit-log"][data-planned="true"]')))) {
            return { drawn: false };
          }
          // A block nobody has laid out lands wherever the automatic layout
          // puts it, which is nowhere near blocks that were placed by hand.
          // Lay the diagram out afresh and fit it, so the screenshot this
          // check leaves behind shows the plan beside what is built.
          document.getElementById("layout-reset").click();
          await wait(500);
          document.getElementById("zoom-fit").click();
          await wait(500);
          const node = [...document.querySelectorAll(".tree .node")].find((n) => n.textContent.includes("audit-log"));
          if (node) node.click();
          await wait(400);
          const box = document.querySelector('.block-box[data-key="audit-log"]');
          const pane = document.getElementById("inspector-pane");
          return {
            drawn: Boolean(box),
            onScreen: Boolean(box) && box.getBoundingClientRect().right < pane.getBoundingClientRect().left,
            label: text('.block-box[data-key="audit-log"] .block-kind'),
            noBreakpoint: Boolean(box) && !box.querySelector(".breakpoint"),
            wireIsQuiet: Boolean(document.querySelector('.bus-group[data-planned="true"]')),
            explained: /generates, checks and runs nothing/.test(text(".planned-note")),
            noTesting: ![...document.querySelectorAll(".group-title")].some((h) => h.textContent === "Testing"),
          };
        `);
        await capture(window, "self-check-planned");

        // Put the selection back on a block whose code can be typed in, which
        // is where the steps after this one carry on from.
        await run("reselected", `
          const node = [...document.querySelectorAll(".tree .node")]
            .find((n) => n.textContent.includes("extract-profile-keywords"));
          if (node) node.click();
          await wait(400);
          return { editable: Boolean(document.querySelector(".code-edit-input")) };
        `);

        // The agent is caught halfway through writing a file, then finishes it.
        const rankResults = inProject("blocks", "rank-jobs", "rank-results", "block.json");
        const whole = await readFile(rankResults, "utf8");
        await writeFile(rankResults, "{ half written", "utf8");
        await run("broken", `
          const banner = await until(() => {
            const note = document.getElementById("load-error");
            return note && !note.hidden ? note.textContent : null;
          });
          return { reported: Boolean(banner && /rank-results/.test(banner)), stillDrawn: document.querySelectorAll(".block-box").length };
        `);
        await capture(window, "self-check-broken");

        await writeFile(rankResults, whole, "utf8");
        await run("restored", `
          return { recovered: Boolean(await until(() => document.getElementById("load-error").hidden)) };
        `);

        // A person has unsaved edits in a file the agent then rewrites.
        await run("typed", `
          const box = document.querySelector(".code-edit-input");
          if (!box) return { typed: false };
          box.value = box.value + "// a person's unsaved edit\\n";
          box.dispatchEvent(new Event("input", { bubbles: true }));
          return { typed: true };
        `);
        const impl = inProject("blocks", "rank-jobs", "extract-profile-keywords", "impl.ts");
        await writeFile(impl, `${await readFile(impl, "utf8")}\n// changed by the agent\n`, "utf8");
        await run("conflict", `
          const warned = await until(() => /changed on disk/.test(text(".code-foot .bench-note")));
          return { warned: Boolean(warned), note: text(".code-foot .bench-note") };
        `);

        // The agent leaves a wire out, so the diagram has a real problem to show.
        const rankJobs = inProject("blocks", "rank-jobs", "block.json");
        const unwired = JSON.parse(await readFile(rankJobs, "utf8")) as { wires: string[] };
        unwired.wires = unwired.wires.filter((wire) => wire !== "extract-profile-keywords.keywords -> score-posting.keywords");
        await writeFile(rankJobs, JSON.stringify(unwired, null, 2), "utf8");
        await run("problems", `
          const root = [...document.querySelectorAll(".tree .node")]
            .find((node) => (node.querySelector(".label") || {}).textContent === "rank-jobs");
          if (!root) return { listed: false };
          root.click();
          const problem = await until(() => {
            const found = [...document.querySelectorAll(".problem.error .problem-text")]
              .find((entry) => /Nothing is connected/.test(entry.textContent));
            return found ? found.textContent : null;
          });
          document.getElementById("inspector-pane").scrollTop = 0;
          return { listed: Boolean(problem), problem, counted: /errors 1/.test(text("#status")) };
        `);
        await capture(window, "self-check-problems");

        // The project becomes a visual one, and a block is pointed at a file.
        const manifestFile = inProject("fragmentor.json");
        await writeFile(manifestFile, JSON.stringify({ ...JSON.parse(await readFile(manifestFile, "utf8")), mode: "visual" }, null, 2), "utf8");
        const pointed = inProject("blocks", "rank-jobs", "load-postings", "block.json");
        await writeFile(pointed, JSON.stringify({ ...JSON.parse(await readFile(pointed, "utf8")), code: "postings.json" }, null, 2), "utf8");
        await run("visual", `
          const generateHidden = Boolean(await until(() => document.getElementById("generate-code").hidden));
          const block = await until(() => document.querySelector('.block-box[data-key="load-postings"]'));
          if (!block) return { generateHidden, linked: false };
          block.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 9, clientX: 5, clientY: 5, isPrimary: true }));
          window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 9, clientX: 5, clientY: 5 }));
          const where = await until(() => text(".code-where"));
          return {
            generateHidden,
            linked: /postings\\.json/.test(where),
            noBench: !document.querySelector(".bench"),
            mode: text(".status .mode-tag"),
          };
        `);
        await capture(window, "self-check-visual");

        await run("closed", `
          document.getElementById("close-project").click();
          await until(() => document.body.dataset.project !== "open");
          await wait(300);
          return {
            back: document.body.dataset.project !== "open",
            startScreen: Boolean(document.querySelector("#welcome-body .welcome-actions")),
            blocks: document.querySelectorAll(".block-box").length,
            closeHidden: document.getElementById("close-project").hidden,
            status: text("#status"),
          };
        `);

        console.log(JSON.stringify(report, null, 2));

        const failures = selfCheckFailures(report);
        if (failures.length > 0) {
          console.error(`The self-check failed:\n${failures.map((failure) => `  - ${failure}`).join("\n")}`);
          process.exitCode = 1;
        } else {
          console.log("The self-check passed.");
        }
      } catch (error) {
        console.log(JSON.stringify(report, null, 2));
        console.error("The self-check could not run:", error);
        process.exitCode = 1;
      } finally {
        for (const id of [...watchers.keys()]) stopWatching(id);
        await rm(check.root, { recursive: true, force: true }).catch(() => {});
        app.exit(process.exitCode === 1 ? 1 : 0);
      }
    })();
  });
}

/* -------------------------------------------------------------------------- */
/* Window                                                                      */
/* -------------------------------------------------------------------------- */

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1040,
    minHeight: 640,
    backgroundColor: "#07090a",
    title: "Fragmentor",
    show: false,
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // A window that is not in front gets its painting throttled, which makes
      // the self-check capture a frame from several steps ago.
      backgroundThrottling: !selfCheck,
    },
  });

  const id = window.webContents.id;
  window.webContents.on("destroyed", () => stopWatching(id));

  if (selfCheck) {
    // Shown but not focused: the page has to be composited to be captured,
    // and taking focus from whoever started the check would be rude.
    window.once("ready-to-show", () => window.showInactive());
    attachSelfCheck(window, selfCheck);
  } else {
    window.once("ready-to-show", () => window.show());
  }

  void window.loadFile(path.join(here, "renderer", "index.html"));

  // Nothing in this application should navigate away or open a browser window.
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
}

void app.whenReady().then(() => {
  registerHandlers();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
