import type { ProjectSnapshot } from "../src/project/snapshot.js";
import type { EmitResult, NewProjectSettings } from "../src/codegen/emit.js";
import type { CaseResult, RunEvent, RunOutcome, StoreSeeds } from "../src/run/run.js";
import type { TestCase } from "../src/run/cases.js";
import type { BlockVersions, SavedVersion, SwapDone, VersionRef } from "../src/project/history.js";
import type { VersionComparison } from "../src/run/versions.js";
import type { FlaggedRun, Note } from "../src/project/notes.js";

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
  emitCode: "codegen:emit",
  revealBlock: "block:reveal",
  revealCode: "code:reveal",
  readCode: "code:read",
  watchRun: "run:start",
  controlRun: "run:control",
  runEvent: "run:event",
  saveCases: "block:save-cases",
  runCases: "block:run-cases",
  blockVersions: "block:versions",
  compareVersion: "block:compare-version",
  swapVersion: "block:swap-version",
  undoSwap: "block:undo-swap",
  saveVersion: "block:save-version",
  deleteSavedVersion: "block:delete-saved-version",
  editSavedVersion: "block:edit-saved-version",
  addNote: "note:add",
  replyToNote: "note:reply",
  resolveNote: "note:resolve",
  deleteNote: "note:delete",
  copyText: "clipboard:write",
} as const;

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
  /** Opens a folder picker. Resolves to null when the user cancels. */
  chooseProject(): Promise<Result<ProjectLoad | null>>;
  /** Picks a folder and starts a project there with what the person chose. Resolves to null when they cancel. */
  newProject(settings: NewProjectSettings): Promise<Result<ProjectLoad | null>>;
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
  emitCode(dir: string): Promise<Result<EmitResult>>;
  /** Shows a block's folder in the system file manager. */
  revealBlock(dir: string, blockPath: string): Promise<Result<null>>;
  /** Shows the file a block points at, given relative to the project. */
  revealCode(dir: string, file: string): Promise<Result<null>>;
  /** The whole of the file a block points at, for reading in a window of its own. */
  readCode(dir: string, pointer: string): Promise<Result<{ file: string; line: number | null; text: string | null }>>;
  /** Runs a block, reporting every block call beneath it to onRunEvent as it happens. Resolves when the run ends. */
  watchRun(request: WatchRunRequest): Promise<Result<RunOutcome>>;
  /** Resumes, re-aims or stops a watched run. */
  controlRun(runId: string, command: RunCommand): Promise<Result<null>>;
  /** Called with each event of every watched run. */
  onRunEvent(callback: (runId: string, event: RunEvent) => void): void;
  /** Replaces the tests saved for a block. */
  saveCases(request: SaveCasesRequest): Promise<Result<null>>;
  /** Runs every saved test for a block. */
  runCases(dir: string, blockPath: string): Promise<Result<CaseResult[]>>;
  /** A block's saved versions and its git history, newest first, and the swap Undo swap would reverse. */
  blockVersions(dir: string, blockPath: string): Promise<Result<BlockVersions>>;
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
  /** Leaves a note from the person on a block, with the run it flags when it flags one. */
  addNote(dir: string, blockPath: string, text: string, run?: FlaggedRun): Promise<Result<Note>>;
  /** Adds the person's reply to a note, with a run that still goes wrong where there is one, which hands it to the agent, opening it again if it was resolved. */
  replyToNote(dir: string, id: string, text: string, run?: FlaggedRun): Promise<Result<Note>>;
  /** Marks a note done. */
  resolveNote(dir: string, id: string): Promise<Result<Note>>;
  deleteNote(dir: string, id: string): Promise<Result<null>>;
  /** Puts text on the clipboard, such as what to tell the agent. */
  copyText(text: string): Promise<Result<null>>;
}

declare global {
  interface Window {
    fragmentor: FragmentorApi;
  }
}
