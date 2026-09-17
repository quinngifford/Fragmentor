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
  /**
   * The connection picked out on the diagram: a bus carrying values between
   * two blocks, or an access reaching a database or a queue. The two kinds
   * cannot share an id, so one field holds whichever is selected.
   */
  selectedLink: string | null;
  zoom: number;
  panX: number;
  panY: number;
  showRail: boolean;
  showInspector: boolean;
  /** How wide the inspector is, in pixels. Dragged by hand and kept between sessions. */
  inspectorWidth: number;
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

const WIDTH_KEY = "fragmentor.inspectorWidth";

/** How wide the inspector may be dragged. Narrow enough to read, wide enough for code. */
export const INSPECTOR_WIDTH = { least: 280, most: 900, standard: 360 };

function readWidth(): number {
  try {
    const stored = Number(localStorage.getItem(WIDTH_KEY));
    if (!Number.isFinite(stored) || stored <= 0) return INSPECTOR_WIDTH.standard;
    return Math.min(INSPECTOR_WIDTH.most, Math.max(INSPECTOR_WIDTH.least, stored));
  } catch {
    return INSPECTOR_WIDTH.standard;
  }
}

/** Kept in this browser profile, like the bus colours: it is how someone likes to look at a project, not part of it. */
export function rememberInspectorWidth(width: number): void {
  try {
    localStorage.setItem(WIDTH_KEY, String(Math.round(width)));
  } catch {
    // Storage can be unavailable; the width simply starts from the default next time.
  }
}

export const ui: UiState = {
  snapshot: null,
  dir: null,
  waiting: false,
  loadError: null,
  view: "",
  selection: new Set(),
  selectedLink: null,
  zoom: 1,
  panX: 40,
  panY: 30,
  showRail: true,
  showInspector: true,
  inspectorWidth: readWidth(),
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

/* -------------------------------------------------------------------------- */
/* How the diagram is drawn                                                    */
/* -------------------------------------------------------------------------- */

/**
 * What a colour on the diagram means.
 *
 * `role` says what kind of thing something is: green for code inside the
 * program, and a hue apiece for the databases, queues, services and people
 * around it. `block` gives every block a colour of its own and paints what
 * leaves it to match, which is easier to follow along one wire and says
 * nothing about what anything is.
 */
export type ColourBy = "role" | "block";

/**
 * Which diagram a store is drawn on.
 *
 * `kept` draws it where it belongs, with everything reaching it from inside
 * the blocks beside it gathered onto one line; the diagrams underneath are
 * left to their own functions. `everywhere` also brings it into each of those
 * diagrams, so no level hides where its data comes from. `used` does the
 * opposite: it is drawn only beside the block that truly touches it, however
 * deep that is, and the levels above say nothing about it.
 */
export type StoresAt = "kept" | "everywhere" | "used";

/**
 * Colours a block can be given when the diagram is coloured block by block.
 * Warm and cool alternate, so blocks near each other in a diagram are never
 * near each other on the wheel.
 */
export const BLOCK_PALETTE = [
  "#4fe38f",
  "#e2a54b",
  "#4fc9e3",
  "#e3778c",
  "#b5e06a",
  "#b98ce6",
  "#dd6a4a",
  "#5aa9e6",
];

/** A viewing preference rather than part of the design, so it stays in this profile. */
function readChoice<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return allowed.includes(raw as T) ? (raw as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeChoice(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // A profile that will not store anything still draws; it just forgets.
  }
}

export const COLOUR_BY: readonly ColourBy[] = ["role", "block"];
export const STORES_AT: readonly StoresAt[] = ["kept", "everywhere", "used"];

export const viewSettings = {
  colourBy: readChoice("fragmentor.colourBy", COLOUR_BY, "role"),
  storesAt: readChoice("fragmentor.storesAt", STORES_AT, "kept"),
  setColourBy(value: ColourBy): void {
    this.colourBy = value;
    writeChoice("fragmentor.colourBy", value);
  },
  setStoresAt(value: StoresAt): void {
    this.storesAt = value;
    writeChoice("fragmentor.storesAt", value);
  },
};

/** Colours a bus can be given. Restrained enough to stay an instrument panel. */
/**
 * The colours a bus can take, which are all greens.
 *
 * Hue means one thing on this canvas: green is data moving inside the
 * program, and anything else belongs to the world outside it. So buses, which
 * are always the first of those, are told apart by shade rather than by
 * borrowing a hue that now says "database" or "someone else's service". A bus
 * can still be given any colour by hand.
 */
export const BUS_PALETTE = ["#4fe38f", "#8fe34f", "#3fcf9e", "#b5e06a", "#5fd8c0", "#2fb87a"];

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
