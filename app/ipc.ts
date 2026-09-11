import type { ProjectSnapshot } from "../src/project/snapshot.js";
import type { Point } from "../src/project/layout.js";
import type { EmitResult } from "../src/codegen/emit.js";
import type { CaseResult, RunOutcome } from "../src/run/run.js";
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
  readProject: "project:read",
  projectChanged: "project:changed",
  recentProjects: "project:recent",
  exampleProjects: "project:examples",
  writeImpl: "block:write-impl",
  saveLayout: "layout:save",
  emitCode: "codegen:emit",
  revealBlock: "block:reveal",
  runBlock: "block:run",
  saveCases: "block:save-cases",
  runCases: "block:run-cases",
} as const;

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * A folder opened as a project. It need not hold a readable project: the agent
 * may not have defined the system yet, or may be halfway through writing it.
 */
export interface ProjectLoad {
  dir: string;
  /** Null when there is nothing readable to show. */
  snapshot: ProjectSnapshot | null;
  /** False while the folder is waiting for an agent to write fragmentor.json. */
  hasManifest: boolean;
  /** Why the project could not be read, when it could not. */
  error: string | null;
}

export interface SaveLayoutRequest {
  dir: string;
  viewPath: string;
  positions: Record<string, Point>;
}

export interface RunBlockRequest {
  dir: string;
  blockPath: string;
  input: unknown;
}

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
  /** Picks a folder and prepares it for a coding agent. Resolves to null when the user cancels. */
  newProject(): Promise<Result<ProjectLoad | null>>;
  /** Opens a project: remembers it, starts watching it, and reads it. */
  loadProject(dir: string): Promise<Result<ProjectLoad>>;
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
  /** Runs one block against the given input and reports what happened. */
  runBlock(request: RunBlockRequest): Promise<Result<RunOutcome>>;
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
