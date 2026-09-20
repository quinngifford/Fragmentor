import { cpSync, mkdirSync, mkdtempSync, watch, writeFileSync } from "node:fs";
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
  WatchRunRequest,
  WriteImplRequest,
} from "./ipc.js";
import { projectSnapshot } from "../src/project/snapshot.js";
import { blockDir, loadProject, locateCode, manifestPath, systemOf } from "../src/project/project.js";
import { getPack, isKnownLanguage } from "../src/lang/index.js";
import { isArchitecture } from "../src/model/roles.js";
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

function prepareSelfCheck(): { root: string; projectDir: string; application: string; messenger: string } {
  const root = mkdtempSync(path.join(tmpdir(), "fragmentor-self-check-"));
  const projectDir = path.join(root, "project");
  const userData = path.join(root, "user-data");
  mkdirSync(projectDir);
  mkdirSync(userData);

  // A copy of the example, so the check can look at a whole architecture,
  // and run it, without touching the repository's own.
  const application = path.join(root, "tickets");
  cpSync(path.join(repoRoot, "examples", "tickets"), application, { recursive: true });
  // And one described from reading its code, with executions written down.
  const messenger = path.join(root, "messenger");
  cpSync(path.join(repoRoot, "examples", "messenger"), messenger, { recursive: true });

  // Offered on the welcome screen as recent projects, which is how the check opens them.
  writeFileSync(path.join(userData, "recent-projects.json"), JSON.stringify([projectDir, application, messenger]));
  app.setPath("userData", userData);
  return { root, projectDir, application, messenger };
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

/** Changes that are nobody's business: the folders tools keep inside a project. */
function ignored(filename: string): boolean {
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
        { dir: path.join(repoRoot, "examples", "tickets"), name: "Tickets" },
        { dir: path.join(repoRoot, "examples", "messenger"), name: "Messenger" },
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
      const node = project.byPath.get(request.blockPath);
      if (node && isArchitecture(node.block.role)) {
        throw new Error(`"${request.blockPath}" is not a function, so it has no code of its own.`);
      }

      const target = resolveInside(blockDir(request.dir, request.blockPath), getPack(system.language).implFile);
      await writeFile(target, request.contents, "utf8");
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
        stores: request.stores ?? {},
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

  ipcMain.handle(
    CHANNELS.readCode,
    async (_event, dir: string, pointer: string): Promise<Result<{ file: string; line: number | null; text: string | null }>> => {
      try {
        const found = await locateCode(dir, pointer);
        if (!found.ok) return { ok: false, error: found.problem };
        return ok({ file: found.location.file, line: found.location.line, text: found.location.text });
      } catch (error) {
        return failed(error);
      }
    },
  );

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
    .find((node) => node.textContent.includes("price-seat"));
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
  let ran = "no run button";
  const runButton = [...document.querySelectorAll(".bench .btn")].find((button) => button.textContent === "Run block");
  if (runButton && runButton.disabled) ran = "run button disabled";
  else if (runButton) {
    const set = (label, value) => {
      const field = [...document.querySelectorAll(".bench .field")].find((f) => (f.querySelector("label") || {}).textContent === label);
      if (!field) return;
      field.querySelector("input").value = value;
      field.querySelector("input").dispatchEvent(new Event("input", { bubbles: true }));
    };
    set("fullPrice", "25");
    set("seat", "5");
    runButton.click();
    await wait(8000);
    const output = document.querySelector(".run-result pre.code");
    const problems = document.querySelector(".run-problems li");
    ran = output ? output.textContent.slice(0, 200) : problems ? "PROBLEM: " + problems.textContent : "no result";
  }

  // Each of these is reported rather than allowed to abort the whole check.
  const attempt = async (run) => {
    try {
      return await run();
    } catch (error) {
      return "THREW: " + (error && error.message ? error.message : String(error));
    }
  };

  const nodeOf = (key) => document.querySelector('.block-box[data-id="' + key + '"]');

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

  // A block with parts folds them away and brings them back, which is the
  // one thing that takes a block off the tree.
  const foldedAway = await attempt(async () => {
    const pricing = nodeOf("pricing");
    if (!pricing) return "no block with parts to fold";
    pricing.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await wait(500);
    const gone = !nodeOf("price-seat");
    pricing.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await wait(500);
    const back = Boolean(nodeOf("price-seat"));
    return gone && back ? "folded and unfolded" : gone ? "did not come back" : "DID NOT FOLD";
  });

  // Finish on a block that has saved tests, scrolled to them, so the
  // screenshot this check captures shows the part worth looking at.
  const shown = await attempt(async () => {
    const withTests = () => [...document.querySelectorAll(".tree .node")]
      .find((node) => node.textContent.includes("refund-for"));
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
    foldedAway,
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
      "a whole application is one tree: every block of it on screen, each under what it is part of",
      value("application", "opened") === true &&
        value("application", "systemOnTop") === true &&
        value("application", "partsUnder") === true &&
        Number(value("application", "blocks")) === 13 &&
        value("application", "tidy") === true &&
        // What is part of what is drawn as plain lines, never as arrows.
        Number(value("application", "branches")) > 0 &&
        Number(value("application", "branchArrows")) === 0 &&
        // Four kinds, four colours. Which exact colours is the person's to
        // choose, and a screen can shift them, so what is held here is that
        // they are told apart rather than what they are.
        value("application", "distinctColours") === true &&
        value("application", "marks") === value("application", "blocks") &&
        value("application", "plannedBlock") === "true" &&
        value("application", "dependencies") === "Dependencies: hidden" &&
        value("application", "arrowsHidden") === "none",
    ],
    [
      "what each block reaches is asked for separately, and is gathered onto whatever is on screen",
      (() => {
        const shown = value("reaches", "shown") as { label?: string; arrows?: number; readAndWrite?: boolean; plannedLine?: boolean };
        const folded = value("reaches", "folded") as { partsGone?: boolean; gathered?: boolean };
        return (
          shown?.label === "Dependencies: shown" &&
          Number(shown?.arrows) > 0 &&
          shown?.readAndWrite === true &&
          shown?.plannedLine === true &&
          // Folding takes the parts off the tree, and what they reach is then
          // reached through the block standing for them.
          folded?.partsGone === true &&
          folded?.gathered === true &&
          value("reaches", "back") === true
        );
      })(),
    ],
    [
      "the functions inside a service still have a bench and a run behind them, and a button leads to one",
      value("structured", "opened") === true &&
        value("structured", "subtype") === "SERVICE: REST API" &&
        value("structured", "bench") === true &&
        value("structured", "runnable") === true &&
        // Every block of the application, on one tree.
      value("structured", "drawn") ===
        "book-seats booking-api box-office cancel-booking find-event outbox price-seat pricing refund-for reminders reserve tickets tickets-db" &&
        // What a service offers, read in a window of its own.
        value("structured", "window") === "Booking API" &&
        String(value("structured", "operations")).includes("bookSeats") &&
        value("structured", "closed") === true &&
        String(value("structured", "triggers")).includes("tickets/box-office=>tickets/booking-api:calls") &&
        /Booking API/.test(String(value("structured", "route"))) &&
        /Book Seats/.test(String(value("structured", "route"))) &&
        value("structured", "canGo") === true &&
        value("structured", "wentTo") === "tickets/booking-api/book-seats" &&
        value("structured", "benchThere") === true,
    ],
    [
      "seats are booked from the box office without naming the block that answers: the database is written and the confirmation goes on a queue",
      value("fromTheTop", "offered") === true &&
        value("fromTheTop", "label") === "Run bookSeats" &&
        value("fromTheTop", "ran") === true &&
        value("fromTheTop", "sent") === true &&
        value("fromTheTop", "written") === true,
    ],
    [
      "a store can be seeded from the bench, and the run reads what was put there",
      value("store", "offered") === true &&
        value("store", "ran") === true &&
        value("store", "reachedTheStore") === true &&
        String(value("store", "shape") ?? "").includes("seatsLeft"),
    ],
    [
      "colouring changes what is drawn, and the legend explains it and folds away",
      value("toggles", "byBlockFirst") === "Colour: by block" &&
        value("toggles", "legendGone") === true &&
        value("toggles", "byKind") === "Colour: by kind" &&
        value("toggles", "named") === true &&
        value("toggles", "tinted") === true &&
        value("toggles", "arrowAtRight") === true &&
        value("toggles", "folded") === true &&
        value("toggles", "unfolded") === true &&
        // Every block a colour of its own, and the button back where it was.
        value("byBlock", "apart") === true &&
        value("backToBlock", "label") === "Colour: by block",
    ],
    [
      "an execution is stepped through on the tree, one arrow at a time, and read end to end as its own drawing",
      value("execution", "opened") === true &&
        value("execution", "offered") === "clean-up-sessions deliver-a-notification log-in log-out send-a-message" &&
        value("execution", "source") === "declared" &&
        value("execution", "count") === "1 of 19" &&
        // What sets it going, in the agent's words, from outside the system.
        /Someone uses Send Button/.test(String(value("execution", "caption"))) &&
        Number(value("execution", "arrows")) === 1 &&
        value("execution", "fromOutside") === "outside" &&
        value("execution", "lit") === "send-button" &&
        value("execution", "page") === "Step 1 of 19" &&
        /Ada presses send/.test(String(value("execution", "said"))) &&
        value("execution", "code") === "src/client/ui/sendButton.ts#onSendPressed" &&
        (() => {
          const stepped = value("stepping", "stepped") as { count?: string; lit?: string; label?: string };
          const back = value("stepping", "back") as { count?: string; way?: string; caption?: string };
          const hidden = value("stepping", "hidden") as { partsGone?: boolean; count?: string; caption?: string };
          const opened = value("stepping", "opened") as { partsBack?: boolean; count?: string; lit?: string; caption?: string };
          return (
            stepped?.count === "2 of 19" &&
            stepped?.lit === "send-button state" &&
            stepped?.label === "call" &&
            // The answer out of the database runs the other way along its arrow.
            back?.count === "7 of 19" &&
            back?.way === "back" &&
            /gives back/.test(String(back?.caption)) &&
            // Folded away, the step between two of the client's parts is
            // passed over: stepping lands on what it can show instead.
            hidden?.partsGone === true &&
            hidden?.count === "3 of 19" &&
            // Stepping in goes to it anyway, and opens what hid it.
            opened?.partsBack === true &&
            opened?.count === "2 of 19" &&
            opened?.lit === "send-button state" &&
            /Send Button calls State/.test(String(opened?.caption))
          );
        })() &&
        (() => {
          const picked = value("flow", "picked") as { page?: string; count?: string };
          return (
            // Every step of the run, wrapped onto more than one row.
            Number(value("flow", "boxes")) === 18 &&
            Number(value("flow", "rows")) > 1 &&
            // One arrow for every step but the four it left behind.
            Number(value("flow", "arrows")) === 15 &&
            // The router is drawn again each time the run comes back to it.
            Number(value("flow", "repeated")) > 1 &&
            // Picking a step out of the flow asks about that step, on both drawings.
            picked?.page === "Step 6 of 19" &&
            value("flow", "backOnTree") === true &&
            value("flow", "sameStep") === picked?.count
          );
        })(),
    ],
    [
      "a database is drawn as itself, with its shape on show and the block that reads it joined to it",
      value("architecture", "drawn") === true &&
        value("architecture", "label") === "DATABASE" &&
        (() => {
          const held = value("architecture", "held") as { title?: string; table?: string; shape?: string };
          return held?.title === "Venues" && held?.table === "venues" && /capacity/.test(String(held?.shape));
        })() &&
        value("architecture", "joined") === true &&
        value("architecture", "joinLabel") === "reads venues" &&
        // A line takes the colour of what it reaches, so the two agree.
        value("architecture", "lineMatchesStore") === true &&
        // Dashed means not built yet, and this one is built.
        ["none", ""].includes(String(value("architecture", "solid"))) &&
        value("architecture", "under") === true &&
        /database/.test(String(value("architecture", "badges"))) &&
        !/not code/.test(String(value("architecture", "badges"))) &&
        /venues/.test(String(value("architecture", "offers"))) &&
        value("architecture", "noPorts") === true,
    ],
    [
      "a planned block is drawn apart from the built ones, and nothing is asked of it",
      value("planned", "drawn") === true &&
        value("planned", "onScreen") === true &&
        value("planned", "label") === "PLANNED" &&
        value("planned", "noBreakpoint") === true &&
        value("planned", "explained") === true &&
        value("planned", "noTesting") === true,
    ],
    [
      "a new project waits for its agent, and says what to ask for in the words of the answers given",
      value("waiting", "waiting") === true &&
        /greyed out/.test(String(value("waiting", "note"))) &&
        /planned blocks appear here/.test(String(value("waiting", "note"))) &&
        !/greyed out/.test(String(value("building", "note"))) &&
        /describe what you want to build/.test(String(value("building", "note"))),
    ],
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
      value("renamed", "keptView") === "refund-for" && value("renamed", "keptSelection") === "Refund For",
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
    ["a block with parts folds them away and brings them back", value("interface", "foldedAway") === "folded and unfolded"],
    [
      "a run stops at a breakpoint, then runs on to the end",
      value("paused", "breakpointSet") === true &&
        value("paused", "paused") === true &&
        String(value("paused", "heldAt")).split(" ").includes("price-seat") &&
        value("watched", "finished") === true &&
        value("cleared", "cleared") === true &&
        value("cleared", "breakpoints") === 0,
    ],
    [
      "a block on screen shows what a run did anywhere inside it, whoever called it, and one it never touched stays dark",
      // Every block that holds something the run touched says so, up to the
      // system itself; the handler it never called stays dark.
      value("watched", "done") === "book-seats booking-api find-event price-seat pricing reserve tickets" &&
        value("watched", "untouched") === true,
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
        value("ring", "selectedBySpace") === "Book Seats",
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
      "stepping moves the canvas at most once, and leaves it where the run is held",
      value("stepped", "stepped") === true &&
        Number(value("stepped", "moves")) <= 1 &&
        /pricing/.test(String(value("stepped", "ended"))),
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
function attachSelfCheck(
  window: BrowserWindow,
  check: { root: string; projectDir: string; application: string; messenger: string },
): void {
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

        // New project: what the person chose, and no system for the agent to
        // have defined yet. It is started as a plan, because the first thing
        // the empty canvas says is supposed to follow the answers given.
        await startProject(check.projectDir, {
          mode: "structured",
          granularity: 3,
          language: "typescript",
          existingCode: false,
          start: "plan",
        });
        await run("waiting", `
          await wait(400);
          const link = [...document.querySelectorAll(".welcome-link")].find((b) => b.title === ${JSON.stringify(check.projectDir)});
          if (!link) return { waiting: false, links: [...document.querySelectorAll(".welcome-link")].map((b) => b.title || b.textContent) };
          link.click();
          const waiting = await until(() => /FRAGMENTOR\\.md/.test(text(".canvas-empty")));
          return { waiting, note: text(".canvas-empty") };
        `);
        await capture(window, "self-check-waiting");

        // The same project set to build instead. Nothing else about it
        // changes, so whatever the canvas now says came from that answer.
        const startFile = inProject("fragmentor.json");
        await writeFile(
          startFile,
          JSON.stringify({ ...JSON.parse(await readFile(startFile, "utf8")), start: "build" }, null, 2),
          "utf8",
        );
        await run("building", `
          const note = await until(() => {
            const shown = text(".canvas-empty");
            return /greyed out/.test(shown) ? null : shown;
          });
          return { note: note || text(".canvas-empty") };
        `);

        // The agent defines and builds the system — here, all at once.
        await cp(path.join(repoRoot, "examples", "tickets"), check.projectDir, { recursive: true });
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
          const api = [...document.querySelectorAll(".tree .node")].find((node) => (node.querySelector(".label") || {}).textContent === "booking-api");
          if (api) api.click();
          await until(() => document.querySelector('.block-box[data-id="find-event"]'), 3000);
          await wait(900);
          const measure = (key) => {
            const block = document.querySelector('.block-box[data-id="' + key + '"]');
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
          const plate = document.querySelector('.block-box[data-id="book-seats"] .block-plate');
          plate.focus();
          const focused = document.activeElement === plate;
          plate.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
          await wait(200);
          const selectedBySpace = text("#inspector h2");

          return {
            // Both have a breakpoint beside them and capabilities below.
            withBreakpoint: measure("book-seats"),
            withCapability: measure("find-event"),
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

        // The person sets a breakpoint on the block that prices a seat, and
        // books five seats: each is priced at once, and the run stops there.
        await run("paused", `
          const node = (label) => [...document.querySelectorAll(".tree .node")].find((n) => (n.querySelector(".label") || {}).textContent === label);
          node("price-seat").click();
          const toggle = await until(() => document.querySelector('.block-box[data-id="price-seat"] .breakpoint-hit'));
          if (!toggle) return { paused: false, stage: "no breakpoint to set" };
          await wait(700);
          document.querySelector('.block-box[data-id="price-seat"] .breakpoint-hit').dispatchEvent(new MouseEvent("click", { bubbles: true }));
          const breakpointSet = document.querySelector('.block-box[data-id="price-seat"]').dataset.breakpoint === "true";

          node("book-seats").click();
          const bench = await until(() => text(".insp-id") === "tickets/booking-api/book-seats" && document.querySelector(".bench"), 5000);
          if (!bench) return { breakpointSet, paused: false, stage: "no bench for book-seats" };
          const set = (label, value) => {
            const field = [...bench.querySelectorAll(".field")].find((f) => (f.querySelector("label") || {}).textContent === label);
            const control = field.querySelector("input, textarea");
            control.value = value;
            control.dispatchEvent(new Event("input", { bubbles: true }));
          };
          set("eventId", "gig");
          set("seats", "5");
          set("email", "ada@example.com");
          set("Tickets Database · events", JSON.stringify({ gig: { id: "gig", name: "Night Gig", seatsLeft: 10, price: 25 } }));

          const runButton = [...bench.querySelectorAll(".btn")].find((button) => button.textContent === "Run block" && !button.disabled);
          if (!runButton) return { breakpointSet, paused: false, stage: "no run button" };
          runButton.click();

          const paused = Boolean(await until(() => /Paused before Price Seat/.test(text("#run-bar")), 20000));
          await wait(900);
          return {
            breakpointSet,
            paused,
            heldAt: [...document.querySelectorAll('.block-box[data-run="paused"]')].map((box) => box.dataset.id).join(" "),
            inspector: text("#inspector h2"),
            runBar: text("#run-bar"),
          };
        `);
        await capture(window, "self-check-paused");

        // Stepping lets the held call go and stops at whatever starts next.
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

        // A block called for several things at once holds every call.
        // "Continue all" lets the whole block through instead of one at a time.
        await run("continueAll", `
          const button = (label) => [...document.querySelectorAll("#run-bar button")].find((b) => b.textContent === label);
          for (let i = 0; i < 6; i += 1) {
            if (/Paused before Price Seat/.test(text("#run-bar"))) break;
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

        // Seen from the API, a block shows what happened anywhere inside it,
        // whoever called it: the handler, the event it looked up, and the
        // pricing it asked for ran, and the cancelling handler was never
        // touched.
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
          const api = [...document.querySelectorAll(".tree .node")].find((n) => (n.querySelector(".label") || {}).textContent === "booking-api");
          if (api) api.click();
          await until(() => document.querySelector('.block-box[data-id="cancel-booking"]'), 3000);
          await wait(900);
          return {
            finished,
            runBar: text("#run-bar"),
            done: [...document.querySelectorAll('.block-box[data-run="done"]')].map((box) => box.dataset.id).sort().join(" "),
            untouched: !document.querySelector('.block-box[data-id="cancel-booking"]').dataset.run,
          };
        `);
        await capture(window, "self-check-watched");

        // The person runs it again, and stops it while it is held.
        await run("stopped", `
          const node = [...document.querySelectorAll(".tree .node")].find((n) => (n.querySelector(".label") || {}).textContent === "book-seats");
          if (!node) return { paused: false, stage: "no book-seats in the tree" };
          node.click();

          // Watching a run leaves the panel on whichever block it was last
          // showing. Wait for the panel to be the one this step means to run,
          // or the bench found below would be another block's.
          const onBlock = Boolean(await until(() => text(".insp-id") === "tickets/booking-api/book-seats", 10000));
          if (!onBlock) return { paused: false, stage: "panel stayed on " + text(".insp-id") };

          const runButton = await until(() => [...document.querySelectorAll(".bench .btn")]
            .find((button) => button.textContent === "Run block" && !button.disabled));
          if (!runButton) return { paused: false, stage: "no run button" };
          runButton.click();

          const paused = Boolean(await until(() => /Paused before/.test(text("#run-bar")), 20000));
          await wait(900);
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

        // Take the run and the breakpoint off again, and go to the block the
        // later steps expect, so nothing after this depends on them.
        await run("cleared", `
          const node = (label) => [...document.querySelectorAll(".tree .node")].find((n) => (n.querySelector(".label") || {}).textContent === label);
          const clear = [...document.querySelectorAll("#run-bar button")].find((button) => button.textContent === "Clear");
          if (clear) clear.click();
          node("price-seat").click();
          await until(() => document.querySelector('.block-box[data-id="price-seat"] .breakpoint-hit'), 3000);
          await wait(700);
          const toggle = document.querySelector('.block-box[data-id="price-seat"] .breakpoint-hit');
          if (toggle) toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          node("refund-for").click();
          await wait(500);
          return {
            cleared: document.getElementById("run-bar").hidden,
            breakpoints: document.querySelectorAll('.block-box[data-breakpoint="true"]').length,
          };
        `);

        // The agent renames a block.
        const priceSeatFile = inProject("blocks", "tickets", "booking-api", "pricing", "price-seat", "block.json");
        const renamed = { ...JSON.parse(await readFile(priceSeatFile, "utf8")), name: "Price Seat (renamed on disk)" };
        await writeFile(priceSeatFile, JSON.stringify(renamed, null, 2), "utf8");
        await run("renamed", `
          const renamed = await until(() => {
            const plate = document.querySelector('.block-box[data-id="price-seat"] .block-plate');
            return plate && plate.getAttribute("aria-label") === "Price Seat (renamed on disk)";
          });
          return {
            renamed,
            keptView: text('.crumb[aria-current="true"]'),
            keptSelection: text("#inspector h2"),
            // A block that was already there is not new, whatever changed about it.
            arriving: document.querySelectorAll(".block-body.appearing").length,
          };
        `);

        // The agent adds a block to the diagram on screen. It takes nothing
        // and returns nothing, which a block may do.
        const auditLog = inProject("blocks", "tickets", "booking-api", "pricing", "audit-log");
        await mkdir(auditLog, { recursive: true });
        await writeFile(path.join(auditLog, "block.json"), JSON.stringify({ responsibility: "Record what was priced." }), "utf8");
        await run("added", `
          const added = Boolean(await until(() => document.querySelector('.block-box[data-id="audit-log"]')));
          return {
            added,
            arriving: [...document.querySelectorAll(".block-body.appearing")].map((body) => body.parentElement.dataset.id),
            inTree: [...document.querySelectorAll(".tree .node.appearing")].some((node) => node.textContent.includes("audit-log")),
          };
        `);
        await capture(window, "self-check-added");

        // The agent turns that block into a plan: drawn and explained, with
        // its types still words, and built into nothing.
        await writeFile(
          path.join(auditLog, "block.json"),
          JSON.stringify(
            {
              responsibility: "Record what was priced, so a later day can be compared against it.",
              planned: true,
              inputs: { prices: "the prices worked out", runId: "some identifier, not decided yet" },
            },
            null,
            2,
          ),
          "utf8",
        );
        await run("planned", `
          if (!(await until(() => document.querySelector('.block-box[data-id="audit-log"][data-planned="true"]')))) {
            return { drawn: false };
          }
          // Fitted, so the screenshot this check leaves behind shows the
          // plan beside what is built.
          document.getElementById("zoom-fit").click();
          await wait(500);
          const node = [...document.querySelectorAll(".tree .node")].find((n) => n.textContent.includes("audit-log"));
          if (node) node.click();
          await wait(400);
          const box = document.querySelector('.block-box[data-id="audit-log"]');
          const pane = document.getElementById("inspector-pane");
          return {
            drawn: Boolean(box),
            onScreen: Boolean(box) && box.getBoundingClientRect().right < pane.getBoundingClientRect().left,
            label: text('.block-box[data-id="audit-log"] .block-kind'),
            noBreakpoint: Boolean(box) && !box.querySelector(".breakpoint"),
            explained: /generates, checks and runs nothing/.test(text(".planned-note")),
            noTesting: ![...document.querySelectorAll(".group-title")].some((h) => h.textContent === "Testing"),
          };
        `);
        await capture(window, "self-check-planned");

        // Put the selection back on a block whose code can be typed in, which
        // is where the steps after this one carry on from.
        await run("reselected", `
          const node = [...document.querySelectorAll(".tree .node")].find((n) => n.textContent.includes("refund-for"));
          if (node) node.click();
          await wait(400);
          return { editable: Boolean(document.querySelector(".code-edit-input")) };
        `);

        // The agent is caught halfway through writing a file, then finishes it.
        const refundFor = inProject("blocks", "tickets", "booking-api", "pricing", "refund-for", "block.json");
        const whole = await readFile(refundFor, "utf8");
        await writeFile(refundFor, "{ half written", "utf8");
        await run("broken", `
          const banner = await until(() => {
            const note = document.getElementById("load-error");
            return note && !note.hidden ? note.textContent : null;
          });
          return { reported: Boolean(banner && /refund-for/.test(banner)), stillDrawn: document.querySelectorAll(".block-box").length };
        `);
        await capture(window, "self-check-broken");

        await writeFile(refundFor, whole, "utf8");
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
        const impl = inProject("blocks", "tickets", "booking-api", "pricing", "refund-for", "impl.ts");
        await writeFile(impl, `${await readFile(impl, "utf8")}\n// changed by the agent\n`, "utf8");
        await run("conflict", `
          const warned = await until(() => /changed on disk/.test(text(".code-foot .bench-note")));
          return { warned: Boolean(warned), note: text(".code-foot .bench-note") };
        `);

        // The agent points a store port at a table that is not there, so the
        // diagram has a real problem to show.
        const findEvent = inProject("blocks", "tickets", "booking-api", "find-event", "block.json");
        const misread = JSON.parse(await readFile(findEvent, "utf8")) as { access: string[] };
        misread.access = ["events reads tickets-db.venues"];
        await writeFile(findEvent, JSON.stringify(misread, null, 2), "utf8");
        await run("problems", `
          const node = [...document.querySelectorAll(".tree .node")].find((n) => (n.querySelector(".label") || {}).textContent === "find-event");
          if (!node) return { listed: false };
          node.click();
          const problem = await until(() => {
            const found = [...document.querySelectorAll(".problem.error .problem-text")]
              .find((entry) => /exposes no table called "venues"/.test(entry.textContent));
            return found ? found.textContent : null;
          });
          document.getElementById("inspector-pane").scrollTop = 0;
          return { listed: Boolean(problem), problem, counted: /errors 1/.test(text("#status")) };
        `);
        await capture(window, "self-check-problems");

        // The project becomes a visual one, and a block is pointed at a file.
        const manifestFile = inProject("fragmentor.json");
        await writeFile(manifestFile, JSON.stringify({ ...JSON.parse(await readFile(manifestFile, "utf8")), mode: "visual" }, null, 2), "utf8");
        await writeFile(
          findEvent,
          JSON.stringify({ ...JSON.parse(await readFile(findEvent, "utf8")), code: "blocks/tickets/booking-api/find-event/impl.ts" }, null, 2),
          "utf8",
        );
        await run("visual", `
          const generateHidden = Boolean(await until(() => document.getElementById("generate-code").hidden));
          const block = await until(() => document.querySelector('.block-box[data-id="find-event"]'));
          if (!block) return { generateHidden, linked: false };
          block.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 9, clientX: 5, clientY: 5, isPrimary: true }));
          window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 9, clientX: 5, clientY: 5 }));
          const where = await until(() => text(".code-where"));
          return {
            generateHidden,
            linked: /find-event\\/impl\\.ts/.test(where),
            noBench: !document.querySelector(".bench"),
            mode: text(".status .mode-tag"),
          };
        `);
        await capture(window, "self-check-visual");

        // The agent draws more of the system: the venues the events are held
        // at become a store of their own, kept beside the block that reads
        // them, with its shape on show and the block joined straight to it.
        const venuesDb = inProject("blocks", "tickets", "booking-api", "venues-db");
        await mkdir(venuesDb, { recursive: true });
        await writeFile(
          path.join(venuesDb, "block.json"),
          JSON.stringify(
            {
              name: "Venues",
              role: "database",
              responsibility: "Every venue an event can be held at.",
              exposes: { venues: { type: "{ id: string; name: string; capacity: number }", description: "One row per venue." } },
            },
            null,
            2,
          ),
          "utf8",
        );
        await writeFile(
          findEvent,
          JSON.stringify(
            { ...JSON.parse(await readFile(findEvent, "utf8")), access: ["events reads tickets-db.events", "reads venues-db.venues"] },
            null,
            2,
          ),
          "utf8",
        );

        await run("architecture", `
          if (!(await until(() => document.querySelector('.block-box[data-id="venues-db"][data-architecture="true"]')))) {
            return { drawn: false };
          }
          document.getElementById("zoom-fit").click();
          await wait(500);
          const box = document.querySelector('.block-box[data-id="venues-db"]');
          box.querySelector(".block-plate").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 11, clientX: 5, clientY: 5, isPrimary: true }));
          window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 11, clientX: 5, clientY: 5 }));
          await wait(400);

          // What it holds is read in its own window: a table, and its columns.
          document.querySelector('.block-box[data-id="venues-db"] .block-button').dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await wait(400);
          const held = {
            title: text("#overlay .window-names h2"),
            table: [...document.querySelectorAll("#overlay .pname")].map((each) => each.textContent).join(" "),
            shape: [...document.querySelectorAll("#overlay .ptype")].map((each) => each.textContent).join(" "),
          };
          document.querySelector("#overlay .window-close").click();
          await wait(300);

          // And the block that reads it is joined to it, once the arrows are asked for.
          const dependencies = document.getElementById("show-dependencies");
          const setArrows = async (wanted) => {
            if (dependencies.textContent !== "Dependencies: " + wanted) dependencies.click();
            await wait(400);
          };
          await setArrows("shown");
          const join = document.querySelector('.access-group[data-access="tickets/booking-api/find-event=>tickets/booking-api/venues-db:reads"]');
          const drawn = {
            label: text('.block-box[data-id="venues-db"] .block-kind'),
            joined: Boolean(join),
            joinLabel: join ? join.querySelector(".access-label").textContent : "",
            lineMatchesStore: Boolean(join) &&
              getComputedStyle(join.querySelector(".access")).stroke === getComputedStyle(box.querySelector(".block-kind")).fill,
            solid: join ? getComputedStyle(join.querySelector(".access")).strokeDasharray : "",
            // It is a part of the service that keeps it, so it hangs under it.
            under: box.getBoundingClientRect().top >= document.querySelector('.block-box[data-id="booking-api"]').getBoundingClientRect().bottom,
          };
          await setArrows("hidden");

          return {
            drawn: true,
            held,
            ...drawn,
            badges: [...document.querySelectorAll(".badge")].map((b) => b.textContent).join(" "),
            offers: [...document.querySelectorAll(".insp-body .pname, .ports .pname")].map((n) => n.textContent).join(" "),
            noPorts: ![...document.querySelectorAll(".section h4")].some((h) => h.textContent === "Inputs"),
          };
        `);
        await capture(window, "self-check-architecture");

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

        // A whole application, drawn as one tree: every block of it on screen
        // at once, each under whatever it is part of.
        await run("application", `
          const link = [...document.querySelectorAll(".welcome-link")].find((b) => b.title === ${JSON.stringify(check.application)});
          if (!link) return { opened: false };
          link.click();
          if (!(await until(() => document.querySelector('.block-box[data-id="tickets-db"]')))) return { opened: false };
          document.getElementById("zoom-fit").click();
          await wait(600);

          const node = (id) => document.querySelector('.block-box[data-id="' + id + '"]');
          const box = (id) => node(id).getBoundingClientRect();
          const colour = (id) => getComputedStyle(node(id).querySelector(".block-kind")).fill;

          // Every part is drawn under the block it is part of.
          const under = (part, whole) => box(part).top >= box(whole).bottom;

          // Nothing on the tree may overlap anything else on it.
          const boxes = [...document.querySelectorAll(".block-box")].map((each) => each.getBoundingClientRect());
          const overlapping = boxes.some((a, i) =>
            boxes.some((b, j) => i !== j && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom),
          );

          return {
            opened: true,
            // The system at the top, its parts beneath it, and theirs beneath them.
            systemOnTop: box("tickets").bottom <= box("booking-api").top,
            partsUnder: under("booking-api", "tickets") && under("book-seats", "booking-api") && under("reserve", "book-seats"),
            // Every block of the system, at once, with nothing overlapping.
            blocks: document.querySelectorAll(".block-box[data-key]").length,
            tidy: !overlapping,
            // Plain lines for what is part of what, with no arrowheads on them.
            branches: document.querySelectorAll("#branch-layer .branch").length,
            branchArrows: [...document.querySelectorAll("#branch-layer .branch")].filter((line) => line.getAttribute("marker-end")).length,
            // A mark in the corner of every block, and a colour of its own.
            marks: document.querySelectorAll(".block-box .role-icon").length,
            distinctColours: new Set([colour("booking-api"), colour("tickets-db"), colour("outbox"), colour("box-office")]).size === 4,
            plannedBlock: node("reminders").dataset.planned,
            // What each block reaches is put away until it is asked for.
            dependencies: document.getElementById("show-dependencies").textContent,
            arrowsHidden: getComputedStyle(document.getElementById("access-layer")).display,
          };
        `);
        await capture(window, "self-check-application");

        // What each block is able to reach, which is a different question
        // from what it is part of, and is drawn as arrows over the tree.
        await run("reaches", `
          document.getElementById("show-dependencies").click();
          await wait(400);
          const line = (id) => document.querySelector('.access-group[data-access="' + id + '"] .access');
          const into = (target) =>
            [...document.querySelectorAll(".access-group")].map((group) => group.dataset.access).filter((id) => id.includes("=>" + target + ":"));
          const reaching = into("tickets/tickets-db");
          const readAndWrite = reaching.some((id) => id.endsWith(":reads")) && reaching.some((id) => id.endsWith(":writes"));
          const planned = line("tickets/reminders=>tickets/tickets-db:reads");
          const shown = {
            label: document.getElementById("show-dependencies").textContent,
            arrows: document.querySelectorAll("#access-layer .access").length,
            // One line each way to the database, not one saying "connected".
            readAndWrite,
            // Nothing sends reminders yet, so its line is drawn as the plan it is.
            plannedLine: planned ? getComputedStyle(planned).strokeDasharray !== "none" : false,
          };

          // Folding a block takes its parts off the tree, and what they reach
          // is then reached through the block standing for them.
          const fold = document.querySelector('.block-box[data-id="booking-api"] .fold');
          fold.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await wait(500);
          const folded = {
            partsGone: !document.querySelector('.block-box[data-id="book-seats"]'),
            // What the parts reached is now reached through the block standing for them.
            gathered: Boolean(line("tickets/booking-api=>tickets/tickets-db:reads")),
          };
          fold.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await wait(500);
          // Left showing, so the screenshot this check leaves behind has them on.
          return { shown, folded, back: Boolean(document.querySelector('.block-box[data-id="book-seats"]')) };
        `);
        await capture(window, "self-check-reaches");

        // Colouring, shown to change what is actually drawn rather than only
        // what the button says.
        await run("toggles", `
          const legendRows = () => document.querySelectorAll("#legend .legend-row").length;
          // Read as the variable rather than as a painted colour, so the two
          // can be compared without minding how each one is written out.
          const roleOf = (selector) => {
            const found = document.querySelector(selector);
            return found ? getComputedStyle(found).getPropertyValue("--role").trim() : "";
          };

          // Coloured block by block to begin with, which is the default: the
          // legend has nothing to explain, so it is not there.
          const byBlockFirst = document.getElementById("colour-by").textContent;
          const legend = document.getElementById("legend");
          const legendGone = legend.hidden && getComputedStyle(legend).display === "none";
          const everyRole = () =>
            [...document.querySelectorAll(".block-box[data-key]")]
              .map((box) => getComputedStyle(box).getPropertyValue("--role").trim())
              .join(" ");
          const byBlockRoles = everyRole();

          document.getElementById("colour-by").click();
          await wait(500);
          const byKind = document.getElementById("colour-by").textContent;

          // Every kind is listed whatever is on this diagram, because the
          // legend is also where a colour is chosen, and each swatch shows the
          // colour that kind is actually drawn in.
          const swatch = roleOf('#legend .legend-row[data-role="database"]');
          const named = legendRows() === 10 && swatch !== "" && swatch === roleOf('.block-box[data-id="tickets-db"]');

          // The arrow that folds it away sits at its top right.
          const head = document.querySelector("#legend .legend-head").getBoundingClientRect();
          const arrow = document.querySelector("#legend .legend-toggle").getBoundingClientRect();
          const arrowAtRight = arrow.right >= head.right - 12 && arrow.top < head.bottom;

          document.querySelector("#legend .legend-toggle").click();
          await wait(300);
          const folded = legendRows() === 0 && !document.getElementById("legend").hidden;
          document.querySelector("#legend .legend-toggle").click();
          await wait(300);

          return {
            byBlockFirst,
            legendGone,
            byKind,
            named,
            tinted: byBlockRoles.trim() !== "" && byBlockRoles !== everyRole(),
            arrowAtRight,
            folded,
            unfolded: legendRows() === 10,
          };
        `);
        await capture(window, "self-check-by-kind");
        await run("backToBlock", `
          document.getElementById("colour-by").click();
          await wait(500);
          document.getElementById("zoom-fit").click();
          await wait(400);
          return { label: document.getElementById("colour-by").textContent };
        `);

        // Every block a colour of its own, which is how a diagram is read
        // unless the person asks for the other way.
        await run("byBlock", `
          const role = (key) => getComputedStyle(document.querySelector('.block-box[data-id="' + key + '"]')).getPropertyValue("--role").trim();
          return { apart: new Set([role("box-office"), role("booking-api"), role("tickets-db")]).size === 3 };
        `);
        await capture(window, "self-check-by-block");

        // The functions inside the service are ordinary blocks with a bench
        // and a run behind them, and the box office's button leads to one.
        await run("structured", `
          const node = (label) => [...document.querySelectorAll(".tree .node")].find((n) => (n.querySelector(".label") || {}).textContent === label);
          const top = { subtype: text('.block-box[data-id="booking-api"] .block-kind') };

          // The box office's buttons, and where pressing one leads. One line
          // from each action to the operation it triggers, and a route from
          // it to the code.
          top.triggers = [...document.querySelectorAll(".access-group")]
            .map((group) => group.dataset.access)
            .filter((id) => id.startsWith("tickets/box-office"))
            .join(" ");
          node("box-office").click();
          await wait(500);
          const happens = [...document.querySelectorAll(".section")].find((each) => /When this happens/.test(each.textContent));
          // Read from inside that section, or the first shape on the panel
          // would answer instead.
          top.route = happens ? (happens.querySelector(".ptype") || {}).textContent : "";
          top.canGo = Boolean(happens && [...happens.querySelectorAll(".btn")].find((b) => b.textContent === "Go there"));
          if (top.canGo) {
            [...happens.querySelectorAll(".btn")].find((b) => b.textContent === "Go there").click();
            await wait(900);
            top.wentTo = text(".insp-id");
            top.benchThere = Boolean(document.querySelector(".bench"));
          }

          // The service and everything inside it are on the one tree.
          node("booking-api").click();
          await wait(700);
          top.drawn = [...document.querySelectorAll(".block-box[data-key]")].map((box) => box.dataset.id).sort().join(" ");

          // What a block holds, in a window of its own.
          const offers = document.querySelector('.block-box[data-id="booking-api"] .block-button');
          offers.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await wait(400);
          top.window = text("#overlay .window-names h2");
          top.operations = [...document.querySelectorAll("#overlay .pname")].map((each) => each.textContent).join(" ");
          document.querySelector("#overlay .window-close").click();
          await wait(300);
          top.closed = document.getElementById("overlay").hidden;

          // And on into the handler, which is a function with a part of its own.
          node("book-seats").click();
          await wait(900);
          const bench = Boolean(await until(() => document.querySelector(".bench")));
          return {
            opened: true,
            subtype: top.subtype,
            bench,
            runnable: Boolean(document.querySelector('.block-box[data-id="reserve"] .breakpoint')),
            window: top.window,
            operations: top.operations,
            closed: top.closed,
            drawn: top.drawn,
            tiles: top.tiles,
            triggers: top.triggers,
            route: top.route,
            canGo: top.canGo,
            wentTo: top.wentTo,
            benchThere: top.benchThere,
          };
        `);
        await capture(window, "self-check-structured");

        // Seeding a store and running through it. The bench is on book-seats
        // from the step above, which reads the events through a Store port.
        await run("store", `
          const bench = document.querySelector(".bench");
          const boxes = [...bench.querySelectorAll("textarea")];
          const rows = boxes.find((area) => (area.closest(".field").querySelector("label") || {}).textContent === "Tickets Database · events");
          if (!rows) return { offered: false };

          const shape = (rows.closest(".field").querySelector(".pdesc") || {}).textContent;
          rows.value = JSON.stringify({ gig: { id: "gig", name: "Night Gig", seatsLeft: 10, price: 25 } });
          rows.dispatchEvent(new Event("input", { bubbles: true }));

          const set = (label, value) => {
            const field = [...bench.querySelectorAll(".field")].find((f) => (f.querySelector("label") || {}).textContent === label);
            const control = field.querySelector("input");
            control.value = value;
            control.dispatchEvent(new Event("input", { bubbles: true }));
          };
          set("eventId", "gig");
          set("seats", "2");
          set("email", "ada@example.com");

          [...bench.querySelectorAll(".btn")].find((b) => b.textContent === "Run block").click();
          const done = await until(() => document.body.textContent.includes("What the stores hold now"), 20000);
          return {
            offered: true,
            shape,
            ran: Boolean(done),
            // The run reached a row nothing but the store could have supplied.
            reachedTheStore: document.body.textContent.includes("Booked 2 for Night Gig"),
          };
        `);
        await capture(window, "self-check-store");

        // The whole point: press the button on the box office, and the system
        // runs. Nothing here says which block answers it.
        await run("fromTheTop", `
          const office = [...document.querySelectorAll(".tree .node")].find((n) => (n.querySelector(".label") || {}).textContent === "box-office");
          office.click();
          await wait(500);

          const trying = [...document.querySelectorAll(".section")].find((each) => /Try bookSeats/.test(each.textContent));
          if (!trying) return { offered: false };

          const rows = [...trying.querySelectorAll("textarea")].find((area) => /events/.test((area.closest(".field").querySelector("label") || {}).textContent || ""));
          rows.value = JSON.stringify({ gig: { id: "gig", name: "Night Gig", seatsLeft: 10, price: 25 } });
          rows.dispatchEvent(new Event("input", { bubbles: true }));

          const set = (label, value) => {
            const field = [...trying.querySelectorAll(".field")].find((f) => (f.querySelector("label") || {}).textContent === label);
            const control = field.querySelector("input");
            control.value = value;
            control.dispatchEvent(new Event("input", { bubbles: true }));
          };
          set("eventId", "gig");
          set("seats", "2");
          set("email", "bo@example.com");

          const button = [...trying.querySelectorAll(".btn")].find((b) => b.textContent === "Run bookSeats");
          const label = button ? button.textContent : "";
          button.click();

          const arrived = await until(() => document.body.textContent.includes("Booked 2 for Night Gig"), 20000);
          return {
            offered: true,
            label,
            ran: Boolean(arrived),
            // Nothing comes back along the queue, so the only evidence it was
            // written to is what the run left on it.
            sent: document.body.textContent.includes("1 message sent"),
            // And the seats came off the event, which is a write rather than a read.
            written: document.body.textContent.includes('"seatsLeft": 8'),
          };
        `);
        await capture(window, "self-check-from-the-top");

        await run("backToKind", `
          document.getElementById("colour-by").click();
          await wait(400);
          return { label: document.getElementById("colour-by").textContent };
        `);

        // An execution written down in the messenger: picked, drawn over the
        // whole application, stepped through, and followed inside.
        // An execution written down in the messenger, stepped through on the
        // tree one arrow at a time, and then read end to end as its own drawing.
        await run("execution", `
          document.getElementById("close-project").click();
          await until(() => document.body.dataset.project !== "open");
          const link = await until(() => [...document.querySelectorAll(".welcome-link")].find((b) => b.title === ${JSON.stringify(check.messenger)}));
          if (!link) return { opened: false };
          link.click();
          if (!(await until(() => document.querySelector('.block-box[data-id="api"]')))) return { opened: false };
          document.getElementById("zoom-fit").click();
          await wait(600);

          const select = document.querySelector("#exec-bar .exec-select");
          const offered = select ? [...select.options].map((option) => option.value).filter(Boolean).join(" ") : "";
          select.value = "send-a-message";
          select.dispatchEvent(new Event("change", { bubbles: true }));
          await until(() => document.querySelector("#exec-layer .exec-line-group"));
          await wait(400);

          const lit = () => [...document.querySelectorAll('.block-box[data-current="true"]')].map((box) => box.dataset.id).sort().join(" ");
          return {
            opened: true,
            offered,
            source: text(".exec-source"),
            count: text(".exec-count"),
            caption: text(".exec-caption-text"),
            // One arrow at a time, and nothing else laid over the tree.
            arrows: document.querySelectorAll("#exec-layer .exec-line-group").length,
            fromOutside: text(".exec-outside-label"),
            lit: lit(),
            // The step has a page of its own, in the agent's words, with the
            // function that makes it.
            page: text("#inspector .insp-head h2"),
            said: text("#inspector .responsibility"),
            code: text("#inspector .code-where"),
          };
        `);
        await capture(window, "self-check-execution");

        await run("stepping", `
          const button = (label) => [...document.querySelectorAll("#exec-bar .run-btn")].find((b) => b.textContent === label);
          const arrow = () => document.querySelector("#exec-layer .exec-line-group");
          const lit = () => [...document.querySelectorAll('.block-box[data-current="true"]')].map((box) => box.dataset.id).sort().join(" ");

          button("Step").click();
          await wait(300);
          const stepped = { count: text(".exec-count"), lit: lit(), label: text(".exec-label") };

          // On to the answer coming back out of the database, which runs the
          // other way along its arrow.
          for (let i = 0; i < 5; i += 1) {
            button("Step").click();
            await wait(200);
          }
          const back = { count: text(".exec-count"), way: arrow() ? arrow().dataset.current : "", caption: text(".exec-caption-text") };

          // Folded away, the client's parts are off the tree, so stepping
          // passes over what happens between them.
          button("Restart").click();
          await wait(200);
          document.querySelector('.block-box[data-id="client"] .fold').dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await wait(400);
          button("Step").click();
          await wait(300);
          const hidden = {
            partsGone: !document.querySelector('.block-box[data-id="send-button"]'),
            count: text(".exec-count"),
            caption: text(".exec-caption-text"),
          };

          // Stepping in goes to it anyway, and opens what hides it.
          button("Restart").click();
          await wait(300);
          button("Step into").click();
          await wait(500);
          const opened = {
            partsBack: Boolean(document.querySelector('.block-box[data-id="send-button"]')),
            count: text(".exec-count"),
            lit: lit(),
            caption: text(".exec-caption-text"),
          };
          return { stepped, back, hidden, opened };
        `);
        await capture(window, "self-check-stepping");

        await run("flow", `
          const chip = (label) => [...document.querySelectorAll("#exec-bar .chip")].find((c) => c.textContent === label);
          chip("Flow").click();
          await until(() => document.querySelector(".flow-box"));
          document.getElementById("zoom-fit").click();
          await wait(600);

          const boxes = [...document.querySelectorAll(".flow-box")];
          const rows = new Set(boxes.map((box) => Math.round(box.getBoundingClientRect().top)));
          const names = boxes.map((box) => box.dataset.key);
          // A block is drawn again every time the run comes back to it.
          const repeated = names.filter((name) => name === "app/api/router").length;
          // Every step, and nothing that loops backwards.
          const arrows = [...document.querySelectorAll("#branch-layer .exec-line-group")];

          // Picking a step out of the flow asks about that step.
          const at = boxes.findIndex((box) => box.dataset.key === "app/infrastructure/database");
          boxes[at].dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 21, isPrimary: true }));
          await wait(400);
          const picked = { page: text("#inspector .insp-head h2"), count: text(".exec-count") };

          // And the same step is still the one showing back on the tree.
          chip("Tree").click();
          await wait(500);
          const backOnTree = Boolean(document.querySelector("#exec-layer .exec-line-group"));
          const sameStep = text(".exec-count");

          // Left on the flow, so the screenshot this check leaves behind is of it.
          chip("Flow").click();
          await wait(500);
          return { boxes: boxes.length, rows: rows.size, repeated, arrows: arrows.length, picked, backOnTree, sameStep };
        `);
        await capture(window, "self-check-flow");

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
    width: 1600,
    height: 1000,
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
