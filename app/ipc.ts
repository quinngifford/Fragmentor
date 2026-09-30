import type { ProjectSnapshot } from "../src/project/snapshot.js";
import type { NewProjectSettings } from "../src/codegen/emit.js";
import type { CaseResult, RunEvent, RunOutcome, StoreSeeds } from "../src/run/run.js";
import type { TestCase } from "../src/run/cases.js";
import type { BlockVersions, ChangePoints, ProjectAt, SavedVersion, SwapDone, VersionRef } from "../src/project/history.js";
import type { VersionComparison } from "../src/run/versions.js";
import type { Trace } from "../src/model/trace.js";
import type { RecordingScope } from "../src/model/recorded.js";
import type { FlaggedRun, Note, NoteAnchor } from "../src/project/notes.js";

/**
 * The whole surface between the interface and the kernel.
 *
 * The renderer has no filesystem access and no kernel code in it. It is handed
 * a snapshot and sends back edits, which is what keeps the drawing code free
 * of paths and the kernel free of anything to do with drawing.
 */

export const CHANNELS = {
  chooseProject: "project:choose",
  newProject: "project:new",
  loadProject: "project:load",
  closeProject: "project:close",
  readProject: "project:read",
  projectChanged: "project:changed",
  recentProjects: "project:recent",
  exampleProjects: "project:examples",
  writeImpl: "block:write-impl",
  revealBlock: "block:reveal",
  revealCode: "code:reveal",
  readCode: "code:read",
  watchRun: "run:start",
  recordRun: "run:record",
  controlRun: "run:control",
  runEvent: "run:event",
  saveCases: "block:save-cases",
  runCases: "block:run-cases",
  blockVersions: "block:versions",
  changePoints: "project:change-points",
  projectAt: "project:at",
  compareVersion: "block:compare-version",
  swapVersion: "block:swap-version",
  undoSwap: "block:undo-swap",
  saveVersion: "block:save-version",
  deleteSavedVersion: "block:delete-saved-version",
  editSavedVersion: "block:edit-saved-version",
  addNote: "note:add",
  addRule: "rule:add",
  removeRule: "rule:remove",
  replyToNote: "note:reply",
  resolveNote: "note:resolve",
  deleteNote: "note:delete",
  copyText: "clipboard:write",
  rerunNote: "note:rerun",
  refreshAgentFiles: "project:agent-files",
  commandInstalled: "agent:command-installed",
  menuCommand: "menu:command",
} as const;

/** What the application menu asks the window to do. */
export type MenuCommand = "new-project" | "open-project" | "close-project" | "reload-project" | "show-commands";

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * A folder opened as a project. It need not hold a readable project: the agent
 * may be halfway through writing it. A project the agent has not defined yet
 * reads as a snapshot with no systems.
 */
export interface ProjectLoad {
  dir: string;
  /** Null when there is nothing readable to show. */
  snapshot: ProjectSnapshot | null;
  /** Why the project could not be read, when it could not. */
  error: string | null;
}

/** A folder the person picked to open that is not a project yet, offered as one to start. */
export interface FolderToStart {
  dir: string;
  /** Whether it holds anything already, which is most likely code to work with. */
  holdsFiles: boolean;
}

export interface WatchRunRequest {
  /** Chosen by the window, so it can tell this run's events from any other's. */
  runId: string;
  dir: string;
  blockPath: string;
  input: unknown;
  /** What each store the block reaches holds before it runs, by target and then by key. */
  stores: StoreSeeds;
  /** Blocks to pause before, by path. */
  breakpoints: string[];
}

/**
 * An execution to record: the code answering its trigger, run and watched as
 * a block run from the bench is. What runs, with what, is read from the
 * execution's file by the main process, never taken from the window.
 */
export interface RecordRunRequest {
  runId: string;
  dir: string;
  execution: string;
  breakpoints: string[];
}

/**
 * A recording made, with what it could see, or why none could be: nothing
 * Fragmentor can run answers the trigger, or the run never got going or
 * never ended. Only the first is ever a trace.
 */
export type RecordedRun =
  | { outcome: RunOutcome; trace: Trace; scope: RecordingScope; complete: boolean }
  | { couldNotRecord: string };

/** What the person can tell a watched run to do. */
export type RunCommand =
  | { type: "resume"; mode: "continue" | "step" | "block" }
  | { type: "breakpoints"; paths: string[] }
  | { type: "stop" };

export interface SaveCasesRequest {
  dir: string;
  blockPath: string;
  cases: TestCase[];
}

export interface WriteImplRequest {
  dir: string;
  blockPath: string;
  contents: string;
}

export interface FragmentorApi {
  /** Opens a folder picker. Resolves to null when the user cancels, and to the folder when it is not a project yet. */
  chooseProject(): Promise<Result<ProjectLoad | { startHere: FolderToStart } | null>>;
  /** Starts a project with what the person chose, in `dir`, or else in a folder picked now. Resolves to null when they cancel. */
  newProject(settings: NewProjectSettings, dir?: string): Promise<Result<ProjectLoad | null>>;
  /** Opens a project: remembers it, starts watching it, and reads it. */
  loadProject(dir: string): Promise<Result<ProjectLoad>>;
  /** Stops watching whatever this window had open, for going back to the start screen. */
  closeProject(): Promise<Result<null>>;
  /** Reads the open project again, after something changed it. */
  readProject(dir: string): Promise<Result<ProjectLoad>>;
  /** Called with the project's folder whenever files in it change on disk. */
  onProjectChanged(callback: (dir: string) => void): void;
  recentProjects(): Promise<Result<string[]>>;
  /** Example projects shipped with Fragmentor, so there is something to open. */
  exampleProjects(): Promise<Result<{ dir: string; name: string }[]>>;
  writeImpl(request: WriteImplRequest): Promise<Result<null>>;
  /** Shows a block's folder in the system file manager. */
  revealBlock(dir: string, blockPath: string): Promise<Result<null>>;
  /** Shows the file a block points at, given relative to the project. */
  revealCode(dir: string, file: string): Promise<Result<null>>;
  /** The whole of the file a block points at, for reading in a window of its own. */
  readCode(dir: string, pointer: string): Promise<Result<{ file: string; line: number | null; text: string | null }>>;
  /** Runs a block, reporting every block call beneath it to onRunEvent as it happens. Resolves when the run ends. */
  watchRun(request: WatchRunRequest): Promise<Result<RunOutcome>>;
  /** Records an execution, reporting its events to onRunEvent as a watched run does. Resolves when the run ends. */
  recordRun(request: RecordRunRequest): Promise<Result<RecordedRun>>;
  /** Resumes, re-aims or stops a watched run. */
  controlRun(runId: string, command: RunCommand): Promise<Result<null>>;
  /** Called with each event of every watched run. */
  onRunEvent(callback: (runId: string, event: RunEvent) => void): void;
  /** Replaces the tests saved for a block. */
  saveCases(request: SaveCasesRequest): Promise<Result<null>>;
  /** Runs every saved test for a block. */
  runCases(dir: string, blockPath: string): Promise<Result<CaseResult[]>>;
  /** A block's saved versions and its git history, newest first, the swap Undo swap would reverse, and, given the commit last looked at, the row the block was on then. */
  blockVersions(dir: string, blockPath: string, since?: string | null): Promise<Result<BlockVersions>>;
  /** The newest commit, whether `base` — the commit last looked at — is still there, and what was committed since it. */
  changePoints(dir: string, base: string | null): Promise<Result<{ unavailable: string } | ChangePoints>>;
  /** The project as it was at one commit, snapshotted so the window can compare it with the one on screen. */
  projectAt(dir: string, commit: string): Promise<Result<ProjectAt>>;
  /** Runs the saved tests of both versions of a block, and every other saved test in its system, against the block as it is and as it was in one version. */
  compareVersion(dir: string, blockPath: string, version: VersionRef): Promise<Result<VersionComparison>>;
  /** Puts a block and its parts back as they were in one version, keeping what was there so it can be undone. */
  swapVersion(dir: string, blockPath: string, version: VersionRef): Promise<Result<SwapDone>>;
  /** Puts back what the last swap of this block replaced. */
  undoSwap(dir: string, blockPath: string): Promise<Result<SwapDone>>;
  /** Saves a block as it is now as a version of it, with a name and a description, in the project for everyone working on it. */
  saveVersion(dir: string, blockPath: string, name: string, description: string): Promise<Result<SavedVersion & { ignored: string | null }>>;
  /** Deletes one of a block's saved versions. */
  deleteSavedVersion(dir: string, blockPath: string, id: string): Promise<Result<null>>;
  /** Gives one of a block's saved versions a new name and description, keeping everything else about it. */
  editSavedVersion(dir: string, blockPath: string, id: string, name: string, description: string): Promise<Result<SavedVersion>>;
  /** Leaves a note from the person on a block: with the run or the problem it flags, and on some lines or a step, where it is. */
  addNote(dir: string, blockPath: string, text: string, extras?: { run?: FlaggedRun; problem?: string; on?: NoteAnchor }): Promise<Result<Note>>;
  /** Adds one of the person's rules, as its sentence, with their reason when they gave one. */
  addRule(dir: string, rule: string, why?: string): Promise<Result<null>>;
  /** Removes one of the person's rules, by its sentence. */
  removeRule(dir: string, rule: string): Promise<Result<null>>;
  /** Adds the person's reply to a note, with a run that still goes wrong where there is one, which hands it to the agent, opening it again if it was resolved. */
  replyToNote(dir: string, id: string, text: string, extras?: { run?: FlaggedRun }): Promise<Result<Note>>;
  /** Runs the run a note flags again, as it was flagged, and says how it went, without touching the block's saved tests. */
  rerunNote(dir: string, id: string): Promise<Result<CaseResult>>;
  /** Brings the project's guide and its agent's slash commands up to date, where they are not. */
  refreshAgentFiles(dir: string): Promise<Result<null>>;
  /** Whether the fragmentor command the agent uses is installed, and where Fragmentor's own folder is, to install it from. */
  commandInstalled(): Promise<Result<{ installed: boolean; fragmentorDir: string }>>;
  /** Marks a note done. */
  resolveNote(dir: string, id: string): Promise<Result<Note>>;
  deleteNote(dir: string, id: string): Promise<Result<null>>;
  /** Puts text on the clipboard, such as what to tell the agent. */
  copyText(text: string): Promise<Result<null>>;
  /** Called with whatever the person picks from the application menu that is the window's to do. */
  onMenuCommand(callback: (command: MenuCommand) => void): void;
}

declare global {
  interface Window {
    fragmentor: FragmentorApi;
  }
}
