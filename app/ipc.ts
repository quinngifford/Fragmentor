import type { ProjectSnapshot } from "../src/project/snapshot.js";
import type { Point } from "../src/project/layout.js";
import type { EmitResult } from "../src/codegen/emit.js";
import type { RunOutcome } from "../src/run/run.js";

/**
 * The whole surface between the interface and the kernel.
 *
 * The renderer has no filesystem access and no kernel code in it. It is handed
 * a snapshot and sends back edits, which is what keeps the drawing code free
 * of paths and the kernel free of anything to do with drawing.
 */

export const CHANNELS = {
  chooseProject: "project:choose",
  loadProject: "project:load",
  recentProjects: "project:recent",
  exampleProjects: "project:examples",
  writeImpl: "block:write-impl",
  saveLayout: "layout:save",
  emitCode: "codegen:emit",
  revealBlock: "block:reveal",
  runBlock: "block:run",
} as const;

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

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

export interface WriteImplRequest {
  dir: string;
  blockPath: string;
  contents: string;
}

export interface FragmentorApi {
  /** Opens a folder picker. Resolves to null when the user cancels. */
  chooseProject(): Promise<Result<ProjectSnapshot | null>>;
  loadProject(dir: string): Promise<Result<ProjectSnapshot>>;
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
}

declare global {
  interface Window {
    fragmentor: FragmentorApi;
  }
}
