import type { ProjectSnapshot, SnapshotExecution } from "../../src/project/snapshot.js";
import type { CaseResult, RunEvent, RunOutcome, StoreSeeds } from "../../src/run/run.js";
import type { Role } from "../../src/model/roles.js";

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
  /** Which of a block's calls the inspector shows, when it was called more than once, by block path. */
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
  /** Blocks whose parts are folded away on the tree, by path. */
  folded: Set<string>;
  /**
   * Which drawing is on the canvas: the architecture as a tree, or the
   * execution being stepped through, from beginning to end.
   */
  shows: "tree" | "flow";
  /** Whether the arrows saying what each block reaches are drawn. A preference, like the colours. */
  showDependencies: boolean;
  setShowDependencies(value: boolean): void;
  /**
   * The execution being stepped through on the tree, and which of its steps
   * is showing. One step is on screen at a time; the whole of it at once is
   * a drawing of its own.
   */
  execution: { id: string; at: number } | null;
  /** The blocks picked out on the tree, by path. */
  selection: Set<string>;
  /** The line picked out on the diagram: an access reaching a database, a queue or a service. */
  selectedLink: string | null;
  zoom: number;
  panX: number;
  panY: number;
  showRail: boolean;
  showInspector: boolean;
  /** Whether the legend is folded away to its heading. */
  legendCollapsed: boolean;
  setLegendCollapsed(value: boolean): void;
  /** How wide the inspector is, in pixels. Dragged by hand and kept between sessions. */
  inspectorWidth: number;
  codeTab: "code" | "contract";
  /**
   * The bench that is open in a window of its own: which block it is for, which
   * of that block's entries if it was opened from one, where it has been
   * dragged to, how big it has been pulled and whether it is rolled up to its
   * title bar. Null when none is open.
   */
  bench: {
    blockPath: string;
    entry: string | null;
    route?: string;
    x: number;
    y: number;
    w: number;
    h: number;
    minimised: boolean;
  } | null;
  /** Once the view has been moved by hand, stop refitting it automatically. */
  userAdjusted: boolean;
  /**
   * Whether Fit was pressed, so the refits that follow keep the whole tree in
   * view rather than stopping where names can still be read. It lasts until
   * a project is next drawn for the first time.
   */
  fitsWhole: boolean;
  /**
   * Unsaved edits to a block's implementation, keyed by block path, with the
   * file as it was when editing began. That is how a change made on disk in
   * the meantime — usually by the agent — is pointed out rather than silently
   * overwritten.
   */
  edits: Map<string, { base: string | null; text: string }>;
  /** What has been typed into each block's test bench, kept across redraws. */
  benchInputs: Map<string, Record<string, unknown>>;
  /**
   * The rows each block's bench puts in the stores it reaches before a run,
   * by block path and then by store target. Kept beside the inputs and for
   * the same reason: running redraws the panel, and a store that emptied
   * itself every time would make the bench useless for a block that reads one.
   */
  benchStores: Map<string, StoreSeeds>;
  /** The last result from running each block. */
  runs: Map<string, RunOutcome>;
  /** What that last run was given, so a run that went wrong can be flagged for the agent as it was. */
  ranWith: Map<string, { input: unknown; stores: StoreSeeds }>;
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

/** Kept in this browser profile, like the colours: it is how someone likes to look at a project, not part of it. */
export function rememberInspectorWidth(width: number): void {
  try {
    localStorage.setItem(WIDTH_KEY, String(Math.round(width)));
  } catch {
    // Storage can be unavailable; the width simply starts from the default next time.
  }
}

const BENCH_SIZE_KEY = "fragmentor.benchSize";

/**
 * How big the bench window may be pulled. It starts wide enough to lay the
 * form out in columns rather than a single thin strip, which is what made it
 * a window instead of a panel in the first place.
 */
export const BENCH_SIZE = { leastW: 420, leastH: 220, standardW: 780, standardH: 580 };

export function readBenchSize(): { w: number; h: number } {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(BENCH_SIZE_KEY) ?? "");
    if (stored === null || typeof stored !== "object") throw new Error("no size");
    const { w, h } = stored as { w?: unknown; h?: unknown };
    if (typeof w !== "number" || typeof h !== "number") throw new Error("no size");
    return { w: Math.max(BENCH_SIZE.leastW, w), h: Math.max(BENCH_SIZE.leastH, h) };
  } catch {
    return { w: BENCH_SIZE.standardW, h: BENCH_SIZE.standardH };
  }
}

/** Remembered like the inspector's width, and for the same reason. */
export function rememberBenchSize(w: number, h: number): void {
  try {
    localStorage.setItem(BENCH_SIZE_KEY, JSON.stringify({ w: Math.round(w), h: Math.round(h) }));
  } catch {
    // Storage can be unavailable; the window simply opens at its usual size next time.
  }
}

export const ui: UiState = {
  snapshot: null,
  dir: null,
  waiting: false,
  loadError: null,
  folded: new Set(),
  shows: "tree",
  showDependencies: (() => {
    try {
      // Off to begin with: the tree is what a system is made of, and the
      // arrows over it are a different question, asked when it is asked.
      return localStorage.getItem("fragmentor.showDependencies") === "true";
    } catch {
      return true;
    }
  })(),
  setShowDependencies(value: boolean): void {
    this.showDependencies = value;
    try {
      localStorage.setItem("fragmentor.showDependencies", String(value));
    } catch {
      // Remembering is a nicety; the lines still come and go.
    }
  },
  execution: null,
  selection: new Set(),
  selectedLink: null,
  zoom: 1,
  panX: 40,
  panY: 30,
  // The canvas draws the whole hierarchy now, so the rail beside it starts
  // out of the way; it is still there for finding one block by name.
  showRail: false,
  showInspector: true,
  // Folded away or not is a preference like the others, and outlives a
  // project, so it is remembered here rather than reset on every open.
  legendCollapsed: (() => {
    try {
      return localStorage.getItem("fragmentor.legendCollapsed") === "true";
    } catch {
      return false;
    }
  })(),
  setLegendCollapsed(value: boolean): void {
    this.legendCollapsed = value;
    try {
      localStorage.setItem("fragmentor.legendCollapsed", String(value));
    } catch {
      // Remembering is a nicety; folding it away still works.
    }
  },
  inspectorWidth: readWidth(),
  codeTab: "code",
  bench: null,
  userAdjusted: false,
  fitsWhole: false,
  edits: new Map(),
  benchInputs: new Map(),
  benchStores: new Map(),
  runs: new Map(),
  ranWith: new Map(),
  running: new Set(),
  caseResults: new Map(),
  runningCases: new Set(),
  caseNames: new Map(),
  breakpoints: new Set(),
  watch: null,
  status: null,
};

/**
 * Forgets what the window holds about some blocks' code, benches and results:
 * `root` and every block inside it, or every block when `root` is null. What
 * was typed or run against files that have since been replaced describes code
 * that is no longer there. These are all the maps kept by block path, listed
 * once, so a project being put away and a block being swapped forget the same.
 */
export function forgetBlocks(root: string | null): void {
  for (const byPath of [ui.edits, ui.benchInputs, ui.benchStores, ui.runs, ui.ranWith, ui.caseResults, ui.caseNames]) {
    for (const path of [...byPath.keys()]) {
      if (root === null || path === root || path.startsWith(`${root}/`)) byPath.delete(path);
    }
  }
}

/** The execution drawn over the diagram, while it is still in the project. */
export function selectedExecution(): SnapshotExecution | null {
  const id = ui.execution?.id;
  return ui.snapshot?.executions.find((each) => each.id === id) ?? null;
}

export function requireSnapshot(): ProjectSnapshot {
  if (!ui.snapshot) throw new Error("No project is open.");
  return ui.snapshot;
}

export function blockAt(path: string) {
  return requireSnapshot().blocks[path];
}

/** The one block picked out, when exactly one is. */
export function selectedBlock() {
  if (ui.selection.size !== 1) return null;
  const [only] = [...ui.selection];
  return only === undefined ? null : (ui.snapshot?.blocks[only] ?? null);
}

/* -------------------------------------------------------------------------- */
/* How the diagram is drawn                                                    */
/* -------------------------------------------------------------------------- */

/**
 * What a colour on the diagram means.
 *
 * `role` says what kind of thing something is: green for code of ours, and a
 * hue apiece for the databases, queues, services and people around it.
 * `block` gives every block a colour of its own, and the lines leaving it the
 * same, which tells the blocks apart and says nothing about what they are.
 */
export type ColourBy = "role" | "block";

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

export const COLOUR_BY: readonly ColourBy[] = ["block", "role"];

export const viewSettings = {
  colourBy: readChoice("fragmentor.colourBy", COLOUR_BY, "block"),
  setColourBy(value: ColourBy): void {
    this.colourBy = value;
    writeChoice("fragmentor.colourBy", value);
  },
};

function writeStore(key: string, value: Record<string, string>): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be unavailable; a choice simply falls back to the default.
  }
}

function readStore(key: string): Record<string, string> {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? {} : (JSON.parse(raw) as Record<string, string>);
  } catch {
    return {};
  }
}

/**
 * What each kind of block is drawn in.
 *
 * Ordered as a wheel from what is most yours to what is least — code, the
 * data it holds, the data it keeps, the programs it owns, the people it
 * serves, the services it does not control — so the hues run in the same
 * direction the meaning does. Green stays the signal colour it always was.
 *
 * These are the defaults. A person can change any of them from the legend,
 * and their choice is theirs rather than the project's, so it stays in this
 * browser profile.
 */
export const DEFAULT_ROLE_COLOURS: Record<Role, string> = {
  function: "#37dc89",   // bright mint green
  component: "#A3E07A",  // soft lime: code of ours too, made of parts rather than called
  structure: "#67D8FF",  // bright cyan
  queue: "#FFD166",      // warm yellow
  storage: "#5EEAD4",    // aqua/teal
  database: "#7C9CFF",   // periwinkle blue
  service: "#C084FC",    // bright purple
  client: "#FFB86B",     // soft bright orange
  external: "#F472B6",   // pink, distinct without reading as error
};

/**
 * Colours used when blocks are coloured individually instead of by role.
 * Ordered so neighbouring colours stay visually distinct.
 */
export const BLOCK_PALETTE = [
  "#37dc89", // mint
  "#C084FC", // purple
  "#FFD166", // yellow
  "#67D8FF", // cyan
  "#FF8FA3", // coral pink
  "#7C9CFF", // periwinkle
  "#FFB86B", // orange
  "#5EEAD4", // aqua
];

const ROLE_COLOURS_KEY = "fragmentor.roleColours";
const BLOCK_COLOURS_KEY = "fragmentor.blockColours";

/** What each kind is drawn in, as changed from the legend. */
export const roleColours = {
  all: readStore(ROLE_COLOURS_KEY) as Partial<Record<Role, string>>,
  get(role: Role): string {
    return this.all[role] ?? DEFAULT_ROLE_COLOURS[role];
  },
  set(role: Role, colour: string | null): void {
    const next = { ...this.all };
    if (colour === null) delete next[role];
    else next[role] = colour;
    this.all = next;
    writeStore(ROLE_COLOURS_KEY, next as Record<string, string>);
    this.apply();
  },
  /**
   * Put on the document itself, so every block, line, badge and swatch of
   * that kind follows from one place rather than each working it out.
   */
  apply(): void {
    for (const role of Object.keys(DEFAULT_ROLE_COLOURS) as Role[]) {
      document.documentElement.style.setProperty(`--role-${role}`, this.get(role));
    }
  },
};

/** What one block is drawn in, when the diagram is coloured block by block. */
export const blockColours = {
  all: readStore(BLOCK_COLOURS_KEY),
  key(view: string, blockKey: string): string {
    return `${ui.snapshot?.dir ?? ""}|${view}|${blockKey}`;
  },
  get(view: string, blockKey: string): string | undefined {
    return this.all[this.key(view, blockKey)];
  },
  set(view: string, blockKey: string, colour: string | null): void {
    const key = this.key(view, blockKey);
    const next = { ...this.all };
    if (colour === null) delete next[key];
    else next[key] = colour;
    this.all = next;
    writeStore(BLOCK_COLOURS_KEY, next);
  },
};
