import { cpSync, mkdirSync, mkdtempSync, watch, writeFileSync } from "node:fs";
import type { FSWatcher } from "node:fs";
import { access, appendFile, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, ClipboardItem, Menu, app, clipboard, dialog, ipcMain, shell } from "electron";
import { CHANNELS } from "./ipc.js";
import type {
  MenuCommand,
  ProjectLoad,
  Result,
  RunCommand,
  SaveCasesRequest,
  WatchRunRequest,
  WriteImplRequest,
} from "./ipc.js";
import { projectSnapshot } from "../src/project/snapshot.js";
import { blockDir, loadProject, locateCode, manifestPath, readManifest } from "../src/project/project.js";
import { readBlockCode } from "../src/project/code.js";
import { startProject, writeCommandSkills, writeGuide } from "../src/codegen/emit.js";
import type { NewProjectSettings } from "../src/codegen/emit.js";
import { GUIDE_FILE } from "../src/codegen/guide.js";
import { resolveInside } from "../src/project/safePath.js";
import { runCases, startRun } from "../src/run/run.js";
import type { CaseResult, RunControl, RunOutcome } from "../src/run/run.js";
import { saveCases } from "../src/run/cases.js";
import {
  blockVersions,
  deleteSavedVersion,
  editSavedVersion,
  noise,
  savedIdPattern,
  saveVersion,
  swapToVersion,
  undoLastSwap,
} from "../src/project/history.js";
import type { BlockVersions, SavedVersion, SwapDone, VersionRef } from "../src/project/history.js";
import { MOST_NOTE_TEXT, addNote, deleteNote, flaggedRunOf, isNotePath, markWorking, noteById, replyToNote, resolveNote } from "../src/project/notes.js";
import type { FlaggedRun, Note, NoteAnchor } from "../src/project/notes.js";
import { compareWithVersion } from "../src/run/versions.js";
import type { VersionComparison } from "../src/run/versions.js";
import { commitExampleHistory, filesOf, gitIn } from "../src/project/exampleHistory.js";

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

  // Offered on the welcome screen as recent projects, which is how the check
  // opens them. Its own project is started from the menu instead.
  writeFileSync(path.join(userData, "recent-projects.json"), JSON.stringify([application, messenger]));
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

/**
 * Text the window sent, refused unless it is text no longer than the panel's
 * own field lets anyone type. The renderer is not trusted to send only what
 * the panel would, so this is checked before the kernel sees it, which checks
 * everything again for whoever calls it.
 */
function sent(value: unknown, what = "What the window sent", most = Infinity): string {
  if (typeof value !== "string") throw new Error(`${what} must be text.`);
  if (value.length > most) throw new Error(`${what} can be at most ${most} characters.`);
  return value;
}

/** A saved version's id, as the window sent it, refused before any path is made from it. */
function savedId(value: unknown): string {
  const id = sent(value, "A saved version's id");
  if (!savedIdPattern.test(id)) throw new Error(`"${id}" is not a saved version.`);
  return id;
}

/** The version the window asked for: a commit, or a saved version by its id, and nothing beside it. */
function versionRef(value: unknown): VersionRef {
  if (typeof value === "object" && value !== null && Object.keys(value).length === 1) {
    // Whether a commit looks like one is the kernel's to check, before git sees it.
    if ("commit" in value) return { commit: sent(value.commit, "A commit") };
    if ("saved" in value) return { saved: savedId(value.saved) };
  }
  throw new Error("That is not a commit or a saved version.");
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

  return {
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

/**
 * Brings a project's guide and its agent's slash commands up to date, for
 * whatever the person is about to ask the agent. It never fails: a project
 * that cannot be read just keeps what it has.
 */
async function refreshAgentFiles(dir: string): Promise<void> {
  await readManifest(dir).then((manifest) => writeGuide(dir, manifest)).catch(() => false);
  await writeCommandSkills(dir).catch(() => null);
}

/** One watcher per window, on whichever project that window has open. */
const watchers = new Map<number, FSWatcher>();

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
      // The folders tools keep inside a project are nobody's business, by the
      // same rule that keeps them out of a block's versions. Notes are the
      // exception: the agent answers them while the person watches.
      if (filename && noise(filename) && !isNotePath(filename)) return;
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
  offerProjectMenu(true);
  return load;
}

async function pickFolder(contents: Electron.WebContents, options: Electron.OpenDialogOptions): Promise<string | undefined> {
  // Nobody is there to answer a folder picker during the self-check, so it is
  // answered with the folder the check made for starting a project in.
  if (selfCheck) return selfCheck.projectDir;
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
        throw new Error(`${dir} is already a Fragmentor project. Open it with File › Open Project… instead.`);
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
    offerProjectMenu(false);
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
      // Which file a block's code is in is the block's to say, and the
      // renderer is not trusted to say it.
      const project = await loadProject(request.dir);
      const node = project.byPath.get(request.blockPath);
      if (!node) throw new Error(`There is no block at "${request.blockPath}".`);

      const found = await readBlockCode(project, node);
      // Only the code Fragmentor holds to a contract is offered for editing.
      // Anything else it is only drawing, and the window says so instead.
      if (!found.bound || found.location === null) {
        throw new Error(found.drawnBecause ?? `"${request.blockPath}" has no code of its own.`);
      }

      const target = resolveInside(request.dir, found.location.file);
      await writeFile(target, request.contents, "utf8");
      return ok(null);
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

  ipcMain.handle(CHANNELS.blockVersions, async (_event, dir: string, blockPath: string): Promise<Result<BlockVersions>> => {
    try {
      return ok(await blockVersions(dir, blockPath));
    } catch (error) {
      return failed(error);
    }
  });

  /**
   * A swap rewrites files, and a comparison is planned from them, as a saved
   * version is read from them: two at once could each back up, compare or
   * save what the other half wrote. A saved version is read by a comparison
   * or a swap of it, so it is never deleted from under one. Here rather than
   * in the panel, which can be left for another project while one runs.
   */
  let busy = false;
  async function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
    if (busy) throw new Error("Something is still being compared, swapped or saved. Try again once it has finished.");
    busy = true;
    try {
      return await work();
    } finally {
      busy = false;
    }
  }

  ipcMain.handle(
    CHANNELS.compareVersion,
    async (_event, dir: unknown, blockPath: unknown, version: unknown): Promise<Result<VersionComparison>> => {
      try {
        const ref = versionRef(version);
        return ok(await oneAtATime(() => compareWithVersion(sent(dir), sent(blockPath), ref)));
      } catch (error) {
        return failed(error);
      }
    },
  );

  ipcMain.handle(CHANNELS.swapVersion, async (_event, dir: unknown, blockPath: unknown, version: unknown): Promise<Result<SwapDone>> => {
    try {
      const ref = versionRef(version);
      return ok(await oneAtATime(() => swapToVersion(sent(dir), sent(blockPath), ref)));
    } catch (error) {
      return failed(error);
    }
  });

  ipcMain.handle(CHANNELS.undoSwap, async (_event, dir: string, blockPath: string): Promise<Result<SwapDone>> => {
    try {
      return ok(await oneAtATime(() => undoLastSwap(dir, blockPath)));
    } catch (error) {
      return failed(error);
    }
  });

  ipcMain.handle(
    CHANNELS.saveVersion,
    async (_event, dir: unknown, blockPath: unknown, name: unknown, description: unknown): Promise<Result<SavedVersion & { ignored: string | null }>> => {
      try {
        const called = sent(name, "A saved version's name", 80);
        const about = sent(description, "A saved version's description", 2000);
        return ok(await oneAtATime(() => saveVersion(sent(dir), sent(blockPath), called, about)));
      } catch (error) {
        return failed(error);
      }
    },
  );

  ipcMain.handle(CHANNELS.deleteSavedVersion, async (_event, dir: unknown, blockPath: unknown, id: unknown): Promise<Result<null>> => {
    try {
      const saved = savedId(id);
      await oneAtATime(() => deleteSavedVersion(sent(dir), sent(blockPath), saved));
      return ok(null);
    } catch (error) {
      return failed(error);
    }
  });

  ipcMain.handle(
    CHANNELS.editSavedVersion,
    async (_event, dir: unknown, blockPath: unknown, id: unknown, name: unknown, description: unknown): Promise<Result<SavedVersion>> => {
      try {
        const saved = savedId(id);
        const called = sent(name, "A saved version's name", 80);
        const about = sent(description, "A saved version's description", 2000);
        return ok(await oneAtATime(() => editSavedVersion(sent(dir), sent(blockPath), saved, called, about)));
      } catch (error) {
        return failed(error);
      }
    },
  );

  /**
   * What the window sent beside a note's words, taking only what the person
   * may send: a run, a problem, and what the note is on. A commit is the
   * agent's to record. Each is held to its shape by the kernel before anything
   * is written.
   */
  const extrasFrom = (value: unknown): { run?: FlaggedRun; problem?: string; on?: NoteAnchor } => {
    if (value === undefined) return {};
    if (typeof value !== "object" || value === null) throw new Error("What came with that note is not something Fragmentor keeps with one.");
    const { run, problem, on } = value as Record<string, unknown>;
    return {
      ...(run === undefined ? {} : { run: run as FlaggedRun }),
      ...(problem === undefined ? {} : { problem: sent(problem, "A flagged problem", MOST_NOTE_TEXT) }),
      ...(on === undefined ? {} : { on: on as NoteAnchor }),
    };
  };

  ipcMain.handle(
    CHANNELS.addNote,
    async (_event, dir: unknown, blockPath: unknown, text: unknown, extras: unknown): Promise<Result<Note>> => {
      try {
        const project = sent(dir);
        const note = await addNote(project, sent(blockPath), "person", sent(text, "A note", MOST_NOTE_TEXT), extrasFrom(extras));
        // The agent learns what to do with notes from its guide and its
        // commands, so a project whose guide was written before there were
        // notes is brought up to date: the person is about to tell the agent
        // to work through them. The note is saved whatever becomes of that.
        await refreshAgentFiles(project);
        return ok(note);
      } catch (error) {
        return failed(error);
      }
    },
  );

  ipcMain.handle(CHANNELS.refreshAgentFiles, async (_event, dir: unknown): Promise<Result<null>> => {
    try {
      await refreshAgentFiles(sent(dir));
      return ok(null);
    } catch (error) {
      return failed(error);
    }
  });

  ipcMain.handle(CHANNELS.replyToNote, async (_event, dir: unknown, id: unknown, text: unknown, extras: unknown): Promise<Result<Note>> => {
    try {
      const said = sent(text, "A note", MOST_NOTE_TEXT);
      const { run } = extrasFrom(extras);
      return ok(await replyToNote(sent(dir), sent(id, "A note's id", 64), "person", said, run === undefined ? {} : { run }));
    } catch (error) {
      return failed(error);
    }
  });

  /**
   * Runs what a note flags again, as it was flagged: a saved test with the
   * values it failed on, or a run from the bench with what it was given. It
   * runs as a test of its own, so the block's saved tests are neither read
   * nor written, and says whether what the person flagged is put right.
   */
  ipcMain.handle(CHANNELS.rerunNote, async (_event, dir: unknown, id: unknown): Promise<Result<CaseResult>> => {
    try {
      const project = sent(dir);
      const note = await noteById(project, sent(id, "A note's id", 64));
      const run = flaggedRunOf(note);
      if (run === undefined) throw new Error("That note flags no run to run again.");
      if (run.cut?.some((part) => part === "input" || part === "stores" || part === "expected")) {
        throw new Error("What this note flags was too large to keep whole, so it cannot be run again as it was.");
      }
      if (!(await loadProject(project)).byPath.has(note.block)) throw new Error(`There is no block at ${note.block} any more.`);
      const [result] = await runCases(project, note.block, {
        cases: [
          {
            name: run.test ?? "the run from the bench",
            input: run.input,
            ...(run.stores === undefined ? {} : { stores: run.stores }),
            ...(run.expected === undefined ? {} : { expected: run.expected }),
          },
        ],
      });
      if (result === undefined) throw new Error("The run came back with nothing to say.");
      return ok(result);
    } catch (error) {
      return failed(error);
    }
  });

  ipcMain.handle(CHANNELS.resolveNote, async (_event, dir: unknown, id: unknown): Promise<Result<Note>> => {
    try {
      return ok(await resolveNote(sent(dir), sent(id, "A note's id", 64)));
    } catch (error) {
      return failed(error);
    }
  });

  ipcMain.handle(CHANNELS.deleteNote, async (_event, dir: unknown, id: unknown): Promise<Result<null>> => {
    try {
      await deleteNote(sent(dir), sent(id, "A note's id", 64));
      return ok(null);
    } catch (error) {
      return failed(error);
    }
  });

  ipcMain.handle(CHANNELS.copyText, async (_event, text: unknown): Promise<Result<null>> => {
    try {
      await clipboard.writeText(sent(text, "What is copied", MOST_NOTE_TEXT));
      return ok(null);
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
  /**
   * Opens the selected block's test bench and gives back that window.
   *
   * The bench is a window over the drawing, not part of the inspector, so it
   * stays on the block it was opened for however the selection moves after
   * that — which is the point of it. A window already open for something else
   * therefore has to be told to follow, rather than taken as the one wanted.
   */
  const openBench = async (label) => {
    // Every way into the bench is "Try <something>", and the window that opens
    // says the same words back, so one name covers the button and the window.
    const wanted = label || "Try " + text("#inspector h2");
    const showing = () => {
      const open = document.querySelector(".bench-window");
      return open && text(".bench-window h2") === wanted && open.querySelector(".bench") ? open : null;
    };
    if (showing()) return showing();
    const button = [...document.querySelectorAll("#inspector .btn")].find((each) => each.textContent === wanted);
    if (!button) return null;
    button.click();
    return await until(showing);
  };
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
  const restoredCleanly = editor().value === original && /Saved src\\/booking/.test(statusText());

  // Running a block is what makes this an application rather than a viewer.
  let ran = "no run button";
  await openBench();
  const runButton = [...document.querySelectorAll(".bench-window .bench .btn")].find((button) => button.textContent === "Run block");
  if (runButton && runButton.disabled) ran = "run button disabled";
  else if (runButton) {
    const set = (label, value) => {
      const field = [...document.querySelectorAll(".bench-window .field")].find((f) => (f.querySelector("label") || {}).textContent === label);
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
    await openBench();
    const runAll = [...document.querySelectorAll(".bench-window .btn")]
      .find((button) => button.textContent === "Run all tests");
    if (!runAll) return "no run-all button";
    if (runAll.disabled) return "run-all disabled";
    runAll.click();
    await wait(9000);
    const summary = document.querySelector(".case-summary");
    return summary ? summary.textContent : "no summary";
  });

  // The bench is a window: it is pulled to whatever size the work wants, and
  // rolled up to its title when the drawing underneath matters more. Both are
  // kept in ui.bench, because every redraw rebuilds the window from it.
  const benchWindow = await attempt(async () => {
    const open = await openBench();
    if (!open) return "no bench";
    const was = open.getBoundingClientRect();

    const grip = open.querySelector('.bench-grip[data-edge="se"]');
    if (!grip) return "no corner to pull";
    const at = grip.getBoundingClientRect();
    const from = { clientX: at.left + 4, clientY: at.top + 4, pointerId: 31, bubbles: true, isPrimary: true };
    grip.dispatchEvent(new PointerEvent("pointerdown", from));
    window.dispatchEvent(new PointerEvent("pointermove", { ...from, clientX: from.clientX + 140, clientY: from.clientY + 90 }));
    window.dispatchEvent(new PointerEvent("pointerup", { ...from, clientX: from.clientX + 140, clientY: from.clientY + 90 }));
    await wait(200);

    const pulled = document.querySelector(".bench-window").getBoundingClientRect();
    const grew = pulled.width > was.width + 100 && pulled.height > was.height + 60;

    // A redraw must not undo it, which is the whole reason the size is in ui.
    // Changing what the colours mean redraws everything, and a second press
    // puts them back.
    document.getElementById("colour-by").click();
    document.getElementById("colour-by").click();
    await wait(900);
    const after = document.querySelector(".bench-window");
    const kept = after && Math.abs(after.getBoundingClientRect().width - pulled.width) < 2;

    const roll = [...after.querySelectorAll(".window-close")].find((b) => b.textContent === "—");
    if (!roll) return "no way to roll it up";
    roll.click();
    await wait(300);
    const rolled = document.querySelector('.bench-window[data-minimised="true"]');
    const bodyGone = Boolean(rolled) && !rolled.querySelector(".bench-window-body");

    [...rolled.querySelectorAll(".window-close")].find((b) => b.textContent === "▢").click();
    await wait(300);
    const back = Boolean(document.querySelector(".bench-window .bench-window-body"));

    return "grew: " + grew + " / kept: " + Boolean(kept) + " / rolled: " + bodyGone + " / back: " + back;
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

    await openBench();
    const runAll = [...document.querySelectorAll(".bench-window .btn")]
      .find((button) => button.textContent === "Run all tests");
    if (runAll && !runAll.disabled) {
      runAll.click();
      await wait(6000);
    }

    // The bench window keeps its place across the redraw a run causes, so the
    // screenshot this check captures shows the tests where they were left.
    await wait(400);
    const body = document.querySelector(".bench-window-body");
    if (body) body.scrollTop = body.scrollHeight;
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
    benchWindow,
    foldedAway,
    shown,
    savedToDisk: /Saved src\\/booking/.test(afterSave),
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
        value("dialog", "levelUnasked") === true &&
        value("dialog", "blockedWithoutStart") === true &&
        value("dialog", "blockedWithoutLevel") === true &&
        value("dialog", "ready") === true &&
        value("dialog", "languageIsFree") === true &&
        value("dialogClosed", "closed") === true,
    ],
    [
      "a question that stops applying is put away, and its answer still stands when it applies again",
      value("dialog", "startNotAskedOfExistingCode") === true &&
        value("dialog", "readyWithoutStart") === true &&
        value("dialog", "keptBelow") === true &&
        value("dialog", "readyAgain") === true,
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
      "Escape closes the window over the drawing before the bench, Ctrl-click adds to the selection, an arrow opens as a dependency, and the zoom buttons zoom",
      value("controls", "windowOpened") === true &&
        value("controls", "benchBefore") === true &&
        value("controls", "windowFirst") === true &&
        value("controls", "benchNext") === true &&
        value("controls", "several") === "2 blocks selected" &&
        value("controls", "arrow") === "dependency" &&
        value("controls", "zoomedIn") === true,
    ],
    [
      "a step's page opens the function that makes it",
      value("stepping", "codeOpened") === true,
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
      "an arrow between two blocks with no room between them comes round the side of both",
      (() => {
        type Tight = { count?: string; reach?: string; tail?: string; head?: string };
        const into = value("tight", "into") as Tight;
        const back = value("tight", "back") as Tight;
        return (
          into?.count === "10 of 20" &&
          into?.reach === "beside" &&
          into?.tail === "book-seats" &&
          into?.head === "reserve" &&
          // And the answer comes back round the same side, the other way.
          back?.count === "17 of 20" &&
          back?.reach === "beside" &&
          back?.tail === "reserve" &&
          back?.head === "book-seats"
        );
      })(),
    ],
    ["a new project starts a git repository, so its blocks have versions from the start", value("newRepo", "started") === true],
    [
      "every block's panel ends with its versions, the saved ones and then its git history, newest first, with no window of their own",
      value("history", "built") === true &&
        /Versions$/.test(String(value("versions", "sections"))) &&
        !/Versions/.test(String(value("versions", "windows"))) &&
        value("versions", "parts") === "Saved | Git history" &&
        value("versions", "nowFirst") === true &&
        value("versions", "listed") === 2 &&
        value("versions", "subjects") === "Take ten percent off from the fifth seat | Price seats with a discount from the third seat" &&
        value("versions", "latest") === true &&
        value("versions", "now") === "The same as the latest commit." &&
        value("versions", "offers") === "Compare | Swap to this" &&
        value("versions", "undo") === false &&
        value("versions", "saveOffered") === true &&
        value("versions", "noneSaved") === "No saved versions yet. Save one when Pricing works the way you want to keep it." &&
        value("versions", "noFold") === true,
    ],
    [
      "which version a block is on is marked: the latest commit's row is lit as in use, and the badge in the panel's header names it",
      value("versions", "inUse") === "Take ten percent off from the fifth seat" &&
        value("versions", "latestTag") === "in use" &&
        value("versions", "changedFrom") === "" &&
        value("versions", "badge") === "version: Take ten percent off from…" &&
        value("versions", "badgeLit") === true &&
        /^The version in use: “Take ten percent off from the fifth seat”\. See Versions/.test(String(value("versions", "badgeTitle"))),
    ],
    [
      "comparing a version runs the saved tests of both versions against both, and shows what that would change elsewhere",
      // Pricing's own seven tests, and the one of book-seats' that its older
      // version changes the outcome of.
      value("compared", "count") === 8 &&
        value("compared", "summary") === "4 of 7 saved tests of Pricing and its parts come out differently." &&
        value("compared", "others") === "1 of 9 other saved tests in Tickets comes out differently:" &&
        value("compared", "changed") === "now · passed / then · failed" &&
        value("compared", "noLonger") === "now · failed / then · passed" &&
        value("compared", "same") === "now · passed / then · passed" &&
        value("compared", "gone") === "now · not in this version / then · passed" &&
        value("compared", "outside") === "now · passed / then · failed" &&
        value("compared", "newSince") === 2 &&
        value("compared", "notSaved") === 3,
    ],
    [
      "a swap waits while the code it would replace has unsaved changes, and stops asking once it is saved or reverted",
      /unsaved changes to Price Seat's code/.test(String(value("guarded", "said"))) &&
        value("guarded", "untouched") === true &&
        value("guardedOnDisk", "untouched") === true &&
        value("guarded", "reverted") === true &&
        value("guarded", "askedStill") === false,
    ],
    [
      "a comparison stays in its block's panel while the person looks at another block",
      value("guarded", "kept") === true,
    ],
    [
      "swapping puts a block back as it was, parts and code included, forgets what was shown about it, and changes nothing outside it",
      value("swapped", "arrived") === true &&
        value("swapped", "status") ===
          "Swapped Pricing to the version “Price seats with a discount from the third seat”. Undo swap is under Versions in its panel." &&
        /^Swapped to “Price seats with a discount from the third seat”, committed /.test(String(value("swapped", "now"))) &&
        value("swapped", "undo") === true &&
        value("guarded", "ran") === "2 of 2 passed." &&
        value("swapped", "benchTests") === "the first two seats are full price | the third is a fifth off" &&
        value("swapped", "benchResults") === false &&
        ["partCode", "partContract", "callsPart", "nothingElse", "keptAside", "notForCommitting"].every(
          (key) => value("swappedOnDisk", key) === true,
        ),
    ],
    [
      "after a swap, the version swapped in is the one marked in use, on its row and in the panel's header, and the latest commit is not",
      value("swapped", "inUse") === "Price seats with a discount from the third seat" &&
        value("swapped", "olderTag") === "in use" &&
        value("swapped", "latestTag") === "" &&
        value("swapped", "badge") === "version: Price seats with a discount…",
    ],
    [
      "once a file the swap wrote is changed, the version swapped in is marked, quietly, as changed since, in the Now row, on its row and in the header",
      value("changedSince", "now") === "Swapped to “Price seats with a discount from the third seat”, and changed since." &&
        value("changedSince", "inUse") === "" &&
        value("changedSince", "changedFrom") === "Price seats with a discount from the third seat" &&
        value("changedSince", "olderTag") === "changed since" &&
        value("changedSince", "badge") === "changed since: Price seats with a discount…" &&
        value("changedSince", "quiet") === true,
    ],
    [
      "undoing a swap puts back exactly what was there",
      value("undone", "gone") === true &&
        value("undone", "now") === "The same as the latest commit." &&
        value("undone", "status") === "Put Pricing back as it was before the swap." &&
        value("undone", "undo") === false &&
        value("undone", "benchTests") === "the first four seats are full price | the fifth is ten percent off" &&
        value("undoneOnDisk", "exactly") === true,
    ],
    [
      "after undoing a swap, the latest commit is in use again, on its row and in the header",
      value("undone", "inUse") === "Take ten percent off from the fifth seat" &&
        value("undone", "changedFrom") === "" &&
        value("undone", "badge") === "version: Take ten percent off from…",
    ],
    [
      "a block is saved as a version from a form that keeps what is typed, and is listed with its name, description and author, in a file that shows up to be committed with the project",
      value("saveForm", "focused") === true &&
        value("saveForm", "emptyRefused") === true &&
        value("saveForm", "kept") === true &&
        value("saving", "about") === "The first four seats at full price, and ten percent off each one after." &&
        /^saved .+ · Fragmentor$/.test(String(value("saving", "meta"))) &&
        value("saving", "offers") === "Compare | Swap to this | Edit | Delete" &&
        value("saving", "formGone") === true &&
        value("saving", "status") ===
          "Saved “Ten percent from the fifth seat” as a version of Pricing. It is shared once the project is next committed." &&
        ["written", "forCommitting", "swapsPrivate"].every((key) => value("savedOnDisk", key) === true),
    ],
    [
      "a version just saved is in use, as is the commit it is the same as, and the Now row and the header name the saved one",
      value("saving", "inUse") === "Ten percent from the fifth seat | Take ten percent off from the fifth seat" &&
        value("saving", "tag") === "in use" &&
        value("saving", "now") === "The same as the latest commit. It is the saved version “Ten percent from the fifth seat”." &&
        value("saving", "badge") === "version: Ten percent from the fifth…",
    ],
    [
      "a saved version is renamed and described again from a form in its own row, which opens with what it says now and keeps what is typed, and its file changes in only those two",
      value("versionEditing", "prefilled") === "Ten percent from the fifth seat / The first four seats at full price, and ten percent off each one after." &&
        value("versionEditing", "offers") === "Save changes | Cancel" &&
        value("versionEditing", "focused") === true &&
        value("versionEditing", "kept") === true &&
        value("versionRenamed", "renamed") === true &&
        value("versionRenamed", "about") === "Full price for the first four seats, then ten percent off." &&
        value("versionRenamed", "status") === "Renamed “Ten percent from the fifth seat” to “Ten percent off from the fifth seat”." &&
        // It is the same version, so it is still the one in use.
        value("versionRenamed", "tag") === "in use" &&
        value("versionRenamed", "badge") === "version: Ten percent off from the…" &&
        value("versionDescribed", "about") === "The first four seats at full price, and ten percent off each one after." &&
        value("versionDescribed", "status") === "Saved the description of “Ten percent off from the fifth seat”." &&
        ["named", "described", "restKept"].every((key) => value("editedOnDisk", key) === true),
    ],
    [
      "a saved version is compared like a commit",
      value("savedCompared", "summary") === "Every saved test of Pricing and its parts comes out the same in both versions." &&
        value("savedCompared", "others") === "Every other saved test in Tickets comes out the same in both versions." &&
        value("savedCompared", "differing") === 0,
    ],
    [
      "swapping to a saved version puts back every file it saved, leaves alone code it knew nothing about, and undoing that puts back what was there",
      value("swappedOlder", "arrived") === true &&
        value("swappedSaved", "gone") === true &&
        /^Swapped to “Ten percent off from the fifth seat”, saved /.test(String(value("swappedSaved", "now"))) &&
        value("swappedSaved", "status") ===
          "Swapped Pricing to the version “Ten percent off from the fifth seat”. Undo swap is under Versions in its panel." &&
        value("swappedSaved", "tag") === "in use" &&
        value("swappedSaved", "badge") === "version: Ten percent off from the…" &&
        value("swappedSaved", "undo") === true &&
        value("savedSwapOnDisk", "exactly") === true &&
        value("undoneSaved", "back") === true &&
        value("undoneSavedOnDisk", "exactly") === true,
    ],
    [
      "a saved version is deleted only once the person has said so twice",
      value("asked", "question") ===
        "Delete “Ten percent off from the fifth seat”? It goes for everyone once the project is next committed. If it was ever committed, git's history still has it; if not, it is gone for good." &&
        value("asked", "answers") === "Delete it | Keep" &&
        value("asked", "kept") === true &&
        value("askedOnDisk", "still") === true &&
        value("deleted", "gone") === true &&
        value("deleted", "status") === "Deleted the saved version “Ten percent off from the fifth seat”." &&
        value("deleted", "none") === "No saved versions yet. Save one when Pricing works the way you want to keep it." &&
        value("deletedOnDisk", "gone") === true,
    ],
    [
      "the git history lists its newest five commits until all of them are asked for",
      value("historyFolded", "offered") === true &&
        value("historyFolded", "folded") === 5 &&
        value("historyFolded", "unfolded") === 6 &&
        value("historyFolded", "back") === 5,
    ],
    [
      "a block's panel offers to leave a note, before anything else about the block, while none is open",
      value("notesOffered", "opened") === true &&
        value("notesOffered", "of") === "tickets/booking-api/pricing/price-seat" &&
        value("notesOffered", "notesFirst") === true &&
        value("notesOffered", "offers") === true &&
        value("notesOffered", "bar") === "" &&
        value("notesOffered", "marked") === "",
    ],
    [
      "a note left from the panel is for the agent, is counted on its block, and the words to tell the agent are shown",
      value("noteLeft", "focused") === true &&
        value("noteLeft", "emptyRefused") === true &&
        value("noteLeft", "readyNow") === true &&
        value("noteLeft", "waiting") === "agent" &&
        value("noteLeft", "state") === "for your agent" &&
        value("noteLeft", "says") === "Seats in row A should cost double." &&
        value("noteLeft", "formGone") === true &&
        value("noteLeft", "phrases") === "fragmentor notes | fragmentor notes tickets/booking-api/pricing/price-seat" &&
        value("noteLeft", "marked") === "agent 1" &&
        String(value("noteLeft", "bar")).startsWith("1 note for your agent. Tell it") &&
        String(value("noteLeft", "bar")).includes("fragmentor notes") &&
        value("noteLeft", "status") === "Left a note on Price Seat. Tell your agent “fragmentor notes” when you are ready.",
    ],
    [
      "a note is a file in the project, committed with it, and the agent's guide says what to do with it",
      value("noteOnDisk", "files") === 1 &&
        value("noteOnDisk", "block") === "tickets/booking-api/pricing/price-seat" &&
        value("noteOnDisk", "from") === "person" &&
        value("noteOnDisk", "status") === "open" &&
        value("noteOnDisk", "forCommitting") === true &&
        value("noteOnDisk", "guided") === true,
    ],
    [
      "the words to tell the agent are copied from the bar above the drawing",
      value("phraseCopied", "copied") === true && value("phraseOnClipboard", "text") === "fragmentor notes",
    ],
    [
      "the agent's answer appears with nothing reloaded, and hands the note back to the person",
      value("noteAnswered", "seen") === true &&
        value("noteAnswered", "from") === "You Agent" &&
        value("noteAnswered", "state") === "for you" &&
        value("noteAnswered", "marked") === "person 1" &&
        value("noteAnswered", "bar") === "1 note for youShow" &&
        value("noteAnswered", "offers") === "Reply | Resolve | Delete",
    ],
    [
      "a reply being written keeps its words, and the cursor its place, while the agent changes the project",
      value("replying", "focused") === true &&
        value("typingKept", "redrawn") === true &&
        value("typingKept", "words") === "Row B too, please." &&
        value("typingKept", "focused") === true &&
        value("typingKept", "at") === 3,
    ],
    [
      "the person resolves a note, which folds it away and takes its count off the block",
      value("noteResolved", "gone") === true &&
        value("noteResolved", "folded") === "1 resolved note" &&
        value("noteResolved", "shown") === "none" &&
        value("noteResolved", "marked") === "" &&
        value("noteResolved", "elsewhere") === "person 1" &&
        value("noteResolved", "status") === "Resolved a note on Price Seat." &&
        value("resolvedOnDisk", "status") === "resolved",
    ],
    [
      "the project's panel lists every open note, says what to tell the agent, and leads to each note's block",
      value("projectNotes", "parts") === "For you (1) | On blocks no longer there (1) | What to tell your agent" &&
        value("projectNotes", "listed") === "tickets/booking-api/find-event" &&
        value("projectNotes", "phrases") === "fragmentor notes | fragmentor notes <block path>" &&
        value("projectNotes", "goneMarked") === "" &&
        value("projectNotes", "goneOffers") === "Reply | Delete" &&
        String(value("projectNotes", "goneBar")).includes("1 note for you on a block no longer there") &&
        value("projectNotes", "goneDeleted") === true &&
        value("projectNotes", "went") === "tickets/booking-api/find-event",
    ],
    [
      "a failing test is offered to the agent from the bench, and the note flagging it carries the test",
      String(value("flagged", "offered")).startsWith("Flag this for your coding agent?") &&
        value("flagged", "flagged") === true &&
        value("flagged", "marked") === "agent 1" &&
        value("flagged", "listed") === "ERROR:Test “row A is double”" &&
        value("flagged", "outlined") === "rgb(227, 119, 140)" &&
        value("flagged", "summary") === "View failed test" &&
        value("flaggedOnDisk", "count") === 1 &&
        value("flaggedOnDisk", "block") === "tickets/booking-api/pricing/price-seat" &&
        value("flaggedOnDisk", "text") === "The test “row A is double” fails." &&
        JSON.stringify(value("flaggedOnDisk", "run")) ===
          JSON.stringify({
            test: "row A is double",
            input: { fullPrice: 25, seat: 1 },
            expected: { price: 50 },
            output: { price: 25 },
            problems: ["output.price was 25, expected 50."],
            logs: [],
          }),
    ],
    [
      "while the agent works on a note, its block's count pulses and the note says since when",
      value("noteWorking", "pulsing") === true &&
        String(value("noteWorking", "said")).startsWith("Your agent started on this at ") &&
        String(value("noteWorking", "bar")).startsWith("1 note for your agent, 1 being worked on. Tell it"),
    ],
    [
      "the agent's answer carries its commit, offers the version before it, and what was flagged is run again",
      value("noteCommitted", "seen") === true &&
        value("noteCommitted", "drawnOnce") === true &&
        String(value("noteCommitted", "commit")).includes("“Refuse a seat past the last one”") &&
        value("noteCommitted", "offers") === "Compare with before | Swap back to before" &&
        value("noteCommitted", "working") === false &&
        value("noteCommitted", "rerunTone") === "bad" &&
        value("noteCommitted", "rerunSaid") === "Ran it again: it still fails. output.price was 25, expected 50." &&
        value("noteCommitted", "rerunOffers") === "Tell your agent" &&
        value("noteCommitted", "retry") === true,
    ],
    [
      "comparing from the note runs the Versions comparison against the version before the commit",
      value("comparedFromNote", "compared") === true && value("comparedFromNote", "onRow") === true,
    ],
    [
      "a flagged test still failing after the answer goes back to the agent with the run",
      value("toldStillFails", "told") === true &&
        value("toldOnDisk", "from") === "person" &&
        value("toldOnDisk", "still") === "output.price was 25, expected 50." &&
        value("toldOnDisk", "working") === null &&
        value("toldOnDisk", "commit") === true,
    ],
    [
      "a block that fails in a run carries a red flag and a red glow, and no word beside its kind",
      value("failedRun", "failed") === true &&
        value("failedRun", "said") === "" &&
        value("failedRun", "flagShown") === true &&
        value("failedRun", "around") === "price-seat" &&
        String(value("failedRun", "glow")).includes("drop-shadow") &&
        String(value("failedRun", "offered")).startsWith("Flag this for your coding agent?"),
    ],
    [
      "a note is left on the lines picked out in a block's code",
      value("lineNote", "on") === "On lines 2–3 of src/booking/price-seat.tsShow×" &&
        value("lineNote", "windowClosed") === true &&
        value("lineNote", "listed") === "On lines 2–3 of src/booking/price-seat.ts" &&
        JSON.stringify(value("anchorsOnDisk", "lines")) === "[2,3]" &&
        typeof value("anchorsOnDisk", "text") === "string",
    ],
    [
      "a note is left on a step of an execution, and leads back to it",
      String(value("stepNote", "on")).startsWith("On the step “") &&
        String(value("stepNote", "on")).endsWith("” of Book seats") &&
        value("stepNote", "went") === true &&
        value("anchorsOnDisk", "execution") === "book-seats",
    ],
    [
      "a problem Fragmentor reports on a block is flagged for the agent from the block's panel",
      value("problemFlagged", "offered") === true &&
        value("problemFlagged", "flagged") === true &&
        String(value("problemFlagged", "problem")).includes("src/outbox-nowhere.ts") &&
        value("problemFlagged", "redFlag") === true,
    ],
    [
      "every command is listed in a window of its own, with the block picked out filled in",
      value("commandsListed", "title") === "Commands for your agent" &&
        value("commandsListed", "names") === "notes review rebuild explain plan build make cover" &&
        value("commandsListed", "review") === "fragmentor review | fragmentor review tickets/booking-api/pricing/price-seat" &&
        value("commandsListed", "slash") === "fragmentor review [block] · in Claude Code, /fragmentor-review" &&
        value("commandsFromMenu", "subtitle") === "with Price Seat picked out" &&
        value("commandsFromMenu", "names") === "notes review rebuild explain plan build make cover",
    ],
    [
      "an architecture block says what kind it is under what it does, the kind in its colour",
      String(value("kindShown", "kind")).startsWith("DATABASE: ") &&
        value("kindShown", "underResponsibility") === true &&
        value("kindShown", "coloured") !== "" &&
        value("errorShown", "shown") === true &&
        value("errorShown", "open") === true &&
        value("errorShown", "retry") === true,
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
        // And the mark for it lands on no block, whichever run it is.
        value("execution", "outside") === "clear" &&
        value("execution", "lit") === "send-button" &&
        value("execution", "page") === "Step 1 of 19" &&
        /Ada presses send/.test(String(value("execution", "said"))) &&
        value("execution", "code") === "src/client/ui/sendButton.ts#onSendPressed" &&
        (() => {
          type Step = { count?: string; lit?: string; label?: string; tail?: string; head?: string };
          const reaches = value("stepping", "reaches") as { crossed?: string; fold?: string; word?: string };
          const page = value("stepping", "page");
          const stepped = value("stepping", "stepped") as Step;
          const back = value("stepping", "back") as Step & { way?: string; caption?: string };
          const hidden = value("folded", "hidden") as { partsGone?: boolean; count?: string; caption?: string };
          const opened = value("folded", "opened") as { partsBack?: boolean; count?: string; lit?: string; caption?: string };
          return (
            stepped?.count === "2 of 19" &&
            stepped?.lit === "send-button state" &&
            stepped?.label === "call" &&
            // The arrow is over the blocks and still does not take their
            // clicks: where it runs across the UI, and over that block's own
            // fold, the block is what is on top. Only the arrow's word takes
            // a click, which is how the step is opened.
            reaches?.crossed === "block ui" &&
            reaches?.fold === "block ui" &&
            reaches?.word === "exec-label-plate" &&
            // The step's page says its ends the way the arrow points.
            page === "from Database · sessions | to Check Session | kind gives back" &&
            // A call points at whoever was called.
            stepped?.tail === "send-button" &&
            stepped?.head === "state" &&
            // And an answer points back at whoever asked, not at whoever
            // answered: the arrow is drawn the way the step runs.
            back?.count === "7 of 19" &&
            back?.way === "back" &&
            back?.tail === "database" &&
            back?.head === "check-session" &&
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
      "a new project waits for its agent, and says what to send it first in the words of the answers given",
      value("waiting", "waiting") === true &&
        /fragmentor plan <what you want to build>/.test(String(value("waiting", "note"))) &&
        /greyed out/.test(String(value("waiting", "note"))) &&
        /send it:\s+fragmentor build/.test(String(value("waiting", "note"))) &&
        /full list of commands/i.test(String(value("waiting", "note"))) &&
        !/greyed out/.test(String(value("building", "note"))) &&
        /fragmentor make <what you want to build>/.test(String(value("building", "note"))) &&
        !/fragmentor build/.test(String(value("building", "note"))),
    ],
    [
      "a project just made says what to send the agent first, from the answers given, and lists every command",
      value("firstSteps", "shown") === true &&
        value("firstSteps", "opened") === true &&
        value("firstSteps", "first") === "plan" &&
        value("firstSteps", "phrase") === "fragmentor plan <what you want to build>" &&
        /\| fragmentor build$/.test(String(value("firstSteps", "phrases"))) &&
        value("firstSteps", "listed") === "notes review rebuild explain plan build make cover" &&
        value("firstSteps", "focused") === "Got it" &&
        value("firstStepsClosed", "closed") === true,
    ],
    [
      "new, open and close are under File, Reload Project reads the project again, and the toolbar is left to Commands",
      value("menu", "file") === true &&
        value("menu", "reloadIsTheProject") === true &&
        value("menu", "noPageReload") === true &&
        value("menu", "closedWithNothingOpen") === true &&
        value("menu", "toolbar") === "agent-commands toggle-rail toggle-inspector" &&
        value("waiting", "closeOffered") === true &&
        value("waiting", "reloadOffered") === true &&
        value("reloaded", "said") === true,
    ],
    [
      "a waiting project opened again is taught the command its canvas names",
      value("reopened", "opened") === true && value("reopened", "taught") === true,
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
      "code that does not import its contract is drawn, read-only, with nothing to run and the reason on show",
      /^src\/booking\/cancel-booking\.ts/.test(String(value("drawnOnly", "where"))) &&
        /does not import/.test(String(value("drawnOnly", "reason"))) &&
        value("drawnOnly", "noEditor") === true &&
        value("drawnOnly", "noBench") === true &&
        value("drawnOnly", "drawn") === true &&
        // And it is held to its contract again as soon as the import is back.
        value("boundAgain", "held") === true,
    ],
    ["a block with parts folds them away and brings them back", value("interface", "foldedAway") === "folded and unfolded"],
    [
      "the bench window is pulled to size by its corner, keeps that size through a redraw, and rolls up to its title",
      value("interface", "benchWindow") === "grew: true / kept: true / rolled: true / back: true",
    ],
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
        value("closed", "commandsHidden") === true &&
        value("closed", "closeOffered") === false,
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
      // The menu belongs to this process, so the check picks from it here, as
      // the person would, and the window hears of it as it would then.
      const menuItem = (id: string) => {
        const item = Menu.getApplicationMenu()?.getMenuItemById(id);
        if (!item) throw new Error(`The application menu has no "${id}".`);
        return item;
      };
      const pick = (id: string) => {
        const item = menuItem(id);
        if (item.enabled) item.click(undefined, window, window.webContents);
      };
      const inProject = (...parts: string[]) => path.join(check.projectDir, ...parts);
      // Every byte of every file the same, as filesOf gives them.
      const sameFiles = (a: Map<string, string>, b: Map<string, string>) =>
        a.size === b.size && [...a].every(([file, bytes]) => b.get(file) === bytes);
      // The same text in every file, whatever line endings a checkout here gave it.
      const asText = (bytes: string | undefined) => (bytes === undefined ? undefined : Buffer.from(bytes, "base64").toString("latin1").replace(/\r\n/g, "\n"));
      const sameText = (a: Map<string, string>, b: Map<string, string>) =>
        a.size === b.size && [...a].every(([file, bytes]) => asText(b.get(file)) === asText(bytes));

      try {
        // The tickets copy is given a history first, while nothing has it open
        // to hear the commits: an older version of its pricing, with a part
        // the example no longer has, then the example as it ships.
        report.history = await (async () => {
          try {
            await gitIn(check.application)("init", "--quiet");
            await commitExampleHistory(check.application);
            return { built: true };
          } catch (error) {
            return { built: false, error: messageOf(error) };
          }
        })();

        // Starting, opening and closing a project are under File, and the
        // toolbar is left to what is done with one once it is open.
        report.menu = {
          file: ["new-project", "open-project", "close-project"].every((id) => menuItem(id).label.endsWith("Project…") || menuItem(id).label === "Close Project"),
          reloadIsTheProject: menuItem("reload-project").label === "Reload Project" && menuItem("reload-project").accelerator === "CmdOrCtrl+R",
          // Reloading the page would put the open project away, so it is not offered.
          noPageReload: !(Menu.getApplicationMenu()?.items ?? []).some((top) => (top.submenu?.items ?? []).some((item) => item.role === "reload" || item.role === "forceReload")),
          closedWithNothingOpen: !menuItem("close-project").enabled && !menuItem("reload-project").enabled && !menuItem("show-commands").enabled,
          toolbar: (await window.webContents.executeJavaScript(
            `[...document.querySelectorAll(".toolbar button")].map((b) => b.id).join(" ")`,
          )) as string,
        };

        // The person asks for a new project. The questions are asked as a
        // tree: each answer reveals the next, and the form will not go on
        // until every question that applies has one. This time it is
        // cancelled before the folder is chosen; the project is started for
        // real further down.
        pick("new-project");
        await run("dialog", `
          const dialog = await until(() => document.querySelector("dialog.new-project[open]"));
          if (!dialog) return { opened: false };
          const create = [...dialog.querySelectorAll(".dialog-actions .btn")].find((b) => b.textContent.startsWith("Choose folder"));
          const blockedAtFirst = create.disabled;
          // Nothing is asked about Fragmentor's role over the code: it does
          // what it can with whatever each block turns out to point at.
          const roleUnasked = dialog.querySelectorAll('input[name="mode"]').length === 0;
          const levelUnasked = dialog.querySelector('input[name="granularity"]').closest("fieldset").hidden;
          dialog.querySelector('input[name="starting-point"][value="false"]').click();
          const blockedWithoutStart = create.disabled;
          dialog.querySelector('input[name="start"][value="plan"]').click();
          const blockedWithoutLevel = create.disabled;
          dialog.querySelector('input[name="granularity"][value="3"]').click();
          const ready = !create.disabled;

          // Code that already exists is described, never planned, so that
          // question is not asked of it at all.
          dialog.querySelector('input[name="starting-point"][value="true"]').click();
          const startNotAskedOfExistingCode = dialog.querySelector('input[name="start"]').closest("fieldset").hidden;
          const readyWithoutStart = !create.disabled;

          // Going back asks it again, with the answer already given still
          // standing, so the form can be finished without answering it twice.
          // A radio left checked for a cleared answer could not be re-chosen:
          // clicking the one already checked raises no event at all.
          dialog.querySelector('input[name="starting-point"][value="false"]').click();
          const keptBelow = [...dialog.querySelectorAll('input[name="start"]')].some((i) => i.checked);

          return {
            opened: true,
            blockedAtFirst,
            roleUnasked,
            levelUnasked,
            blockedWithoutStart,
            blockedWithoutLevel,
            ready,
            startNotAskedOfExistingCode,
            readyWithoutStart,
            keptBelow,
            readyAgain: !create.disabled,
            languageIsFree: Boolean(dialog.querySelector('input[list="project-languages"]')),
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
        // it is told to send, and what the empty canvas says, are supposed to
        // follow the answers given. The folder picker answers with the check's
        // own empty folder.
        pick("new-project");
        await run("firstSteps", `
          const dialog = await until(() => document.querySelector("dialog.new-project[open]"));
          if (!dialog) return { shown: false };
          dialog.querySelector('input[name="starting-point"][value="false"]').click();
          dialog.querySelector('input[name="start"][value="plan"]').click();
          dialog.querySelector('input[name="granularity"][value="3"]').click();
          const language = dialog.querySelector('input[list="project-languages"]');
          language.value = "TypeScript";
          language.dispatchEvent(new Event("input", { bubbles: true }));
          [...dialog.querySelectorAll(".dialog-actions .btn")].find((b) => b.textContent.startsWith("Choose folder")).click();

          const steps = await until(() => document.querySelector("dialog.first-steps[open]"), 15000);
          if (!steps) return { shown: false };
          const first = steps.querySelector("[data-first]");
          return {
            shown: true,
            opened: document.body.dataset.project === "open",
            first: first ? first.dataset.first : "",
            phrase: text("dialog.first-steps .first-phrase .note-phrase-words"),
            phrases: [...steps.querySelectorAll(".note-phrase-words")].map((each) => each.textContent).join(" | "),
            listed: [...steps.querySelectorAll("[data-command]")].map((each) => each.dataset.command).join(" "),
            focused: document.activeElement && document.activeElement.textContent,
          };
        `);
        await capture(window, "self-check-first-steps");
        await run("firstStepsClosed", `
          const done = [...document.querySelectorAll("dialog.first-steps .btn")].find((b) => b.textContent === "Got it");
          if (done) done.click();
          await wait(200);
          return { closed: !document.querySelector("dialog.first-steps") };
        `);
        // Its folder is in no repository, so it gets one of its own.
        report.newRepo = { started: await exists(inProject(".git")) };
        await run("waiting", `
          const waiting = await until(() => /FRAGMENTOR\\.md/.test(text(".canvas-empty")));
          return { waiting, note: text(".canvas-empty") };
        `);
        report.waiting = { ...report.waiting, closeOffered: menuItem("close-project").enabled, reloadOffered: menuItem("reload-project").enabled };
        await capture(window, "self-check-waiting");

        // The canvas names a command to send first, so a waiting project
        // started before that command existed is taught it when it is opened.
        const makeSkill = inProject(".claude", "skills", "fragmentor-make", "SKILL.md");
        await rm(makeSkill);
        pick("close-project");
        await run("reopened", `
          await until(() => document.body.dataset.project !== "open");
          const link = await until(() => [...document.querySelectorAll(".welcome-link")].find((b) => b.title === ${JSON.stringify(check.projectDir)}));
          if (!link) return { opened: false };
          link.click();
          return { opened: Boolean(await until(() => /fragmentor plan/.test(text(".canvas-empty")))) };
        `);
        report.reopened = { ...report.reopened, taught: false };
        for (let tries = 0; tries < 50 && !report.reopened.taught; tries++) {
          report.reopened.taught = await exists(makeSkill);
          if (!report.reopened.taught) await new Promise((resolve) => setTimeout(resolve, 100));
        }

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
        // Reading it again by hand says it did, since nothing else would show it.
        pick("reload-project");
        await run("reloaded", `
          const said = await until(() => /Read the project again/.test(text("#status")) && text("#status"), 5000);
          return { said: Boolean(said) };
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
          if (!(await until(() => text(".insp-id") === "tickets/booking-api/book-seats", 5000))) {
            return { breakpointSet, paused: false, stage: "panel stayed on " + text(".insp-id") };
          }
          const bench = await openBench();
          if (!bench) return { breakpointSet, paused: false, stage: "no bench for book-seats" };
          // A field that is not there says which one, rather than throwing: a
          // crash in here tells whoever reads the check nothing at all.
          const missing = [];
          const set = (label, value) => {
            const field = [...bench.querySelectorAll(".field")].find((f) => (f.querySelector("label") || {}).textContent === label);
            const control = field ? field.querySelector("input, textarea") : null;
            if (!control) {
              missing.push(label);
              return;
            }
            control.value = value;
            control.dispatchEvent(new Event("input", { bubbles: true }));
          };
          set("eventId", "gig");
          set("seats", "5");
          set("email", "ada@example.com");
          set("Tickets Database · events", JSON.stringify({ gig: { id: "gig", name: "Night Gig", seatsLeft: 10, price: 25 } }));
          if (missing.length > 0) {
            return {
              breakpointSet,
              paused: false,
              stage: "bench is missing " + missing.join(", "),
              labels: [...bench.querySelectorAll(".field label")].map((each) => each.textContent).join(" | "),
            };
          }

          const runButton = [...bench.querySelectorAll(".btn")].find((button) => button.textContent === "Run block" && !button.disabled);
          if (!runButton) return { breakpointSet, paused: false, stage: "no run button", buttons: [...bench.querySelectorAll(".btn")].map((b) => b.textContent).join(" | ") };
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

          await openBench();
          const runButton = await until(() => [...document.querySelectorAll(".bench-window .btn")]
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
            noTesting: ![...document.querySelectorAll("#inspector .section h4")].some((h) => h.textContent === "Run"),
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
        const impl = inProject("src", "booking", "refund-for.ts");
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

        // One block's code stops importing its contract, so nothing holds the
        // two together any more: Fragmentor draws that code and runs nothing.
        // Nothing else calls this one, so the rest of the system is unaffected.
        const cancelFile = inProject("src", "booking", "cancel-booking.ts");
        const cancelWhole = await readFile(cancelFile, "utf8");
        await writeFile(
          cancelFile,
          `export async function cancelBooking(input: { bookingId: string }) {
  return { cancelled: false, message: "no such booking", refund: 0 };
}
`,
          "utf8",
        );
        await run("drawnOnly", `
          const node = await until(() =>
            [...document.querySelectorAll(".tree .node")].find((n) => n.textContent.includes("cancel-booking")),
          );
          if (!node) return { found: false };
          node.click();
          const where = await until(() => text(".code-where"));
          const reason = await until(() => {
            const note = [...document.querySelectorAll(".code-foot .bench-note")].find((p) => /does not import/.test(p.textContent));
            return note ? note.textContent : null;
          });
          return {
            found: true,
            where,
            reason: reason || "",
            noEditor: !document.querySelector(".code-edit-input"),
            noBench: ![...document.querySelectorAll("#inspector .section h4")].some((h) => h.textContent === "Run"),
            drawn: /drawn/.test(text("#inspector .badge.state")),
          };
        `);
        await capture(window, "self-check-drawn-only");
        await writeFile(cancelFile, cancelWhole, "utf8");
        await run("boundAgain", `
          const held = await until(() => (text("#inspector .badge.state") === "checked and runnable" ? true : null));
          return { held: held === true };
        `);

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
            // A database has an interface like everything else, but it is made
            // of tables rather than of the ports a function is called through.
            shows: [...document.querySelectorAll("#inspector .section h4")].map((h) => h.textContent).join(" "),
            noPorts: ![...document.querySelectorAll("#inspector .subsection h5")].some((h) => h.textContent === "Inputs"),
          };
        `);
        await capture(window, "self-check-architecture");

        pick("close-project");
        await run("closed", `
          await until(() => document.body.dataset.project !== "open");
          await wait(300);
          return {
            back: document.body.dataset.project !== "open",
            startScreen: Boolean(document.querySelector("#welcome-body .welcome-actions")),
            blocks: document.querySelectorAll(".block-box").length,
            commandsHidden: document.getElementById("agent-commands").hidden,
            status: text("#status"),
          };
        `);
        report.closed = { ...report.closed, closeOffered: menuItem("close-project").enabled };

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
          // Where an action leads is written on the action's own row, inside
          // the interface, rather than in a list that repeats every name.
          const leads = document.querySelector("#inspector .proute");
          top.route = leads ? (leads.querySelector(".proute-text") || {}).textContent : "";
          top.canGo = Boolean(leads && [...leads.querySelectorAll(".btn")].find((b) => b.textContent === "Go there"));
          if (top.canGo) {
            [...leads.querySelectorAll(".btn")].find((b) => b.textContent === "Go there").click();
            await wait(900);
            top.wentTo = text(".insp-id");
            top.benchThere = Boolean(await openBench());
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
          const bench = Boolean(await openBench());
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

        // The controls that are only ever pressed, never looked at: Escape,
        // Ctrl-click, a click on an arrow and the zoom buttons. The bench is
        // on book-seats from the step above, and the dependencies are shown.
        await run("controls", `
          const escape = () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
          const press = (id, ctrlKey) =>
            document.querySelector('.block-box[data-id="' + id + '"]').dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, ctrlKey }));

          // Escape closes what is most in the way: the window over the
          // drawing first, then the bench beside it.
          document.querySelector('.block-box[data-id="booking-api"] .block-button').dispatchEvent(new MouseEvent("click", { bubbles: true }));
          const windowOpened = Boolean(await until(() => !document.getElementById("overlay").hidden, 3000));
          const benchBefore = Boolean(document.querySelector(".bench-window"));
          escape();
          await wait(300);
          const windowFirst = document.getElementById("overlay").hidden && Boolean(document.querySelector(".bench-window"));
          escape();
          await wait(300);
          const benchNext = !document.querySelector(".bench-window");

          // Ctrl-click adds a block to what is selected.
          press("book-seats", false);
          await wait(300);
          press("cancel-booking", true);
          await wait(400);
          const several = text("#inspector h2");

          // An arrow is a dependency, and has a page of its own.
          document.querySelector(".access-group").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
          await wait(400);
          const arrow = text("#inspector .insp-id");

          const zoom = text("#zoom-level");
          document.getElementById("zoom-in").click();
          await wait(300);
          const zoomedIn = text("#zoom-level") !== zoom;
          document.getElementById("zoom-fit").click();
          await wait(400);

          // Back where the step above left it, for the one below.
          press("book-seats", false);
          await wait(500);
          await openBench();
          return { windowOpened, benchBefore, windowFirst, benchNext, several, arrow, zoomedIn };
        `);

        // Seeding a store and running through it. The bench is on book-seats
        // from the step above, which reads the events through a Store port.
        await run("store", `
          const bench = (await openBench()) || document.querySelector(".bench-window");
          if (!bench) return { offered: false };
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

          // The inspector offers the way in; the bench itself is a window.
          const trying = await openBench("Try bookSeats");
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

        // A step between two blocks with nothing between them. Reserve is the
        // one part of Book Seats, listed twenty-two pixels under it, which is
        // no room at all for an arrow: it has to come round the side of both.
        await run("tight", `
          const shut = [...document.querySelectorAll(".bench-window .window-close")].find((b) => b.textContent === "\u2715");
          if (shut) shut.click();
          await wait(300);
          document.getElementById("zoom-fit").click();
          await wait(500);

          const button = (label) => [...document.querySelectorAll("#exec-bar .run-btn")].find((b) => b.textContent === label);
          const select = document.querySelector("#exec-bar .exec-select");
          select.value = "book-seats";
          select.dispatchEvent(new Event("change", { bubbles: true }));
          await until(() => document.querySelector("#exec-layer .exec-line-group"));

          // How far the arrow reaches past the two blocks it joins. Squeezed
          // into the gap it would stay within them, and be a squiggle.
          const reach = () => {
            const line = document.querySelector("#exec-layer .exec-line");
            if (!line) return "no arrow";
            const lit = [...document.querySelectorAll('.block-box[data-current="true"]')].map((box) => box.getBoundingClientRect());
            if (lit.length !== 2) return "lit " + lit.length;
            const past = line.getBoundingClientRect().right - Math.max(...lit.map((box) => box.right));
            return past > 8 ? "beside" : "squeezed";
          };
          const nearest = (line, length) => {
            const point = line.getPointAtLength(length).matrixTransform(line.getScreenCTM());
            let best = "";
            let near = Infinity;
            for (const box of document.querySelectorAll("#node-layer .block-box")) {
              const rect = box.getBoundingClientRect();
              const away = Math.hypot(
                Math.max(rect.left - point.x, 0, point.x - rect.right),
                Math.max(rect.top - point.y, 0, point.y - rect.bottom),
              );
              if (away < near) { near = away; best = box.dataset.id; }
            }
            return best;
          };
          const endsOf = () => {
            const line = document.querySelector("#exec-layer .exec-line");
            return line ? { tail: nearest(line, 0), head: nearest(line, line.getTotalLength()) } : {};
          };
          const stepTo = async (times) => {
            for (let i = 0; i < times; i += 1) {
              button("Step").click();
              await wait(160);
            }
            await wait(200);
          };

          // Book Seats reserving the seats, and the answer coming back.
          await stepTo(9);
          const into = { count: text(".exec-count"), reach: reach(), ...endsOf() };
          await stepTo(7);
          const back = { count: text(".exec-count"), reach: reach(), ...endsOf() };
          return { into, back };
        `);
        await capture(window, "self-check-tight");

        // A block's versions, from the history the tickets copy was given at
        // the start: pricing as it ships, and an older pricing with a part of
        // its own that took a fifth off from the third seat.
        const versionsSection = `
          const node = (label) => [...document.querySelectorAll(".tree .node")].find((n) => (n.querySelector(".label") || {}).textContent === label);
          const heading = (label) => until(() => text("#inspector h2") === label, 5000);
          const button = (within, label) => (within ? [...within.querySelectorAll("button")].find((b) => b.textContent === label) : undefined);
          const meta = (row) => ((row && row.querySelector(".version-meta")) || {}).textContent || "";
          // The block as it is, above both lists.
          const nowRow = () => document.querySelector("#inspector .version-row[data-now]");
          // The section's two named parts: "Saved" and "Git history".
          const part = (title) => [...document.querySelectorAll("#inspector .version-part")].find((each) => each.querySelector("h5").textContent === title);
          const named = (rows, name) => [...rows].find((row) => (row.querySelector(".case-name") || {}).textContent === name);
          // The older version's row, in the git history, and the latest's, which comes first.
          const older = () => named(document.querySelectorAll("#inspector .version-row[data-commit]"), "Price seats with a discount from the third seat");
          const latest = () => document.querySelector("#inspector .version-row[data-commit]");
          // The version saved from the panel, the only one saved: it is renamed on the way.
          const savedRow = () => document.querySelector("#inspector .version-row[data-saved]");
          // Which version the block is on: the rows marked "in-use" or "changed-from",
          // the tag on one row, and the badge in the panel's header.
          const marked = (state) =>
            [...document.querySelectorAll('#inspector .version-row[data-' + state + '="true"]')].map((row) => row.querySelector(".case-name").textContent).join(" | ");
          const tag = (row) => ((row && row.querySelector(".version-line .badge")) || {}).textContent || "";
          const badge = () => text("#inspector [data-version-badge-of]");
          // How one saved test came out in the two versions, as its row says.
          const cells = (name) => {
            const row = older() && [...older().querySelectorAll(".compare-row")].find((each) => each.querySelector(".case-name").textContent.startsWith(name));
            return row ? [...row.querySelectorAll(".case-status")].map((cell) => cell.textContent).join(" / ") : "";
          };
        `;

        await run("versions", `${versionsSection}
          node("pricing").click();
          if (!(await heading("Pricing"))) return { opened: false, inspector: text("#inspector h2") };
          const rows = await until(() => {
            const found = [...document.querySelectorAll("#inspector .version-row[data-commit]")];
            return found.length >= 2 ? found : null;
          }, 10000);
          if (!rows) return { opened: false, section: text("#inspector [data-versions-of]") };

          return {
            opened: true,
            // The last section of the panel, with no window of its own.
            sections: [...document.querySelectorAll("#inspector .section h4")].map((h) => h.textContent).join(" "),
            windows: [...document.querySelectorAll("#inspector .insp-windows .btn")].map((b) => b.textContent).join(" "),
            parts: [...document.querySelectorAll("#inspector .version-part h5")].map((h) => h.textContent).join(" | "),
            // The Now row comes before either list.
            nowFirst: Boolean(nowRow() && part("Saved") && nowRow().compareDocumentPosition(part("Saved")) & Node.DOCUMENT_POSITION_FOLLOWING),
            listed: rows.length,
            now: meta(nowRow()),
            subjects: rows.map((row) => row.querySelector(".case-name").textContent).join(" | "),
            latest: /latest/.test(meta(rows[0])),
            offers: older() ? [...older().querySelectorAll(".case-actions button")].map((b) => b.textContent).join(" | ") : "",
            undo: Boolean(button(nowRow(), "Undo swap")),
            saveOffered: Boolean(button(part("Saved"), "Save this version")),
            noneSaved: (part("Saved")?.querySelector(".bench-note") || {}).textContent || "",
            // Only a longer history is folded.
            noFold: ![...part("Git history").querySelectorAll("button")].some((b) => /^Show /.test(b.textContent)),
            inUse: marked("in-use"),
            latestTag: tag(rows[0]),
            changedFrom: marked("changed-from"),
            badge: badge(),
            badgeLit: document.querySelector("#inspector [data-version-badge-of]").classList.contains("in-use"),
            badgeTitle: document.querySelector("#inspector [data-version-badge-of]").title,
          };
        `);

        // Both versions' saved tests, run against both, and the rest of the
        // system's too: the older pricing changes what booking five seats costs.
        await run("compared", `${versionsSection}
          const compare = button(older(), "Compare");
          if (!compare) return { compared: false };
          compare.click();
          const summary = await until(() => {
            const found = older() && older().querySelector(".version-compare .case-summary");
            return found ? found.textContent : null;
          }, 30000);
          if (!summary) return { compared: false, note: older() ? (older().querySelector(".bench-note") || {}).textContent : "no row" };

          const saved = [...older().querySelectorAll(".case-saved")].map((each) => each.textContent);
          return {
            count: older().querySelectorAll(".compare-row").length,
            summary,
            others: (older().querySelector(".compare-others") || {}).textContent || "",
            changed: cells("the fifth is ten percent off"),
            noLonger: cells("the third is a fifth off"),
            same: cells("keeps a fee for each seat"),
            gone: cells("the third seat is a fifth off"),
            outside: cells("the fifth seat onwards"),
            newSince: saved.filter((each) => /new since then/.test(each)).length,
            notSaved: saved.filter((each) => /no longer saved/.test(each)).length,
            scrolled: (older().querySelector(".version-compare").scrollIntoView({ block: "start" }), true),
          };
        `);
        await capture(window, "self-check-versions");

        // Code typed into a file the swap would replace, and not saved: the
        // swap waits, and says which block's code to save or revert first.
        await run("guarded", `${versionsSection}
          node("price-seat").click();
          if (!(await heading("Price Seat"))) return { stage: "panel stayed on " + text("#inspector h2") };
          const bench = await openBench();
          if (!bench) return { stage: "no bench for price-seat" };
          const runAll = button(bench, "Run all tests");
          if (!runAll) return { stage: "no run-all button" };
          runAll.click();
          const ran = await until(() => text(".bench-window .case-summary"), 20000);

          const box = document.querySelector("#inspector .code-edit-input");
          if (!box) return { ran, stage: "no code to type in" };
          box.value += "// not saved yet\\n";
          box.dispatchEvent(new Event("input", { bubbles: true }));

          node("pricing").click();
          await heading("Pricing");
          const swap = await until(() => button(older(), "Swap to this"), 10000);
          if (!swap) return { ran, stage: "no Swap to this" };
          // The comparison made before going to Price Seat is still there on the way back.
          const kept = Boolean(older().querySelector(".version-compare .case-summary"));
          swap.click();
          const said = await until(() => {
            const note = older() && older().querySelector(".bench-note.bad");
            return note ? note.textContent : null;
          }, 5000);
          await wait(900);
          const untouched = !document.querySelector('.block-box[data-id="seat-discount"]');

          // Reverted, so the swap after this has nothing in its way.
          node("price-seat").click();
          await heading("Price Seat");
          const revert = [...document.querySelectorAll("#inspector .code-foot .btn")].find((b) => b.textContent === "Revert");
          if (revert) revert.click();
          await wait(300);
          const reverted = text("#inspector .code-foot .bench-note") === "Saved.";
          node("pricing").click();
          await heading("Pricing");
          // Nothing is left unsaved, so nothing is left asking for it to be.
          await until(() => button(older(), "Swap to this"), 10000);
          const askedStill = Boolean(older() && older().querySelector(".bench-note.bad"));
          return { ran, kept, said, untouched, reverted, askedStill };
        `);
        report.guardedOnDisk = { untouched: !(await exists(path.join(check.application, "src", "booking", "seat-discount.ts"))) };
        const beforeSwap = await filesOf(check.application);

        // The swap: the older pricing's part arrives on the tree, and the
        // bench still open on Price Seat shows that version's tests, with
        // nothing left from the run before.
        await run("swapped", `${versionsSection}
          const swap = await until(() => button(older(), "Swap to this"), 10000);
          if (!swap) return { arrived: false, stage: "no Swap to this" };
          swap.click();
          const arrived = Boolean(await until(() => document.querySelector('.block-box[data-id="seat-discount"]'), 15000));
          const undo = Boolean(await until(() => button(nowRow(), "Undo swap"), 10000));
          await wait(400);
          document.querySelector("#inspector [data-versions-of]").scrollIntoView({ block: "start" });
          return {
            arrived,
            status: text("#status .message"),
            now: meta(nowRow()),
            // The version in place says so on its own row, and in the panel's header.
            inUse: marked("in-use"),
            olderTag: tag(older()),
            latestTag: tag(latest()),
            badge: badge(),
            undo,
            benchTests: [...document.querySelectorAll(".bench-window .case-row .case-name")].map((each) => each.textContent).join(" | "),
            benchResults: Boolean(document.querySelector(".bench-window .case-summary")),
          };
        `);
        await capture(window, "self-check-swapped");
        // The badge at the top of the panel, which says so without scrolling,
        // and the rows that say so, as wide as the inspector opens: the check
        // widened it earlier, and gives it that width back afterwards.
        const inspectorWidth = (width: string) => `
          const pane = document.getElementById("inspector-pane");
          const handle = document.getElementById("inspector-splitter");
          const from = Math.round(pane.getBoundingClientRect().width);
          const at = (type, x, target) => target.dispatchEvent(
            new PointerEvent(type, { bubbles: true, pointerId: 7, clientX: x, clientY: 400, isPrimary: true }),
          );
          at("pointerdown", window.innerWidth - from, handle);
          at("pointermove", window.innerWidth - ${width}, window);
          at("pointerup", window.innerWidth - ${width}, window);
          await wait(200);
        `;
        await run("badgeShown", `${inspectorWidth("360")}
          document.querySelector("#inspector .insp-head").scrollIntoView({ block: "start" });
          return { from, width: Math.round(pane.getBoundingClientRect().width), shown: text("#inspector [data-version-badge-of]") };
        `);
        await capture(window, "self-check-version-badge");
        await run("rowsShown", `
          document.querySelector("#inspector [data-versions-of]").scrollIntoView({ block: "start" });
          await wait(200);
          return {};
        `);
        await capture(window, "self-check-version-rows");
        await run("widenedAgain", `${inspectorWidth(String(report.badgeShown?.from ?? 360))}
          return { width: Math.round(pane.getBoundingClientRect().width) };
        `);
        const afterSwap = await filesOf(check.application);
        // Everything a swap of pricing may write: its folder, and the code it
        // and its parts point at, now or in that version.
        const plan = /^(blocks\/tickets\/booking-api\/pricing\/|src\/booking\/(price-seat|refund-for|seat-discount)\.ts$)/;
        const porcelain = await gitIn(check.application)("status", "--porcelain", "--untracked-files=all");
        report.swappedOnDisk = {
          partCode: afterSwap.has("src/booking/seat-discount.ts"),
          partContract: afterSwap.has("blocks/tickets/booking-api/pricing/seat-discount/contract.ts"),
          callsPart: Buffer.from(afterSwap.get("src/booking/price-seat.ts") ?? "", "base64").toString("utf8").includes("seatDiscount"),
          nothingElse: [...new Set([...beforeSwap.keys(), ...afterSwap.keys()])]
            .filter((file) => !plan.test(file))
            .every((file) => beforeSwap.get(file) === afterSwap.get(file)),
          keptAside: await exists(path.join(check.application, ".fragmentor")),
          notForCommitting: !porcelain.includes(".fragmentor"),
        };

        // The agent changes a file the swap wrote. The block is no longer the
        // version swapped in, nor any other: it has changed since that one.
        await appendFile(path.join(check.application, "src", "booking", "price-seat.ts"), "// changed after the swap\n", "utf8");
        await run("changedSince", `${versionsSection}
          const now = await until(() => (/, and changed since\\.$/.test(meta(nowRow())) ? meta(nowRow()) : null), 15000);
          await wait(300);
          document.querySelector("#inspector [data-versions-of]").scrollIntoView({ block: "start" });
          return {
            now,
            inUse: marked("in-use"),
            changedFrom: marked("changed-from"),
            olderTag: tag(older()),
            badge: badge(),
            quiet: !document.querySelector("#inspector [data-version-badge-of]").classList.contains("in-use"),
          };
        `);
        await capture(window, "self-check-changed-since");

        await run("undone", `${versionsSection}
          const undo = button(nowRow(), "Undo swap");
          if (!undo) return { gone: false, stage: "no Undo swap" };
          undo.click();
          const gone = Boolean(await until(() => !document.querySelector('.block-box[data-id="seat-discount"]'), 15000));
          const now = await until(() => (meta(nowRow()) && !/^Swapped/.test(meta(nowRow())) ? meta(nowRow()) : null), 10000);
          return {
            gone,
            now,
            status: text("#status .message"),
            undo: Boolean(button(nowRow(), "Undo swap")),
            benchTests: [...document.querySelectorAll(".bench-window .case-row .case-name")].map((each) => each.textContent).join(" | "),
            inUse: marked("in-use"),
            changedFrom: marked("changed-from"),
            badge: badge(),
          };
        `);
        report.undoneOnDisk = { exactly: sameFiles(beforeSwap, await filesOf(check.application)) };

        // Pricing saved as a version from the panel, as the person would:
        // named and described in the form, which keeps what is typed while
        // they look at another block. Whoever saves one is named by git's own
        // setting, which a machine that has never committed does not have.
        await gitIn(check.application)("config", "user.name", "Fragmentor");
        const saveForm = `${versionsSection}
          const form = () => document.querySelector("#inspector .version-save");
        `;
        await run("saveForm", `${saveForm}
          const open = await until(() => button(part("Saved"), "Save this version"), 10000);
          if (!open) return { stage: "no Save this version" };
          open.click();
          if (!(await until(form))) return { stage: "no form" };
          const focused = document.activeElement === form().querySelector("input");
          const emptyRefused = button(form(), "Save").disabled;
          const put = (box, value) => {
            box.value = value;
            box.dispatchEvent(new Event("input", { bubbles: true }));
          };
          put(form().querySelector("input"), "Ten percent from the fifth seat");
          put(form().querySelector("textarea"), "The first four seats at full price, and ten percent off each one after.");

          // Away to another block and back, so the panel and the form are drawn afresh.
          node("price-seat").click();
          await heading("Price Seat");
          node("pricing").click();
          await heading("Pricing");
          await until(form, 10000);
          const kept =
            Boolean(form()) &&
            form().querySelector("input").value === "Ten percent from the fifth seat" &&
            form().querySelector("textarea").value === "The first four seats at full price, and ten percent off each one after.";
          await wait(300);
          part("Saved").scrollIntoView({ block: "center" });
          return { focused, emptyRefused, kept };
        `);
        await capture(window, "self-check-save-form");

        await run("saving", `${saveForm}
          button(form(), "Save").click();
          const row = await until(savedRow, 15000);
          if (!row) return { stage: "not listed", said: text("#inspector .version-save .bench-note") };
          await wait(300);
          document.querySelector("#inspector [data-versions-of]").scrollIntoView({ block: "start" });
          return {
            about: (row.querySelector(".version-about") || {}).textContent || "",
            meta: meta(row),
            offers: [...row.querySelectorAll(".case-actions button")].map((b) => b.textContent).join(" | "),
            formGone: !form(),
            status: text("#status .message"),
            // It is the block as it is, as the latest commit also is.
            inUse: marked("in-use"),
            tag: tag(row),
            now: meta(nowRow()),
            badge: badge(),
          };
        `);
        await capture(window, "self-check-saved");
        const savedFolder = path.join(check.application, ".fragmentor", "versions", "tickets", "booking-api", "pricing");
        const savedFiles = (await readdir(savedFolder).catch(() => [] as string[])).filter((file) => file.endsWith(".json"));
        const savedFile = savedFiles.length === 1 ? path.join(savedFolder, savedFiles[0]!) : null;
        const toCommit = await gitIn(check.application)("status", "--porcelain", "--untracked-files=all");
        report.savedOnDisk = {
          written: savedFile !== null,
          // It shows up to be committed with the project; the copies Undo swap keeps do not.
          forCommitting: toCommit.includes(`.fragmentor/versions/tickets/booking-api/pricing/${savedFiles[0]}`),
          swapsPrivate: !/\.fragmentor\/(swaps|\.gitignore)/.test(toCommit),
        };
        const whenSaved = await filesOf(check.application);
        const asSaved = savedFile === null ? null : JSON.parse(await readFile(savedFile, "utf8"));

        // Renamed and described again from its own row, as the person would:
        // the form opens there with what it says now, and keeps what is typed
        // while they look at another block.
        const editForm = `${versionsSection}
          const editing = () => savedRow() && savedRow().querySelector(".version-save");
          const put = (box, value) => {
            box.value = value;
            box.dispatchEvent(new Event("input", { bubbles: true }));
          };
        `;
        const openEdit = `
          const edit = await until(() => button(savedRow(), "Edit"), 10000);
          if (!edit) return { stage: "no Edit" };
          edit.click();
          if (!(await until(editing, 5000))) return { stage: "no form" };
        `;
        await run("versionEditing", `${editForm}${openEdit}
          const prefilled = editing().querySelector("input").value + " / " + editing().querySelector("textarea").value;
          const offers = [...editing().querySelectorAll("button")].map((b) => b.textContent).join(" | ");
          const focused = document.activeElement === editing().querySelector("input");
          put(editing().querySelector("input"), "Ten percent off from the fifth seat");
          put(editing().querySelector("textarea"), "Full price for the first four seats, then ten percent off.");

          node("price-seat").click();
          await heading("Price Seat");
          node("pricing").click();
          await heading("Pricing");
          // Coming back reads its versions again, which on a busy machine takes a while.
          await until(editing, 20000);
          const kept = Boolean(editing()) && editing().querySelector("input").value === "Ten percent off from the fifth seat";
          await wait(300);
          if (savedRow()) savedRow().scrollIntoView({ block: "center" });
          return { prefilled, offers, focused, kept };
        `);
        await capture(window, "self-check-version-edit");
        await run("versionRenamed", `${editForm}
          // Waited for: coming back to Pricing reads its versions again, and on a
          // busy machine git can still be reading when this step starts.
          const save = await until(() => editing() && button(editing(), "Save changes"), 15000);
          if (!save) return { stage: "no form" };
          save.click();
          const renamed = await until(
            () => savedRow() && !editing() && savedRow().querySelector(".case-name").textContent === "Ten percent off from the fifth seat",
            10000,
          );
          return {
            renamed: Boolean(renamed),
            about: (savedRow().querySelector(".version-about") || {}).textContent || "",
            status: text("#status .message"),
            tag: tag(savedRow()),
            badge: badge(),
          };
        `);
        await run("versionDescribed", `${editForm}${openEdit}
          put(editing().querySelector("textarea"), "The first four seats at full price, and ten percent off each one after.");
          button(editing(), "Save changes").click();
          await until(() => savedRow() && !editing(), 10000);
          return {
            about: (savedRow().querySelector(".version-about") || {}).textContent || "",
            status: text("#status .message"),
          };
        `);
        // The same file, with only its name and description changed.
        const asEdited = savedFile === null ? null : JSON.parse(await readFile(savedFile, "utf8"));
        report.editedOnDisk = {
          named: asEdited?.name === "Ten percent off from the fifth seat",
          described: asEdited?.description === "The first four seats at full price, and ten percent off each one after.",
          restKept: asSaved !== null && JSON.stringify({ ...asEdited, name: asSaved.name, description: asSaved.description }) === JSON.stringify(asSaved),
        };

        // Compared with the block it was saved from, which it still is.
        await run("savedCompared", `${versionsSection}
          const compare = button(savedRow(), "Compare");
          if (!compare) return { stage: "no Compare" };
          compare.click();
          const summary = await until(() => {
            const found = savedRow() && savedRow().querySelector(".version-compare .case-summary");
            return found ? found.textContent : null;
          }, 30000);
          return {
            summary,
            others: ((savedRow() && savedRow().querySelector(".compare-others")) || {}).textContent || "",
            differing: savedRow() ? savedRow().querySelectorAll('.compare-row[data-differs="true"]').length : -1,
          };
        `);

        // Swapped to the older commit, and then to the saved version, which
        // puts back every file it saved as it was when it was saved.
        await run("swappedOlder", `${versionsSection}
          const swap = await until(() => button(older(), "Swap to this"), 10000);
          if (!swap) return { arrived: false, stage: "no Swap to this" };
          swap.click();
          const arrived = Boolean(await until(() => document.querySelector('.block-box[data-id="seat-discount"]'), 15000));
          // The list is read again after a swap, and the next one waits for it.
          await until(() => button(nowRow(), "Undo swap") && button(savedRow(), "Swap to this"), 10000);
          return { arrived };
        `);
        const olderInPlace = await filesOf(check.application);

        await run("swappedSaved", `${versionsSection}
          const swap = button(savedRow(), "Swap to this");
          if (!swap) return { gone: false, stage: "no Swap to this" };
          swap.click();
          const gone = Boolean(await until(() => !document.querySelector('.block-box[data-id="seat-discount"]'), 15000));
          const now = await until(() => (/^Swapped to “Ten/.test(meta(nowRow())) ? meta(nowRow()) : null), 10000);
          return {
            gone,
            now,
            status: text("#status .message"),
            tag: tag(savedRow()),
            badge: badge(),
            undo: Boolean(button(nowRow(), "Undo swap")),
          };
        `);
        // Every file it saved is back, written as a checkout here writes it.
        // The code of the part the older commit added is under a pointer the
        // saved version knows nothing about, so it is left as it was.
        const afterSaved = await filesOf(check.application);
        const leftOver = "src/booking/seat-discount.ts";
        report.savedSwapOnDisk = {
          exactly:
            afterSaved.get(leftOver) === olderInPlace.get(leftOver) &&
            sameText(whenSaved, new Map([...afterSaved].filter(([file]) => file !== leftOver))),
        };

        await run("undoneSaved", `${versionsSection}
          const undo = button(nowRow(), "Undo swap");
          if (!undo) return { back: false, stage: "no Undo swap" };
          undo.click();
          const back = Boolean(await until(() => document.querySelector('.block-box[data-id="seat-discount"]'), 15000));
          // Only the latest swap can be undone, and this undid it.
          await until(() => !button(nowRow(), "Undo swap") && savedRow(), 10000);
          return { back };
        `);
        report.undoneSavedOnDisk = { exactly: sameFiles(olderInPlace, await filesOf(check.application)) };

        // Deleted only once the person has said so twice.
        await run("asked", `${versionsSection}
          const remove = button(savedRow(), "Delete");
          if (!remove) return { stage: "no Delete" };
          remove.click();
          const question = await until(() => ((savedRow() && savedRow().querySelector(".bench-note.bad")) || {}).textContent, 5000);
          const answers = [...savedRow().querySelectorAll(".case-actions button")].map((b) => b.textContent).join(" | ");
          button(savedRow(), "Keep").click();
          await wait(200);
          const kept = Boolean(savedRow()) && !savedRow().querySelector(".bench-note.bad") && Boolean(button(savedRow(), "Delete"));
          button(savedRow(), "Delete").click();
          await until(() => button(savedRow(), "Delete it"), 5000);
          return { question, answers, kept };
        `);
        report.askedOnDisk = { still: savedFile !== null && (await exists(savedFile)) };

        await run("deleted", `${versionsSection}
          const yes = button(savedRow(), "Delete it");
          if (!yes) return { gone: false, stage: "no Delete it" };
          yes.click();
          const gone = Boolean(await until(() => !savedRow(), 10000));
          return {
            gone,
            status: text("#status .message"),
            none: ((part("Saved") && part("Saved").querySelector(".bench-note")) || {}).textContent || "",
          };
        `);
        report.deletedOnDisk = { gone: savedFile !== null && !(await exists(savedFile)) };

        // An agent commits every small step, so the git history lists only the
        // newest five until the person asks for all of them.
        for (let n = 1; n <= 4; n += 1) {
          const file = `blocks/tickets/booking-api/pricing/step-${n}.md`;
          await writeFile(path.join(check.application, ...file.split("/")), `A small step, ${n}.\n`, "utf8");
          await gitIn(check.application)("add", "--", file);
          await gitIn(check.application)("commit", "--quiet", "-m", `Take a small step, ${n}`);
        }
        await run("historyFolded", `${versionsSection}
          // A commit touches only .git, which nothing watches: the list is read
          // again when the window has the focus back.
          window.dispatchEvent(new Event("focus"));
          const all = await until(() => button(part("Git history"), "Show all 6"), 15000);
          if (!all) return { offered: false };
          const commits = () => part("Git history").querySelectorAll(".version-row[data-commit]").length;
          const folded = commits();
          all.click();
          const unfolded = commits();
          button(part("Git history"), "Show fewer").click();
          return { offered: true, folded, unfolded, back: commits() };
        `);

        // Notes: the person leaves one on a block for the agent, from the
        // block's panel; the agent answers it from the command line while the
        // window is open, and leaves one of its own while the person is typing;
        // the person resolves it; and a failing test is flagged from the bench.
        const notesSection = `${versionsSection}
          const notes = () => document.querySelector("#inspector [data-notes-of]");
          const cards = () => [...document.querySelectorAll("#inspector [data-notes-of] .note-card")];
          const mark = (id) => document.querySelector('.block-box[data-id="' + id + '"] .note-mark');
          const count = (id) => (mark(id) ? mark(id).dataset.waiting + " " + mark(id).querySelector(".note-mark-count").textContent : "");
          const bar = () => (document.getElementById("notes-bar").hidden ? "" : text("#notes-bar"));
          const put = (box, value) => {
            box.value = value;
            box.dispatchEvent(new Event("input", { bubbles: true }));
          };
        `;
        await run("notesOffered", `${notesSection}
          // The bench left open by the steps before would cover the blocks and the bar.
          const close = [...document.querySelectorAll(".bench-window .window-close")].find((each) => each.textContent === "✕");
          if (close) close.click();
          node("price-seat").click();
          if (!(await heading("Price Seat"))) return { opened: false };
          const section = await until(notes, 5000);
          if (!section) return { opened: true, section: false };
          const headings = [...document.querySelectorAll("#inspector .section h4")].map((h) => h.textContent);
          return {
            opened: true,
            of: section.dataset.notesOf,
            // What is waiting to be done comes before what the block is.
            notesFirst: headings.indexOf("Notes") !== -1 && headings.indexOf("Notes") < headings.indexOf("Interface"),
            offers: Boolean(button(section, "Leave a note")),
            bar: bar(),
            marked: count("price-seat"),
          };
        `);

        await run("noteLeft", `${notesSection}
          button(notes(), "Leave a note").click();
          const box = await until(() => notes() && notes().querySelector(".note-form textarea"), 5000);
          if (!box) return { stage: "no form" };
          const focused = document.activeElement === box;
          const send = () => button(notes().querySelector(".note-form"), "Leave note");
          const emptyRefused = send().disabled;
          put(box, "Seats in row A should cost double.");
          const readyNow = !send().disabled;
          send().click();
          const card = await until(() => cards()[0], 10000);
          if (!card) return { stage: "not listed", said: text("#inspector [data-notes-of] .bench-note.bad") };
          await until(() => mark("price-seat"), 5000);
          return {
            focused,
            emptyRefused,
            readyNow,
            waiting: card.dataset.waiting,
            state: text("#inspector .note-card .note-state"),
            says: text("#inspector .note-card .note-text"),
            formGone: !notes().querySelector(".note-form"),
            phrases: [...notes().querySelectorAll(".note-phrase-words")].map((c) => c.textContent).join(" | "),
            marked: count("price-seat"),
            bar: bar(),
            status: text("#status .message"),
          };
        `);
        await capture(window, "self-check-note-left");
        const notesFolder = path.join(check.application, ".fragmentor", "notes");
        const noteFiles = async () => (await readdir(notesFolder).catch(() => [] as string[])).filter((file) => file.endsWith(".json")).sort();
        const readNoteFile = async (file: string) => JSON.parse(await readFile(path.join(notesFolder, file), "utf8"));
        const [leftFile] = await noteFiles();
        const noteId = leftFile === undefined ? null : leftFile.slice(0, -".json".length);
        const leftNote = leftFile === undefined ? null : await readNoteFile(leftFile);
        const notesToCommit = await gitIn(check.application)("status", "--porcelain", "--untracked-files=all");
        report.noteOnDisk = {
          files: (await noteFiles()).length,
          block: leftNote?.block,
          from: leftNote?.messages?.[0]?.from,
          status: leftNote?.status,
          // It shows up to be committed with the project, as a saved version does.
          forCommitting: leftFile !== undefined && notesToCommit.includes(`.fragmentor/notes/${leftFile}`),
          // And the guide the agent reads says what to do with it.
          guided: (await readFile(path.join(check.application, "FRAGMENTOR.md"), "utf8")).includes("fragmentor notes"),
        };

        // What to tell the agent, copied from the bar above the drawing. The
        // clipboard is the person's, so whatever was on it, in every format, is put back.
        // Read out in full first: an item read from the clipboard cannot be written back as it is.
        const clipboardBefore = await Promise.all(
          (await clipboard.read()).map(
            async (item) => new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async (type) => [type, await item.getType(type)] as const)))),
          ),
        );
        await run("phraseCopied", `${notesSection}
          const copy = [...document.querySelectorAll("#notes-bar button")].find((b) => b.textContent === "Copy");
          if (!copy) return { copied: false };
          copy.click();
          return { copied: Boolean(await until(() => copy.textContent === "Copied", 3000)) };
        `);
        report.phraseOnClipboard = { text: await clipboard.readText() };
        await clipboard.write(clipboardBefore);

        // The agent answers from the command line, as its guide says, with
        // nothing in the window asked to read the project again.
        if (noteId !== null) {
          await replyToNote(check.application, noteId, "agent", "Done: priceSeat now charges double for any seat in row A. Its tests pass.");
        }
        await run("noteAnswered", `${notesSection}
          const answered = await until(() => (cards()[0] && cards()[0].dataset.waiting === "person" ? cards()[0] : null), 10000);
          if (!answered) return { seen: false };
          return {
            seen: true,
            from: [...answered.querySelectorAll(".note-from")].map((f) => f.textContent).join(" "),
            state: text("#inspector .note-card .note-state"),
            marked: count("price-seat"),
            bar: bar(),
            offers: [...answered.querySelectorAll(".case-actions button")].map((b) => b.textContent).join(" | "),
          };
        `);
        await capture(window, "self-check-note-answered");

        // The person starts a reply, and the agent leaves a note on another
        // block while they type, which draws the whole window again.
        await run("replying", `${notesSection}
          button(cards()[0], "Reply").click();
          const box = await until(() => cards()[0] && cards()[0].querySelector("textarea"), 5000);
          if (!box) return { focused: false };
          put(box, "Row B too, please.");
          box.setSelectionRange(3, 3);
          return { focused: document.activeElement === box };
        `);
        await addNote(check.application, "tickets/booking-api/find-event", "agent", "An event that has been cancelled is still found. Should it be?");
        await run("typingKept", `${notesSection}
          const other = await until(() => mark("find-event"), 10000);
          const box = cards()[0] && cards()[0].querySelector("textarea");
          const kept = {
            redrawn: Boolean(other),
            words: box ? box.value : "",
            focused: Boolean(box) && document.activeElement === box,
            at: box ? box.selectionStart : -1,
          };
          button(cards()[0].querySelector(".note-form"), "Cancel").click();
          await until(() => !notes().querySelector(".note-form"), 3000);
          return kept;
        `);

        await run("noteResolved", `${notesSection}
          const resolve = button(cards()[0], "Resolve");
          if (!resolve) return { stage: "no Resolve" };
          resolve.click();
          const gone = await until(() => cards().length === 0, 10000);
          const toggle = [...notes().querySelectorAll("button")].find((b) => /resolved note/.test(b.textContent));
          const folded = toggle ? toggle.textContent : "";
          if (toggle) toggle.click();
          await wait(100);
          return {
            gone: Boolean(gone),
            folded,
            shown: cards().map((card) => card.dataset.waiting).join(" "),
            marked: count("price-seat"),
            elsewhere: count("find-event"),
            bar: bar(),
            status: text("#status .message"),
          };
        `);
        report.resolvedOnDisk = { status: leftFile === undefined ? null : (await readNoteFile(leftFile)).status };

        // A note on a block the agent has since taken away, as its file would
        // be left: answered by the agent, and so waiting for the person.
        const goneNote = "1700000000000-take-this-block-away";
        await writeFile(
          path.join(notesFolder, `${goneNote}.json`),
          `${JSON.stringify(
            {
              block: "tickets/booking-api/gone",
              status: "open",
              messages: [
                { from: "person", at: "2023-11-14T22:13:20.000Z", text: "Take this block away." },
                { from: "agent", at: "2023-11-14T22:20:00.000Z", text: "Done: it is gone, and nothing called it." },
              ],
            },
            null,
            2,
          )}\n`,
          "utf8",
        );

        // With nothing picked out, the project's own panel lists every open
        // note, says what to tell the agent, and leads to each note's block.
        await run("projectNotes", `${notesSection}
          document.querySelector("#crumbs .crumb").click();
          const notesPart = () => [...document.querySelectorAll("#inspector .section")].find((each) => each.querySelector("h4").textContent === "Notes");
          const goneCard = () => notesPart() && notesPart().querySelector('.note-card[data-note="${goneNote}"]');
          // The agent's answer on the block that has gone arrives with the watcher.
          if (!(await until(goneCard, 10000))) return { listed: "", parts: notesPart() ? [...notesPart().querySelectorAll("h5")].map((h) => h.textContent).join(" | ") : "" };
          const section = notesPart();
          const rows = [...section.querySelectorAll(".note-row")];
          const result = {
            parts: [...section.querySelectorAll("h5")].map((h) => h.textContent).join(" | "),
            listed: rows.map((row) => row.querySelector(".problem-where").textContent).join(" "),
            phrases: [...section.querySelectorAll(".note-phrase-words")].map((c) => c.textContent).join(" | "),
            // It is on no block, so no block carries its count.
            goneMarked: count("booking-api"),
            goneOffers: [...goneCard().querySelectorAll(".case-actions button")].map((b) => b.textContent).join(" | "),
          };
          result.goneBar = text("#notes-bar");
          button(goneCard(), "Delete").click();
          const yes = await until(() => button(goneCard(), "Delete it"), 5000);
          if (yes) yes.click();
          result.goneDeleted = Boolean(await until(() => !goneCard(), 10000));
          const rowsNow = [...notesPart().querySelectorAll(".note-row")];
          if (rowsNow[0]) rowsNow[0].click();
          await heading("Find Event");
          return { ...result, went: notes() ? notes().dataset.notesOf : "" };
        `);

        // A test that fails, flagged from the bench. It is a test of Price
        // Seat's own, written as an agent writes one, that the code does not meet.
        const priceSeatCases = path.join(check.application, "blocks", "tickets", "booking-api", "pricing", "price-seat", "cases.json");
        const casesBefore = await readFile(priceSeatCases, "utf8");
        const rowA = { name: "row A is double", input: { fullPrice: 25, seat: 1 }, expected: { price: 50 } };
        await writeFile(priceSeatCases, `${JSON.stringify([...JSON.parse(casesBefore), rowA], null, 2)}\n`, "utf8");
        await run("flagged", `${notesSection}
          node("price-seat").click();
          await heading("Price Seat");
          if (!(await openBench())) return { stage: "no bench" };
          // Found again each time: the window is drawn afresh as the project changes.
          const bench = () => document.querySelector(".bench-window");
          const runAll = () => bench() && [...bench().querySelectorAll("button")].find((b) => b.textContent === "Run all tests");
          const ready = await until(() => runAll() && [...bench().querySelectorAll(".case-name")].some((n) => n.textContent === "row A is double"), 10000);
          if (!ready) return { stage: "no new test" };
          runAll().click();
          const offer = await until(() => bench() && bench().querySelector(".flag-offer"), 30000);
          if (!offer) return { stage: "no offer", summary: text(".bench-window .case-summary") };
          const offered = offer.textContent;
          [...offer.querySelectorAll("button")].find((b) => b.textContent === "Flag it").click();
          const flagged = await until(() => /Flagged for your agent/.test(text(".bench-window .flag-offer")), 10000);
          return {
            offered,
            flagged: Boolean(flagged),
            summary: text(".bench-window .case-summary"),
            marked: count("price-seat"),
            // The open ones: the resolved note is still unfolded from before.
            listed: cards().filter((card) => card.dataset.waiting !== "none").map((card) => (card.querySelector(".note-error") || card.querySelector(".note-text")).textContent).join(" | "),
            // A failure flagged for the agent is drawn as a failed run is, outlined in red.
            outlined: getComputedStyle(document.querySelector('.block-box[data-id="price-seat"] .block-plate')).stroke,
            summary: text("#inspector .note-run summary"),
          };
        `);
        await capture(window, "self-check-flagged");
        await writeFile(priceSeatCases, casesBefore, "utf8");
        const flaggedNotes: { block: string; messages: { text: string; run?: unknown }[] }[] = [];
        for (const file of await noteFiles()) {
          const note = await readNoteFile(file);
          if (note.messages?.[0]?.run) flaggedNotes.push(note);
        }
        report.flaggedOnDisk = {
          count: flaggedNotes.length,
          block: flaggedNotes[0]?.block,
          text: flaggedNotes[0]?.messages[0]?.text,
          run: flaggedNotes[0]?.messages[0]?.run,
        };

        // Round two of notes. The agent says it has started on the flagged
        // test, and the block's count pulses while it works.
        let flaggedId: string | null = null;
        for (const file of await noteFiles()) if ((await readNoteFile(file)).messages?.[0]?.run) flaggedId = file.slice(0, -".json".length);
        if (flaggedId !== null) await markWorking(check.application, flaggedId);
        await run("noteWorking", `${notesSection}
          const working = await until(() => mark("price-seat") && mark("price-seat").dataset.working === "true", 10000);
          const card = cards().find((each) => each.dataset.working === "true");
          return {
            pulsing: Boolean(working) && Boolean(mark("price-seat").querySelector(".note-mark-ring")),
            said: card ? text("#inspector .note-working") : "",
            bar: bar(),
          };
        `);

        // The agent answers it as `fragmentor reply` does, recording the commit
        // its work is in: a change to Price Seat that refuses a seat past 99.
        const priceSeatCode = path.join(check.application, "src", "booking", "price-seat.ts");
        const codeBefore = await readFile(priceSeatCode, "utf8");
        await writeFile(
          priceSeatCode,
          codeBefore.replace(
            /(export async function priceSeat\([^)]*\)[^{]*\{)/,
            `$1\n  if (input.seat > 99) throw new Error("There is no seat " + input.seat + ".");`,
          ),
          "utf8",
        );
        await gitIn(check.application)("add", "--", "src/booking/price-seat.ts");
        await gitIn(check.application)("commit", "--quiet", "-m", "Refuse a seat past the last one");
        const fixHash = (await gitIn(check.application)("rev-parse", "HEAD")).trim();
        if (flaggedId !== null) {
          await replyToNote(check.application, flaggedId, "agent", "Row A is priced the same as any other row, so I have left the price alone; I made a seat past 99 an error instead.", {
            commit: { hash: fixHash, subject: "Refuse a seat past the last one" },
          });
        }
        await run("noteCommitted", `${notesSection}
          window.dispatchEvent(new Event("focus"));
          const answered = await until(() => cards().find((each) => each.dataset.waiting === "person" && each.querySelector(".note-commit")), 10000);
          if (!answered) return { seen: false };
          // The answer arriving starts what was flagged running again, which
          // draws the panel again; it is still drawn once.
          const headings = () => [...document.querySelectorAll("#inspector .section h4")].map((h) => h.textContent);
          const drawnOnce = () => headings().filter((h) => h === "Notes").length === 1 && headings().filter((h) => h === "Versions").length === 1;
          const onceAtAnswer = drawnOnce();
          // Once the block's versions are read, the version before the commit is offered.
          const offers = await until(() => {
            const found = [...cards().find((each) => each.querySelector(".note-commit")).querySelectorAll(".note-commit button")].map((b) => b.textContent).join(" | ");
            return found || null;
          }, 15000);
          // What was flagged is run again now it is answered, and still fails.
          const rerun = await until(() => {
            const line = cards().find((each) => each.querySelector(".note-commit")).querySelector(".note-rerun");
            return line && line.dataset.tone ? line : null;
          }, 30000);
          // Looked at again from another block, as the person would, while the
          // flagged run is run again: the panel is still drawn once.
          node("find-event").click();
          await heading("Find Event");
          node("price-seat").click();
          await heading("Price Seat");
          await wait(300);
          return {
            seen: true,
            drawnOnce: onceAtAnswer && drawnOnce(),
            commit: text("#inspector .note-commit"),
            offers: offers || "",
            working: Boolean(mark("price-seat")) && mark("price-seat").dataset.working === "true",
            rerunTone: rerun ? rerun.dataset.tone : "",
            rerunSaid: rerun ? rerun.querySelector("span").textContent : "",
            rerunOffers: rerun ? [...rerun.querySelectorAll("button")].map((b) => b.textContent).join(" | ") : "",
            retry: Boolean([...cards().find((each) => each.querySelector(".note-commit")).querySelectorAll(".note-run button")].find((b) => b.textContent === "Retry test")),
          };
        `);
        await capture(window, "self-check-note-committed");

        await run("comparedFromNote", `${notesSection}
          const card = cards().find((each) => each.querySelector(".note-commit"));
          const compare = card && button(card.querySelector(".note-commit"), "Compare with before");
          if (!compare) return { compared: false };
          compare.click();
          const shown = await until(() => document.querySelector("#inspector [data-versions-of] .version-compare"), 60000);
          return { compared: Boolean(shown), onRow: shown ? shown.closest(".version-row").dataset.commit !== ${JSON.stringify(fixHash)} : false };
        `);

        await run("toldStillFails", `${notesSection}
          const card = cards().find((each) => each.querySelector(".note-rerun[data-tone='bad']"));
          const tell = card && button(card.querySelector(".note-rerun"), "Tell your agent");
          if (!tell) return { told: false };
          tell.click();
          const back = await until(() => cards().find((each) => each.dataset.note === card.dataset.note && each.dataset.waiting === "agent"), 10000);
          return { told: Boolean(back) };
        `);
        const toldNote = flaggedId === null ? null : await readNoteFile(`${flaggedId}.json`);
        report.toldOnDisk = {
          from: toldNote?.messages?.at(-1)?.from,
          still: toldNote?.messages?.at(-1)?.run?.problems?.join(" "),
          working: toldNote?.working ?? null,
          commit: toldNote?.messages?.find((message: { commit?: { hash: string } }) => message.commit)?.commit?.hash === fixHash,
        };

        // A run of Price Seat past the last seat fails in the block: a red
        // flag on its corner and a red glow, with no word in the box.
        await run("failedRun", `${notesSection}
          const bench = await openBench();
          if (!bench) return { stage: "no bench" };
          const [fullPrice, seat] = [...document.querySelectorAll(".bench-window .bench-fields input")];
          if (!fullPrice || !seat) return { stage: "no fields" };
          put(fullPrice, "25");
          put(seat, "100");
          [...document.querySelectorAll(".bench-window button")].find((b) => b.textContent === "Run block").click();
          const failed = await until(() => document.querySelector('.block-box[data-id="price-seat"][data-run="failed"]'), 20000);
          if (!failed) return { stage: "did not fail", bar: text("#run-bar") };
          const flag = failed.querySelector(".block-flag");
          return {
            failed: true,
            said: failed.querySelector(".run-note").textContent,
            flagShown: Boolean(flag) && getComputedStyle(flag).display !== "none",
            // What holds it is outlined as failing too, but the flag says where it happened.
            around: [...document.querySelectorAll('.block-box[data-run="failed"]')]
              .filter((each) => getComputedStyle(each.querySelector(".block-flag")).display !== "none")
              .map((each) => each.dataset.id)
              .join(" "),
            glow: getComputedStyle(failed.querySelector(".block-plate")).filter,
            offered: text(".bench-window .flag-offer"),
          };
        `);
        await capture(window, "self-check-failed-run");
        await writeFile(priceSeatCode, codeBefore, "utf8");

        // A note on the lines picked out in a block's code.
        await run("linesPicked", `${notesSection}
          const close = [...document.querySelectorAll(".bench-window .window-close")].find((each) => each.textContent === "✕");
          if (close) close.click();
          node("price-seat").click();
          await heading("Price Seat");
          const codeButton = [...document.querySelectorAll("#inspector .insp-windows button")].find((b) => b.textContent === "Code");
          if (!codeButton) return { stage: "no Code button" };
          codeButton.click();
          const pre = await until(() => document.querySelector("#overlay pre.window-code"), 10000);
          if (!pre) return { stage: "no code window" };
          const lines = [...pre.querySelectorAll(".excerpt-line")];
          const range = document.createRange();
          range.setStart(lines[1], 1);
          // Just after the fourth line's number: none of its code is taken.
          range.setEnd(lines[3], 1);
          const picked = window.getSelection();
          picked.removeAllRanges();
          picked.addRange(range);
          const leave = [...document.querySelectorAll("#overlay .window-foot button")].find((b) => b.textContent === "Leave a note on the selected lines");
          if (!leave) return { stage: "no button" };
          leave.scrollIntoView({ block: "center" });
          const box = leave.getBoundingClientRect();
          return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
        `);
        const pressAt = report.linesPicked as { x?: number; y?: number } | undefined;
        if (pressAt?.x !== undefined && pressAt.y !== undefined) {
          window.webContents.sendInputEvent({ type: "mouseDown", x: pressAt.x, y: pressAt.y, button: "left", clickCount: 1 });
          window.webContents.sendInputEvent({ type: "mouseUp", x: pressAt.x, y: pressAt.y, button: "left", clickCount: 1 });
        }
        await run("lineNote", `${notesSection}
          const form = await until(() => notes() && notes().querySelector(".note-form .note-on"), 5000);
          if (!form) return { stage: "no form" };
          const on = form.textContent;
          put(notes().querySelector(".note-form textarea"), "Say why these two lines are here.");
          button(notes().querySelector(".note-form"), "Leave note").click();
          const card = await until(() => cards().find((each) => each.querySelector(".note-on") && each.dataset.waiting === "agent"), 10000);
          return { on, windowClosed: document.getElementById("overlay").hidden, listed: card ? card.querySelector(".note-on span").textContent : "" };
        `);

        // A note on one step of an execution, from the step's own page.
        await run("stepNote", `${notesSection}
          const barButton = (label) => [...document.querySelectorAll("#exec-bar button")].find((b) => b.textContent === label);
          if (!barButton("Restart") || !barButton("Step")) return { stage: "no stepping" };
          barButton("Restart").click();
          await wait(200);
          barButton("Step").click();
          await wait(200);
          const leave = await until(() => [...document.querySelectorAll("#inspector button")].find((b) => b.textContent === "Leave a note on this step"), 5000);
          if (!leave) return { stage: "no button", inspector: text("#inspector h2") };
          const step = text("#inspector h2");
          leave.click();
          const form = await until(() => notes() && notes().querySelector(".note-form .note-on"), 5000);
          if (!form) return { stage: "no form" };
          const on = form.querySelector("span").textContent;
          put(notes().querySelector(".note-form textarea"), "Should this step happen before the seats are reserved?");
          button(notes().querySelector(".note-form"), "Leave note").click();
          const card = await until(() => cards().find((each) => each.querySelector(".note-on") && each.querySelector(".note-on span").textContent.startsWith("On the step")), 10000);
          // Its Show goes back to that step.
          const show = card && button(card.querySelector(".note-on"), "Show");
          if (show) show.click();
          const back = await until(() => text("#inspector h2") === step, 5000);
          return { on, step, went: Boolean(back) };
        `);
        const anchored = [];
        for (const file of await noteFiles()) {
          const note = await readNoteFile(file);
          if (note.on) anchored.push(note.on);
        }
        report.anchorsOnDisk = {
          lines: anchored.find((on: { lines?: number[] }) => on.lines)?.lines ?? null,
          text: anchored.find((on: { text?: string }) => on.text !== undefined)?.text ?? null,
          execution: anchored.find((on: { execution?: string }) => on.execution)?.execution ?? null,
        };

        // A problem Fragmentor reports on a block, flagged for the agent from
        // the block's own panel.
        const outboxFile = path.join(check.application, "blocks", "tickets", "outbox", "block.json");
        const outboxBefore = await readFile(outboxFile, "utf8");
        await writeFile(outboxFile, JSON.stringify({ ...JSON.parse(outboxBefore), code: "src/outbox-nowhere.ts" }, null, 2), "utf8");
        await run("problemFlagged", `${notesSection}
          node("outbox").click();
          await heading("Outbox");
          const flag = await until(() => [...document.querySelectorAll("#inspector .problem-line button")].find((b) => b.textContent === "Flag"), 10000);
          if (!flag) return { offered: false };
          flag.click();
          const flagged = await until(() => document.querySelector("#inspector .problem-line .problem-flagged"), 10000);
          const card = await until(() => cards().find((each) => each.querySelector(".note-problem")), 10000);
          return {
            offered: true,
            flagged: Boolean(flagged),
            problem: card ? card.querySelector(".note-problem").textContent : "",
            redFlag: Boolean(document.querySelector('.block-box[data-id="outbox"][data-failing="true"]')),
          };
        `);
        await writeFile(outboxFile, outboxBefore, "utf8");

        // Every command, in a window of its own, with the block picked out filled in.
        await run("commandsListed", `${notesSection}
          node("price-seat").click();
          await heading("Price Seat");
          document.getElementById("agent-commands").click();
          const listed = await until(() => document.querySelectorAll("#overlay [data-command]").length > 0 ? [...document.querySelectorAll("#overlay [data-command]")] : null, 5000);
          if (!listed) return { names: "" };
          const review = listed.find((each) => each.dataset.command === "review");
          const result = {
            title: text("#overlay .window-head h2"),
            names: listed.map((each) => each.dataset.command).join(" "),
            review: review ? [...review.querySelectorAll(".note-phrase-words")].map((c) => c.textContent).join(" | ") : "",
            slash: review ? text('#overlay [data-command="review"] .command-usage') : "",
          };
          document.querySelector("#overlay .window-close").click();
          return result;
        `);
        await capture(window, "self-check-commands");
        // View › Commands opens the same window, with the same block filled in.
        pick("show-commands");
        await run("commandsFromMenu", `
          const listed = await until(() => document.querySelectorAll("#overlay [data-command]").length > 0 ? [...document.querySelectorAll("#overlay [data-command]")] : null, 5000);
          if (!listed) return { names: "" };
          const result = { subtitle: text("#overlay .window-head .window-sub"), names: listed.map((each) => each.dataset.command).join(" ") };
          document.querySelector("#overlay .window-close").click();
          return result;
        `);

        // How a failure flagged for the agent looks, with nothing over the
        // drawing: the block outlined in red, and the note leading with the error.
        await run("errorShown", `${notesSection}
          const close = [...document.querySelectorAll(".bench-window .window-close")].find((each) => each.textContent === "✕");
          if (close) close.click();
          node("price-seat").click();
          await heading("Price Seat");
          const failed = await until(() => cards().find((each) => each.querySelector(".note-error") && each.dataset.waiting === "agent"), 5000);
          if (!failed) return { shown: false };
          const summary = failed.querySelector(".note-run summary");
          if (summary) summary.click();
          failed.scrollIntoView({ block: "start" });
          await wait(1500);
          const opened = failed.querySelector(".note-run[open]");
          return { shown: true, open: Boolean(opened), retry: Boolean(opened && [...opened.querySelectorAll("button")].find((b) => b.textContent === "Retry test")) };
        `);
        await capture(window, "self-check-note-error");
        await run("kindShown", `${notesSection}
          node("tickets-db").click();
          await heading("Tickets Database");
          await wait(1500);
          const kind = document.querySelector("#inspector .role-note");
          const after = kind && kind.previousElementSibling;
          return {
            kind: kind ? kind.textContent : "",
            underResponsibility: Boolean(after && after.classList.contains("responsibility")),
            coloured: kind ? getComputedStyle(kind.querySelector(".role-note-kind")).color : "",
          };
        `);
        await capture(window, "self-check-kind");

        // An execution written down in the messenger: picked, drawn over the
        // whole application, stepped through, and followed inside.
        // An execution written down in the messenger, stepped through on the
        // tree one arrow at a time, and then read end to end as its own drawing.
        pick("close-project");
        await run("execution", `
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

          // Outside the system is marked beside the block a run starts at,
          // and must land on no block: nothing on the tree stands for
          // outside, so a mark on a block would read as that block being it.
          // The clean-up job starts beside the database, which is where the
          // room beside it runs out.
          const outsideOn = () => {
            const dot = document.querySelector("#exec-layer .exec-outside-dot");
            if (!dot) return "no mark";
            const at = dot.getBoundingClientRect();
            const x = at.left + at.width / 2;
            const y = at.top + at.height / 2;
            const over = [...document.querySelectorAll("#node-layer .block-box")].find((box) => {
              const rect = box.getBoundingClientRect();
              return x > rect.left && x < rect.right && y > rect.top && y < rect.bottom;
            });
            return over ? "block " + over.dataset.id : "clear";
          };
          const pick = async (id) => {
            select.value = id;
            select.dispatchEvent(new Event("change", { bubbles: true }));
            await until(() => document.querySelector("#exec-layer .exec-line-group"));
            await wait(300);
          };
          await pick("clean-up-sessions");
          const outside = outsideOn();
          await pick("send-a-message");

          return {
            opened: true,
            offered,
            outside,
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

          // Which block each end of the arrow is at, which is the only way to
          // tell which way it points. The head is the end the marker is on.
          const endsOf = () => {
            const line = document.querySelector("#exec-layer .exec-line");
            if (!line) return {};
            const nearest = (length) => {
              const point = line.getPointAtLength(length).matrixTransform(line.getScreenCTM());
              let best = "";
              let near = Infinity;
              for (const box of document.querySelectorAll("#node-layer .block-box")) {
                const rect = box.getBoundingClientRect();
                const away = Math.hypot(
                  Math.max(rect.left - point.x, 0, point.x - rect.right),
                  Math.max(rect.top - point.y, 0, point.y - rect.bottom),
                );
                if (away < near) { near = away; best = box.dataset.id; }
              }
              return best;
            };
            return { tail: nearest(0), head: nearest(line.getTotalLength()) };
          };

          // The arrow goes over the blocks, so the one thing it must not do is
          // take their clicks. Every other interaction in this check is
          // dispatched straight at an element, which skips hit-testing
          // altogether, so these two ask the page what is really on top.
          const onTop = (x, y) => {
            const hit = document.elementFromPoint(x, y);
            if (!hit) return "nothing";
            const box = hit.closest(".block-box");
            return box ? "block " + box.dataset.id : hit.getAttribute("class") || hit.tagName;
          };
          const middleOf = (selector) => {
            const found = document.querySelector(selector);
            if (!found) return null;
            const rect = found.getBoundingClientRect();
            return [rect.left + rect.width / 2, rect.top + rect.height / 2];
          };
          const onTopOf = (selector) => {
            const point = middleOf(selector);
            return point ? onTop(point[0], point[1]) : "missing";
          };
          // The first place the arrow runs across a block: what is on top
          // there has to be the block, not the arrow.
          const whereItCrosses = () => {
            const line = document.querySelector("#exec-layer .exec-line");
            if (!line) return "no arrow";
            const boxes = [...document.querySelectorAll("#node-layer .block-box")];
            for (let at = 0; at <= line.getTotalLength(); at += 2) {
              const point = line.getPointAtLength(at).matrixTransform(line.getScreenCTM());
              const over = boxes.find((box) => {
                const rect = box.getBoundingClientRect();
                return point.x > rect.left + 3 && point.x < rect.right - 3 && point.y > rect.top + 3 && point.y < rect.bottom - 3;
              });
              if (over) return onTop(point.x, point.y);
            }
            return "crosses no block";
          };

          button("Step").click();
          await wait(300);
          const stepped = { count: text(".exec-count"), lit: lit(), label: text(".exec-label"), ...endsOf() };

          // On to the answer coming back out of the database, which is drawn
          // out of the database and into whoever asked.
          for (let i = 0; i < 5; i += 1) {
            button("Step").click();
            await wait(200);
          }
          const back = {
            count: text(".exec-count"),
            way: arrow() ? arrow().dataset.current : "",
            caption: text(".exec-caption-text"),
            ...endsOf(),
          };
          // This answer runs the width of the drawing, across the client's UI
          // and over its fold. Both have to stay the thing on top.
          const reaches = {
            crossed: whereItCrosses(),
            fold: onTopOf('.block-box[data-id="ui"] .fold-hit'),
            word: onTopOf("#exec-layer .exec-label-plate"),
          };
          // And the step's own page says its ends the same way round as the
          // arrow does: out of whoever was called, into whoever asked.
          const page = [...document.querySelectorAll("#inspector .port-row")]
            .map((row) => [...row.children].map((cell) => cell.textContent.replace(/Show$/, "").trim()).join(" "))
            .join(" | ");

          // The function behind the step, opened from its page and put away again.
          const openCode = [...document.querySelectorAll("#inspector .btn")].find((b) => b.textContent === "Open the code");
          let codeOpened = false;
          if (openCode) {
            openCode.click();
            codeOpened = Boolean(await until(() => document.querySelector("#overlay pre.window-code"), 3000));
            document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
            await wait(300);
          }
          return { reaches, page, stepped, back, codeOpened };
        `);
        await capture(window, "self-check-giving-back");

        await run("folded", `
          const button = (label) => [...document.querySelectorAll("#exec-bar .run-btn")].find((b) => b.textContent === label);
          const lit = () => [...document.querySelectorAll('.block-box[data-current="true"]')].map((box) => box.dataset.id).sort().join(" ");

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
          return { hidden, opened };
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
/* Menu                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The application menu. Starting, opening and closing a project are under
 * File, which leaves the toolbar to what is done with a project once it is
 * open. Each of those is the window's to carry out, so the menu only passes
 * the choice on.
 *
 * View › Reload Project reads the project from disk again. Reloading the page
 * itself, which the standard menu offers there, would put whatever project was
 * open away and show the start screen.
 */
function setUpMenu(): void {
  const send = (command: MenuCommand) => (_item: Electron.MenuItem, window: Electron.BaseWindow | undefined) => {
    const target = window instanceof BrowserWindow ? window : (BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]);
    if (target) {
      target.webContents.send(CHANNELS.menuCommand, command);
      return;
    }
    // On macOS the application outlives its window, and asking for a
    // project is a reason to open one again.
    const opened = createWindow();
    opened.webContents.once("did-finish-load", () => opened.webContents.send(CHANNELS.menuCommand, command));
  };
  const mac = process.platform === "darwin";

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(mac ? [{ role: "appMenu" } as const] : []),
    {
      label: "File",
      submenu: [
        { id: "new-project", label: "New Project…", accelerator: "CmdOrCtrl+N", click: send("new-project") },
        { id: "open-project", label: "Open Project…", accelerator: "CmdOrCtrl+O", click: send("open-project") },
        { id: "close-project", label: "Close Project", enabled: false, click: send("close-project") },
        { type: "separator" },
        mac ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { id: "show-commands", label: "Commands", enabled: false, click: send("show-commands") },
        { id: "reload-project", label: "Reload Project", accelerator: "CmdOrCtrl+R", enabled: false, click: send("reload-project") },
        { type: "separator" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** Closing or reloading a project, and the commands for its agent, are only offered while one is open. */
function offerProjectMenu(open: boolean): void {
  for (const id of ["close-project", "reload-project", "show-commands"]) {
    const item = Menu.getApplicationMenu()?.getMenuItemById(id);
    if (item) item.enabled = open;
  }
}

/* -------------------------------------------------------------------------- */
/* Window                                                                      */
/* -------------------------------------------------------------------------- */

function createWindow(): BrowserWindow {
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
  window.webContents.on("destroyed", () => {
    stopWatching(id);
    offerProjectMenu(false);
  });

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
  return window;
}

void app.whenReady().then(() => {
  registerHandlers();
  setUpMenu();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
