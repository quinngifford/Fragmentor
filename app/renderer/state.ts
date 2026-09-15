import type { ProjectSnapshot } from "../../src/project/snapshot.js";
import type { CaseResult, RunEvent, RunOutcome } from "../../src/run/run.js";

/**
 * What the interface is currently showing. Kernel types are imported for their
 * shapes only — no kernel code runs in the renderer, which has no filesystem.
 */

/** One block call in a watched run, as far as the playback has shown it. */
export interface WatchedCall {
  id: number;
  parent: number | null;
  block: string;
  input: unknown;
  output?: unknown;
  error?: string;
  /** "stopped" is a call the run ended before it could finish. */
  state: "running" | "paused" | "returned" | "threw" | "stopped";
}

/**
 * A run shown on the canvas. It is played back at a pace a person can follow,
 * so what is on screen can be behind what has happened; everything shown is
 * derived from the events played so far.
 */
export interface Watch {
  runId: string;
  /** The block that was run. */
  blockPath: string;
  events: RunEvent[];
  /** How many of the events have been shown. */
  played: number;
  /** Every call, as of the events shown so far. */
  calls: Map<number, WatchedCall>;
  /** The call Continue and Step act on, when the run is held. Others may be waiting behind it. */
  heldId: number | null;
  /** Set when the run has ended. */
  outcome: RunOutcome | null;
  /** Which call of a block to show inside its diagram when it ran more than once, by block path. */
  frames: Map<string, number>;
}

export interface UiState {
  snapshot: ProjectSnapshot | null;
  /** The folder open as a project, even while it holds nothing readable. */
  dir: string | null;
  /** True while the agent has not defined a system yet. */
  waiting: boolean;
  /** Why the newest version of the project could not be read. The last good snapshot stays on screen. */
  loadError: string | null;
  /** The composite whose diagram is on the canvas. */
  view: string;
  /** Node keys inside the current diagram: a child id, or `input` / `output`. */
  selection: Set<string>;
  selectedBus: string | null;
  zoom: number;
  panX: number;
  panY: number;
  showRail: boolean;
  showInspector: boolean;
  codeTab: "impl" | "contract";
  /** Once the view has been moved by hand, stop refitting it automatically. */
  userAdjusted: boolean;
  /**
   * Unsaved edits to a block's implementation, keyed by block path, with the
   * file as it was when editing began. That is how a change made on disk in
   * the meantime — usually by the agent — is pointed out rather than silently
   * overwritten.
   */
  edits: Map<string, { base: string | null; text: string }>;
  /** What has been typed into each block's test bench, kept across redraws. */
  benchInputs: Map<string, Record<string, unknown>>;
  /** The last result from running each block. */
  runs: Map<string, RunOutcome>;
  /** Blocks currently running. */
  running: Set<string>;
  /** The last result of running each block's saved tests. */
  caseResults: Map<string, CaseResult[]>;
  /** Blocks whose saved tests are running. */
  runningCases: Set<string>;
  /** The name being typed for a new test, per block. */
  caseNames: Map<string, string>;
  /** Blocks a watched run pauses before, by path. */
  breakpoints: Set<string>;
  /** The run on the canvas, if there is one. */
  watch: Watch | null;
  status: { text: string; tone: "info" | "good" | "bad" } | null;
}

export const ui: UiState = {
  snapshot: null,
  dir: null,
  waiting: false,
  loadError: null,
  view: "",
  selection: new Set(),
  selectedBus: null,
  zoom: 1,
  panX: 40,
  panY: 30,
  showRail: true,
  showInspector: true,
  codeTab: "impl",
  userAdjusted: false,
  edits: new Map(),
  benchInputs: new Map(),
  runs: new Map(),
  running: new Set(),
  caseResults: new Map(),
  runningCases: new Set(),
  caseNames: new Map(),
  breakpoints: new Set(),
  watch: null,
  status: null,
};

export function requireSnapshot(): ProjectSnapshot {
  if (!ui.snapshot) throw new Error("No project is open.");
  return ui.snapshot;
}

export function blockAt(path: string) {
  return requireSnapshot().blocks[path];
}

export function currentBlock() {
  return blockAt(ui.view);
}

/** Colours a bus can be given. Restrained enough to stay an instrument panel. */
export const BUS_PALETTE = ["#4fe38f", "#4fc9e3", "#e2a54b", "#b98ce6", "#e3778c", "#8fe34f"];

const COLORS_KEY = "fragmentor.busColors";

function readStore(key: string): Record<string, string> {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? {} : (JSON.parse(raw) as Record<string, string>);
  } catch {
    return {};
  }
}

/**
 * Bus colours are a viewing preference rather than part of the design, so they
 * stay in this browser profile. Block positions are not: those live in the
 * project, because how a diagram is arranged is part of how it reads.
 */
export const busColors = {
  all: readStore(COLORS_KEY),
  key(view: string, busId: string): string {
    return `${ui.snapshot?.dir ?? ""}|${view}|${busId}`;
  },
  get(view: string, busId: string): string | undefined {
    return this.all[this.key(view, busId)];
  },
  set(view: string, busId: string, colour: string | null): void {
    const key = this.key(view, busId);
    const next = { ...this.all };
    if (colour === null) delete next[key];
    else next[key] = colour;
    this.all = next;
    try {
      localStorage.setItem(COLORS_KEY, JSON.stringify(next));
    } catch {
      // Storage can be unavailable; colours simply fall back to the defaults.
    }
  },
};
