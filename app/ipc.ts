import type { ProjectSnapshot } from "../src/project/snapshot.js";
import type { Point } from "../src/project/layout.js";
import type { EmitResult, NewProjectSettings } from "../src/codegen/emit.js";
import type { CaseResult, RunEvent, RunOutcome, StoreSeeds } from "../src/run/run.js";
import type { TestCase } from "../src/run/cases.js";

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
  saveLayout: "layout:save",
  emitCode: "codegen:emit",
  revealBlock: "block:reveal",
  revealCode: "code:reveal",
  readCode: "code:read",
  watchRun: "run:start",
  controlRun: "run:control",
  runEvent: "run:event",
  saveCases: "block:save-cases",
  runCases: "block:run-cases",
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

export interface SaveLayoutRequest {
  dir: string;
  viewPath: string;
  positions: Record<string, Point>;
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
  saveLayout(request: SaveLayoutRequest): Promise<Result<null>>;
  emitCode(dir: string): Promise<Result<EmitResult>>;
  /** Shows a block's folder in the system file manager. */
  revealBlock(dir: string, blockPath: string): Promise<Result<null>>;
  /** Shows a file a visual block points at, given relative to the project. */
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
}

declare global {
  interface Window {
    fragmentor: FragmentorApi;
  }
}
